//! Sandbox: complete sets, precision, isolation, cutoff behaviour.

#![allow(unused_must_use)]

mod common;
use common::*;
use serde_json::json;

#[tokio::test]
async fn fractional_and_one_base_unit_quantities() {
    let e = setup(Opts::default()).await;
    let alice = e.alice.id().clone();
    e.mint(&alice, 3).await;
    e.deposit(&e.alice, 3).await;
    ok(e.split(&e.alice, 1).await);
    assert_eq!(e.snapshot(&alice).await, (2, 1, 1));
    assert_eq!(e.total("market_backing").await, 1);
    ok(e.split(&e.alice, 2).await);
    assert_eq!(e.snapshot(&alice).await, (0, 3, 3));
    ok(e.merge(&e.alice, 1).await);
    assert_eq!(e.snapshot(&alice).await, (1, 2, 2));
    ok(e.merge(&e.alice, 2).await);
    assert_eq!(e.snapshot(&alice).await, (3, 0, 0));
    ok(e.withdraw(&e.alice, 3).await);
    assert_eq!(
        e.token_balance(&alice).await,
        3,
        "one-base-unit precision round-trips exactly"
    );
    assert_eq!(e.token_balance(e.market.id()).await, 0);
}

#[tokio::test]
async fn failed_operations_change_nothing() {
    let e = setup(Opts::default()).await;
    let alice = e.alice.id().clone();
    e.mint(&alice, 10 * ONE).await;
    e.deposit(&e.alice, 10 * ONE).await;
    ok(e.split(&e.alice, 4 * ONE).await);
    let before = (e.snapshot(&alice).await, e.totals().await);

    let bad = [
        e.split(&e.alice, 0).await,
        e.merge(&e.alice, 0).await,
        e.split(&e.alice, 6 * ONE + 1).await,
        e.merge(&e.alice, 4 * ONE + 1).await,
        e.call_market(
            &e.alice,
            "split_position",
            json!({ "market_id": "other", "amount": "1" }),
        )
        .await,
        e.call_market(
            &e.alice,
            "merge_positions",
            json!({ "market_id": "other", "amount": "1" }),
        )
        .await,
        // u128::MAX overflows backing / exceeds balances
        e.split(&e.alice, u128::MAX).await,
        e.merge(&e.alice, u128::MAX).await,
    ];
    for r in &bad {
        assert!(!r.is_success(), "should have failed");
    }
    assert!(failed_with(&bad[0], "greater than zero"));
    assert!(failed_with(&bad[2], "insufficient available collateral"));
    assert!(failed_with(&bad[3], "insufficient YES/NO shares"));
    assert!(failed_with(&bad[4], "unknown market id"));
    assert_eq!((e.snapshot(&alice).await, e.totals().await), before);
}

#[tokio::test]
async fn one_yocto_is_required_for_every_user_operation() {
    let e = setup(Opts::default()).await;
    e.mint(e.alice.id(), ONE).await;
    e.deposit(&e.alice, ONE).await;
    for (method, args) in [
        ("split_position", json!({ "market_id": MID, "amount": "1" })),
        (
            "merge_positions",
            json!({ "market_id": MID, "amount": "1" }),
        ),
        ("withdraw", json!({ "amount": "1" })),
    ] {
        let r = e
            .alice
            .call(e.market.id(), method)
            .args_json(args)
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await
            .unwrap();
        assert!(failed_with(&r, "exactly 1 yoctoNEAR"), "{method}");
    }
    assert_eq!(e.snapshot(e.alice.id()).await, (ONE, 0, 0));
}

#[tokio::test]
async fn accounts_are_isolated() {
    let e = setup(Opts::default()).await;
    e.mint(e.alice.id(), 20 * ONE).await;
    e.mint(e.bob.id(), 5 * ONE).await;
    e.deposit(&e.alice, 20 * ONE).await;
    e.deposit(&e.bob, 5 * ONE).await;
    ok(e.split(&e.alice, 10 * ONE).await);

    // Bob holds no shares: he cannot merge or withdraw Alice's backing.
    assert!(!e.merge(&e.bob, ONE).await.is_success());
    assert!(!e.withdraw(&e.bob, 5 * ONE + 1).await.is_success());
    assert_eq!(
        e.snapshot(e.alice.id()).await,
        (10 * ONE, 10 * ONE, 10 * ONE)
    );
    assert_eq!(e.snapshot(e.bob.id()).await, (5 * ONE, 0, 0));

    // Bob's own activity does not move Alice's balances.
    ok(e.split(&e.bob, 2 * ONE).await);
    ok(e.withdraw(&e.bob, 3 * ONE).await);
    assert_eq!(
        e.snapshot(e.alice.id()).await,
        (10 * ONE, 10 * ONE, 10 * ONE)
    );
    assert_eq!(e.snapshot(e.bob.id()).await, (0, 2 * ONE, 2 * ONE));
    assert_eq!(e.total("market_backing").await, 12 * ONE);
    assert_eq!(e.total("outstanding_yes").await, 12 * ONE);
    assert_eq!(e.total("available_collateral").await, 10 * ONE);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
}

#[tokio::test]
async fn repeated_split_merge_conserves_backing_against_the_token() {
    let e = setup(Opts::default()).await;
    let alice = e.alice.id().clone();
    e.mint(&alice, 1_000_003).await;
    e.deposit(&e.alice, 1_000_003).await;
    for i in 1..=6u128 {
        ok(e.split(&e.alice, i * 1_000 + 7).await);
        ok(e.merge(&e.alice, i * 37 + 1).await);
        let (avail, yes, no) = e.snapshot(&alice).await;
        assert_eq!(yes, no);
        assert_eq!(
            avail + yes,
            1_000_003,
            "collateral conserved after round {i}"
        );
        assert_eq!(e.total("market_backing").await, yes);
        assert_eq!(e.total("outstanding_yes").await, yes);
        assert_eq!(e.assert_escrow_covers_obligations().await, 0);
    }
}

#[tokio::test]
async fn split_closes_at_cutoff_but_merge_and_withdraw_stay_open() {
    let e = setup(Opts {
        cutoff_secs: 90,
        ..Opts::default()
    })
    .await;
    let alice = e.alice.id().clone();
    e.mint(&alice, 10 * ONE).await;
    e.deposit(&e.alice, 10 * ONE).await;
    let view: serde_json::Value = e
        .market
        .view("get_market")
        .args_json(json!({ "market_id": MID }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(view["split_open"], true);
    assert!(
        now_ns(&e.worker).await < e.cutoff_ns,
        "test must start before the cutoff"
    );
    ok(e.split(&e.alice, 6 * ONE).await);

    e.wait_past(e.cutoff_ns).await;

    let view: serde_json::Value = e
        .market
        .view("get_market")
        .args_json(json!({ "market_id": MID }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(view["split_open"], false);
    let r = e.split(&e.alice, ONE).await;
    assert!(failed_with(&r, "splitting is closed"));
    // Merging and withdrawing remain possible, as do new deposits.
    ok(e.merge(&e.alice, 2 * ONE).await);
    ok(e.withdraw(&e.alice, 6 * ONE).await);
    assert_eq!(e.snapshot(&alice).await, (0, 4 * ONE, 4 * ONE));
    assert_eq!(e.token_balance(&alice).await, 6 * ONE);
    e.mint(&alice, ONE).await;
    e.deposit(&e.alice, ONE).await;
    assert_eq!(e.snapshot(&alice).await.0, ONE);
    ok(e.merge(&e.alice, 4 * ONE).await);
    ok(e.withdraw(&e.alice, 5 * ONE).await);
    assert_eq!(e.token_balance(&alice).await, 11 * ONE);
    assert_eq!(e.token_balance(e.market.id()).await, 0);
}
