//! Fully funded, fixed-price onchain offers (Milestone 2).
//!
//! Units: prices are collateral base units per ONE whole share
//! (`PRICE_SCALE = 1_000_000` share base units). A fill of `q` share base units
//! at price `p` costs `q * p / PRICE_SCALE` collateral base units. With
//! `p` a multiple of `PRICE_TICK` (10_000) and `q` a multiple of
//! `QUANTITY_LOT` (100) that division is always exact:
//! `q*p = (100a)*(10_000b) = 1_000_000*a*b`. So many small fills cost exactly
//! the same as one large fill, there is no rounding, and no dust.
//!
//! Authorization is the same as Milestone 1: the account is always
//! `predecessor_account_id()` and exactly 1 yoctoNEAR must be attached (kept by
//! the contract; unrelated to collateral). No fees (zero) in this milestone.
//! No external calls: trading moves only internal ledger balances.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near};

use crate::balances::Res;
use crate::errors::*;
use crate::events::MarketEvent;
use crate::state::ContractExt;
use crate::state::{Contract, Outcome, Side};
use crate::types::{CancelResult, FillResult, OfferView};

pub const PRICE_SCALE: u128 = 1_000_000;
pub const PRICE_TICK: u128 = 10_000;
pub const MIN_PRICE: u128 = 10_000;
pub const MAX_PRICE: u128 = 990_000;
pub const QUANTITY_LOT: u128 = 100;
pub const MIN_ORDER_QUANTITY: u128 = 10_000;
pub const MAX_OPEN_OFFERS: usize = 10;

/// 0 = Yes/Sell, 1 = Yes/Buy, 2 = No/Sell, 3 = No/Buy.
pub fn bucket(outcome: Outcome, side: Side) -> u8 {
    match (outcome, side) {
        (Outcome::Yes, Side::Sell) => 0,
        (Outcome::Yes, Side::Buy) => 1,
        (Outcome::No, Side::Sell) => 2,
        (Outcome::No, Side::Buy) => 3,
    }
}

/// Offer ids are `(sequence << 2) | bucket`; callers must treat them as opaque.
pub fn bucket_of_id(id: u64) -> usize {
    (id & 3) as usize
}

/// Exact collateral cost of `quantity` share base units at `price`.
pub fn offer_cost(quantity: u128, price: u128) -> Res<u128> {
    let product = quantity.checked_mul(price).ok_or(ERR_OVERFLOW)?;
    if !product.is_multiple_of(PRICE_SCALE) {
        return Err(ERR_INEXACT_COST);
    }
    Ok(product / PRICE_SCALE)
}

#[near]
impl Contract {
    /// Creates a fully funded offer and returns it.
    ///
    /// * `Sell`: reserves `quantity` of the caller's AVAILABLE `outcome` shares.
    /// * `Buy`: reserves `quantity * price / 1e6` of AVAILABLE collateral.
    /// * `price` must be a multiple of 10_000 in [10_000, 990_000];
    ///   `quantity` a multiple of 100 and >= 10_000 (share base units).
    /// * `expires_at_ns` (optional) must be in the future; trading also ends at
    ///   the market cutoff.
    ///
    /// Requires exactly 1 yoctoNEAR. Storage is prepaid at registration (max 10
    /// open offers per account).
    #[payable]
    pub fn create_offer(
        &mut self,
        market_id: String,
        outcome: Outcome,
        side: Side,
        price: U128,
        quantity: U128,
        expires_at_ns: Option<U64>,
    ) -> OfferView {
        assert_one_yocto();
        self.require_market(&market_id);
        let owner = env::predecessor_account_id();
        let now = env::block_timestamp();
        let offer = self
            .apply_create_offer(
                &owner,
                outcome,
                side,
                price.0,
                quantity.0,
                expires_at_ns.map(|t| t.0).unwrap_or(0),
                now,
            )
            .unwrap_or_else(|e| env::panic_str(e));
        let view = self.offer_view(&offer, now);
        MarketEvent::OfferCreated {
            offer_id: U64(offer.id),
            owner_id: owner,
            market_id,
            outcome,
            side,
            price,
            quantity,
            expires_at_ns,
            reserved_collateral: view.reserved_collateral,
            reserved_shares: view.reserved_shares,
        }
        .emit();
        view
    }

    /// Fills `quantity` share base units of an open offer (partial fills
    /// allowed, up to the remaining quantity). The caller is the taker: on a
    /// `Sell` offer they pay collateral and receive shares; on a `Buy` offer
    /// they give shares and receive collateral. Atomic, internal ledger only.
    /// Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn fill_offer(&mut self, offer_id: U64, quantity: U128) -> FillResult {
        assert_one_yocto();
        let taker = env::predecessor_account_id();
        let now = env::block_timestamp();
        let out = self
            .apply_fill_offer(&taker, offer_id.0, quantity.0, now)
            .unwrap_or_else(|e| env::panic_str(e));
        let remaining = out.offer.quantity - out.offer.filled;
        MarketEvent::OfferFilled {
            offer_id,
            maker_id: out.offer.owner.clone(),
            taker_id: taker,
            market_id: self.market.id.clone(),
            outcome: out.offer.outcome,
            maker_side: out.offer.side,
            price: U128(out.offer.price),
            quantity,
            collateral_amount: U128(out.cost),
            remaining_quantity: U128(remaining),
        }
        .emit();
        FillResult {
            offer_id,
            quantity,
            collateral_amount: U128(out.cost),
            remaining_quantity: U128(remaining),
            status: if out.fully_filled {
                crate::types::FillStatus::Filled
            } else {
                crate::types::FillStatus::PartiallyFilled
            },
        }
    }

    /// Maker-only. Releases exactly the unfilled remainder and removes the
    /// offer. Allowed at any time, including after expiry or the trading
    /// cutoff. Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn cancel_offer(&mut self, offer_id: U64) -> CancelResult {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let out = self
            .apply_cancel_offer(&caller, offer_id.0)
            .unwrap_or_else(|e| env::panic_str(e));
        let remaining = out.offer.quantity - out.offer.filled;
        MarketEvent::OfferCancelled {
            offer_id,
            owner_id: caller,
            market_id: self.market.id.clone(),
            outcome: out.offer.outcome,
            side: out.offer.side,
            remaining_quantity: U128(remaining),
            released_collateral: U128(out.released_collateral),
            released_shares: U128(out.released_shares),
        }
        .emit();
        CancelResult {
            offer_id,
            remaining_quantity: U128(remaining),
            released_collateral: U128(out.released_collateral),
            released_shares: U128(out.released_shares),
        }
    }
}
