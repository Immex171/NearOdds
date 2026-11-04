//! Unit tests for Milestone 3: resolution, redemption, the resolved phase.

use super::trading::{
    bal, cancel, fails, fill, market_with_traders, nothing_reserved, offer, P60, P70,
};
use super::*;
use crate::state::{Outcome, Side};
use crate::types::MarketStatus;

fn resolve(c: &mut Contract, who: &str, o: Outcome, ts: u64) -> crate::types::ResolutionView {
    set(who, 1, ts);
    c.resolve_market(
        MID.into(),
        o,
        "https://nimet.example/report/2026-12-01".into(),
    )
}

fn redeem(c: &mut Contract, who: &str) -> crate::types::RedeemResult {
    set(who, 1, CUTOFF + 50);
    c.redeem(MID.into())
}

fn resolve_ok(c: &mut Contract, o: Outcome) {
    resolve(c, "resolver.test", o, CUTOFF + 10);
}

/// Total value held by the contract's books: available + reserved + backing.
fn book_value(c: &Contract) -> u128 {
    let t = c.get_totals();
    t.available_collateral.0 + t.reserved_collateral.0 + t.market_backing.0
}

/// Runs the Milestone 2 acceptance trades. Value in the books is 120.
fn trade_acceptance(c: &mut Contract) {
    let o = offer(c, "alice.test", Outcome::Yes, Side::Sell, P60, 20 * ONE);
    fill(c, "bob.test", o.offer_id.0, 8 * ONE);
    fill(c, "carol.test", o.offer_id.0, 5 * ONE);
    cancel(c, "alice.test", o.offer_id.0);
    let r = offer(c, "bob.test", Outcome::Yes, Side::Sell, P70, 3 * ONE);
    fill(c, "carol.test", r.offer_id.0, 3 * ONE);
}

fn avail(c: &Contract, who: &str) -> u128 {
    bal(c, who).avail
}

// ---------- resolution rules ----------

#[test]
fn only_the_resolver_can_resolve() {
    let mut c = market_with_traders();
    for who in [
        "alice.test",
        "bob.test",
        "owner.test",
        "market.test",
        "token.test",
    ] {
        fails(
            || {
                resolve(&mut c, who, Outcome::Yes, CUTOFF + 1);
            },
            "only the configured resolver",
        );
    }
    assert!(c.get_market(MID.into()).resolution.is_none());
}

#[test]
fn resolution_is_blocked_before_the_cutoff_and_allowed_at_it() {
    let mut c = market_with_traders();
    fails(
        || {
            resolve(&mut c, "resolver.test", Outcome::Yes, 10);
        },
        "cannot be resolved before its cutoff",
    );
    fails(
        || {
            resolve(&mut c, "resolver.test", Outcome::Yes, CUTOFF - 1);
        },
        "cannot be resolved before its cutoff",
    );
    // Exactly at the cutoff the market is closed AND resolvable.
    set("alice.test", 0, CUTOFF);
    assert_eq!(
        c.get_market(MID.into()).status,
        MarketStatus::AwaitingResolution
    );
    let r = resolve(&mut c, "resolver.test", Outcome::No, CUTOFF);
    assert_eq!(r.outcome, Outcome::No);
    assert_eq!(r.resolved_at_ns.0, CUTOFF);
}

#[test]
fn the_result_cannot_be_repeated_or_replaced() {
    let mut c = market_with_traders();
    resolve(&mut c, "resolver.test", Outcome::Yes, CUTOFF + 1);
    for o in [Outcome::Yes, Outcome::No] {
        fails(
            || {
                resolve(&mut c, "resolver.test", o, CUTOFF + 2);
            },
            "already resolved",
        );
    }
    let m = c.get_market(MID.into());
    let r = m.resolution.unwrap();
    assert_eq!(r.outcome, Outcome::Yes);
    assert_eq!(r.resolved_at_ns.0, CUTOFF + 1);
}

#[test]
fn evidence_is_required_and_bounded() {
    let mut c = market_with_traders();
    for bad in ["".to_string(), "   ".to_string(), "x".repeat(513)] {
        set("resolver.test", 1, CUTOFF);
        let b = bad.clone();
        fails(
            || {
                c.resolve_market(MID.into(), Outcome::Yes, b);
            },
            "evidence must be 1 to 512 bytes",
        );
    }
    set("resolver.test", 1, CUTOFF);
    c.resolve_market(MID.into(), Outcome::Yes, "x".repeat(512));
    assert_eq!(
        c.get_market(MID.into()).resolution.unwrap().evidence.len(),
        512
    );
}

#[test]
fn resolution_needs_one_yocto_and_the_right_market() {
    let mut c = market_with_traders();
    set("resolver.test", 0, CUTOFF);
    fails(
        || {
            c.resolve_market(MID.into(), Outcome::Yes, "e".into());
        },
        "exactly 1 yoctoNEAR",
    );
    set("resolver.test", 1, CUTOFF);
    fails(
        || {
            c.resolve_market("other".into(), Outcome::Yes, "e".into());
        },
        "unknown market id",
    );
}

#[test]
fn config_and_market_views_expose_the_lifecycle() {
    let mut c = market_with_traders();
    let cfg = c.get_config();
    assert_eq!(cfg.resolver_id, acct("resolver.test"));
    assert!(cfg.resolution_model.contains("trusted"));
    assert_eq!(cfg.schema_version, 3);
    set("alice.test", 0, 50);
    let m = c.get_market(MID.into());
    assert_eq!(
        (m.status, m.trading_open, m.awaiting_resolution, m.resolved),
        (MarketStatus::Open, true, false, false)
    );
    assert!(m.merge_open && m.resolution.is_none());
    assert_eq!(m.resolution_source, "NiMet daily report");
    set("alice.test", 0, CUTOFF + 1);
    let m = c.get_market(MID.into());
    assert_eq!(m.status, MarketStatus::AwaitingResolution);
    assert!(!m.trading_open && m.awaiting_resolution && !m.resolved && m.merge_open);
    resolve_ok(&mut c, Outcome::Yes);
    set("alice.test", 0, CUTOFF + 20);
    let m = c.get_market(MID.into());
    assert_eq!(m.status, MarketStatus::Resolved);
    assert!(
        !m.trading_open && !m.awaiting_resolution && m.resolved && !m.merge_open && !m.split_open
    );
    let r = m.resolution.unwrap();
    assert_eq!(r.resolver_id, acct("resolver.test"));
    assert_eq!(r.evidence, "https://nimet.example/report/2026-12-01");
}

// ---------- phase gating ----------

#[test]
fn trading_split_and_merge_stop_at_resolution_but_cancel_and_withdraw_work() {
    let mut c = market_with_traders();
    let sell = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        10 * ONE,
    );
    let buy = offer(&mut c, "bob.test", Outcome::Yes, Side::Buy, P60, 5 * ONE);
    resolve_ok(&mut c, Outcome::Yes);
    set("carol.test", 1, CUTOFF + 20);
    fails(
        || {
            c.fill_offer(sell.offer_id, U128(ONE));
        },
        "market is resolved",
    );
    fails(
        || {
            c.fill_offer(buy.offer_id, U128(ONE));
        },
        "market is resolved",
    );
    set("alice.test", 1, CUTOFF + 20);
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
        "market is resolved",
    );
    fails(
        || {
            c.split_position(MID.into(), U128(1));
        },
        "market is resolved",
    );
    fails(
        || {
            c.merge_positions(MID.into(), U128(1));
        },
        "market is resolved",
    );
    // Offers show as not fillable.
    let v = c.get_offer(sell.offer_id).unwrap();
    assert!(!v.fillable);
    // Cancellation still releases exactly the reserves; withdrawal works.
    set("alice.test", 1, CUTOFF + 21);
    assert_eq!(c.cancel_offer(sell.offer_id).released_shares.0, 10 * ONE);
    set("bob.test", 1, CUTOFF + 22);
    assert_eq!(c.cancel_offer(buy.offer_id).released_collateral.0, 3 * ONE);
    nothing_reserved(&c);
    super::withdraw_req(&mut c, "bob.test", 10 * ONE);
    assert_eq!(
        c.get_totals().market_backing.0,
        100 * ONE,
        "backing untouched"
    );
    // Deposits still work after resolution.
    fund(&mut c, "dave.test", 3 * ONE);
}

#[test]
fn redeem_before_resolution_fails() {
    let mut c = market_with_traders();
    set("alice.test", 1, 10);
    fails(
        || {
            c.redeem(MID.into());
        },
        "not resolved yet",
    );
    let p = c.get_redemption_preview(acct("alice.test"));
    assert!(!p.resolved && !p.redeemable && p.outcome.is_none());
}

#[test]
fn redeem_requires_one_yocto_registration_and_market() {
    let mut c = market_with_traders();
    resolve_ok(&mut c, Outcome::Yes);
    set("alice.test", 0, CUTOFF + 20);
    fails(
        || {
            c.redeem(MID.into());
        },
        "exactly 1 yoctoNEAR",
    );
    set("alice.test", 1, CUTOFF + 20);
    fails(
        || {
            c.redeem("other".into());
        },
        "unknown market id",
    );
    set("ghost.test", 1, CUTOFF + 20);
    fails(
        || {
            c.redeem(MID.into());
        },
        "not registered",
    );
}

// ---------- the acceptance scenario, resolved ----------

#[test]
fn yes_wins_everyone_redeems_and_withdraws() {
    let mut c = market_with_traders();
    trade_acceptance(&mut c);
    let (a, b, k) = (
        bal(&c, "alice.test"),
        bal(&c, "bob.test"),
        bal(&c, "carol.test"),
    );
    assert_eq!((a.avail, a.yes, a.no), (7_800_000, 87 * ONE, 100 * ONE));
    assert_eq!((b.avail, b.yes, b.no), (7_300_000, 5 * ONE, 0));
    assert_eq!((k.avail, k.yes, k.no), (4_900_000, 8 * ONE, 0));
    assert_eq!(book_value(&c), 120 * ONE);

    resolve_ok(&mut c, Outcome::Yes);
    let p = c.get_redemption_preview(acct("alice.test"));
    assert!(p.redeemable);
    assert_eq!(
        (p.winning_shares.0, p.losing_shares.0, p.payout.0),
        (87 * ONE, 100 * ONE, 87 * ONE)
    );
    assert_eq!(p.available_collateral_after.0, 94_800_000);

    let r = redeem(&mut c, "alice.test");
    assert_eq!(r.payout.0, 87 * ONE);
    assert_eq!(r.losing_shares.0, 100 * ONE);
    assert_eq!((r.yes.0, r.no.0), (0, 0));
    assert_eq!(r.available_collateral.0, 94_800_000);
    assert_eq!(book_value(&c), 120 * ONE);
    // Backing now equals the outstanding winning claims (Bob 5 + Carol 8).
    let t = c.get_totals();
    assert_eq!(t.market_backing.0, 13 * ONE);
    assert_eq!((t.outstanding_yes.0, t.outstanding_no.0), (13 * ONE, 0));

    redeem(&mut c, "bob.test");
    redeem(&mut c, "carol.test");
    assert_eq!(avail(&c, "alice.test"), 94_800_000);
    assert_eq!(avail(&c, "bob.test"), 12_300_000);
    assert_eq!(avail(&c, "carol.test"), 12_900_000);
    let t = c.get_totals();
    assert_eq!(t.market_backing.0, 0);
    assert_eq!(t.available_collateral.0, 120 * ONE);
    assert_eq!((t.outstanding_yes.0, t.outstanding_no.0), (0, 0));
    assert_eq!(t.settled_escrow_requirement.0, 120 * ONE);

    // Withdraw everything: complete exit.
    for (who, amt) in [
        ("alice.test", 94_800_000),
        ("bob.test", 12_300_000),
        ("carol.test", 12_900_000),
    ] {
        super::withdraw_req(&mut c, who, amt);
    }
    for (i, who) in ["alice.test", "bob.test", "carol.test"].iter().enumerate() {
        // withdrawal ids are 1, 2, 3 in request order
        let o = settle(
            &mut c,
            who,
            (i + 1) as u64,
            PromiseResult::Successful(vec![]),
        );
        assert_eq!(o, SettlementOutcome::Completed);
    }
    let t = c.get_totals();
    assert_eq!(
        (
            t.available_collateral.0,
            t.pending_withdrawals.0,
            t.market_backing.0
        ),
        (0, 0, 0)
    );
}

#[test]
fn no_wins_with_the_same_starting_positions() {
    let mut c = market_with_traders();
    trade_acceptance(&mut c);
    resolve_ok(&mut c, Outcome::No);
    for who in ["alice.test", "bob.test", "carol.test"] {
        redeem(&mut c, who);
    }
    assert_eq!(avail(&c, "alice.test"), 107_800_000);
    assert_eq!(avail(&c, "bob.test"), 7_300_000, "Bob held only losing YES");
    assert_eq!(avail(&c, "carol.test"), 4_900_000);
    let t = c.get_totals();
    assert_eq!(t.market_backing.0, 0);
    assert_eq!(t.available_collateral.0, 120 * ONE);
    assert_eq!((t.outstanding_yes.0, t.outstanding_no.0), (0, 0));
}

#[test]
fn redemption_order_does_not_matter() {
    let orders = [
        ["alice.test", "bob.test", "carol.test"],
        ["carol.test", "bob.test", "alice.test"],
        ["bob.test", "alice.test", "carol.test"],
    ];
    for order in orders {
        let mut c = market_with_traders();
        trade_acceptance(&mut c);
        resolve_ok(&mut c, Outcome::Yes);
        for who in order {
            redeem(&mut c, who);
            assert_eq!(book_value(&c), 120 * ONE, "conserved after {who}");
            let t = c.get_totals();
            assert_eq!(
                t.market_backing.0, t.outstanding_yes.0,
                "backing == outstanding winners"
            );
        }
        assert_eq!(avail(&c, "alice.test"), 94_800_000);
        assert_eq!(avail(&c, "bob.test"), 12_300_000);
        assert_eq!(avail(&c, "carol.test"), 12_900_000);
        assert_eq!(c.get_totals().market_backing.0, 0);
    }
}

#[test]
fn redeem_cannot_pay_twice() {
    let mut c = market_with_traders();
    trade_acceptance(&mut c);
    resolve_ok(&mut c, Outcome::Yes);
    redeem(&mut c, "bob.test");
    let before = (
        avail(&c, "bob.test"),
        c.get_totals().market_backing.0,
        book_value(&c),
    );
    for _ in 0..3 {
        fails(
            || {
                redeem(&mut c, "bob.test");
            },
            "nothing to redeem",
        );
    }
    assert_eq!(
        (
            avail(&c, "bob.test"),
            c.get_totals().market_backing.0,
            book_value(&c)
        ),
        before
    );
    let p = c.get_redemption_preview(acct("bob.test"));
    assert!(p.resolved && !p.redeemable && p.payout.0 == 0);
}

#[test]
fn redemption_never_touches_other_accounts() {
    let mut c = market_with_traders();
    trade_acceptance(&mut c);
    resolve_ok(&mut c, Outcome::Yes);
    let (b0, k0) = (bal(&c, "bob.test"), bal(&c, "carol.test"));
    redeem(&mut c, "alice.test");
    let (b1, k1) = (bal(&c, "bob.test"), bal(&c, "carol.test"));
    assert_eq!((b0.avail, b0.yes), (b1.avail, b1.yes));
    assert_eq!((k0.avail, k0.yes), (k1.avail, k1.yes));
}

#[test]
fn one_base_unit_winning_redemption_is_exact() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 3);
    split(&mut c, "alice.test", 3);
    resolve_ok(&mut c, Outcome::No);
    let r = redeem(&mut c, "alice.test");
    assert_eq!(
        (r.winning_shares.0, r.losing_shares.0, r.payout.0),
        (3, 3, 3)
    );
    assert_eq!(avail(&c, "alice.test"), 3);
    assert_eq!(c.get_totals().market_backing.0, 0);

    // One base unit exactly: Alice keeps 1 unit of YES/NO via merge of the rest.
    let mut c = new_contract();
    fund(&mut c, "alice.test", 2);
    split(&mut c, "alice.test", 2);
    merge(&mut c, "alice.test", 1);
    resolve_ok(&mut c, Outcome::Yes);
    let r = redeem(&mut c, "alice.test");
    assert_eq!((r.payout.0, r.losing_shares.0), (1, 1));
    assert_eq!(avail(&c, "alice.test"), 2);
    assert_eq!(c.get_totals().market_backing.0, 0);
}

#[test]
fn losing_only_holder_gets_zero_and_releases_no_backing() {
    let mut c = market_with_traders();
    trade_acceptance(&mut c);
    resolve_ok(&mut c, Outcome::No);
    let backing = c.get_totals().market_backing.0;
    let before = avail(&c, "bob.test");
    let r = redeem(&mut c, "bob.test");
    assert_eq!((r.payout.0, r.losing_shares.0), (0, 5 * ONE));
    assert_eq!(avail(&c, "bob.test"), before);
    assert_eq!(
        c.get_totals().market_backing.0,
        backing,
        "losing shares release nothing"
    );
    assert_eq!(c.get_totals().outstanding_yes.0, 100 * ONE - 5 * ONE);
}

// ---------- offers released by redemption ----------

#[test]
fn redemption_releases_reserved_collateral_and_shares_without_double_credit() {
    let mut c = market_with_traders();
    // Alice: 30 YES for sale. Bob: bid for 10 NO at 0.50 (reserves 5.0).
    // Carol: bid for 4 YES at 0.40 (reserves 1.6).
    let sell = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        30 * ONE,
    );
    let bid_b = offer(
        &mut c,
        "bob.test",
        Outcome::No,
        Side::Buy,
        500_000,
        10 * ONE,
    );
    let bid_c = offer(
        &mut c,
        "carol.test",
        Outcome::Yes,
        Side::Buy,
        400_000,
        4 * ONE,
    );
    fill(&mut c, "carol.test", sell.offer_id.0, 2 * ONE); // Carol buys 2 YES for 1.2
    assert_eq!(bal(&c, "carol.test").rcol, 1_600_000);
    resolve_ok(&mut c, Outcome::Yes);

    let p = c.get_redemption_preview(acct("carol.test"));
    assert_eq!(p.offers_to_release.len(), 1);
    assert_eq!(p.released_collateral.0, 1_600_000);
    assert_eq!(p.winning_shares.0, 2 * ONE);
    assert_eq!(p.payout.0, 2 * ONE);
    assert_eq!(
        p.available_collateral_after.0,
        10 * ONE - 1_200_000 - 1_600_000 + 1_600_000 + 2 * ONE
    );

    // Carol: released 1.6 and payout 2.0 are separate and each counted once.
    let r = redeem(&mut c, "carol.test");
    assert_eq!(r.released_offers.len(), 1);
    assert_eq!(r.released_offers[0].offer_id, bid_c.offer_id);
    assert_eq!(r.released_collateral.0, 1_600_000);
    assert_eq!(r.payout.0, 2 * ONE);
    assert_eq!(r.available_collateral.0, 10 * ONE - 1_200_000 + 2 * ONE);
    assert_eq!(bal(&c, "carol.test").rcol, 0);

    // Alice: 28 YES still reserved + 70 available YES + 100 NO.
    let r = redeem(&mut c, "alice.test");
    assert_eq!(r.released_shares.0, 28 * ONE);
    assert_eq!(r.winning_shares.0, 98 * ONE, "70 available + 28 released");
    assert_eq!(r.payout.0, 98 * ONE);
    assert_eq!(r.released_collateral.0, 0);
    assert_eq!(bal(&c, "alice.test").avail, 1_200_000 + 98 * ONE);

    // Bob: only a buy offer; collateral comes back, payout zero, offer gone.
    let r = redeem(&mut c, "bob.test");
    assert_eq!((r.payout.0, r.released_collateral.0), (0, 5 * ONE));
    assert_eq!(bal(&c, "bob.test").avail, 10 * ONE);
    assert!(c.get_offer(bid_b.offer_id).is_none());
    nothing_reserved(&c);
    assert_eq!(book_value(&c), 120 * ONE);
    // Remaining backing = Carol's 2 redeemed already... everything YES redeemed:
    // outstanding YES = 0, so backing 100 - 98 - 2 = 0.
    assert_eq!(c.get_totals().market_backing.0, 0);
}

#[test]
fn redemption_with_all_ten_offer_slots_occupied() {
    let mut c = market_with_traders();
    for i in 0..4u128 {
        offer(
            &mut c,
            "alice.test",
            Outcome::Yes,
            Side::Sell,
            P60 + i * 10_000,
            5 * ONE,
        );
    }
    for i in 0..3u128 {
        offer(
            &mut c,
            "alice.test",
            Outcome::No,
            Side::Sell,
            P70 + i * 10_000,
            2 * ONE,
        );
    }
    // Alice has no collateral left to bid: top up through a deposit.
    fund_more(&mut c, "alice.test", 10 * ONE);
    for i in 0..3u128 {
        offer(
            &mut c,
            "alice.test",
            Outcome::Yes,
            Side::Buy,
            100_000 + i * 10_000,
            ONE,
        );
    }
    assert_eq!(c.get_account_offers(acct("alice.test")).len(), 10);
    fails(
        || {
            offer(&mut c, "alice.test", Outcome::Yes, Side::Sell, P60, 10_000);
        },
        "too many open offers",
    );
    let reserved_before = bal(&c, "alice.test");
    assert_eq!(
        (reserved_before.ryes, reserved_before.rno),
        (20 * ONE, 6 * ONE)
    );

    resolve_ok(&mut c, Outcome::Yes);
    let p = c.get_redemption_preview(acct("alice.test"));
    assert_eq!(p.offers_to_release.len(), 10);
    let r = redeem(&mut c, "alice.test");
    assert_eq!(r.released_offers.len(), 10);
    assert_eq!(r.released_shares.0, 26 * ONE);
    assert_eq!(
        r.released_collateral.0, 330_000,
        "0.10+0.11+0.12 per share x 1"
    );
    assert_eq!(r.payout.0, 100 * ONE);
    let a = bal(&c, "alice.test");
    assert_eq!((a.rcol, a.ryes, a.rno, a.yes, a.no), (0, 0, 0, 0, 0));
    assert!(c.get_account_offers(acct("alice.test")).is_empty());
    nothing_reserved(&c);
    for k in 0..4 {
        for (o, s) in [
            (Outcome::Yes, Side::Sell),
            (Outcome::Yes, Side::Buy),
            (Outcome::No, Side::Sell),
        ] {
            let l = c.list_offers(MID.into(), o, s, Some(U64(0)), Some(50));
            assert!(l.is_empty(), "bucket {k} {o:?}/{s:?} must be empty");
        }
    }
    assert_eq!(c.get_totals().market_backing.0, 0);
}

fn fund_more(c: &mut Contract, who: &str, amount: u128) {
    set("token.test", 0, 5);
    let _ = c.ft_on_transfer(acct(who), U128(amount), "deposit".into());
}

#[test]
fn cancellation_still_works_after_resolution_and_redeem_afterwards() {
    let mut c = market_with_traders();
    let sell = offer(
        &mut c,
        "alice.test",
        Outcome::Yes,
        Side::Sell,
        P60,
        10 * ONE,
    );
    resolve_ok(&mut c, Outcome::Yes);
    set("alice.test", 1, CUTOFF + 30);
    let x = c.cancel_offer(sell.offer_id);
    assert_eq!(x.released_shares.0, 10 * ONE);
    // Cancelling changed no backing; the cancelled offer cannot be cancelled again.
    assert_eq!(c.get_totals().market_backing.0, 100 * ONE);
    fails(
        || {
            c.cancel_offer(sell.offer_id);
        },
        "offer not found",
    );
    let r = redeem(&mut c, "alice.test");
    assert_eq!(r.released_offers.len(), 0);
    assert_eq!(r.payout.0, 100 * ONE);
}

#[test]
fn redeem_then_withdraw_cannot_pay_twice_and_failed_callback_stays_safe() {
    let mut c = market_with_traders();
    trade_acceptance(&mut c);
    resolve_ok(&mut c, Outcome::Yes);
    redeem(&mut c, "bob.test"); // 12.30 available
    super::withdraw_req(&mut c, "bob.test", 12_300_000);
    // Verified failure: credit returns once; a second redeem still pays nothing.
    let o = settle(&mut c, "bob.test", 1, PromiseResult::Failed);
    assert_eq!(o, SettlementOutcome::FailedRestored);
    assert_eq!(avail(&c, "bob.test"), 12_300_000);
    fails(
        || {
            redeem(&mut c, "bob.test");
        },
        "nothing to redeem",
    );
    assert_eq!(avail(&c, "bob.test"), 12_300_000);
    assert_eq!(book_value(&c), 120 * ONE);
    // While a withdrawal is pending the debited amount is not spendable twice.
    super::withdraw_req(&mut c, "bob.test", 12_300_000);
    fails(
        || {
            super::withdraw_req(&mut c, "bob.test", 1);
        },
        "already pending",
    );
    // A Pending (unsettled) withdrawal is left alone by redemption of others.
    redeem(&mut c, "alice.test");
    assert_eq!(
        c.get_withdrawal(acct("bob.test")).unwrap().status,
        crate::types::WithdrawalStatus::Pending
    );
    assert_eq!(c.get_totals().pending_withdrawals.0, 12_300_000);
}

#[test]
fn events_are_emitted_for_resolution_and_redemption() {
    let mut c = market_with_traders();
    let _ = offer(&mut c, "bob.test", Outcome::Yes, Side::Buy, P60, 5 * ONE);
    resolve_ok(&mut c, Outcome::Yes);
    let logs = near_sdk::test_utils::get_logs();
    assert!(logs
        .iter()
        .any(|l| l.contains("\"event\":\"market_resolved\"") && l.contains("\"outcome\":\"Yes\"")));
    redeem(&mut c, "bob.test");
    let logs = near_sdk::test_utils::get_logs();
    let pos = |needle: &str| logs.iter().position(|l| l.contains(needle));
    let cancelled = pos("\"event\":\"offer_cancelled\"").expect("offer_cancelled");
    let redeemed = pos("\"event\":\"position_redeemed\"").expect("position_redeemed");
    assert!(
        cancelled < redeemed,
        "cancellations are emitted before the redemption"
    );
}
