//! Versioned NEP-297 events, standard `nearodds_market`.
//!
//! Amounts are decimal strings in base units. A `withdrawal_requested` event
//! does NOT mean the wallet was paid; indexers must look at the finalized
//! receipts and at `withdrawal_completed` / `withdrawal_failed_restored`.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use crate::state::{Outcome, Side};

#[near(event_json(standard = "nearodds_market"))]
pub enum MarketEvent {
    #[event_version("1.0.0")]
    StorageRegistered {
        account_id: AccountId,
        payer_id: AccountId,
        storage_deposit_yocto: U128,
    },
    #[event_version("1.0.0")]
    Deposit {
        account_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    Split {
        account_id: AccountId,
        market_id: String,
        amount: U128,
    },
    #[event_version("1.0.0")]
    Merge {
        account_id: AccountId,
        market_id: String,
        amount: U128,
    },
    #[event_version("1.0.0")]
    WithdrawalRequested {
        account_id: AccountId,
        withdrawal_id: U64,
        receiver_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    WithdrawalCompleted {
        account_id: AccountId,
        withdrawal_id: U64,
        amount: U128,
    },
    #[event_version("1.0.0")]
    WithdrawalFailedRestored {
        account_id: AccountId,
        withdrawal_id: U64,
        amount: U128,
    },
    /// A fully funded offer was created. `reserved_collateral` (Buy) or
    /// `reserved_shares` (Sell) is what was locked.
    #[event_version("1.0.0")]
    OfferCreated {
        offer_id: U64,
        owner_id: AccountId,
        market_id: String,
        outcome: Outcome,
        side: Side,
        price: U128,
        quantity: U128,
        expires_at_ns: Option<U64>,
        reserved_collateral: U128,
        reserved_shares: U128,
    },
    /// `quantity` shares moved against `collateral_amount` at `price`.
    /// `maker_side` is the offer's side. `remaining_quantity == 0` means the
    /// offer is now fully filled and removed.
    #[event_version("1.0.0")]
    OfferFilled {
        offer_id: U64,
        maker_id: AccountId,
        taker_id: AccountId,
        market_id: String,
        outcome: Outcome,
        maker_side: Side,
        price: U128,
        quantity: U128,
        collateral_amount: U128,
        remaining_quantity: U128,
    },
    /// The unfilled remainder was released and the offer removed.
    #[event_version("1.0.0")]
    OfferCancelled {
        offer_id: U64,
        owner_id: AccountId,
        market_id: String,
        outcome: Outcome,
        side: Side,
        remaining_quantity: U128,
        released_collateral: U128,
        released_shares: U128,
    },
    /// The trusted resolver set the final outcome. Irrevocable.
    #[event_version("1.0.0")]
    MarketResolved {
        market_id: String,
        outcome: Outcome,
        resolver_id: AccountId,
        resolved_at_ns: U64,
        evidence: String,
    },
    /// A resolved position was settled into the internal available balance.
    /// `payout` is ONLY the winning-share payout; collateral released from
    /// cancelled buy offers is reported separately (and each cancelled offer
    /// also emitted its own `offer_cancelled` event just before this one).
    #[event_version("1.0.0")]
    PositionRedeemed {
        account_id: AccountId,
        market_id: String,
        outcome: Outcome,
        winning_shares: U128,
        losing_shares: U128,
        payout: U128,
        released_offers: u32,
        released_collateral: U128,
        released_shares: U128,
    },
}
