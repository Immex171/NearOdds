//! Trusted-resolver resolution and redemption (Milestone 3).
//!
//! MVP trust model: ONE configured resolver account (fixed at `new`) sets the
//! final YES or NO once, after the cutoff, with a bounded evidence reference.
//! The contract cannot verify the evidence; it only records it. VOID /
//! invalid settlement, disputes, challenge periods and fractional payouts are
//! deliberately NOT supported. Use clearly resolvable markets.
//!
//! Units: a winning share pays exactly 1 collateral base unit per share base
//! unit (1 whole share -> 1 whole collateral token). Losing shares pay zero.
//! Redemption credits the INTERNAL available balance; users withdraw through
//! the existing `withdraw`. There is no admin sweep of unclaimed collateral.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require};

use crate::errors::*;
use crate::events::MarketEvent;
use crate::state::ContractExt;
use crate::state::{Contract, Outcome, Resolution};
use crate::types::{CancelResult, RedeemResult, RedemptionPreview, ResolutionView};

pub const MAX_EVIDENCE_BYTES: usize = 512;

#[near]
impl Contract {
    /// Sets the final outcome. Only the configured resolver, only at or after
    /// the cutoff, only once. `evidence` is a 1..=512 byte reference (URL, hash
    /// or note); it is recorded, not verified. Requires exactly 1 yoctoNEAR.
    /// Afterwards offers, fills, splitting and merging are blocked; cancelling,
    /// redeeming, depositing and withdrawing remain available.
    #[payable]
    pub fn resolve_market(
        &mut self,
        market_id: String,
        outcome: Outcome,
        evidence: String,
    ) -> ResolutionView {
        assert_one_yocto();
        self.require_market(&market_id);
        let caller = env::predecessor_account_id();
        require!(caller == self.resolver, ERR_NOT_RESOLVER);
        require!(self.resolution.is_none(), ERR_ALREADY_RESOLVED);
        let now = env::block_timestamp();
        require!(now >= self.market.split_cutoff_ns, ERR_RESOLVE_TOO_EARLY);
        require!(
            !evidence.trim().is_empty() && evidence.len() <= MAX_EVIDENCE_BYTES,
            ERR_BAD_EVIDENCE
        );
        let resolution = Resolution {
            outcome,
            resolver: caller.clone(),
            resolved_at_ns: now,
            evidence: evidence.clone(),
        };
        self.resolution = Some(resolution);
        self.assert_invariants();
        MarketEvent::MarketResolved {
            market_id,
            outcome,
            resolver_id: caller.clone(),
            resolved_at_ns: U64(now),
            evidence: evidence.clone(),
        }
        .emit();
        ResolutionView {
            outcome,
            resolver_id: caller,
            resolved_at_ns: U64(now),
            evidence,
        }
    }

    /// Settles the caller's position after resolution, atomically:
    /// cancels all of the caller's open offers (releasing Buy collateral and
    /// Sell shares), burns all YES/NO shares, and credits the winning shares
    /// 1:1 to `available_collateral` while reducing market backing by exactly
    /// that payout. `payout` is the winning-share payout ONLY; released offer
    /// collateral is reported separately and credited separately (once).
    /// Fails with "nothing to redeem" if the caller has no shares and no
    /// offers (e.g. a repeat call). Requires exactly 1 yoctoNEAR; no token
    /// transfer happens (call `withdraw` afterwards).
    #[payable]
    pub fn redeem(&mut self, market_id: String) -> RedeemResult {
        assert_one_yocto();
        self.require_market(&market_id);
        let account_id = env::predecessor_account_id();
        let out = self
            .apply_redeem(&account_id)
            .unwrap_or_else(|e| env::panic_str(e));
        let mut released_offers = Vec::with_capacity(out.released.len());
        for r in &out.released {
            let remaining = r.offer.quantity - r.offer.filled;
            MarketEvent::OfferCancelled {
                offer_id: U64(r.offer.id),
                owner_id: account_id.clone(),
                market_id: market_id.clone(),
                outcome: r.offer.outcome,
                side: r.offer.side,
                remaining_quantity: U128(remaining),
                released_collateral: U128(r.released_collateral),
                released_shares: U128(r.released_shares),
            }
            .emit();
            released_offers.push(CancelResult {
                offer_id: U64(r.offer.id),
                remaining_quantity: U128(remaining),
                released_collateral: U128(r.released_collateral),
                released_shares: U128(r.released_shares),
            });
        }
        MarketEvent::PositionRedeemed {
            account_id,
            market_id,
            outcome: out.outcome,
            winning_shares: U128(out.winning_shares),
            losing_shares: U128(out.losing_shares),
            payout: U128(out.payout),
            released_offers: out.released.len() as u32,
            released_collateral: U128(out.released_collateral),
            released_shares: U128(out.released_shares),
        }
        .emit();
        RedeemResult {
            outcome: out.outcome,
            winning_shares: U128(out.winning_shares),
            losing_shares: U128(out.losing_shares),
            payout: U128(out.payout),
            released_offers,
            released_collateral: U128(out.released_collateral),
            released_shares: U128(out.released_shares),
            available_collateral: U128(out.available_after),
            yes: U128(out.yes_after),
            no: U128(out.no_after),
        }
    }

    /// Read-only preview of `redeem` for an account: which offers it would
    /// release, the payout, and the resulting available balance.
    pub fn get_redemption_preview(&self, account_id: near_sdk::AccountId) -> RedemptionPreview {
        let now = env::block_timestamp();
        let empty = |resolved, outcome| RedemptionPreview {
            resolved,
            outcome,
            redeemable: false,
            offers_to_release: vec![],
            released_collateral: U128(0),
            released_shares: U128(0),
            winning_shares: U128(0),
            losing_shares: U128(0),
            payout: U128(0),
            available_collateral_after: U128(0),
        };
        let Some(res) = &self.resolution else {
            return empty(false, None);
        };
        let Some(a) = self.accounts.get(&account_id) else {
            return empty(true, Some(res.outcome));
        };
        let offers = self.get_account_offers(account_id);
        let released_collateral: u128 = offers.iter().map(|o| o.reserved_collateral.0).sum();
        let released_shares: u128 = offers.iter().map(|o| o.reserved_shares.0).sum();
        let (yes, no) = (a.yes + a.yes_reserved, a.no + a.no_reserved);
        let (winning, losing) = match res.outcome {
            Outcome::Yes => (yes, no),
            Outcome::No => (no, yes),
        };
        let _ = now;
        RedemptionPreview {
            resolved: true,
            outcome: Some(res.outcome),
            redeemable: !offers.is_empty() || winning > 0 || losing > 0,
            offers_to_release: offers,
            released_collateral: U128(released_collateral),
            released_shares: U128(released_shares),
            winning_shares: U128(winning),
            losing_shares: U128(losing),
            payout: U128(winning),
            available_collateral_after: U128(
                a.available
                    .saturating_add(released_collateral)
                    .saturating_add(winning),
            ),
        }
    }
}
