//! Unit tests for Milestone 2 trading (offers, fills, cancellation).

use super::*;
use crate::state::{Outcome, Side};
use crate::types::{FillStatus, OfferStatus};
use std::panic::{catch_unwind, AssertUnwindSafe};

pub(super) const P60: u128 = 600_000;
pub(super) const P70: u128 = 700_000;
const EXPIRY_NONE: Option<U64> = None;

pub(super) fn offer(
    c: &mut Contract,
    who: &str,
    o: Outcome,
    s: Side,
    price: u128,
    qty: u128,
) -> crate::types::OfferView {
    set(who, 1, 10);
    c.create_offer(MID.into(), o, s, U128(price), U128(qty), EXPIRY_NONE)
}

pub(super) fn fill(c: &mut Contract, who: &str, id: u64, qty: u128) -> crate::types::FillResult {
    set(who, 1, 11);
    c.fill_offer(U64(id), U128(qty))
}

pub(super) fn cancel(c: &mut Contract, who: &str, id: u64) -> crate::types::CancelResult {
    set(who, 1, 12);
    c.cancel_offer(U64(id))
}

/// Runs `f` and asserts it panics with a message containing `needle`.
pub(super) fn fails<F: FnOnce()>(f: F, needle: &str) {
    let e = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    let msg = if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = e.downcast_ref::<&str>() {
        s.to_string()
    } else {
        String::new()
    };
    assert!(
        msg.contains(needle),
        "panic {msg:?} does not contain {needle:?}"
    );
}

pub(super) struct Bal {
    pub(super) avail: u128,
    pub(super) rcol: u128,
    pub(super) yes: u128,
    pub(super) ryes: u128,
    pub(super) no: u128,
    pub(super) rno: u128,
}
pub(super) fn bal(c: &Contract, who: &str) -> Bal {
    let a = c.get_account(acct(who)).unwrap();
    Bal {
        avail: a.available_collateral.0,
        rcol: a.reserved_collateral.0,
        yes: a.yes.0,
        ryes: a.reserved_yes.0,
        no: a.no.0,
        rno: a.reserved_no.0,
    }
}

pub(super) fn nothing_reserved(c: &Contract) {
    let t = c.get_totals();
    assert_eq!(t.reserved_collateral.0, 0);
    assert_eq!(t.reserved_yes.0, 0);
    assert_eq!(t.reserved_no.0, 0);
    assert_eq!(t.open_offers.0, 0);
}

/// Alice has 100 YES + 100 NO; Bob and Carol 10 collateral each.
pub(super) fn market_with_traders() -> Contract {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 100 * ONE);
    split(&mut c, "alice.test", 100 * ONE);
    fund(&mut c, "bob.test", 10 * ONE);
    fund(&mut c, "carol.test", 10 * ONE);
    c
}

// ---------- acceptance scenario ----------

#[test]
fn acceptance_scenario() {
    let mut c = market_with_traders();
    let o = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        20 * ONE,
    );
    assert_eq!(o.reserved_shares.0, 20 * ONE);
    assert_eq!(bal(&c, "alice.test").yes, 80 * ONE);
    assert_eq!(bal(&c, "alice.test").ryes, 20 * ONE);

    let r = fill(&mut c, "bob.test", o.offer_id.0, 8 * ONE);
    assert_eq!(r.collateral_amount.0, 4_800_000);
    assert_eq!(r.remaining_quantity.0, 12 * ONE);
    assert_eq!(r.status, FillStatus::PartiallyFilled);
    let r = fill(&mut c, "carol.test", o.offer_id.0, 5 * ONE);
    assert_eq!(r.collateral_amount.0, 3_000_000);
    assert_eq!(r.remaining_quantity.0, 7 * ONE);

    let x = cancel(&mut c, "alice.test", o.offer_id.0);
    assert_eq!(x.released_shares.0, 7 * ONE);
    assert_eq!(x.released_collateral.0, 0);

    // Bob resells 3 YES to Carol at 0.70.
    let resale = offer(&mut c, "bob.test", Outcome::Yes, Side::Sell, P70, 3 * ONE);
    let r = fill(&mut c, "carol.test", resale.offer_id.0, 3 * ONE);
    assert_eq!(r.collateral_amount.0, 2_100_000);
    assert_eq!(r.status, FillStatus::Filled);

    let (a, b, k) = (
        bal(&c, "alice.test"),
        bal(&c, "bob.test"),
        bal(&c, "carol.test"),
    );
    assert_eq!((a.avail, a.yes, a.no), (7_800_000, 87 * ONE, 100 * ONE));
    assert_eq!((b.avail, b.yes, b.no), (7_300_000, 5 * ONE, 0));
    assert_eq!((k.avail, k.yes, k.no), (4_900_000, 8 * ONE, 0));
    for x in [&a, &b, &k] {
        assert_eq!((x.rcol, x.ryes, x.rno), (0, 0, 0));
    }
    nothing_reserved(&c);
    let t = c.get_totals();
    assert_eq!(t.market_backing.0, 100 * ONE);
    assert_eq!(t.outstanding_yes.0, 100 * ONE);
    assert_eq!(t.outstanding_no.0, 100 * ONE);
    assert_eq!(t.available_collateral.0, 20 * ONE);
    assert_eq!(t.settled_escrow_requirement.0, 120 * ONE);
    // Share supply: 87 + 5 + 8 = 100 YES, no minting.
    assert_eq!(a.yes + b.yes + k.yes, 100 * ONE);
}

// ---------- sell side ----------

#[test]
fn sell_offer_multiple_partial_fills_then_cancel_remainder() {
    let mut c = market_with_traders();
    let o = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        10 * ONE,
    );
    let id = o.offer_id.0;
    fill(&mut c, "bob.test", id, 2 * ONE);
    assert_eq!(
        c.get_offer(U64(id)).unwrap().status,
        OfferStatus::PartiallyFilled
    );
    fill(&mut c, "carol.test", id, 3 * ONE);
    fill(&mut c, "bob.test", id, ONE);
    let v = c.get_offer(U64(id)).unwrap();
    assert_eq!(v.filled_quantity.0, 6 * ONE);
    assert_eq!(v.remaining_quantity.0, 4 * ONE);
    assert_eq!(bal(&c, "alice.test").ryes, 4 * ONE);
    let x = cancel(&mut c, "alice.test", id);
    assert_eq!(x.released_shares.0, 4 * ONE);
    let a = bal(&c, "alice.test");
    assert_eq!(
        (a.yes, a.ryes),
        (94 * ONE, 0),
        "only the unfilled 4 came back"
    );
    assert_eq!(a.avail, 3_600_000);
    assert_eq!(bal(&c, "bob.test").yes, 3 * ONE);
    assert_eq!(bal(&c, "carol.test").yes, 3 * ONE);
    assert!(c.get_offer(U64(id)).is_none());
    nothing_reserved(&c);
    assert_eq!(c.get_totals().market_backing.0, 100 * ONE);
}

#[test]
fn no_shares_are_supported_like_yes() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::No, Side::Sell, P70, 4 * ONE);
    assert_eq!(bal(&c, "alice.test").rno, 4 * ONE);
    assert_eq!(bal(&c, "alice.test").ryes, 0);
    fill(&mut c, "bob.test", o.offer_id.0, 4 * ONE);
    assert_eq!(bal(&c, "bob.test").no, 4 * ONE);
    assert_eq!(bal(&c, "bob.test").avail, 10 * ONE - 2_800_000);
    // Resell NO.
    let r = offer(&mut c, "bob.test", Outcome::No, Side::Sell, P60, 4 * ONE);
    fill(&mut c, "carol.test", r.offer_id.0, 4 * ONE);
    assert_eq!(bal(&c, "carol.test").no, 4 * ONE);
    assert_eq!(bal(&c, "carol.test").avail, 10 * ONE - 2_400_000);
    nothing_reserved(&c);
}

// ---------- buy side ----------

#[test]
fn buy_offer_partial_fill_and_exact_return_on_cancel() {
    let mut c = market_with_traders();
    // Bob bids for 10 YES at 0.60: reserves 6.0.
    let o = offer(&mut c, "bob.test", Outcome::Yes, Side::Buy, P60, 10 * ONE);
    assert_eq!(o.reserved_collateral.0, 6 * ONE);
    assert_eq!(bal(&c, "bob.test").avail, 4 * ONE);
    assert_eq!(bal(&c, "bob.test").rcol, 6 * ONE);
    // Alice (holds YES) sells 4 into the bid.
    let r = fill(&mut c, "alice.test", o.offer_id.0, 4 * ONE);
    assert_eq!(r.collateral_amount.0, 2_400_000);
    assert_eq!(r.remaining_quantity.0, 6 * ONE);
    assert_eq!(bal(&c, "alice.test").yes, 96 * ONE);
    assert_eq!(bal(&c, "alice.test").avail, 2_400_000);
    assert_eq!(bal(&c, "bob.test").yes, 4 * ONE);
    assert_eq!(bal(&c, "bob.test").rcol, 3_600_000);
    // Cancel: exactly the unfilled 6 * 0.60 = 3.6 returns.
    let x = cancel(&mut c, "bob.test", o.offer_id.0);
    assert_eq!(x.released_collateral.0, 3_600_000);
    let b = bal(&c, "bob.test");
    assert_eq!((b.avail, b.rcol), (4 * ONE + 3_600_000, 0));
    // Bob spent exactly 2.4 for 4 YES.
    assert_eq!(b.avail + 2_400_000, 10 * ONE);
    nothing_reserved(&c);
}

#[test]
fn buy_offer_taker_must_hold_the_shares() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "bob.test", Outcome::Yes, Side::Buy, P60, 2 * ONE);
    fails(
        || {
            fill(&mut c, "carol.test", o.offer_id.0, ONE);
        },
        "insufficient YES/NO shares",
    );
    // Failed fill changed nothing.
    assert_eq!(bal(&c, "bob.test").rcol, 1_200_000);
    assert_eq!(c.get_offer(o.offer_id).unwrap().filled_quantity.0, 0);
}

#[test]
fn sell_offer_taker_must_have_collateral() {
    let mut c = market_with_traders();
    register(&mut c, "dave.test");
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 5 * ONE);
    fails(
        || {
            fill(&mut c, "dave.test", o.offer_id.0, ONE);
        },
        "insufficient available collateral",
    );
    assert_eq!(bal(&c, "alice.test").ryes, 5 * ONE);
}

// ---------- reservations cannot be double spent ----------

#[test]
fn reserved_shares_cannot_be_reused() {
    let mut c = market_with_traders();
    offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        100 * ONE,
    );
    assert_eq!(bal(&c, "alice.test").yes, 0);
    // another offer
    fails(
        || {
            offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 10_000);
        },
        "insufficient YES/NO shares",
    );
    // merge uses only available shares
    fails(
        || merge(&mut c, "alice.test", 1),
        "insufficient YES/NO shares",
    );
    // NO is untouched and still usable
    merge_ok_is_blocked_without_yes(&mut c);
}

fn merge_ok_is_blocked_without_yes(c: &mut Contract) {
    fails(|| merge(c, "alice.test", 100), "insufficient YES/NO shares");
    assert_eq!(bal(c, "alice.test").no, 100 * ONE);
}

#[test]
fn reserved_collateral_cannot_be_withdrawn_or_reused() {
    let mut c = market_with_traders();
    offer(
        &mut c,
        "bob.test",
        Outcome::Yes,
        Side::Buy,
        900_000,
        10 * ONE,
    ); // reserves 9.0
    assert_eq!(bal(&c, "bob.test").avail, ONE);
    fails(
        || withdraw_req(&mut c, "bob.test", ONE + 1),
        "insufficient available collateral",
    );
    fails(
        || split(&mut c, "bob.test", ONE + 1),
        "insufficient available collateral",
    );
    fails(
        || {
            offer(&mut c, "bob.test", Outcome::No, Side::Buy, 500_000, 4 * ONE);
        },
        "insufficient available collateral",
    );
    // The free 1.0 is still fully usable.
    withdraw_req(&mut c, "bob.test", ONE);
    assert_eq!(bal(&c, "bob.test").rcol, 9 * ONE);
}

#[test]
fn trading_interleaved_with_deposit_split_merge_withdraw() {
    let mut c = market_with_traders();
    let sell = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        30 * ONE,
    );
    // Alice can still merge what is not reserved (70 YES / 100 NO -> 70).
    merge(&mut c, "alice.test", 70 * ONE);
    assert_eq!(bal(&c, "alice.test").avail, 70 * ONE);
    assert_eq!(c.get_totals().market_backing.0, 30 * ONE);
    assert_eq!(c.get_totals().outstanding_yes.0, 30 * ONE);
    // ...withdraw part of the proceeds while the offer stays open...
    withdraw_req(&mut c, "alice.test", 20 * ONE);
    // ...and Bob fills the open offer meanwhile.
    fill(&mut c, "bob.test", sell.offer_id.0, 10 * ONE);
    // Alice's pending withdrawal settles as failed: restored to CURRENT balance.
    let o = settle(&mut c, "alice.test", 1, PromiseResult::Failed);
    assert_eq!(o, SettlementOutcome::FailedRestored);
    let a = bal(&c, "alice.test");
    assert_eq!(
        a.avail,
        70 * ONE + 6 * ONE,
        "70 merged + 6.0 sale proceeds, 20 restored - 20 debited"
    );
    assert_eq!(a.ryes, 20 * ONE);
    // Bob splits with leftover collateral, then cancel releases the rest.
    split(&mut c, "bob.test", 2 * ONE);
    cancel(&mut c, "alice.test", sell.offer_id.0);
    assert_eq!(bal(&c, "alice.test").yes, 20 * ONE);
    nothing_reserved(&c);
    let t = c.get_totals();
    assert_eq!(t.market_backing.0, 32 * ONE);
    assert_eq!(t.outstanding_yes.0, 32 * ONE);
    assert_eq!(t.outstanding_no.0, 32 * ONE);
}

// ---------- authorization & validation ----------

#[test]
fn only_the_owner_can_cancel() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 5 * ONE);
    fails(
        || {
            cancel(&mut c, "bob.test", o.offer_id.0);
        },
        "only the offer owner",
    );
    assert_eq!(bal(&c, "alice.test").ryes, 5 * ONE);
    assert!(c.get_offer(o.offer_id).is_some());
}

#[test]
fn invalid_prices_are_rejected() {
    let mut c = market_with_traders();
    for p in [
        0u128,
        9_999,
        10_001,
        505_000,
        995_000,
        1_000_000,
        1_010_000,
        u128::MAX,
    ] {
        fails(
            || {
                offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, p, ONE);
            },
            "invalid price",
        );
    }
    assert_eq!(bal(&c, "alice.test").ryes, 0);
}

#[test]
fn invalid_quantities_are_rejected() {
    let mut c = market_with_traders();
    for q in [0u128, 1, 99, 9_900, 10_050, ONE + 1] {
        fails(
            || {
                offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, q);
            },
            "invalid quantity",
        );
    }
    fails(
        || {
            offer(
                &mut c,
                "alice.test",
                Outcome::Yes,
                Side::Sell,
                P60,
                u128::MAX - 7,
            );
        },
        "invalid quantity",
    );
}

#[test]
fn overflowing_buy_cost_is_rejected_not_wrapped() {
    let mut c = market_with_traders();
    // multiple of the lot, but quantity * price overflows u128
    let q = (u128::MAX / 100) * 100;
    fails(
        || {
            offer(&mut c, "alice.test", Outcome::Yes, Side::Buy, 990_000, q);
        },
        "arithmetic overflow",
    );
}

#[test]
fn invalid_ids_and_markets_are_rejected() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, ONE);
    for bad in [
        0u64,
        1,
        2,
        3,
        999_999,
        u64::MAX,
        o.offer_id.0 + 1,
        o.offer_id.0 ^ 3,
    ] {
        fails(
            || {
                fill(&mut c, "bob.test", bad, ONE);
            },
            "offer not found",
        );
        fails(
            || {
                cancel(&mut c, "alice.test", bad);
            },
            "offer not found",
        );
        assert!(c.get_offer(U64(bad)).is_none());
    }
    set("alice.test", 1, 10);
    fails(
        || {
            c.create_offer(
                "nope".into(),
                Outcome::Yes,
                Side::Sell,
                U128(P60),
                U128(ONE),
                None,
            );
        },
        "unknown market id",
    );
}

#[test]
fn bad_fill_quantities_are_rejected() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, ONE);
    for q in [0u128, 1, 99, 101] {
        fails(
            || {
                fill(&mut c, "bob.test", o.offer_id.0, q);
            },
            "invalid fill quantity",
        );
    }
}

#[test]
fn unregistered_accounts_cannot_trade() {
    let mut c = market_with_traders();
    fails(
        || {
            offer(&mut c, "ghost.test", Outcome::Yes, Side::Buy, P60, ONE);
        },
        "not registered",
    );
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, ONE);
    fails(
        || {
            fill(&mut c, "ghost.test", o.offer_id.0, ONE);
        },
        "not registered",
    );
}

#[test]
fn one_yocto_is_required_for_trading_calls() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 2 * ONE);
    set("bob.test", 0, 10);
    fails(
        || {
            c.fill_offer(o.offer_id, U128(ONE));
        },
        "exactly 1 yoctoNEAR",
    );
    set("alice.test", 2, 10);
    fails(
        || {
            c.cancel_offer(o.offer_id);
        },
        "exactly 1 yoctoNEAR",
    );
    set("alice.test", 0, 10);
    fails(
        || {
            c.create_offer(
                MID.into(),
                Outcome::Yes,
                Side::Sell,
                U128(P60),
                U128(ONE),
                None,
            );
        },
        "exactly 1 yoctoNEAR",
    );
}

#[test]
fn self_fill_is_rejected() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, ONE);
    fails(
        || {
            fill(&mut c, "alice.test", o.offer_id.0, ONE);
        },
        "cannot fill your own",
    );
}

// ---------- overfill, replay, ordering ----------

#[test]
fn overfill_is_rejected_and_exact_fill_closes_the_offer() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 5 * ONE);
    fails(
        || {
            fill(&mut c, "bob.test", o.offer_id.0, 5 * ONE + 100);
        },
        "exceeds the offer's remaining",
    );
    fill(&mut c, "bob.test", o.offer_id.0, 3 * ONE);
    fails(
        || {
            fill(&mut c, "carol.test", o.offer_id.0, 2 * ONE + 100);
        },
        "exceeds the offer's remaining",
    );
    let r = fill(&mut c, "carol.test", o.offer_id.0, 2 * ONE);
    assert_eq!(r.status, FillStatus::Filled);
    assert!(c.get_offer(o.offer_id).is_none());
    // Filled offers cannot be filled or cancelled again.
    fails(
        || {
            fill(&mut c, "bob.test", o.offer_id.0, 100);
        },
        "offer not found",
    );
    fails(
        || {
            cancel(&mut c, "alice.test", o.offer_id.0);
        },
        "offer not found",
    );
    nothing_reserved(&c);
}

#[test]
fn fill_after_cancel_and_double_cancel_fail() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 5 * ONE);
    cancel(&mut c, "alice.test", o.offer_id.0);
    fails(
        || {
            fill(&mut c, "bob.test", o.offer_id.0, ONE);
        },
        "offer not found",
    );
    fails(
        || {
            cancel(&mut c, "alice.test", o.offer_id.0);
        },
        "offer not found",
    );
    assert_eq!(
        bal(&c, "alice.test").yes,
        100 * ONE,
        "released exactly once"
    );
}

#[test]
fn fill_then_cancel_and_cancel_then_fill_never_double_spend() {
    // Order A: fill first, then cancel releases only the remainder.
    let mut c = market_with_traders();
    let o = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        10 * ONE,
    );
    fill(&mut c, "bob.test", o.offer_id.0, 4 * ONE);
    let x = cancel(&mut c, "alice.test", o.offer_id.0);
    assert_eq!(x.released_shares.0, 6 * ONE);
    assert_eq!(
        bal(&c, "alice.test").yes + bal(&c, "bob.test").yes,
        100 * ONE
    );
    // Order B: cancel first, the fill then fails and nothing moves.
    let mut c = market_with_traders();
    let o = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        10 * ONE,
    );
    cancel(&mut c, "alice.test", o.offer_id.0);
    fails(
        || {
            fill(&mut c, "bob.test", o.offer_id.0, 4 * ONE);
        },
        "offer not found",
    );
    assert_eq!(bal(&c, "bob.test").yes, 0);
    assert_eq!(bal(&c, "bob.test").avail, 10 * ONE);
    assert_eq!(bal(&c, "alice.test").yes, 100 * ONE);
}

// ---------- time ----------

#[test]
fn offers_cannot_be_created_or_filled_after_the_cutoff_but_can_be_cancelled() {
    let mut c = market_with_traders();
    let sell = offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 5 * ONE);
    let buy = offer(&mut c, "bob.test", Outcome::Yes, Side::Buy, P60, 5 * ONE);
    set("alice.test", 1, CUTOFF);
    fails(
        || {
            c.create_offer(
                MID.into(),
                Outcome::Yes,
                Side::Sell,
                U128(P60),
                U128(ONE),
                None,
            );
        },
        "trading is closed",
    );
    set("bob.test", 1, CUTOFF + 5);
    fails(
        || {
            c.fill_offer(sell.offer_id, U128(ONE));
        },
        "trading is closed",
    );
    let v = c.get_offer(sell.offer_id).unwrap();
    assert_eq!(v.status, OfferStatus::Expired);
    assert!(!v.fillable);
    // Both makers recover their reserves after trading has closed.
    set("alice.test", 1, CUTOFF + 6);
    assert_eq!(c.cancel_offer(sell.offer_id).released_shares.0, 5 * ONE);
    set("bob.test", 1, CUTOFF + 7);
    assert_eq!(c.cancel_offer(buy.offer_id).released_collateral.0, 3 * ONE);
    assert_eq!(bal(&c, "bob.test").avail, 10 * ONE);
    nothing_reserved(&c);
    // Merging and withdrawing remain possible after the cutoff.
    set("alice.test", 1, CUTOFF + 8);
    c.merge_positions(MID.into(), U128(100 * ONE));
    assert_eq!(bal(&c, "alice.test").avail, 100 * ONE);
}

#[test]
fn expiry_blocks_fills_but_not_cancellation() {
    let mut c = market_with_traders();
    set("alice.test", 1, 10);
    let o = c.create_offer(
        MID.into(),
        Outcome::Yes,
        Side::Sell,
        U128(P60),
        U128(5 * ONE),
        Some(U64(1_000)),
    );
    assert_eq!(o.expires_at_ns, Some(U64(1_000)));
    set("bob.test", 1, 999);
    c.fill_offer(o.offer_id, U128(ONE)); // still valid
    set("bob.test", 1, 1_000);
    fails(
        || {
            c.fill_offer(o.offer_id, U128(ONE));
        },
        "offer has expired",
    );
    assert_eq!(
        c.get_offer(o.offer_id).unwrap().status,
        OfferStatus::Expired
    );
    set("alice.test", 1, 2_000);
    assert_eq!(c.cancel_offer(o.offer_id).released_shares.0, 4 * ONE);
    nothing_reserved(&c);
}

#[test]
fn past_expiry_is_rejected_at_creation() {
    let mut c = market_with_traders();
    set("alice.test", 1, 500);
    fails(
        || {
            c.create_offer(
                MID.into(),
                Outcome::Yes,
                Side::Sell,
                U128(P60),
                U128(ONE),
                Some(U64(500)),
            );
        },
        "invalid expiry",
    );
}

// ---------- precision ----------

#[test]
fn minimum_tick_and_lot_are_exact() {
    let mut c = market_with_traders();
    // Lowest price, smallest lot: 100 share units at 0.01 cost exactly 1 base unit.
    let o = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        10_000,
        10_000,
    );
    let r = fill(&mut c, "bob.test", o.offer_id.0, 100);
    assert_eq!(r.collateral_amount.0, 1);
    assert_eq!(bal(&c, "bob.test").yes, 100);
    assert_eq!(bal(&c, "alice.test").avail, 1);
    // Highest price.
    let o2 = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        990_000,
        10_000,
    );
    let r = fill(&mut c, "bob.test", o2.offer_id.0, 100);
    assert_eq!(r.collateral_amount.0, 99);
}

#[test]
fn many_small_fills_equal_one_large_fill() {
    // Same offer, filled once vs. in 7 uneven valid pieces.
    let pieces = [100u128, 300, 1_700, 20_000, 5_400, 970_000, 2_500];
    let total: u128 = pieces.iter().sum();
    assert_eq!(total % 100, 0);

    let mut one = market_with_traders();
    let o = offer(
        &mut one,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        730_000,
        2 * ONE,
    );
    let r = fill(&mut one, "bob.test", o.offer_id.0, total);

    let mut many = market_with_traders();
    let o = offer(
        &mut many,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        730_000,
        2 * ONE,
    );
    let mut paid = 0u128;
    for p in pieces {
        paid += fill(&mut many, "bob.test", o.offer_id.0, p)
            .collateral_amount
            .0;
    }
    assert_eq!(paid, r.collateral_amount.0);
    for who in ["alice.test", "bob.test"] {
        let (a, b) = (bal(&one, who), bal(&many, who));
        assert_eq!((a.avail, a.yes, a.ryes), (b.avail, b.yes, b.ryes));
    }
    // And the cost is exactly price*qty/1e6 with no rounding.
    assert_eq!(paid * 1_000_000, 730_000 * total);
}

#[test]
fn buy_reservation_equals_sum_of_fills_plus_release() {
    let mut c = market_with_traders();
    let o = offer(&mut c, "bob.test", Outcome::No, Side::Buy, 370_000, 73_000);
    let reserved = o.reserved_collateral.0;
    assert_eq!(reserved * 1_000_000, 370_000 * 73_000);
    // Carol needs NO shares to sell; give her some via Alice's offer.
    let s = offer(
        &mut c,
        "alice.test",
        Outcome::No,
        Side::Sell,
        100_000,
        10_000,
    );
    fill(&mut c, "carol.test", s.offer_id.0, 10_000);
    let mut got = 0u128;
    for q in [100u128, 2_100, 1_000] {
        got += fill(&mut c, "carol.test", o.offer_id.0, q)
            .collateral_amount
            .0;
    }
    let x = cancel(&mut c, "bob.test", o.offer_id.0);
    assert_eq!(
        got + x.released_collateral.0,
        reserved,
        "nothing created or lost"
    );
}

// ---------- limits & views ----------

#[test]
fn open_offer_limit_and_slot_release() {
    let mut c = market_with_traders();
    let mut ids = vec![];
    for _ in 0..10 {
        ids.push(
            offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 10_000)
                .offer_id
                .0,
        );
    }
    fails(
        || {
            offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 10_000);
        },
        "too many open offers",
    );
    assert_eq!(c.get_account_offers(acct("alice.test")).len(), 10);
    cancel(&mut c, "alice.test", ids[3]);
    offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 10_000);
    // A fully filled offer also frees its slot.
    fill(&mut c, "bob.test", ids[0], 10_000);
    offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 10_000);
    assert_eq!(c.get_account_offers(acct("alice.test")).len(), 10);
}

#[test]
fn views_paginate_by_outcome_and_side() {
    let mut c = market_with_traders();
    for i in 0..5u128 {
        offer(
            &mut c,
            "alice.test",
            Outcome::Yes,
            Side::Sell,
            500_000 + i * 10_000,
            10_000,
        );
    }
    offer(&mut c, "alice.test", Outcome::No, Side::Sell, P60, 10_000);
    offer(&mut c, "bob.test", Outcome::Yes, Side::Buy, 300_000, 10_000);
    let list = |c: &Contract, o, s, from: Option<u64>, lim: Option<u64>| {
        c.list_offers(MID.into(), o, s, from.map(U64), lim)
    };
    assert_eq!(list(&c, Outcome::Yes, Side::Sell, None, None).len(), 5);
    assert_eq!(list(&c, Outcome::Yes, Side::Sell, None, Some(2)).len(), 2);
    assert_eq!(
        list(&c, Outcome::Yes, Side::Sell, Some(2), Some(2)).len(),
        2
    );
    assert_eq!(
        list(&c, Outcome::Yes, Side::Sell, Some(4), Some(10)).len(),
        1
    );
    assert_eq!(
        list(&c, Outcome::Yes, Side::Sell, Some(5), Some(10)).len(),
        0
    );
    assert_eq!(list(&c, Outcome::No, Side::Sell, None, None).len(), 1);
    assert_eq!(list(&c, Outcome::Yes, Side::Buy, None, None).len(), 1);
    assert_eq!(list(&c, Outcome::No, Side::Buy, None, None).len(), 0);
    assert_eq!(c.get_account_offers(acct("bob.test")).len(), 1);
    assert_eq!(c.get_totals().open_offers.0, 7);
    let all: Vec<u64> = list(&c, Outcome::Yes, Side::Sell, None, Some(50))
        .iter()
        .map(|o| o.offer_id.0)
        .collect();
    let mut dedup = all.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(dedup.len(), 5, "ids are unique");
}

#[test]
fn config_reports_trading_parameters() {
    let c = new_contract();
    let t = c.get_config().trading;
    assert_eq!(t.price_scale.0, 1_000_000);
    assert_eq!(t.price_tick.0, 10_000);
    assert_eq!(t.quantity_lot.0, 100);
    assert_eq!(t.min_order_quantity.0, 10_000);
    assert_eq!(t.max_open_offers_per_account, 10);
    assert_eq!(t.fee_bps, 0);
}

#[test]
fn escrow_requirement_includes_buy_reservations() {
    let mut c = market_with_traders();
    offer(&mut c, "bob.test", Outcome::Yes, Side::Buy, P60, 10 * ONE);
    let t = c.get_totals();
    assert_eq!(t.reserved_collateral.0, 6 * ONE);
    assert_eq!(t.available_collateral.0, 14 * ONE);
    // 100 backing + 4 (bob avail) + 6 (bob reserved) + 10 (carol)
    assert_eq!(t.settled_escrow_requirement.0, 120 * ONE);
}
