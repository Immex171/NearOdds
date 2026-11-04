//! The ONLY place balances change. Every operation validates and computes the
//! complete new state first, then commits, so a failed check mutates nothing.
//! (A panic also reverts the whole receipt on-chain.)
//!
//! No function here iterates over accounts.

use near_sdk::AccountId;

use crate::errors::*;
use crate::state::{Account, Contract, PendingWithdrawal, SettlementOutcome};

pub type Res<T> = Result<T, &'static str>;

pub fn add(a: u128, b: u128) -> Res<u128> {
    a.checked_add(b).ok_or(ERR_OVERFLOW)
}

pub fn sub(a: u128, b: u128, err: &'static str) -> Res<u128> {
    a.checked_sub(b).ok_or(err)
}

impl Contract {
    pub(crate) fn require_market(&self, market_id: &str) {
        near_sdk::require!(market_id == self.market.id, ERR_UNKNOWN_MARKET);
    }

    pub(crate) fn load_account(&self, id: &AccountId) -> Res<Account> {
        self.accounts.get(id).cloned().ok_or(ERR_NOT_REGISTERED)
    }

    fn store_account(&mut self, id: &AccountId, account: Account) {
        self.accounts.insert(id.clone(), account);
    }

    /// Credits `amount` of received collateral to `id`'s available balance.
    pub(crate) fn apply_deposit(&mut self, id: &AccountId, amount: u128) -> Res<()> {
        if amount == 0 {
            return Err(ERR_ZERO_AMOUNT);
        }
        let mut acct = self.load_account(id)?;
        acct.available = add(acct.available, amount)?;
        let total = add(self.totals.available_collateral, amount)?;
        self.store_account(id, acct);
        self.totals.available_collateral = total;
        self.assert_invariants();
        Ok(())
    }

    /// available collateral -> market backing; mints `amount` YES and NO.
    pub(crate) fn apply_split(&mut self, id: &AccountId, amount: u128) -> Res<()> {
        if amount == 0 {
            return Err(ERR_ZERO_AMOUNT);
        }
        let mut acct = self.load_account(id)?;
        acct.available = sub(acct.available, amount, ERR_INSUFFICIENT_COLLATERAL)?;
        acct.yes = add(acct.yes, amount)?;
        acct.no = add(acct.no, amount)?;
        let t = &self.totals;
        let available = sub(t.available_collateral, amount, ERR_UNDERFLOW)?;
        let backing = add(t.market_backing, amount)?;
        let yes = add(t.outstanding_yes, amount)?;
        let no = add(t.outstanding_no, amount)?;
        self.store_account(id, acct);
        let t = &mut self.totals;
        t.available_collateral = available;
        t.market_backing = backing;
        t.outstanding_yes = yes;
        t.outstanding_no = no;
        self.assert_invariants();
        Ok(())
    }

    /// Burns `amount` YES and `amount` NO; market backing -> available collateral.
    pub(crate) fn apply_merge(&mut self, id: &AccountId, amount: u128) -> Res<()> {
        if amount == 0 {
            return Err(ERR_ZERO_AMOUNT);
        }
        let mut acct = self.load_account(id)?;
        acct.yes = sub(acct.yes, amount, ERR_INSUFFICIENT_SHARES)?;
        acct.no = sub(acct.no, amount, ERR_INSUFFICIENT_SHARES)?;
        acct.available = add(acct.available, amount)?;
        let t = &self.totals;
        let available = add(t.available_collateral, amount)?;
        let backing = sub(t.market_backing, amount, ERR_UNDERFLOW)?;
        let yes = sub(t.outstanding_yes, amount, ERR_UNDERFLOW)?;
        let no = sub(t.outstanding_no, amount, ERR_UNDERFLOW)?;
        self.store_account(id, acct);
        let t = &mut self.totals;
        t.available_collateral = available;
        t.market_backing = backing;
        t.outstanding_yes = yes;
        t.outstanding_no = no;
        self.assert_invariants();
        Ok(())
    }

    /// Debits `amount` and records the single pending withdrawal for `id`.
    pub(crate) fn apply_begin_withdrawal(
        &mut self,
        id: &AccountId,
        amount: u128,
        now_ns: u64,
    ) -> Res<PendingWithdrawal> {
        if amount == 0 {
            return Err(ERR_ZERO_AMOUNT);
        }
        let mut acct = self.load_account(id)?;
        if self.withdrawals.contains_key(id) {
            return Err(ERR_PENDING_WITHDRAWAL);
        }
        acct.available = sub(acct.available, amount, ERR_INSUFFICIENT_COLLATERAL)?;
        let available = sub(self.totals.available_collateral, amount, ERR_UNDERFLOW)?;
        let pending_total = add(self.totals.pending_withdrawals, amount)?;
        let wid = self.next_withdrawal_id.checked_add(1).ok_or(ERR_OVERFLOW)?;
        let record = PendingWithdrawal {
            id: wid,
            receiver_id: id.clone(),
            amount,
            requested_at_ns: now_ns,
        };
        self.store_account(id, acct);
        self.withdrawals.insert(id.clone(), record.clone());
        self.next_withdrawal_id = wid;
        self.totals.available_collateral = available;
        self.totals.pending_withdrawals = pending_total;
        self.assert_invariants();
        Ok(record)
    }

    /// Settles the pending withdrawal using a VERIFIED transfer result.
    /// `transferred = true`: finalize. `false`: restore `amount` to the
    /// account's CURRENT available balance (never a stale snapshot). Outcome
    /// shares are never touched. Removing the record makes replays fail.
    pub(crate) fn apply_settle_withdrawal(
        &mut self,
        id: &AccountId,
        withdrawal_id: u64,
        transferred: bool,
    ) -> Res<PendingWithdrawal> {
        let pending = self
            .withdrawals
            .get(id)
            .cloned()
            .ok_or(ERR_NO_PENDING_WITHDRAWAL)?;
        if pending.id != withdrawal_id {
            return Err(ERR_WRONG_WITHDRAWAL_ID);
        }
        let mut acct = self.load_account(id)?;
        let pending_total = sub(
            self.totals.pending_withdrawals,
            pending.amount,
            ERR_UNDERFLOW,
        )?;
        let mut available = self.totals.available_collateral;
        if transferred {
            acct.last_withdrawal_outcome = SettlementOutcome::Completed;
        } else {
            acct.available = add(acct.available, pending.amount)?;
            available = add(available, pending.amount)?;
            acct.last_withdrawal_outcome = SettlementOutcome::FailedRestored;
        }
        acct.last_withdrawal_id = pending.id;
        acct.last_withdrawal_amount = pending.amount;
        self.store_account(id, acct);
        self.withdrawals.remove(id);
        self.totals.pending_withdrawals = pending_total;
        self.totals.available_collateral = available;
        self.assert_invariants();
        Ok(pending)
    }

    /// Cheap O(1) checks. Per-account sums cannot be re-added without
    /// iterating accounts, so tests compare the counters with the accounts
    /// they know about.
    pub(crate) fn assert_invariants(&self) {
        let t = &self.totals;
        // Unresolved, split-and-merge-only milestone: one backing unit per
        // YES share and per NO share. NOT a post-resolution invariant.
        near_sdk::require!(
            t.market_backing == t.outstanding_yes && t.market_backing == t.outstanding_no,
            ERR_INVARIANT
        );
    }
}
