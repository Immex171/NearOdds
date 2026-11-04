//! Public JSON shapes. Amounts are `U128` (decimal strings, base units);
//! timestamps are `U64` (nanoseconds); native NEAR amounts are yoctoNEAR.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, NearToken};

use crate::state::SettlementOutcome;

#[near(serializers=[json])]
pub struct ConfigView {
    pub schema_version: u32,
    pub collateral_token_id: AccountId,
    pub market_id: String,
    /// The only accepted `ft_transfer_call` msg.
    pub deposit_msg: String,
    pub decimals: u8,
    /// yoctoNEAR charged by `storage_deposit` for one account.
    pub storage_cost_per_account: NearToken,
}

#[near(serializers=[json])]
pub struct MarketView {
    pub market_id: String,
    pub question: String,
    pub rules: String,
    pub split_cutoff_ns: U64,
    /// True while `block_timestamp < split_cutoff_ns`.
    pub split_open: bool,
    pub collateral_token_id: AccountId,
    pub outstanding_yes: U128,
    pub outstanding_no: U128,
    pub market_backing: U128,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WithdrawalStatus {
    /// Transfer scheduled, callback not yet settled (or the callback failed).
    Pending,
    Completed,
    FailedRestored,
}

#[near(serializers=[json])]
pub struct WithdrawalView {
    pub withdrawal_id: U64,
    pub receiver_id: Option<AccountId>,
    pub amount: U128,
    pub status: WithdrawalStatus,
}

#[near(serializers=[json])]
pub struct AccountView {
    pub account_id: AccountId,
    pub storage_deposit: NearToken,
    pub available_collateral: U128,
    pub yes: U128,
    pub no: U128,
    pub pending_withdrawal: Option<WithdrawalView>,
}

#[near(serializers=[json])]
pub struct PositionView {
    pub account_id: AccountId,
    pub market_id: String,
    pub yes: U128,
    pub no: U128,
}

/// INTERNAL accounting counters. They are not a token balance: compare
/// `settled_escrow_requirement` with `ft_balance_of(market)` off-chain.
#[near(serializers=[json])]
pub struct TotalsView {
    pub available_collateral: U128,
    pub market_backing: U128,
    pub outstanding_yes: U128,
    pub outstanding_no: U128,
    /// Withdrawals scheduled but not settled (already removed from available).
    pub pending_withdrawals: U128,
    pub registered_accounts: U64,
    /// `available_collateral + market_backing`. After all async operations
    /// settle, the token contract's balance of this account must be >= this.
    pub settled_escrow_requirement: U128,
}

#[near(serializers=[json])]
pub struct StorageBalance {
    pub total: NearToken,
    pub available: NearToken,
}

#[near(serializers=[json])]
pub struct StorageBalanceBounds {
    pub min: NearToken,
    pub max: Option<NearToken>,
}

impl From<SettlementOutcome> for Option<WithdrawalStatus> {
    fn from(o: SettlementOutcome) -> Self {
        match o {
            SettlementOutcome::None => None,
            SettlementOutcome::Completed => Some(WithdrawalStatus::Completed),
            SettlementOutcome::FailedRestored => Some(WithdrawalStatus::FailedRestored),
        }
    }
}
