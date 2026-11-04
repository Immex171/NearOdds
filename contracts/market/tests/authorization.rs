//! Sandbox: who can call what, and what does not exist.

#![allow(unused_must_use)]

mod common;
use common::*;
use serde_json::json;

#[tokio::test]
async fn init_cannot_run_twice() {
    let e = setup(Opts::default()).await;
    let r = e
        .alice
        .call(e.market.id(), "new")
        .args_json(json!({
            "collateral_token": e.alice.id(),
            "market_id": "evil",
            "question": "q",
            "rules": "r",
            "split_cutoff_ns": "99999999999999999999"
        }))
        .transact()
        .await
        .unwrap();
    assert!(!r.is_success());
    let cfg: serde_json::Value = e.market.view("get_config").await.unwrap().json().unwrap();
    assert_eq!(cfg["collateral_token_id"], e.token.id().to_string());
    assert_eq!(cfg["market_id"], MID);
}

#[tokio::test]
async fn private_callback_rejects_outside_callers() {
    let e = setup(Opts::default()).await;
    e.mint(e.alice.id(), ONE).await;
    e.deposit(&e.alice, ONE).await;
    let r = e
        .alice
        .call(e.market.id(), "on_withdraw_complete")
        .args_json(json!({ "account_id": e.alice.id(), "withdrawal_id": "1" }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(failed_with(&r, "private"), "{:#?}", r.failures());
    assert_eq!(e.snapshot(e.alice.id()).await.0, ONE);
}

#[tokio::test]
async fn no_admin_or_future_feature_methods_exist() {
    let e = setup(Opts::default()).await;
    // The deployer/owner key and every account get MethodNotFound: there is
    // no way to mint shares, set balances, move the reserve or call
    // placeholder trading/resolution methods.
    for method in [
        "mint",
        "set_balance",
        "credit",
        "deposit",
        "admin_withdraw",
        "sweep",
        "create_offer",
        "take_offer",
        "cancel_offer",
        "resolve_market",
        "redeem",
        "create_market",
        "refund",
        "storage_unregister",
        "storage_withdraw",
    ] {
        for caller in [&e.root, &e.alice] {
            let r = caller
                .call(e.market.id(), method)
                .args_json(json!({ "account_id": e.alice.id(), "amount": "1" }))
                .max_gas()
                .transact()
                .await
                .unwrap();
            assert!(!r.is_success(), "{method} must not exist");
            assert!(
                failed_with(&r, "MethodNotFound") || failed_with(&r, "MethodResolveError"),
                "{method}: {:#?}",
                r.failures()
            );
        }
    }
}

#[tokio::test]
async fn views_report_configuration() {
    let e = setup(Opts::default()).await;
    let cfg: serde_json::Value = e.market.view("get_config").await.unwrap().json().unwrap();
    assert_eq!(cfg["decimals"], 6);
    assert_eq!(cfg["deposit_msg"], "deposit");
    assert_eq!(cfg["schema_version"], 1);
    let m: serde_json::Value = e
        .market
        .view("get_market")
        .args_json(json!({ "market_id": MID }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(m["market_id"], MID);
    assert_eq!(m["collateral_token_id"], e.token.id().to_string());
    let bal: serde_json::Value = e
        .market
        .view("storage_balance_of")
        .args_json(json!({ "account_id": e.alice.id() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert!(bal["total"].as_str().unwrap().parse::<u128>().unwrap() > 0);
    // Unknown market view fails.
    assert!(e
        .market
        .view("get_market")
        .args_json(json!({ "market_id": "nope" }))
        .await
        .is_err());
}

#[tokio::test]
async fn token_has_six_decimals_and_test_name() {
    let e = setup(Opts::default()).await;
    let md: serde_json::Value = e.token.view("ft_metadata").await.unwrap().json().unwrap();
    assert_eq!(md["decimals"], 6);
    assert!(md["name"].as_str().unwrap().contains("TEST"));
    // Only the owner can mint on the fixture; the market cannot.
    let r = e
        .alice
        .call(e.token.id(), "mint")
        .args_json(json!({ "account_id": e.alice.id(), "amount": "1" }))
        .transact()
        .await
        .unwrap();
    assert!(failed_with(&r, "only the fixture owner"));
}
