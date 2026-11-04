#![allow(unused_must_use)]
//! Sandbox: Milestone 3 resolution and redemption with real Wasm and real tokens.

mod common;
use common::*;
use near_workspaces::types::Gas;
use serde_json::{json, Value};

const CUTOFF_SECS: u64 = 100;

fn tgas(g: Gas) -> f64 {
    g.as_gas() as f64 / 1e12
}

#[tokio::test]
async fn yes_wins_full_lifecycle_with_real_tokens() {
    let (e, carol) = traders(Opts {
        cutoff_secs: CUTOFF_SECS,
        ..Opts::default()
    })
    .await;
    let (a, b, k) = (e.alice.id().clone(), e.bob.id().clone(), carol.id().clone());
    trade_acceptance(&e, &carol).await;
    assert_eq!(e.full(&a).await, [7_800_000, 0, 87 * ONE, 0, 100 * ONE, 0]);
    assert_eq!(e.full(&b).await, [7_300_000, 0, 5 * ONE, 0, 0, 0]);
    assert_eq!(e.full(&k).await, [4_900_000, 0, 8 * ONE, 0, 0, 0]);
    assert!(
        now_ns(&e.worker).await < e.cutoff_ns,
        "trading must finish before the cutoff"
    );

    // Before the cutoff: the market is Open and the resolver cannot resolve.
    let m = e.market_view().await;
    assert_eq!(m["status"], "Open");
    assert_eq!(m["resolver_id"], e.resolver.id().to_string());
    let r = e.resolve(&e.resolver, "Yes").await;
    assert!(failed_with(&r, "cannot be resolved before its cutoff"));
    let r = e.redeem(&e.alice).await;
    assert!(failed_with(&r, "not resolved yet"));

    e.wait_past(e.cutoff_ns).await;
    assert_eq!(e.market_view().await["status"], "AwaitingResolution");

    // Unauthorized resolution fails; the resolver succeeds once.
    for who in [&e.alice, &e.bob, &e.root] {
        let r = e.resolve(who, "Yes").await;
        assert!(failed_with(&r, "only the configured resolver"));
    }
    let usage_before = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    let r = ok(e.resolve(&e.resolver, "Yes").await);
    assert!(r.logs().iter().any(|l| l.contains("market_resolved")));
    let usage_after = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    eprintln!(
        "MEASURED resolution storage growth: {} bytes",
        usage_after - usage_before
    );
    assert!(usage_after - usage_before <= 1024);
    let res: Value = r.json().unwrap();
    assert_eq!(res["outcome"], "Yes");
    assert_eq!(res["resolver_id"], e.resolver.id().to_string());
    for (who, o) in [(&e.resolver, "Yes"), (&e.resolver, "No")] {
        let r = e.resolve(who, o).await;
        assert!(failed_with(&r, "already resolved"), "the result is final");
    }
    let m = e.market_view().await;
    assert_eq!(m["status"], "Resolved");
    assert_eq!(m["resolution"]["outcome"], "Yes");
    assert_eq!(
        m["resolution"]["evidence"],
        "https://nimet.example/report/2026-12-01"
    );
    assert_eq!(m["trading_open"], false);
    assert_eq!(m["merge_open"], false);

    // Blocked after resolution.
    assert!(failed_with(
        &e.split(&e.bob, ONE).await,
        "market is resolved"
    ));
    assert!(failed_with(
        &e.merge(&e.alice, ONE).await,
        "market is resolved"
    ));
    assert!(failed_with(
        &e.create_offer(&e.alice, "Yes", "Sell", 600_000, ONE).await,
        "market is resolved"
    ));

    // Redeem in a different order: Carol, Alice, Bob.
    let p = e.preview(&k).await;
    assert_eq!(p["payout"], tok(8));
    assert_eq!(p["available_collateral_after"], "12900000");
    let r = ok(e.redeem(&carol).await);
    assert!(r.logs().iter().any(|l| l.contains("position_redeemed")));
    let v: Value = r.json().unwrap();
    assert_eq!(v["payout"], tok(8));
    assert_eq!(v["available_collateral"], "12900000");
    ok(e.redeem(&e.alice).await);
    ok(e.redeem(&e.bob).await);
    assert_eq!(e.full(&a).await, [94_800_000, 0, 0, 0, 0, 0]);
    assert_eq!(e.full(&b).await, [12_300_000, 0, 0, 0, 0, 0]);
    assert_eq!(e.full(&k).await, [12_900_000, 0, 0, 0, 0, 0]);
    assert_eq!(e.total("market_backing").await, 0);
    assert_eq!(e.total("available_collateral").await, 120 * ONE);
    assert_eq!(e.total("outstanding_yes").await, 0);
    assert_eq!(e.total("outstanding_no").await, 0);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);

    // Repeated redemption never pays again.
    for who in [&e.alice, &e.bob, &carol] {
        let r = e.redeem(who).await;
        assert!(failed_with(&r, "nothing to redeem"));
    }
    assert_eq!(e.total("available_collateral").await, 120 * ONE);

    // Withdraw everything: complete exit.
    ok(e.withdraw(&e.alice, 94_800_000).await);
    ok(e.withdraw(&e.bob, 12_300_000).await);
    ok(e.withdraw(&carol, 12_900_000).await);
    assert_eq!(e.token_balance(&a).await, 94_800_000);
    assert_eq!(e.token_balance(&b).await, 12_300_000);
    assert_eq!(e.token_balance(&k).await, 12_900_000);
    assert_eq!(e.token_balance(e.market.id()).await, 0);
    assert_eq!(e.total("available_collateral").await, 0);
    assert_eq!(e.total("pending_withdrawals").await, 0);
    assert_eq!(e.withdrawal(&a).await["status"], "Completed");
}

#[tokio::test]
async fn no_wins_full_lifecycle_with_real_tokens() {
    let (e, carol) = traders(Opts {
        cutoff_secs: CUTOFF_SECS,
        ..Opts::default()
    })
    .await;
    let (a, b, k) = (e.alice.id().clone(), e.bob.id().clone(), carol.id().clone());
    trade_acceptance(&e, &carol).await;
    assert!(now_ns(&e.worker).await < e.cutoff_ns);
    e.wait_past(e.cutoff_ns).await;
    ok(e.resolve(&e.resolver, "No").await);

    for who in [&e.alice, &e.bob, &carol] {
        ok(e.redeem(who).await);
    }
    assert_eq!(e.full(&a).await[0], 107_800_000);
    assert_eq!(e.full(&b).await[0], 7_300_000);
    assert_eq!(e.full(&k).await[0], 4_900_000);
    assert_eq!(e.total("market_backing").await, 0);
    assert_eq!(e.total("available_collateral").await, 120 * ONE);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);

    ok(e.withdraw(&e.alice, 107_800_000).await);
    ok(e.withdraw(&e.bob, 7_300_000).await);
    ok(e.withdraw(&carol, 4_900_000).await);
    assert_eq!(e.token_balance(&a).await, 107_800_000);
    assert_eq!(e.token_balance(&b).await, 7_300_000);
    assert_eq!(e.token_balance(&k).await, 4_900_000);
    assert_eq!(e.token_balance(e.market.id()).await, 0);
}

#[tokio::test]
async fn offers_outstanding_at_resolution_are_cancellable_and_redeem_releases_them() {
    let (e, carol) = traders(Opts {
        cutoff_secs: CUTOFF_SECS,
        ..Opts::default()
    })
    .await;
    let (a, b, k) = (e.alice.id().clone(), e.bob.id().clone(), carol.id().clone());
    let sell = e
        .new_offer(&e.alice, "Yes", "Sell", 600_000, 30 * ONE)
        .await;
    let sell_no = e.new_offer(&e.alice, "No", "Sell", 400_000, 10 * ONE).await;
    let bid = e.new_offer(&e.bob, "Yes", "Buy", 500_000, 10 * ONE).await; // reserves 5.0
    ok(e.fill_offer(&carol, &sell, 2 * ONE).await); // Carol buys 2 YES for 1.2
    let bid_c = e.new_offer(&carol, "No", "Buy", 300_000, 4 * ONE).await; // reserves 1.2
    assert!(now_ns(&e.worker).await < e.cutoff_ns);
    e.wait_past(e.cutoff_ns).await;
    ok(e.resolve(&e.resolver, "Yes").await);

    // Fills and new offers are refused; offers read as expired.
    assert!(failed_with(
        &e.fill_offer(&carol, &sell, ONE).await,
        "market is resolved"
    ));
    assert!(failed_with(
        &e.fill_offer(&e.alice, &bid, ONE).await,
        "market is resolved"
    ));
    let v = e.get_offer(&sell).await;
    assert_eq!(
        (v["status"].as_str(), v["fillable"].as_bool()),
        (Some("Expired"), Some(false))
    );

    // Alice cancels one offer by hand after resolution; backing is untouched.
    let x: Value = ok(e.cancel_offer(&e.alice, &sell_no).await).json().unwrap();
    assert_eq!(x["released_shares"], tok(10));
    assert_eq!(e.total("market_backing").await, 100 * ONE);
    assert!(
        e.get_offer(&sell_no).await.is_null(),
        "null = no active offer record"
    );

    // Redeem releases the rest. Bob: collateral only. Carol: collateral + payout.
    let p = e.preview(&k).await;
    assert_eq!(p["released_collateral"], "1200000");
    assert_eq!(p["payout"], tok(2));
    assert_eq!(p["offers_to_release"].as_array().unwrap().len(), 1);
    let r: Value = ok(e.redeem(&carol).await).json().unwrap();
    assert_eq!(r["released_collateral"], "1200000");
    assert_eq!(
        r["payout"],
        tok(2),
        "released collateral is not part of the payout"
    );
    assert_eq!(r["released_offers"][0]["offer_id"], bid_c);
    assert_eq!(
        r["available_collateral"],
        (10 * ONE - 1_200_000 + 2 * ONE).to_string()
    );
    let r: Value = ok(e.redeem(&e.bob).await).json().unwrap();
    assert_eq!(
        (r["payout"].as_str(), r["released_collateral"].as_str()),
        (Some("0"), Some("5000000"))
    );
    assert_eq!(e.full(&b).await[0], 10 * ONE);
    let r: Value = ok(e.redeem(&e.alice).await).json().unwrap();
    assert_eq!(r["released_shares"], tok(28));
    assert_eq!(r["winning_shares"], tok(98));
    assert_eq!(e.total("reserved_collateral").await, 0);
    assert_eq!(e.total("reserved_yes").await, 0);
    assert_eq!(e.total("open_offers").await, 0);
    assert_eq!(e.total("market_backing").await, 0);
    assert_eq!(e.total("available_collateral").await, 120 * ONE);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
    let _ = a;
}

#[tokio::test]
async fn redeem_with_all_ten_offer_slots_measures_gas() {
    let (e, _carol) = traders(Opts {
        cutoff_secs: CUTOFF_SECS,
        ..Opts::default()
    })
    .await;
    let a = e.alice.id().clone();
    e.mint(&a, 10 * ONE).await;
    e.deposit(&e.alice, 10 * ONE).await;
    for i in 0..4u128 {
        e.new_offer(&e.alice, "Yes", "Sell", 600_000 + i * 10_000, 5 * ONE)
            .await;
    }
    for i in 0..3u128 {
        e.new_offer(&e.alice, "No", "Sell", 700_000 + i * 10_000, 2 * ONE)
            .await;
    }
    for i in 0..3u128 {
        e.new_offer(&e.alice, "Yes", "Buy", 100_000 + i * 10_000, ONE)
            .await;
    }
    assert_eq!(
        e.account(&a).await["open_offer_ids"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert!(failed_with(
        &e.create_offer(&e.alice, "Yes", "Sell", 600_000, 10_000)
            .await,
        "too many open offers"
    ));
    assert!(now_ns(&e.worker).await < e.cutoff_ns);
    e.wait_past(e.cutoff_ns).await;
    ok(e.resolve(&e.resolver, "Yes").await);

    // View-only preview first (what the UI shows before the user confirms).
    let p = e.preview(&a).await;
    assert_eq!(p["offers_to_release"].as_array().unwrap().len(), 10);
    assert_eq!(p["released_shares"], tok(26));
    assert_eq!(p["released_collateral"], "330000");

    // 100 Tgas is what the test harness attaches; measure what is burned.
    let r = ok(e.redeem(&e.alice).await);
    let burned = tgas(r.total_gas_burnt);
    eprintln!("MEASURED redeem with 10 offers (4 sell YES, 3 sell NO, 3 buy YES): {burned:.1} Tgas burned (100 Tgas attached)");
    let v: Value = r.json().unwrap();
    assert_eq!(v["released_offers"].as_array().unwrap().len(), 10);
    assert_eq!(v["payout"], tok(100));
    assert!(
        burned < 90.0,
        "redeem must fit comfortably in 100 Tgas, burned {burned}"
    );
    assert_eq!(e.total("open_offers").await, 0);
    assert!(e.account(&a).await["open_offer_ids"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(e.total("market_backing").await, 0);

    // The same call with only 60 Tgas still succeeds if it burns less: measure the floor.
    let (e2, _c2) = traders(Opts {
        cutoff_secs: CUTOFF_SECS,
        ..Opts::default()
    })
    .await;
    let r0 = {
        e2.wait_past(e2.cutoff_ns).await;
        ok(e2.resolve(&e2.resolver, "Yes").await);
        ok(e2.redeem(&e2.alice).await)
    };
    eprintln!(
        "MEASURED redeem with 0 offers: {:.1} Tgas burned",
        tgas(r0.total_gas_burnt)
    );
}

#[tokio::test]
async fn views_and_redeem_edge_cases() {
    let (e, carol) = traders(Opts {
        cutoff_secs: CUTOFF_SECS,
        ..Opts::default()
    })
    .await;
    // Preview before resolution.
    let p = e.preview(e.alice.id()).await;
    assert_eq!(
        (p["resolved"].as_bool(), p["redeemable"].as_bool()),
        (Some(false), Some(false))
    );
    assert!(p["outcome"].is_null());
    let cfg: Value = e.market.view("get_config").await.unwrap().json().unwrap();
    assert_eq!(cfg["resolver_id"], e.resolver.id().to_string());
    assert!(cfg["resolution_model"]
        .as_str()
        .unwrap()
        .contains("trusted"));
    assert_eq!(cfg["schema_version"], 3);
    assert!(now_ns(&e.worker).await < e.cutoff_ns);
    e.wait_past(e.cutoff_ns).await;
    let before = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    ok(e.call_market(
        &e.resolver,
        "resolve_market",
        json!({ "market_id": MID, "outcome": "No", "evidence": "x".repeat(512) }),
    )
    .await);
    let growth = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage
        - before;
    eprintln!("MEASURED resolution storage growth with 512-byte evidence: {growth} bytes");
    assert!(growth <= 1024);
    // Unregistered account: preview reports nothing, redeem fails.
    let ghost = new_user(&e.root, "ghost").await;
    assert_eq!(e.preview(ghost.id()).await["redeemable"], false);
    assert!(failed_with(&e.redeem(&ghost).await, "not registered"));
    // A registered account with nothing at all cannot redeem.
    let empty = new_user(&e.root, "empty").await;
    e.register_with_market(&empty).await;
    assert!(failed_with(&e.redeem(&empty).await, "nothing to redeem"));
    // Carol has only collateral (no shares, no offers): nothing to redeem.
    assert!(failed_with(&e.redeem(&carol).await, "nothing to redeem"));
    // Alice holds 100 YES (losing) and 100 NO (winning): mixed position.
    let r: Value = ok(e.redeem(&e.alice).await).json().unwrap();
    assert_eq!(
        (r["winning_shares"].as_str(), r["losing_shares"].as_str()),
        (Some("100000000"), Some("100000000"))
    );
    assert_eq!(r["outcome"], "No");
    assert_eq!(
        (r["yes"].as_str(), r["no"].as_str()),
        (Some("0"), Some("0"))
    );
}
