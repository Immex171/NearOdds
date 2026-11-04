//! Sandbox: asynchronous withdrawal behaviour — verified transfer failure,
//! interleaved activity, pending state, and a callback that itself fails.

#![allow(unused_must_use)]

mod common;
use common::*;
use serde_json::json;

/// Receipts that failed, as (executor account, debug of the failure).
fn failed_executors(r: &near_workspaces::result::ExecutionFinalResult) -> Vec<String> {
    r.receipt_failures()
        .iter()
        .map(|o| o.executor_id.to_string())
        .collect()
}

#[tokio::test]
async fn verified_transfer_failure_restores_collateral_once() {
    let e = setup(Opts::default()).await;
    let alice = e.alice.id().clone();
    e.mint(&alice, 10 * ONE).await;
    e.deposit(&e.alice, 10 * ONE).await;
    ok(e.split(&e.alice, 4 * ONE).await);

    // Make the token transfer genuinely fail: alice has no token balance
    // left, so she can unregister from the token; ft_transfer to an
    // unregistered receiver then fails inside the TOKEN contract.
    ok(e.alice
        .call(e.token.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(YOCTO)
        .transact()
        .await
        .unwrap());

    let r = e.withdraw(&e.alice, 6 * ONE).await;
    assert_eq!(
        failed_executors(&r),
        vec![e.token.id().to_string()],
        "only the token transfer failed; the market callback succeeded"
    );
    assert!(r
        .logs()
        .iter()
        .any(|l| l.contains("withdrawal_failed_restored")));

    // Restored exactly once, shares untouched, nothing pending.
    assert_eq!(e.snapshot(&alice).await, (6 * ONE, 4 * ONE, 4 * ONE));
    assert_eq!(e.total("available_collateral").await, 6 * ONE);
    assert_eq!(e.total("pending_withdrawals").await, 0);
    assert_eq!(e.total("market_backing").await, 4 * ONE);
    assert_eq!(e.token_balance(e.market.id()).await, 10 * ONE);
    assert_eq!(e.withdrawal(&alice).await["status"], "FailedRestored");
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);

    // Replay: the market calls its own callback again with the same id.
    let replay = e
        .market
        .call("on_withdraw_complete")
        .args_json(json!({ "account_id": alice, "withdrawal_id": "1" }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(failed_with(&replay, "no pending withdrawal"));
    assert_eq!(e.snapshot(&alice).await, (6 * ONE, 4 * ONE, 4 * ONE));

    // Fix the cause (re-register) and the next withdrawal succeeds with a new id.
    e.register_with_token(&alice).await;
    ok(e.withdraw(&e.alice, 6 * ONE).await);
    assert_eq!(e.token_balance(&alice).await, 6 * ONE);
    assert_eq!(e.snapshot(&alice).await, (0, 4 * ONE, 4 * ONE));
    assert_eq!(e.withdrawal(&alice).await["withdrawal_id"], "2");
}

#[tokio::test]
async fn deposit_arriving_during_a_failing_withdrawal_is_preserved() {
    let e = setup(Opts::default()).await;
    let (alice, bob) = (e.alice.id().clone(), e.bob.id().clone());
    e.mint(&alice, 10 * ONE).await;
    e.deposit(&e.alice, 10 * ONE).await;
    e.mint(&bob, 5 * ONE).await;
    ok(e.alice
        .call(e.token.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(YOCTO)
        .transact()
        .await
        .unwrap());

    // Submit both concurrently so the deposit's receipts interleave with the
    // withdrawal's token call and callback. (Same-account interleaving is
    // pinned deterministically by the unit test
    // `failed_callback_restores_to_current_balance_once`.)
    let (w, d) = tokio::join!(
        e.withdraw(&e.alice, 10 * ONE),
        e.deposit_raw(&e.bob, 5 * ONE, "deposit")
    );
    assert!(d.is_success() && d.receipt_failures().is_empty());
    assert_eq!(failed_executors(&w), vec![e.token.id().to_string()]);

    assert_eq!(e.snapshot(&alice).await.0, 10 * ONE, "alice restored once");
    assert_eq!(e.snapshot(&bob).await.0, 5 * ONE, "bob's deposit preserved");
    assert_eq!(e.total("available_collateral").await, 15 * ONE);
    assert_eq!(e.total("pending_withdrawals").await, 0);
    assert_eq!(e.token_balance(e.market.id()).await, 15 * ONE);
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);
}

#[tokio::test]
async fn failed_callback_leaves_withdrawal_pending_without_double_payment() {
    // TEST-ONLY market build: the callback gets too little gas and fails.
    let e = setup(Opts {
        failure_injection: true,
        ..Opts::default()
    })
    .await;
    let (alice, bob) = (e.alice.id().clone(), e.bob.id().clone());
    e.mint(&alice, 10 * ONE).await;
    e.deposit(&e.alice, 10 * ONE).await;

    let r = e.withdraw(&e.alice, 4 * ONE).await;

    // The TOKEN transfer succeeded; only the market's callback failed.
    assert_eq!(failed_executors(&r), vec![e.market.id().to_string()]);
    assert_eq!(e.token_balance(&alice).await, 4 * ONE, "paid exactly once");
    assert_eq!(e.token_balance(e.market.id()).await, 6 * ONE);

    // Accounting: debited, still pending, not restored, not finalized.
    assert_eq!(e.snapshot(&alice).await.0, 6 * ONE);
    let w = e.withdrawal(&alice).await;
    assert_eq!(w["status"], "Pending");
    assert_eq!(w["amount"], tok(4));
    assert_eq!(w["withdrawal_id"], "1");
    assert_eq!(e.total("pending_withdrawals").await, 4 * ONE);
    assert_eq!(e.total("available_collateral").await, 6 * ONE);
    // Pending amount is NOT added to the escrow requirement: the tokens left.
    assert_eq!(e.assert_escrow_covers_obligations().await, 0);

    // Worst-case per-account footprint (account record + a pending record
    // that stays) must fit inside what registration prepays.
    let erin = new_user(&e.root, "erin").await;
    let before = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    e.register_with_token(erin.id()).await;
    e.register_with_market(&erin).await;
    e.mint(erin.id(), 2 * ONE).await;
    e.deposit(&erin, 2 * ONE).await;
    let _ = e.withdraw(&erin, ONE).await; // callback fails: record stays
    assert_eq!(e.withdrawal(erin.id()).await["status"], "Pending");
    let after = e
        .worker
        .view_account(e.market.id())
        .await
        .unwrap()
        .storage_usage;
    assert!(
        after - before <= STORAGE_BOUND_BYTES,
        "account + pending record used {} bytes > prepaid {}",
        after - before,
        STORAGE_BOUND_BYTES
    );

    // A second withdrawal while one is pending is refused.
    let second = e.withdraw(&e.alice, ONE).await;
    assert!(failed_with(&second, "already pending"));
    assert_eq!(
        e.token_balance(&alice).await,
        4 * ONE,
        "no duplicate payment"
    );

    // Other accounts keep working while alice's operation is pending.
    e.mint(&bob, 3 * ONE).await;
    e.deposit(&e.bob, 3 * ONE).await;
    ok(e.split(&e.bob, ONE).await);
    ok(e.merge(&e.bob, ONE).await);
    // ...and so does alice for non-withdrawal activity.
    ok(e.split(&e.alice, 6 * ONE).await);
    ok(e.merge(&e.alice, 6 * ONE).await);

    // Nobody can force settlement: outsiders are rejected, and the market's
    // own key cannot invent a promise result or use a wrong id.
    let outsider = e
        .bob
        .call(e.market.id(), "on_withdraw_complete")
        .args_json(json!({ "account_id": alice, "withdrawal_id": "1" }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(failed_with(&outsider, "private"));
    let wrong_id = e
        .market
        .call("on_withdraw_complete")
        .args_json(json!({ "account_id": alice, "withdrawal_id": "999" }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(failed_with(&wrong_id, "does not match the pending record"));
    let forged = e
        .market
        .call("on_withdraw_complete")
        .args_json(json!({ "account_id": alice, "withdrawal_id": "1" }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(failed_with(&forged, "exactly one promise result"));

    // Still pending, still exactly one payment, balances intact.
    assert_eq!(e.withdrawal(&alice).await["status"], "Pending");
    assert_eq!(e.snapshot(&alice).await.0, 6 * ONE);
    assert_eq!(e.token_balance(&alice).await, 4 * ONE);
    // alice's 4 plus erin's 1 (her callback also failed above).
    assert_eq!(e.total("pending_withdrawals").await, 5 * ONE);
    // Recovery of this state needs a separately verified design (docs).
}
