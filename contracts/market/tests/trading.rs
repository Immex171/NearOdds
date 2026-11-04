#![allow(unused_must_use)]
//! Sandbox: Milestone 2 trading against the real Wasm with real tokens.

mod common;
use common::*;
use serde_json::{json, Value};

const P60: u128 = 600_000;
const P70: u128 = 700_000;

/// Alice: 100 collateral deposited and split. Bob, Carol: 10 collateral each.
async fn traders(opts: Opts) -> (Env, near_workspaces::Account) {
    let e = setup(opts).await;
    let carol = new_user(&e.root, "carol").await;
    e.register_with_token(carol.id()).await;
    e.register_with_market(&carol).await;
    e.mint(e.alice.id(), 100 * ONE).await;
    e.mint(e.bob.id(), 10 * ONE).await;
    e.mint(carol.id(), 10 * ONE).await;
    e.deposit(&e.alice, 100 * ONE).await;
    ok(e.split(&e.alice, 100 * ONE).await);
    e.deposit(&e.bob, 10 * ONE).await;
    e.deposit(&carol, 10 * ONE).await;
    (e, carol)
}

#[tokio::test]
async fn acceptance_scenario_with_real_tokens() {
    let (e, carol) = traders(Opts::default()).await;
    let (a, b, k) = (e.alice.id().clone(), e.bob.id().clone(), carol.id().clone());

    // 3. Alice offers 20 YES at 0.60.
    let r = ok(e.create_offer(&e.alice, "Yes", "Sell", P60, 20 * ONE).await);
    assert!(r.logs().iter().any(|l| l.contains("offer_created")));
    let offer: Value = r.json().unwrap();
    let id = offer["offer_id"].as_str().unwrap().to_string();
    assert_eq!(offer["status"], "Open");
    assert_eq!(offer["reserved_shares"], tok(20));
    assert_eq!(e.full(&a).await, [0, 0, 80 * ONE, 20 * ONE, 100 * ONE, 0]);

    // 4. Bob buys 8.  5. Carol buys 5.
    let r = ok(e.fill_offer(&e.bob, &id, 8 * ONE).await);
    assert!(r.logs().iter().any(|l| l.contains("offer_filled")));
    let f: Value = r.json().unwrap();
    assert_eq!(f["collateral_amount"], "4800000");
    assert_eq!(f["remaining_quantity"], tok(12));
    assert_eq!(f["status"], "PartiallyFilled");
    let f: Value = ok(e.fill_offer(&carol, &id, 5 * ONE).await).json().unwrap();
    assert_eq!(f["collateral_amount"], "3000000");
    assert_eq!(e.get_offer(&id).await["status"], "PartiallyFilled");

    // 6. Alice cancels the remaining 7.
    let r = ok(e.cancel_offer(&e.alice, &id).await);
    assert!(r.logs().iter().any(|l| l.contains("offer_cancelled")));
    let c: Value = r.json().unwrap();
    assert_eq!(c["released_shares"], tok(7));
    assert!(e.get_offer(&id).await.is_null());

    // 7. Bob resells 3 YES to Carol at 0.70.
    let id2 = e.new_offer(&e.bob, "Yes", "Sell", P70, 3 * ONE).await;
    let f: Value = ok(e.fill_offer(&carol, &id2, 3 * ONE).await)
        .json()
        .unwrap();
    assert_eq!(f["collateral_amount"], "2100000");
    assert_eq!(f["status"], "Filled");

    // Final available balances, no reserves left.
    assert_eq!(e.full(&a).await, [7_800_000, 0, 87 * ONE, 0, 100 * ONE, 0]);
    assert_eq!(e.full(&b).await, [7_300_000, 0, 5 * ONE, 0, 0, 0]);
    assert_eq!(e.full(&k).await, [4_900_000, 0, 8 * ONE, 0, 0, 0]);
    let t = e.totals().await;
    for key in ["reserved_collateral", "reserved_yes", "reserved_no"] {
        assert_eq!(t[key], "0", "{key}");
    }
    assert_eq!(t["open_offers"], "0");
    assert_eq!(e.total("market_backing").await, 100 * ONE);
    assert_eq!(e.total("outstanding_yes").await, 100 * ONE);
    assert_eq!(e.total("outstanding_no").await, 100 * ONE);
    assert_eq!(e.total("available_collateral").await, 20 * ONE);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);

    // Exit: Carol merges nothing (no NO); Alice merges 87 and everyone withdraws.
    ok(e.merge(&e.alice, 87 * ONE).await);
    ok(e.withdraw(&e.alice, 7_800_000 + 87 * ONE).await);
    ok(e.withdraw(&e.bob, 7_300_000).await);
    ok(e.withdraw(&carol, 4_900_000).await);
    assert_eq!(e.token_balance(&a).await, 94_800_000);
    assert_eq!(e.token_balance(&b).await, 7_300_000);
    assert_eq!(e.token_balance(&k).await, 4_900_000);
    // 13 backing remains for Alice's 13 NO + the others' 13 YES.
    assert_eq!(e.token_balance(e.market.id()).await, 13 * ONE);
    assert_eq!(e.total("market_backing").await, 13 * ONE);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
}

#[tokio::test]
async fn validation_authorization_and_reuse_errors_change_nothing() {
    let (e, carol) = traders(Opts::default()).await;
    let a = e.alice.id().clone();
    let id = e.new_offer(&e.alice, "Yes", "Sell", P60, 10 * ONE).await;
    let before = (e.totals().await, e.full(&a).await, e.full(e.bob.id()).await);

    let cases: Vec<(near_workspaces::result::ExecutionFinalResult, &str)> = vec![
        (e.create_offer(&e.bob, "Yes", "Sell", 0, ONE).await, "invalid price"),
        (e.create_offer(&e.bob, "Yes", "Sell", 505_000, ONE).await, "invalid price"),
        (e.create_offer(&e.bob, "Yes", "Sell", 1_000_000, ONE).await, "invalid price"),
        (e.create_offer(&e.alice, "Yes", "Sell", P60, 99).await, "invalid quantity"),
        (e.create_offer(&e.alice, "Yes", "Sell", P60, ONE + 1).await, "invalid quantity"),
        (e.create_offer(&e.alice, "Yes", "Sell", P60, 0).await, "invalid quantity"),
        // not enough available shares / collateral
        (e.create_offer(&e.bob, "Yes", "Sell", P60, ONE).await, "insufficient YES/NO shares"),
        (e.create_offer(&e.bob, "No", "Buy", 900_000, 12 * ONE).await, "insufficient available collateral"),
        // reserved shares cannot be offered again or merged
        (e.create_offer(&e.alice, "Yes", "Sell", P60, 91 * ONE).await, "insufficient YES/NO shares"),
        (e.merge(&e.alice, 91 * ONE).await, "insufficient YES/NO shares"),
        // unauthorized cancel / self-fill / overfill / unknown id / bad lot
        (e.cancel_offer(&e.bob, &id).await, "only the offer owner"),
        (e.fill_offer(&e.alice, &id, ONE).await, "cannot fill your own"),
        (e.fill_offer(&e.bob, &id, 10 * ONE + 100).await, "exceeds the offer's remaining"),
        (e.fill_offer(&e.bob, &id, 150).await, "invalid fill quantity"),
        (e.fill_offer(&e.bob, "123456", ONE).await, "offer not found"),
        (e.cancel_offer(&e.alice, "123456").await, "offer not found"),
        (e.fill_offer(&carol, &id, 11 * ONE).await, "exceeds the offer's remaining"),
        // invalid enum values never reach the ledger
        (
            e.call_market(&e.bob, "create_offer", json!({"market_id": MID, "outcome": "Maybe", "side": "Sell", "price": "600000", "quantity": "1000000"})).await,
            "Failed to deserialize",
        ),
        (
            e.call_market(&e.bob, "create_offer", json!({"market_id": "other", "outcome": "Yes", "side": "Sell", "price": "600000", "quantity": "1000000"})).await,
            "unknown market id",
        ),
    ];
    for (i, (r, needle)) in cases.iter().enumerate() {
        assert!(!r.is_success(), "case {i} should fail");
        assert!(
            failed_with(r, needle),
            "case {i}: expected {needle:?}, got {:#?}",
            r.failures()
        );
    }
    // A reserved-collateral buy cannot be withdrawn or reused either.
    e.new_offer(&e.bob, "Yes", "Buy", 900_000, 10 * ONE).await; // reserves 9.0
    assert!(!e.withdraw(&e.bob, 2 * ONE).await.is_success());
    assert!(!e.split(&e.bob, 2 * ONE).await.is_success());
    assert_eq!(e.full(e.bob.id()).await[0], ONE);

    let after_totals = e.totals().await;
    assert_eq!(after_totals["reserved_yes"], tok(10));
    assert_eq!(after_totals["reserved_collateral"], tok(9));
    assert_eq!(before.1, e.full(&a).await, "alice untouched by failures");
    assert_eq!(e.get_offer(&id).await["filled_quantity"], "0");
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
}

#[tokio::test]
async fn buy_offer_partial_fill_and_exact_return_on_cancel() {
    let (e, _carol) = traders(Opts::default()).await;
    let (a, b) = (e.alice.id().clone(), e.bob.id().clone());
    let id = e.new_offer(&e.bob, "Yes", "Buy", P60, 10 * ONE).await;
    assert_eq!(e.full(&b).await[..2], [4 * ONE, 6 * ONE]);
    let f: Value = ok(e.fill_offer(&e.alice, &id, 4 * ONE).await)
        .json()
        .unwrap();
    assert_eq!(f["collateral_amount"], "2400000");
    assert_eq!(e.full(&b).await, [4 * ONE, 3_600_000, 4 * ONE, 0, 0, 0]);
    let c: Value = ok(e.cancel_offer(&e.bob, &id).await).json().unwrap();
    assert_eq!(c["released_collateral"], "3600000");
    assert_eq!(c["released_shares"], "0");
    assert_eq!(e.full(&b).await, [7_600_000, 0, 4 * ONE, 0, 0, 0]);
    assert_eq!(e.full(&a).await[0], 2_400_000);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
    assert_eq!(e.total("market_backing").await, 100 * ONE);
}

#[tokio::test]
async fn precision_one_fill_equals_many_fills() {
    let (e, carol) = traders(Opts::default()).await;
    // Two identical offers; Bob takes one in a single fill, Carol takes the
    // other in seven uneven valid pieces. They must pay exactly the same.
    let a_id = e.new_offer(&e.alice, "No", "Sell", 730_000, 2 * ONE).await;
    let b_id = e.new_offer(&e.alice, "No", "Sell", 730_000, 2 * ONE).await;
    let pieces = [100u128, 300, 1_700, 20_000, 5_400, 970_000, 2_500];
    let total: u128 = pieces.iter().sum();
    let f: Value = ok(e.fill_offer(&e.bob, &a_id, total).await).json().unwrap();
    let one = f["collateral_amount"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let mut many = 0u128;
    for p in pieces {
        let f: Value = ok(e.fill_offer(&carol, &b_id, p).await).json().unwrap();
        many += f["collateral_amount"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
    }
    assert_eq!(one, many);
    assert_eq!(one * 1_000_000, 730_000 * total, "exact, no rounding");
    // Smallest tick and lot.
    let tiny = e.new_offer(&e.alice, "Yes", "Sell", 10_000, 10_000).await;
    let f: Value = ok(e.fill_offer(&e.bob, &tiny, 100).await).json().unwrap();
    assert_eq!(f["collateral_amount"], "1");
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
}

#[tokio::test]
async fn trading_closes_at_cutoff_but_makers_can_always_cancel() {
    let (e, _carol) = traders(Opts {
        cutoff_secs: 180,
        ..Opts::default()
    })
    .await;
    assert!(
        now_ns(&e.worker).await < e.cutoff_ns,
        "test must start before the cutoff"
    );
    let sell = e.new_offer(&e.alice, "Yes", "Sell", P60, 5 * ONE).await;
    let buy = e.new_offer(&e.bob, "Yes", "Buy", P60, 5 * ONE).await;
    assert_eq!(e.get_offer(&sell).await["fillable"], true);

    e.wait_past(e.cutoff_ns).await;

    let r = e.fill_offer(&e.bob, &sell, ONE).await;
    assert!(failed_with(&r, "trading is closed"));
    let r = e.create_offer(&e.alice, "Yes", "Sell", P60, ONE).await;
    assert!(failed_with(&r, "trading is closed"));
    let v = e.get_offer(&sell).await;
    assert_eq!(v["status"], "Expired");
    assert_eq!(v["fillable"], false);
    // Reserves are recoverable without waiting for any worker.
    let c: Value = ok(e.cancel_offer(&e.alice, &sell).await).json().unwrap();
    assert_eq!(c["released_shares"], tok(5));
    let c: Value = ok(e.cancel_offer(&e.bob, &buy).await).json().unwrap();
    assert_eq!(c["released_collateral"], tok(3));
    assert_eq!(e.full(e.alice.id()).await[2], 100 * ONE);
    assert_eq!(e.full(e.bob.id()).await[..2], [10 * ONE, 0]);
    assert_eq!(e.total("open_offers").await, 0);
    // Merge and withdraw still work.
    ok(e.merge(&e.alice, 100 * ONE).await);
    ok(e.withdraw(&e.alice, 100 * ONE).await);
}

#[tokio::test]
async fn fill_and_cancel_race_never_double_spends() {
    let (e, _carol) = traders(Opts::default()).await;
    let a = e.alice.id().clone();
    for round in 0..2 {
        let id = e.new_offer(&e.alice, "Yes", "Sell", P60, 10 * ONE).await;
        let (f, c) = tokio::join!(
            e.fill_offer(&e.bob, &id, 4 * ONE),
            e.cancel_offer(&e.alice, &id)
        );
        // Whatever the order: the cancel succeeds (it can always release the
        // remainder) and the fill either fully succeeded first or failed.
        assert!(c.is_success(), "round {round}: cancel must always succeed");
        let released: Value = c.json().unwrap();
        let filled = f.is_success();
        let expected_released = if filled { 6 * ONE } else { 10 * ONE };
        assert_eq!(released["released_shares"], expected_released.to_string());
        if !filled {
            assert!(failed_with(&f, "offer not found"));
        }
        assert!(e.get_offer(&id).await.is_null());
        let alice_yes = e.full(&a).await[2];
        let bob_yes = e.full(e.bob.id()).await[2];
        assert_eq!(alice_yes + bob_yes, 100 * ONE, "no share created or lost");
        assert_eq!(e.total("reserved_yes").await, 0);
        assert_eq!(e.total("open_offers").await, 0);
        if filled {
            assert_eq!(bob_yes, 4 * ONE);
        }
        // Reset for the next round: Bob sends his YES back via a Buy offer fill.
        if filled {
            let back = e.new_offer(&e.bob, "Yes", "Sell", P60, 4 * ONE).await;
            ok(e.fill_offer(&e.alice, &back, 4 * ONE).await);
        }
    }
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
}

#[tokio::test]
async fn trading_interleaved_with_withdrawal_and_deposit() {
    let (e, _carol) = traders(Opts::default()).await;
    let (a, b) = (e.alice.id().clone(), e.bob.id().clone());
    let id = e.new_offer(&e.alice, "Yes", "Sell", P60, 30 * ONE).await;
    ok(e.merge(&e.alice, 70 * ONE).await); // 70 unreserved YES + NO
    e.mint(&b, 5 * ONE).await;
    // Withdrawal, a fill and a deposit all in flight together.
    let (w, f, d) = tokio::join!(
        e.withdraw(&e.alice, 40 * ONE),
        e.fill_offer(&e.bob, &id, 10 * ONE),
        e.deposit_raw(&e.bob, 5 * ONE, "deposit")
    );
    assert!(w.is_success() && w.receipt_failures().is_empty());
    assert!(f.is_success() && d.is_success());
    // Alice: 70 merged - 40 withdrawn + 6.0 proceeds.
    assert_eq!(e.full(&a).await[0], 30 * ONE + 6 * ONE);
    assert_eq!(e.full(&a).await[3], 20 * ONE, "20 still reserved");
    assert_eq!(e.token_balance(&a).await, 40 * ONE);
    // Bob: 10 + 5 deposited - 6.0 paid
    assert_eq!(e.full(&b).await[0], 15 * ONE - 6 * ONE);
    ok(e.cancel_offer(&e.alice, &id).await);
    assert_eq!(e.full(&a).await[2], 20 * ONE);
    assert_eq!(e.total("reserved_yes").await, 0);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
}

#[tokio::test]
async fn offer_storage_is_prepaid_and_bounded() {
    let (e, _carol) = traders(Opts {
        failure_injection: true, // lets a pending withdrawal record stay put
        ..Opts::default()
    })
    .await;
    let erin = new_user(&e.root, "erin").await;
    e.register_with_token(erin.id()).await;
    e.mint(erin.id(), 50 * ONE).await;

    let before = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    e.register_with_market(&erin).await;
    e.deposit(&erin, 50 * ONE).await;
    ok(e.split(&erin, 20 * ONE).await);
    let mut ids = vec![];
    for i in 0..5 {
        ids.push(
            e.new_offer(&erin, "Yes", "Sell", P60 + i * 10_000, 10_000)
                .await,
        );
    }
    for i in 0..5 {
        ids.push(
            e.new_offer(&erin, "No", "Buy", 100_000 + i * 10_000, 10_000)
                .await,
        );
    }
    // The 11th open offer is refused and cannot create unfunded records.
    let r = e.create_offer(&erin, "Yes", "Sell", P60, 10_000).await;
    assert!(failed_with(&r, "too many open offers"));
    // Worst case: 10 offers + a pending withdrawal record that stays pending.
    let _ = e.withdraw(&erin, ONE).await;
    assert_eq!(e.withdrawal(erin.id()).await["status"], "Pending");
    let after = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    eprintln!(
        "MEASURED account + 10 offers + pending record: {} bytes (prepaid bound {})",
        after - before,
        STORAGE_BOUND_BYTES
    );
    assert!(
        after - before <= STORAGE_BOUND_BYTES,
        "account + 10 offers + pending record used {} bytes > prepaid {}",
        after - before,
        STORAGE_BOUND_BYTES
    );
    // Freed slots are reusable and do not grow storage.
    ok(e.cancel_offer(&erin, &ids[0]).await);
    let again = e.new_offer(&erin, "Yes", "Sell", P60, 10_000).await;
    assert!(!again.is_empty());
    let end = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    assert!(
        end <= after + 64,
        "re-using a slot must not grow storage materially"
    );
}

#[tokio::test]
async fn views_paginate_offers_and_report_account_offers() {
    let (e, _carol) = traders(Opts::default()).await;
    for i in 0..5 {
        e.new_offer(&e.alice, "Yes", "Sell", 500_000 + i * 10_000, 10_000)
            .await;
    }
    e.new_offer(&e.alice, "No", "Sell", P60, 10_000).await;
    e.new_offer(&e.bob, "Yes", "Buy", 300_000, 10_000).await;
    let list = |outcome: &'static str, side: &'static str, from: u64, limit: u64| {
        let m = e.market.clone();
        async move {
            let v: Vec<Value> = m
                .view("list_offers")
                .args_json(json!({
                    "market_id": MID, "outcome": outcome, "side": side,
                    "from_index": from.to_string(), "limit": limit
                }))
                .await
                .unwrap()
                .json()
                .unwrap();
            v
        }
    };
    assert_eq!(list("Yes", "Sell", 0, 20).await.len(), 5);
    assert_eq!(list("Yes", "Sell", 3, 20).await.len(), 2);
    assert_eq!(list("Yes", "Sell", 0, 2).await.len(), 2);
    assert_eq!(list("No", "Sell", 0, 20).await.len(), 1);
    assert_eq!(list("Yes", "Buy", 0, 20).await.len(), 1);
    assert_eq!(list("No", "Buy", 0, 20).await.len(), 0);
    let mine: Vec<Value> = e
        .market
        .view("get_account_offers")
        .args_json(json!({ "account_id": e.alice.id() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(mine.len(), 6);
    assert!(mine
        .iter()
        .all(|o| o["owner_id"] == e.alice.id().to_string()));
    let cfg: Value = e.market.view("get_config").await.unwrap().json().unwrap();
    assert_eq!(cfg["trading"]["price_tick"], "10000");
    assert_eq!(cfg["trading"]["quantity_lot"], "100");
    assert_eq!(cfg["trading"]["fee_bps"], 0);
    assert_eq!(cfg["schema_version"], 2);
}
