#![allow(unused_must_use)]
//! Deployment smoke test: the SAME scenario runs on the local Sandbox (always)
//! and on NEAR testnet (only when you provide a funded parent account).
//!
//! Testnet run (see docs/testnet.md):
//!   NEARODDS_TESTNET_PARENT=<funded testnet account id> \
//!   NEARODDS_TESTNET_PARENT_KEY=ed25519:<its full-access secret key> \
//!   cargo test -p nearodds-market --test testnet_smoke smoke_on_testnet -- --ignored --nocapture
//!
//! It creates fresh sub-accounts of the parent, deploys the production
//! `market.wasm` and the `test_collateral.wasm` fixture (never the
//! failure-injection build), runs deposit -> split -> offer -> partial fills ->
//! cancel -> resale -> merge -> withdraw, and writes the facts to
//! `deployments/testnet.json` (accounts, commit, hashes, tx hashes).

mod common;
use common::*;

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken, SecretKey};
use near_workspaces::Network;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::process::Command;

struct Recorder {
    steps: Vec<Value>,
}

impl Recorder {
    fn record(&mut self, step: &str, r: &ExecutionFinalResult) {
        let tx = r.outcome().transaction_hash.to_string();
        let full_ok = r.is_success() && r.receipt_failures().is_empty();
        println!(
            "  {step:<34} {} {tx}",
            if full_ok { "OK  " } else { "FAIL" }
        );
        self.steps
            .push(json!({ "step": step, "tx_hash": tx, "succeeded": full_ok }));
        assert!(full_ok, "step {step} failed: {:#?}", r.failures());
    }
}

async fn user(parent: &Account, name: &str, near: u128) -> Account {
    parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await
        .unwrap()
        .unwrap()
}

fn num(v: &Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

/// Runs the full scenario. Returns the deployment facts.
async fn run_smoke<T: Network + 'static>(worker: &Worker<T>, parent: &Account, tag: &str) -> Value {
    let mut rec = Recorder { steps: vec![] };
    let gas = Gas::from_tgas(100);

    let token_wasm = wasm("test_collateral");
    let market_wasm = wasm("market");
    let now = worker.view_block().await.unwrap().timestamp();
    let cutoff_ns = now + 24 * 3600 * 1_000_000_000;

    // Accounts and deployments.
    let token_acct = user(parent, &format!("tok-{tag}"), 4).await;
    let token = token_acct.deploy(&token_wasm).await.unwrap().unwrap();
    rec.record(
        "token: init",
        &token
            .call("new")
            .args_json(json!({ "owner_id": parent.id() }))
            .transact()
            .await
            .unwrap(),
    );

    let market_acct = user(parent, &format!("mkt-{tag}"), 5).await;
    let batch = market_acct
        .batch(market_acct.id())
        .deploy(&market_wasm)
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(json!({
                    "collateral_token": token.id(),
                    "market_id": MID,
                    "question": "Will it rain in Lagos on 2026-12-01?",
                    "rules": "Resolves YES if the NiMet daily report records measurable rain.",
                    "split_cutoff_ns": cutoff_ns.to_string(),
                }))
                .gas(gas),
        )
        .transact()
        .await
        .unwrap();
    rec.record("market: deploy + init (one tx)", &batch);
    let market = Contract::from_secret_key(
        market_acct.id().clone(),
        market_acct.secret_key().clone(),
        worker,
    );

    let alice = user(parent, &format!("alice-{tag}"), 2).await;
    let bob = user(parent, &format!("bob-{tag}"), 2).await;
    let carol = user(parent, &format!("carol-{tag}"), 2).await;

    let cfg: Value = market.view("get_config").await.unwrap().json().unwrap();
    let cost = NearToken::from_yoctonear(
        cfg["storage_cost_per_account"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    );
    for id in [market.id(), alice.id(), bob.id(), carol.id()] {
        rec.record(
            "token: storage_deposit",
            &parent
                .call(token.id(), "storage_deposit")
                .args_json(json!({ "account_id": id, "registration_only": true }))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await
                .unwrap(),
        );
    }
    for who in [&alice, &bob, &carol] {
        rec.record(
            "market: storage_deposit",
            &who.call(market.id(), "storage_deposit")
                .args_json(json!({ "account_id": null, "registration_only": true }))
                .deposit(cost)
                .transact()
                .await
                .unwrap(),
        );
    }
    for (who, amt) in [(&alice, 100), (&bob, 10), (&carol, 10)] {
        rec.record(
            "token: mint (fixture owner)",
            &parent
                .call(token.id(), "mint")
                .args_json(json!({ "account_id": who.id(), "amount": tok(amt) }))
                .transact()
                .await
                .unwrap(),
        );
    }

    let call = |who: &Account, method: &str, args: Value| {
        who.call(market.id(), method)
            .args_json(args)
            .deposit(YOCTO)
            .gas(gas)
            .transact()
    };

    // Deposit (real ft_transfer_call), split.
    for (who, amt) in [(&alice, 100), (&bob, 10), (&carol, 10)] {
        rec.record(
            "deposit (ft_transfer_call)",
            &who.call(token.id(), "ft_transfer_call")
                .args_json(
                    json!({ "receiver_id": market.id(), "amount": tok(amt), "msg": "deposit" }),
                )
                .deposit(YOCTO)
                .gas(MAX_GAS)
                .transact()
                .await
                .unwrap(),
        );
    }
    rec.record(
        "alice: split 100",
        &call(
            &alice,
            "split_position",
            json!({ "market_id": MID, "amount": tok(100) }),
        )
        .await
        .unwrap(),
    );

    // Trade: offer, two partial fills, cancel remainder, resale.
    let r = call(
        &alice,
        "create_offer",
        json!({ "market_id": MID, "outcome": "Yes", "side": "Sell", "price": "600000", "quantity": tok(20) }),
    )
    .await
    .unwrap();
    rec.record("alice: create_offer 20 YES @0.60", &r);
    let id = r.json::<Value>().unwrap()["offer_id"]
        .as_str()
        .unwrap()
        .to_string();
    rec.record(
        "bob: fill 8",
        &call(
            &bob,
            "fill_offer",
            json!({ "offer_id": id, "quantity": tok(8) }),
        )
        .await
        .unwrap(),
    );
    rec.record(
        "carol: fill 5",
        &call(
            &carol,
            "fill_offer",
            json!({ "offer_id": id, "quantity": tok(5) }),
        )
        .await
        .unwrap(),
    );
    rec.record(
        "alice: cancel remainder (7)",
        &call(&alice, "cancel_offer", json!({ "offer_id": id }))
            .await
            .unwrap(),
    );
    let r = call(
        &bob,
        "create_offer",
        json!({ "market_id": MID, "outcome": "Yes", "side": "Sell", "price": "700000", "quantity": tok(3) }),
    )
    .await
    .unwrap();
    rec.record("bob: resell offer 3 YES @0.70", &r);
    let id2 = r.json::<Value>().unwrap()["offer_id"]
        .as_str()
        .unwrap()
        .to_string();
    rec.record(
        "carol: fill resale 3",
        &call(
            &carol,
            "fill_offer",
            json!({ "offer_id": id2, "quantity": tok(3) }),
        )
        .await
        .unwrap(),
    );

    // Verify the documented acceptance balances (collateral, YES, NO).
    let snap = |a: Value| {
        (
            num(&a, "available_collateral"),
            num(&a, "yes"),
            num(&a, "no"),
        )
    };
    let acct = |id: &near_workspaces::AccountId| {
        let m = market.clone();
        let id = id.clone();
        async move {
            let v: Value = m
                .view("get_account")
                .args_json(json!({ "account_id": id }))
                .await
                .unwrap()
                .json()
                .unwrap();
            v
        }
    };
    assert_eq!(
        snap(acct(alice.id()).await),
        (7_800_000, 87 * ONE, 100 * ONE)
    );
    assert_eq!(snap(acct(bob.id()).await), (7_300_000, 5 * ONE, 0));
    assert_eq!(snap(acct(carol.id()).await), (4_900_000, 8 * ONE, 0));
    let totals: Value = market.view("get_totals").await.unwrap().json().unwrap();
    assert_eq!(num(&totals, "market_backing"), 100 * ONE);
    assert_eq!(num(&totals, "reserved_yes"), 0);
    assert_eq!(num(&totals, "open_offers"), 0);

    // Merge and withdraw.
    rec.record(
        "alice: merge 87",
        &call(
            &alice,
            "merge_positions",
            json!({ "market_id": MID, "amount": tok(87) }),
        )
        .await
        .unwrap(),
    );
    rec.record(
        "alice: withdraw 94.8",
        &call(
            &alice,
            "withdraw",
            json!({ "amount": (7_800_000 + 87 * ONE).to_string() }),
        )
        .await
        .unwrap(),
    );
    rec.record(
        "bob: withdraw 7.3",
        &call(&bob, "withdraw", json!({ "amount": "7300000" }))
            .await
            .unwrap(),
    );
    rec.record(
        "carol: withdraw 4.9",
        &call(&carol, "withdraw", json!({ "amount": "4900000" }))
            .await
            .unwrap(),
    );
    let bal = |id: &near_workspaces::AccountId| {
        let t = token.clone();
        let id = id.clone();
        async move {
            let v: String = t
                .view("ft_balance_of")
                .args_json(json!({ "account_id": id }))
                .await
                .unwrap()
                .json()
                .unwrap();
            v.parse::<u128>().unwrap()
        }
    };
    assert_eq!(bal(alice.id()).await, 94_800_000);
    assert_eq!(bal(bob.id()).await, 7_300_000);
    assert_eq!(bal(carol.id()).await, 4_900_000);
    assert_eq!(bal(market.id()).await, 13 * ONE);
    let wd: Value = market
        .view("get_withdrawal")
        .args_json(json!({ "account_id": alice.id() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(wd["status"], "Completed");

    // Facts.
    let code_hash = |id: &near_workspaces::AccountId| {
        let w = worker.clone();
        let id = id.clone();
        async move { format!("{:?}", w.view_account(&id).await.unwrap().contract_state) }
    };
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let md: Value = token.view("ft_metadata").await.unwrap().json().unwrap();
    json!({
        "network": format!("{:?}", std::any::type_name::<T>()).rsplit("::").next().unwrap().trim_matches('"'),
        "parent_account": parent.id(),
        "git_commit": git(&["rev-parse", "HEAD"]),
        "git_dirty": !git(&["status", "--porcelain", "--", "contracts", "Cargo.toml", "Cargo.lock"]).is_empty(),
        "accounts": {
            "market": market.id(), "token": token.id(),
            "alice": alice.id(), "bob": bob.id(), "carol": carol.id(),
        },
        "market_id": MID,
        "split_cutoff_ns": cutoff_ns.to_string(),
        "token_metadata": md,
        "config": cfg,
        "onchain_contract_state": {
            "market": code_hash(market.id()).await,
            "token": code_hash(token.id()).await,
        },
        "steps": rec.steps,
    })
}

#[tokio::test]
async fn smoke_on_sandbox() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let facts = run_smoke(&worker, &root, "sbx").await;
    assert!(facts["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["succeeded"] == true));
}

#[tokio::test]
#[ignore = "needs NEARODDS_TESTNET_PARENT and NEARODDS_TESTNET_PARENT_KEY (funded testnet account)"]
async fn smoke_on_testnet() {
    let parent_id = std::env::var("NEARODDS_TESTNET_PARENT")
        .expect("set NEARODDS_TESTNET_PARENT to a funded testnet account id");
    let key: SecretKey = std::env::var("NEARODDS_TESTNET_PARENT_KEY")
        .expect("set NEARODDS_TESTNET_PARENT_KEY to its ed25519 secret key")
        .parse()
        .expect("invalid secret key");
    let worker = near_workspaces::testnet().await.unwrap();
    let parent = Account::from_secret_key(parent_id.parse().unwrap(), key, &worker);
    let tag = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            % 10_000_000
    );
    let facts = run_smoke(&worker, &parent, &tag).await;
    let out = std::env::var("NEARODDS_DEPLOYMENT_OUT").unwrap_or_else(|_| {
        format!(
            "{}/../../deployments/testnet.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    std::fs::create_dir_all(std::path::Path::new(&out).parent().unwrap()).unwrap();
    std::fs::write(&out, serde_json::to_string_pretty(&facts).unwrap()).unwrap();
    println!("wrote {out}");
}
