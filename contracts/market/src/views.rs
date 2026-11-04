//! Read-only methods. `get_totals` is INTERNAL accounting, not a token balance.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, NearToken};

use crate::state::ContractExt;
use crate::state::{Contract, SettlementOutcome, SCHEMA_VERSION};
use crate::storage::storage_cost;
use crate::types::*;

pub const DEPOSIT_MSG: &str = "deposit";
pub const DECIMALS: u8 = 6;

#[near]
impl Contract {
    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            schema_version: self.schema_version.max(SCHEMA_VERSION),
            collateral_token_id: self.collateral_token.clone(),
            market_id: self.market.id.clone(),
            deposit_msg: DEPOSIT_MSG.to_string(),
            decimals: DECIMALS,
            storage_cost_per_account: storage_cost(),
        }
    }

    pub fn get_market(&self, market_id: String) -> MarketView {
        self.require_market(&market_id);
        MarketView {
            market_id: self.market.id.clone(),
            question: self.market.question.clone(),
            rules: self.market.rules.clone(),
            split_cutoff_ns: U64(self.market.split_cutoff_ns),
            split_open: env::block_timestamp() < self.market.split_cutoff_ns,
            collateral_token_id: self.collateral_token.clone(),
            outstanding_yes: U128(self.totals.outstanding_yes),
            outstanding_no: U128(self.totals.outstanding_no),
            market_backing: U128(self.totals.market_backing),
        }
    }

    /// `None` if the account is not registered.
    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        let a = self.accounts.get(&account_id)?;
        Some(AccountView {
            storage_deposit: NearToken::from_yoctonear(a.storage_deposit),
            available_collateral: U128(a.available),
            yes: U128(a.yes),
            no: U128(a.no),
            pending_withdrawal: self.get_withdrawal(account_id.clone()),
            account_id,
        })
    }

    /// Zero balances for unregistered accounts. Panics on an unknown market.
    pub fn get_position(&self, account_id: AccountId, market_id: String) -> PositionView {
        self.require_market(&market_id);
        let (yes, no) = self
            .accounts
            .get(&account_id)
            .map(|a| (a.yes, a.no))
            .unwrap_or((0, 0));
        PositionView {
            account_id,
            market_id,
            yes: U128(yes),
            no: U128(no),
        }
    }

    pub fn get_totals(&self) -> TotalsView {
        let t = &self.totals;
        TotalsView {
            available_collateral: U128(t.available_collateral),
            market_backing: U128(t.market_backing),
            outstanding_yes: U128(t.outstanding_yes),
            outstanding_no: U128(t.outstanding_no),
            pending_withdrawals: U128(t.pending_withdrawals),
            registered_accounts: U64(t.registered_accounts),
            // Saturates at u128::MAX (unreachable with a real u128 token supply).
            settled_escrow_requirement: U128(
                t.available_collateral.saturating_add(t.market_backing),
            ),
        }
    }

    /// The pending withdrawal if one exists, otherwise the account's most
    /// recent settled one (bounded: only the last is kept), otherwise `None`.
    pub fn get_withdrawal(&self, account_id: AccountId) -> Option<WithdrawalView> {
        if let Some(p) = self.withdrawals.get(&account_id) {
            return Some(WithdrawalView {
                withdrawal_id: U64(p.id),
                receiver_id: Some(p.receiver_id.clone()),
                amount: U128(p.amount),
                status: WithdrawalStatus::Pending,
            });
        }
        let a = self.accounts.get(&account_id)?;
        let status: Option<WithdrawalStatus> = a.last_withdrawal_outcome.into();
        if a.last_withdrawal_outcome == SettlementOutcome::None {
            return None;
        }
        Some(WithdrawalView {
            withdrawal_id: U64(a.last_withdrawal_id),
            receiver_id: None,
            amount: U128(a.last_withdrawal_amount),
            status: status?,
        })
    }
}
