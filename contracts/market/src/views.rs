//! Read-only methods. `get_totals` is INTERNAL accounting, not a token balance.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, NearToken};

use crate::offers::{
    bucket, offer_cost, MAX_OPEN_OFFERS, MAX_PRICE, MIN_ORDER_QUANTITY, MIN_PRICE, PRICE_SCALE,
    PRICE_TICK, QUANTITY_LOT,
};
use crate::state::ContractExt;
use crate::state::{Contract, Offer, Outcome, SettlementOutcome, Side, SCHEMA_VERSION};
use crate::storage::storage_cost;
use crate::types::*;

pub const DEPOSIT_MSG: &str = "deposit";
pub const DECIMALS: u8 = 6;
pub const RESOLUTION_MODEL: &str = "manual-trusted-resolver: one configured account sets a final YES or NO after the cutoff; VOID and disputes are not supported";

#[near]
impl Contract {
    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            schema_version: self.schema_version.max(SCHEMA_VERSION),
            collateral_token_id: self.collateral_token.clone(),
            resolver_id: self.resolver.clone(),
            resolution_model: RESOLUTION_MODEL.to_string(),
            market_id: self.market.id.clone(),
            deposit_msg: DEPOSIT_MSG.to_string(),
            decimals: DECIMALS,
            storage_cost_per_account: storage_cost(),
            trading: TradingParams {
                price_scale: U128(PRICE_SCALE),
                price_tick: U128(PRICE_TICK),
                min_price: U128(MIN_PRICE),
                max_price: U128(MAX_PRICE),
                quantity_lot: U128(QUANTITY_LOT),
                min_order_quantity: U128(MIN_ORDER_QUANTITY),
                max_open_offers_per_account: MAX_OPEN_OFFERS as u32,
                fee_bps: 0,
            },
        }
    }

    pub fn get_market(&self, market_id: String) -> MarketView {
        self.require_market(&market_id);
        MarketView {
            market_id: self.market.id.clone(),
            question: self.market.question.clone(),
            rules: self.market.rules.clone(),
            split_cutoff_ns: U64(self.market.split_cutoff_ns),
            split_open: self.trading_open(env::block_timestamp()),
            trading_cutoff_ns: U64(self.market.split_cutoff_ns),
            trading_open: self.trading_open(env::block_timestamp()),
            status: self.market_status(env::block_timestamp()),
            awaiting_resolution: self.market_status(env::block_timestamp())
                == MarketStatus::AwaitingResolution,
            resolved: self.resolution.is_some(),
            merge_open: self.resolution.is_none(),
            resolver_id: self.resolver.clone(),
            resolution_source: self.market.resolution_source.clone(),
            resolution: self.resolution.as_ref().map(|r| ResolutionView {
                outcome: r.outcome,
                resolver_id: r.resolver.clone(),
                resolved_at_ns: U64(r.resolved_at_ns),
                evidence: r.evidence.clone(),
            }),
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
            reserved_collateral: U128(a.reserved_collateral),
            yes: U128(a.yes),
            no: U128(a.no),
            reserved_yes: U128(a.yes_reserved),
            reserved_no: U128(a.no_reserved),
            open_offer_ids: a.open_offers.iter().map(|i| U64(*i)).collect(),
            pending_withdrawal: self.get_withdrawal(account_id.clone()),
            account_id,
        })
    }

    /// Zero balances for unregistered accounts. Panics on an unknown market.
    pub fn get_position(&self, account_id: AccountId, market_id: String) -> PositionView {
        self.require_market(&market_id);
        let (yes, no, ryes, rno) = self
            .accounts
            .get(&account_id)
            .map(|a| (a.yes, a.no, a.yes_reserved, a.no_reserved))
            .unwrap_or((0, 0, 0, 0));
        PositionView {
            account_id,
            market_id,
            yes: U128(yes),
            no: U128(no),
            reserved_yes: U128(ryes),
            reserved_no: U128(rno),
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
            reserved_collateral: U128(t.reserved_collateral),
            reserved_yes: U128(t.reserved_yes),
            reserved_no: U128(t.reserved_no),
            open_offers: U64(t.open_offers),
            // Saturates at u128::MAX (unreachable with a real u128 token supply).
            settled_escrow_requirement: U128(
                t.available_collateral
                    .saturating_add(t.reserved_collateral)
                    .saturating_add(t.market_backing),
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

    /// `None` if the offer never existed, or was fully filled or cancelled.
    pub fn get_offer(&self, offer_id: U64) -> Option<OfferView> {
        let o = self.offers[crate::offers::bucket_of_id(offer_id.0)].get(&offer_id.0)?;
        Some(self.offer_view(o, env::block_timestamp()))
    }

    /// Open offers of one (outcome, side) bucket in insertion-slot order (NOT
    /// sorted by price; the client sorts). `from_index` defaults to 0, `limit`
    /// to 20 and is capped at 50. Page by increasing `from_index` until the
    /// result has fewer than `limit` items.
    pub fn list_offers(
        &self,
        market_id: String,
        outcome: Outcome,
        side: Side,
        from_index: Option<U64>,
        limit: Option<u64>,
    ) -> Vec<OfferView> {
        self.require_market(&market_id);
        let now = env::block_timestamp();
        let limit = limit.unwrap_or(20).min(50) as usize;
        let from = from_index.map(|i| i.0).unwrap_or(0) as usize;
        self.offers[bucket(outcome, side) as usize]
            .iter()
            .skip(from)
            .take(limit)
            .map(|(_, o)| self.offer_view(o, now))
            .collect()
    }

    /// All open offers of an account (at most 10).
    pub fn get_account_offers(&self, account_id: AccountId) -> Vec<OfferView> {
        let now = env::block_timestamp();
        self.accounts
            .get(&account_id)
            .map(|a| {
                a.open_offers
                    .iter()
                    .filter_map(|id| {
                        self.offers[crate::offers::bucket_of_id(*id)]
                            .get(id)
                            .map(|o| self.offer_view(o, now))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Contract {
    pub(crate) fn market_status(&self, now_ns: u64) -> MarketStatus {
        if self.resolution.is_some() {
            MarketStatus::Resolved
        } else if now_ns < self.market.split_cutoff_ns {
            MarketStatus::Open
        } else {
            MarketStatus::AwaitingResolution
        }
    }

    pub(crate) fn offer_view(&self, o: &Offer, now_ns: u64) -> OfferView {
        let remaining = o.quantity - o.filled;
        let expired =
            !self.trading_open(now_ns) || (o.expires_at_ns != 0 && now_ns >= o.expires_at_ns);
        let (rc, rs) = match o.side {
            Side::Buy => (offer_cost(remaining, o.price).unwrap_or(0), 0),
            Side::Sell => (0, remaining),
        };
        OfferView {
            offer_id: U64(o.id),
            market_id: self.market.id.clone(),
            owner_id: o.owner.clone(),
            outcome: o.outcome,
            side: o.side,
            price: U128(o.price),
            quantity: U128(o.quantity),
            filled_quantity: U128(o.filled),
            remaining_quantity: U128(remaining),
            reserved_collateral: U128(rc),
            reserved_shares: U128(rs),
            expires_at_ns: (o.expires_at_ns != 0).then_some(U64(o.expires_at_ns)),
            created_at_ns: U64(o.created_at_ns),
            status: if expired {
                OfferStatus::Expired
            } else if o.filled > 0 {
                OfferStatus::PartiallyFilled
            } else {
                OfferStatus::Open
            },
            fillable: !expired,
        }
    }
}
