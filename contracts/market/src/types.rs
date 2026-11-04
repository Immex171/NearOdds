//! Public JSON shapes. Amounts are `U128` (decimal strings, base units);
//! timestamps are `U64` (nanoseconds); native NEAR amounts are yoctoNEAR.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, NearToken};

use crate::state::{Outcome, SettlementOutcome, Side};

#[near(serializers=[json])]
pub struct ConfigView {
    pub schema_version: u32,
    pub collateral_token_id: AccountId,
    /// Trusted account that can resolve the market (manually resolved MVP).
    pub resolver_id: AccountId,
    /// Plain-language trust model, constant.
    pub resolution_model: String,
    pub market_id: String,
    /// The only accepted `ft_transfer_call` msg.
    pub deposit_msg: String,
    pub decimals: u8,
    /// yoctoNEAR charged by `storage_deposit` for one account.
    pub storage_cost_per_account: NearToken,
    pub trading: TradingParams,
}

/// Trading precision and limits. All integers are decimal strings except
/// `max_open_offers_per_account` and `fee_bps`.
#[near(serializers=[json])]
pub struct TradingParams {
    /// Share base units per whole share; also the divisor in `cost = q*p/price_scale`.
    pub price_scale: U128,
    pub price_tick: U128,
    pub min_price: U128,
    pub max_price: U128,
    /// Quantities must be multiples of this (share base units).
    pub quantity_lot: U128,
    pub min_order_quantity: U128,
    pub max_open_offers_per_account: u32,
    /// Trading fee in basis points. Always 0 in this milestone.
    pub fee_bps: u32,
}

#[near(serializers=[json])]
pub struct MarketView {
    pub market_id: String,
    pub question: String,
    pub rules: String,
    pub split_cutoff_ns: U64,
    /// True while `block_timestamp < split_cutoff_ns`.
    pub split_open: bool,
    /// Same cutoff as splitting: offers can be created/filled before it.
    pub trading_cutoff_ns: U64,
    /// `!resolved && block_timestamp < cutoff`.
    pub trading_open: bool,
    /// `Open` | `AwaitingResolution` | `Resolved`.
    pub status: MarketStatus,
    /// Cutoff passed and no result yet: the resolver may act.
    pub awaiting_resolution: bool,
    pub resolved: bool,
    /// Merging is allowed until resolution (including after the cutoff).
    pub merge_open: bool,
    pub resolver_id: AccountId,
    /// Where the resolver will check the outcome; fixed at creation.
    pub resolution_source: String,
    /// `Some` once resolved, else `null`.
    pub resolution: Option<ResolutionView>,
    pub collateral_token_id: AccountId,
    pub outstanding_yes: U128,
    pub outstanding_no: U128,
    pub market_backing: U128,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketStatus {
    Open,
    AwaitingResolution,
    Resolved,
}

#[near(serializers=[json])]
pub struct ResolutionView {
    /// Final outcome: `"Yes"` or `"No"`. One winning share pays exactly 1 collateral base unit per share base unit.
    pub outcome: Outcome,
    pub resolver_id: AccountId,
    pub resolved_at_ns: U64,
    pub evidence: String,
}

/// What `redeem` would do for an account right now. `payout` never includes
/// collateral released from the account's buy offers.
#[near(serializers=[json])]
pub struct RedemptionPreview {
    pub resolved: bool,
    pub outcome: Option<Outcome>,
    /// False when unresolved, unregistered or nothing remains (no shares, no offers).
    pub redeemable: bool,
    /// Open offers that `redeem` would cancel first (at most 10).
    pub offers_to_release: Vec<OfferView>,
    /// Collateral from unfilled buy offers (returned to available; NOT payout).
    pub released_collateral: U128,
    /// Shares from unfilled sell offers (returned to share balances, then settled).
    pub released_shares: U128,
    /// All winning shares after releasing offers (available + reserved).
    pub winning_shares: U128,
    pub losing_shares: U128,
    /// Collateral credited for winning shares (= winning_shares).
    pub payout: U128,
    /// Available collateral after `redeem`: available + released_collateral + payout.
    pub available_collateral_after: U128,
}

#[near(serializers=[json])]
pub struct RedeemResult {
    pub outcome: Outcome,
    pub winning_shares: U128,
    pub losing_shares: U128,
    /// Winning-share payout only.
    pub payout: U128,
    pub released_offers: Vec<CancelResult>,
    pub released_collateral: U128,
    pub released_shares: U128,
    /// Account state after settlement (shares are zero).
    pub available_collateral: U128,
    pub yes: U128,
    pub no: U128,
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
    /// Spendable / withdrawable collateral.
    pub available_collateral: U128,
    /// Collateral locked behind open Buy offers.
    pub reserved_collateral: U128,
    /// AVAILABLE shares (can be offered, merged).
    pub yes: U128,
    pub no: U128,
    /// Shares locked behind open Sell offers.
    pub reserved_yes: U128,
    pub reserved_no: U128,
    pub open_offer_ids: Vec<U64>,
    pub pending_withdrawal: Option<WithdrawalView>,
}

#[near(serializers=[json])]
pub struct PositionView {
    pub account_id: AccountId,
    pub market_id: String,
    /// Available shares.
    pub yes: U128,
    pub no: U128,
    pub reserved_yes: U128,
    pub reserved_no: U128,
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
    pub reserved_collateral: U128,
    pub reserved_yes: U128,
    pub reserved_no: U128,
    pub open_offers: U64,
    /// `available_collateral + reserved_collateral + market_backing`. After all
    /// async operations settle, the token contract's balance of this account
    /// must be >= this.
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

/// Derived lifecycle shown by views. Fully filled and cancelled offers are
/// removed from storage, so they never appear here (see docs).
#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OfferStatus {
    Open,
    PartiallyFilled,
    /// Expiry passed or trading closed. Cannot be filled; the owner can still cancel.
    Expired,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FillStatus {
    PartiallyFilled,
    Filled,
}

#[near(serializers=[json])]
pub struct OfferView {
    /// Opaque id.
    pub offer_id: U64,
    pub market_id: String,
    pub owner_id: AccountId,
    pub outcome: Outcome,
    pub side: Side,
    /// Collateral base units per whole share.
    pub price: U128,
    /// Original quantity (share base units).
    pub quantity: U128,
    pub filled_quantity: U128,
    pub remaining_quantity: U128,
    /// Collateral still locked (Buy offers), else "0".
    pub reserved_collateral: U128,
    /// Shares still locked (Sell offers), else "0".
    pub reserved_shares: U128,
    pub expires_at_ns: Option<U64>,
    pub created_at_ns: U64,
    pub status: OfferStatus,
    /// True when a fill would currently be accepted (status is not Expired).
    pub fillable: bool,
}

#[near(serializers=[json])]
pub struct FillResult {
    pub offer_id: U64,
    /// Share base units exchanged.
    pub quantity: U128,
    /// Collateral base units exchanged (exact).
    pub collateral_amount: U128,
    pub remaining_quantity: U128,
    pub status: FillStatus,
}

#[near(serializers=[json])]
pub struct CancelResult {
    pub offer_id: U64,
    pub remaining_quantity: U128,
    pub released_collateral: U128,
    pub released_shares: U128,
}
