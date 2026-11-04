//! The ONLY place balances change. Every operation validates and computes the
//! complete new state first, then commits, so a failed check mutates nothing.
//! (A panic also reverts the whole receipt on-chain.)
//!
//! No function here iterates over accounts.

use near_sdk::AccountId;

use crate::errors::*;
use crate::offers::{
    bucket, bucket_of_id, offer_cost, MAX_OPEN_OFFERS, MAX_PRICE, MIN_ORDER_QUANTITY, MIN_PRICE,
    PRICE_TICK, QUANTITY_LOT,
};
use crate::state::{
    Account, Contract, Offer, Outcome, PendingWithdrawal, SettlementOutcome, Side, Totals,
};

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
        // Reserved shares are part of supply, never in addition to it.
        near_sdk::require!(
            t.reserved_yes <= t.outstanding_yes && t.reserved_no <= t.outstanding_no,
            ERR_INVARIANT
        );
    }
}

fn avail_mut(a: &mut Account, o: Outcome) -> &mut u128 {
    match o {
        Outcome::Yes => &mut a.yes,
        Outcome::No => &mut a.no,
    }
}

fn reserved_mut(a: &mut Account, o: Outcome) -> &mut u128 {
    match o {
        Outcome::Yes => &mut a.yes_reserved,
        Outcome::No => &mut a.no_reserved,
    }
}

fn total_reserved_mut(t: &mut Totals, o: Outcome) -> &mut u128 {
    match o {
        Outcome::Yes => &mut t.reserved_yes,
        Outcome::No => &mut t.reserved_no,
    }
}

/// Result of a (possibly partial) fill.
pub struct FillOutcome {
    /// The offer after the fill (`filled` updated).
    pub offer: Offer,
    /// Collateral base units exchanged (exact).
    pub cost: u128,
    pub fully_filled: bool,
}

/// What a cancellation released.
pub struct CancelOutcome {
    pub offer: Offer,
    pub released_collateral: u128,
    pub released_shares: u128,
}

// ---- trading ledger (Milestone 2): offers are fully funded at creation ----
impl Contract {
    pub(crate) fn trading_open(&self, now_ns: u64) -> bool {
        now_ns < self.market.split_cutoff_ns
    }

    fn find_offer(&self, id: u64) -> Res<Offer> {
        self.offers[bucket_of_id(id)]
            .get(&id)
            .cloned()
            .ok_or(ERR_OFFER_NOT_FOUND)
    }

    /// Reserves the maker's funds and records the offer.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn apply_create_offer(
        &mut self,
        owner: &AccountId,
        outcome: Outcome,
        side: Side,
        price: u128,
        quantity: u128,
        expires_at_ns: u64,
        now_ns: u64,
    ) -> Res<Offer> {
        if !self.trading_open(now_ns) {
            return Err(ERR_TRADING_CLOSED);
        }
        if !(MIN_PRICE..=MAX_PRICE).contains(&price) || !price.is_multiple_of(PRICE_TICK) {
            return Err(ERR_BAD_PRICE);
        }
        if quantity < MIN_ORDER_QUANTITY || !quantity.is_multiple_of(QUANTITY_LOT) {
            return Err(ERR_BAD_QUANTITY);
        }
        if expires_at_ns != 0 && expires_at_ns <= now_ns {
            return Err(ERR_BAD_EXPIRY);
        }
        let mut acct = self.load_account(owner)?;
        if acct.open_offers.len() >= MAX_OPEN_OFFERS {
            return Err(ERR_TOO_MANY_OFFERS);
        }
        let seq = self.next_offer_seq.checked_add(1).ok_or(ERR_OVERFLOW)?;
        if seq >= (1u64 << 62) {
            return Err(ERR_OVERFLOW);
        }
        let id = (seq << 2) | bucket(outcome, side) as u64;

        let mut totals = self.totals.clone();
        match side {
            Side::Sell => {
                let avail = avail_mut(&mut acct, outcome);
                *avail = sub(*avail, quantity, ERR_INSUFFICIENT_SHARES)?;
                let res = reserved_mut(&mut acct, outcome);
                *res = add(*res, quantity)?;
                let t = total_reserved_mut(&mut totals, outcome);
                *t = add(*t, quantity)?;
            }
            Side::Buy => {
                let cost = offer_cost(quantity, price)?;
                acct.available = sub(acct.available, cost, ERR_INSUFFICIENT_COLLATERAL)?;
                acct.reserved_collateral = add(acct.reserved_collateral, cost)?;
                totals.available_collateral =
                    sub(totals.available_collateral, cost, ERR_UNDERFLOW)?;
                totals.reserved_collateral = add(totals.reserved_collateral, cost)?;
            }
        }
        acct.open_offers.push(id);
        totals.open_offers = totals.open_offers.checked_add(1).ok_or(ERR_OVERFLOW)?;

        let offer = Offer {
            id,
            owner: owner.clone(),
            outcome,
            side,
            price,
            quantity,
            filled: 0,
            expires_at_ns,
            created_at_ns: now_ns,
        };
        self.store_account(owner, acct);
        self.offers[bucket_of_id(id)].insert(id, offer.clone());
        self.next_offer_seq = seq;
        self.totals = totals;
        self.assert_invariants();
        Ok(offer)
    }

    /// Exchanges existing shares and internal collateral atomically.
    /// Creates no shares and no collateral; backing is untouched.
    pub(crate) fn apply_fill_offer(
        &mut self,
        taker_id: &AccountId,
        offer_id: u64,
        quantity: u128,
        now_ns: u64,
    ) -> Res<FillOutcome> {
        let mut offer = self.find_offer(offer_id)?;
        if !self.trading_open(now_ns) {
            return Err(ERR_TRADING_CLOSED);
        }
        if offer.expires_at_ns != 0 && now_ns >= offer.expires_at_ns {
            return Err(ERR_OFFER_EXPIRED);
        }
        if quantity == 0 || !quantity.is_multiple_of(QUANTITY_LOT) {
            return Err(ERR_BAD_FILL_QUANTITY);
        }
        if &offer.owner == taker_id {
            return Err(ERR_SELF_TRADE);
        }
        let remaining = sub(offer.quantity, offer.filled, ERR_UNDERFLOW)?;
        if quantity > remaining {
            return Err(ERR_FILL_EXCEEDS_REMAINING);
        }
        let cost = offer_cost(quantity, offer.price)?;

        let mut maker = self.load_account(&offer.owner)?;
        let mut taker = self.load_account(taker_id)?;
        let mut totals = self.totals.clone();
        let o = offer.outcome;
        match offer.side {
            // Maker sells reserved shares; taker pays collateral.
            Side::Sell => {
                let res = reserved_mut(&mut maker, o);
                *res = sub(*res, quantity, ERR_INSUFFICIENT_RESERVE)?;
                let t = total_reserved_mut(&mut totals, o);
                *t = sub(*t, quantity, ERR_INSUFFICIENT_RESERVE)?;
                taker.available = sub(taker.available, cost, ERR_INSUFFICIENT_COLLATERAL)?;
                maker.available = add(maker.available, cost)?;
                let got = avail_mut(&mut taker, o);
                *got = add(*got, quantity)?;
            }
            // Maker buys with reserved collateral; taker gives shares.
            Side::Buy => {
                maker.reserved_collateral =
                    sub(maker.reserved_collateral, cost, ERR_INSUFFICIENT_RESERVE)?;
                totals.reserved_collateral =
                    sub(totals.reserved_collateral, cost, ERR_INSUFFICIENT_RESERVE)?;
                let give = avail_mut(&mut taker, o);
                *give = sub(*give, quantity, ERR_INSUFFICIENT_SHARES)?;
                let got = avail_mut(&mut maker, o);
                *got = add(*got, quantity)?;
                taker.available = add(taker.available, cost)?;
                totals.available_collateral = add(totals.available_collateral, cost)?;
            }
        }
        offer.filled = add(offer.filled, quantity)?;
        let fully_filled = offer.filled == offer.quantity;
        if fully_filled {
            maker.open_offers.retain(|x| *x != offer_id);
            totals.open_offers = totals.open_offers.saturating_sub(1);
        }

        let maker_id = offer.owner.clone();
        self.store_account(&maker_id, maker);
        self.store_account(taker_id, taker);
        if fully_filled {
            self.offers[bucket_of_id(offer_id)].remove(&offer_id);
        } else {
            self.offers[bucket_of_id(offer_id)].insert(offer_id, offer.clone());
        }
        self.totals = totals;
        self.assert_invariants();
        Ok(FillOutcome {
            offer,
            cost,
            fully_filled,
        })
    }

    /// Releases exactly the unfilled remainder of the owner's offer. Allowed
    /// at any time (including after expiry or the trading cutoff).
    pub(crate) fn apply_cancel_offer(
        &mut self,
        caller: &AccountId,
        offer_id: u64,
    ) -> Res<CancelOutcome> {
        let offer = self.find_offer(offer_id)?;
        if &offer.owner != caller {
            return Err(ERR_NOT_OFFER_OWNER);
        }
        let remaining = sub(offer.quantity, offer.filled, ERR_UNDERFLOW)?;
        let mut owner = self.load_account(caller)?;
        let mut totals = self.totals.clone();
        let (mut released_collateral, mut released_shares) = (0, 0);
        match offer.side {
            Side::Sell => {
                let res = reserved_mut(&mut owner, offer.outcome);
                *res = sub(*res, remaining, ERR_INSUFFICIENT_RESERVE)?;
                let avail = avail_mut(&mut owner, offer.outcome);
                *avail = add(*avail, remaining)?;
                let t = total_reserved_mut(&mut totals, offer.outcome);
                *t = sub(*t, remaining, ERR_INSUFFICIENT_RESERVE)?;
                released_shares = remaining;
            }
            Side::Buy => {
                let rc = offer_cost(remaining, offer.price)?;
                owner.reserved_collateral =
                    sub(owner.reserved_collateral, rc, ERR_INSUFFICIENT_RESERVE)?;
                owner.available = add(owner.available, rc)?;
                totals.reserved_collateral =
                    sub(totals.reserved_collateral, rc, ERR_INSUFFICIENT_RESERVE)?;
                totals.available_collateral = add(totals.available_collateral, rc)?;
                released_collateral = rc;
            }
        }
        owner.open_offers.retain(|x| *x != offer_id);
        totals.open_offers = totals.open_offers.saturating_sub(1);
        self.store_account(caller, owner);
        self.offers[bucket_of_id(offer_id)].remove(&offer_id);
        self.totals = totals;
        self.assert_invariants();
        Ok(CancelOutcome {
            offer,
            released_collateral,
            released_shares,
        })
    }
}
