#![allow(unused_must_use, clippy::too_many_arguments)]
//! Deployment harness. The SAME code runs on the local Sandbox (always, as
//! `*_on_sandbox`) and on NEAR testnet (only when you provide a funded parent
//! account; the `*_on_testnet` tests are `#[ignore]`d).
//!
//! 1. `smoke_*`: a COMPLETE lifecycle on a throw-away market:
//!    deposit -> split -> offer -> partial fills -> cancel -> resale ->
//!    resolve -> redeem -> withdraw. The market is resolved at the end, so the
//!    frontend must NOT use it. Facts go to `deployments/testnet.json`.
//! 2. `demo_*`: a separate, persistent OPEN market with a long cutoff and
//!    seeded liquidity for the frontend. Facts go to
//!    `deployments/testnet-demo.json`.
//!
//! Both deploy the production `market.wasm` (never the failure-injection
//! build) and the `test_collateral.wasm` fixture. The parent account is the
//! token owner and the market resolver. See docs/testnet.md.

mod common;
use common::*;

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Network, Worker};
use serde_json::{json, Value};
use std::process::Command;

/// milliNEAR given to each created account (kept in sync with docs/testnet.md).
/// Sized for a single 10 NEAR faucet account: the smoke accounts are deleted
/// afterwards and their NEAR returned, so smoke then demo fit in the same parent.
const SMOKE_FUNDING_MILLI: [(&str, u128); 5] = [
    ("token", 2000),
    ("market", 3000),
    ("alice", 500),
    ("bob", 500),
    ("carol", 500),
];
const DEMO_FUNDING_MILLI: [(&str, u128); 3] = [("token", 2000), ("market", 3000), ("lp", 1500)];
/// Spare milliNEAR the parent must keep for transaction fees.
const FEE_MARGIN_MILLI: u128 = 1000;

struct Recorder {
    steps: Vec<Value>,
}

impl Recorder {
    fn record(&mut self, step: &str, r: &ExecutionFinalResult) {
        let tx = r.outcome().transaction_hash.to_string();
        let full_ok = r.is_success() && r.receipt_failures().is_empty();
        println!(
            "  {step:<38} {} {tx}",
            if full_ok { "OK  " } else { "FAIL" }
        );
        self.steps
            .push(json!({ "step": step, "tx_hash": tx, "succeeded": full_ok }));
        assert!(full_ok, "step {step} failed: {:#?}", r.failures());
    }
}

fn required_milli(table: &[(&str, u128)]) -> u128 {
    table.iter().map(|(_, n)| n).sum::<u128>() + FEE_MARGIN_MILLI
}

/// Fails early with a clear message if the parent cannot fund the run.
async fn check_funding<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    table: &[(&str, u128)],
) {
    let need = NearToken::from_millinear(required_milli(table));
    let have = worker.view_account(parent.id()).await.unwrap().balance;
    println!(
        "funding check: parent {} has {have}, needs {need}",
        parent.id()
    );
    assert!(
        have >= need,
        "parent account {} holds {have} but this run needs {need} ({:?} milliNEAR + {FEE_MARGIN_MILLI} milliNEAR fee margin)",
        parent.id(),
        table
    );
}

/// When set (testnet runs), every created sub-account's key is written to the
/// credentials directory BEFORE the account is created, so a crashed run can
/// always be cleaned up and its NEAR recovered.
static PERSIST_KEYS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn save_key(account_id: &str, sk: &SecretKey) {
    let home = std::env::var("HOME").expect("HOME");
    let dir = format!("{home}/.near-credentials/testnet");
    std::fs::create_dir_all(&dir).unwrap();
    let path = format!("{dir}/{account_id}.json");
    let body = json!({
        "account_id": account_id,
        "public_key": sk.public_key().to_string(),
        "private_key": sk.to_string(),
    });
    std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

async fn user(parent: &Account, name: &str, milli: u128) -> Account {
    let sk = SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    if PERSIST_KEYS.load(std::sync::atomic::Ordering::SeqCst) {
        save_key(&format!("{name}.{}", parent.id()), &sk);
    }
    parent
        .create_subaccount(name)
        .keys(sk)
        .initial_balance(NearToken::from_millinear(milli))
        .transact()
        .await
        .unwrap()
        .unwrap()
}

fn num(v: &Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

struct Stack {
    token: Contract,
    market: Contract,
    config: Value,
    cutoff_ns: u64,
    storage_cost: NearToken,
}

/// Creates and initializes the token and the market (deploy + init in one tx).
async fn deploy_stack<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    rec: &mut Recorder,
    tag: &str,
    prefix: &str,
    table: &[(&str, u128)],
    cutoff_secs: u64,
    question: &str,
) -> Stack {
    let fund = |name: &str| table.iter().find(|(n, _)| *n == name).unwrap().1;
    let token_acct = user(parent, &format!("tok-{prefix}{tag}"), fund("token")).await;
    let token = token_acct
        .deploy(&wasm("test_collateral"))
        .await
        .unwrap()
        .unwrap();
    rec.record(
        "token: init",
        &token
            .call("new")
            .args_json(json!({ "owner_id": parent.id() }))
            .transact()
            .await
            .unwrap(),
    );
    let now = worker.view_block().await.unwrap().timestamp();
    let cutoff_ns = now + cutoff_secs * 1_000_000_000;
    let market_acct = user(parent, &format!("mkt-{prefix}{tag}"), fund("market")).await;
    let batch = market_acct
        .batch(market_acct.id())
        .deploy(&wasm("market"))
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(json!({
                    "collateral_token": token.id(),
                    "market_id": MID,
                    "question": question,
                    "rules": "Resolves YES if the NiMet daily report records measurable rain in Lagos on 2026-12-01, otherwise NO. A trusted resolver sets the result; there is no VOID or dispute path.",
                    "resolution_source": "NiMet daily weather report, Lagos, 2026-12-01",
                    "split_cutoff_ns": cutoff_ns.to_string(),
                    "resolver_id": parent.id(),
                }))
                .gas(Gas::from_tgas(100)),
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
    let config: Value = market.view("get_config").await.unwrap().json().unwrap();
    assert_eq!(config["resolver_id"], parent.id().to_string());
    let storage_cost = NearToken::from_yoctonear(
        config["storage_cost_per_account"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    );
    Stack {
        token,
        market,
        config,
        cutoff_ns,
        storage_cost,
    }
}

impl Stack {
    async fn register(&self, rec: &mut Recorder, parent: &Account, who: &Account) {
        rec.record(
            "token: storage_deposit",
            &parent
                .call(self.token.id(), "storage_deposit")
                .args_json(json!({ "account_id": who.id(), "registration_only": true }))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await
                .unwrap(),
        );
        rec.record(
            "market: storage_deposit",
            &who.call(self.market.id(), "storage_deposit")
                .args_json(json!({ "account_id": null, "registration_only": true }))
                .deposit(self.storage_cost)
                .transact()
                .await
                .unwrap(),
        );
    }

    async fn mint(
        &self,
        rec: &mut Recorder,
        parent: &Account,
        to: &near_workspaces::AccountId,
        amt: u128,
    ) {
        rec.record(
            "token: mint (fixture owner)",
            &parent
                .call(self.token.id(), "mint")
                .args_json(json!({ "account_id": to, "amount": amt.to_string() }))
                .transact()
                .await
                .unwrap(),
        );
    }

    async fn deposit(&self, rec: &mut Recorder, who: &Account, amt: u128) {
        rec.record(
            "deposit (ft_transfer_call)",
            &who.call(self.token.id(), "ft_transfer_call")
                .args_json(json!({ "receiver_id": self.market.id(), "amount": amt.to_string(), "msg": "deposit" }))
                .deposit(YOCTO)
                .gas(MAX_GAS)
                .transact()
                .await
                .unwrap(),
        );
    }

    fn call(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> near_workspaces::operations::CallTransaction {
        who.call(self.market.id(), method)
            .args_json(args)
            .deposit(YOCTO)
            .gas(Gas::from_tgas(100))
    }

    async fn account(&self, id: &near_workspaces::AccountId) -> Value {
        self.market
            .view("get_account")
            .args_json(json!({ "account_id": id }))
            .await
            .unwrap()
            .json()
            .unwrap()
    }

    async fn token_balance(&self, id: &near_workspaces::AccountId) -> u128 {
        let v: String = self
            .token
            .view("ft_balance_of")
            .args_json(json!({ "account_id": id }))
            .await
            .unwrap()
            .json()
            .unwrap();
        v.parse().unwrap()
    }
}

fn git(args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

async fn facts<T: Network + 'static>(
    worker: &Worker<T>,
    kind: &str,
    parent: &Account,
    stack: &Stack,
    accounts: Value,
    rec: Recorder,
) -> Value {
    let md: Value = stack
        .token
        .view("ft_metadata")
        .await
        .unwrap()
        .json()
        .unwrap();
    let state = |id: &near_workspaces::AccountId| {
        let w = worker.clone();
        let id = id.clone();
        async move { format!("{:?}", w.view_account(&id).await.unwrap().contract_state) }
    };
    json!({
        "kind": kind,
        "network": std::any::type_name::<T>().rsplit("::").next().unwrap(),
        "parent_account_token_owner_and_resolver": parent.id(),
        "git_commit": git(&["rev-parse", "HEAD"]),
        "git_dirty": !git(&["status", "--porcelain", "--", "contracts", "Cargo.toml", "Cargo.lock"]).is_empty(),
        "accounts": accounts,
        "market_id": MID,
        "split_cutoff_ns": stack.cutoff_ns.to_string(),
        "token_metadata": md,
        "config": stack.config,
        "onchain_contract_state": { "market": state(stack.market.id()).await, "token": state(stack.token.id()).await },
        "steps": rec.steps,
    })
}

/// Waits until chain time passes `ts_ns`. On the Sandbox the clock is pushed
/// forward by fast-forwarding blocks; on testnet it just waits.
async fn wait_past<T: Network + 'static>(
    worker: &Worker<T>,
    fast: Option<&Worker<near_workspaces::network::Sandbox>>,
    ts_ns: u64,
) {
    for _ in 0..4000 {
        // The public RPCs rate-limit: treat a failed poll as "not yet" and back off.
        if let Ok(b) = worker.view_block().await {
            if b.timestamp() > ts_ns {
                return;
            }
        } else {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        }
        match fast {
            Some(sb) => {
                sb.fast_forward(20).await.unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            None => tokio::time::sleep(std::time::Duration::from_secs(15)).await,
        }
    }
    panic!("chain time never passed {ts_ns}");
}

// ---------------------------------------------------------------------------
// 1. Full-lifecycle smoke test
// ---------------------------------------------------------------------------

async fn run_smoke<T: Network + 'static>(
    worker: &Worker<T>,
    fast: Option<&Worker<near_workspaces::network::Sandbox>>,
    parent: &Account,
    tag: &str,
    cutoff_secs: u64,
    cleanup: bool,
) -> Value {
    check_funding(worker, parent, &SMOKE_FUNDING_MILLI).await;
    let parent_before = worker.view_account(parent.id()).await.unwrap().balance;
    let mut rec = Recorder { steps: vec![] };
    let stack = deploy_stack(
        worker,
        parent,
        &mut rec,
        tag,
        "",
        &SMOKE_FUNDING_MILLI,
        cutoff_secs,
        "Will it rain in Lagos on 2026-12-01? (smoke-test market)",
    )
    .await;
    let fund = |n: &str| SMOKE_FUNDING_MILLI.iter().find(|(x, _)| *x == n).unwrap().1;
    let alice = user(parent, &format!("alice-{tag}"), fund("alice")).await;
    let bob = user(parent, &format!("bob-{tag}"), fund("bob")).await;
    let carol = user(parent, &format!("carol-{tag}"), fund("carol")).await;
    rec.record(
        "token: register market",
        &parent
            .call(stack.token.id(), "storage_deposit")
            .args_json(json!({ "account_id": stack.market.id(), "registration_only": true }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await
            .unwrap(),
    );
    for (who, amt) in [(&alice, 100), (&bob, 10), (&carol, 10)] {
        stack.register(&mut rec, parent, who).await;
        stack.mint(&mut rec, parent, who.id(), amt * ONE).await;
    }
    for (who, amt) in [(&alice, 100), (&bob, 10), (&carol, 10)] {
        stack.deposit(&mut rec, who, amt * ONE).await;
    }

    // Split, offer, partial fills, cancel, resale.
    rec.record(
        "alice: split 100",
        &stack
            .call(
                &alice,
                "split_position",
                json!({ "market_id": MID, "amount": tok(100) }),
            )
            .transact()
            .await
            .unwrap(),
    );
    let r = stack.call(&alice, "create_offer", json!({ "market_id": MID, "outcome": "Yes", "side": "Sell", "price": "600000", "quantity": tok(20) })).transact().await.unwrap();
    rec.record("alice: create_offer 20 YES @0.60", &r);
    let id = r.json::<Value>().unwrap()["offer_id"]
        .as_str()
        .unwrap()
        .to_string();
    rec.record(
        "bob: fill 8",
        &stack
            .call(
                &bob,
                "fill_offer",
                json!({ "offer_id": id, "quantity": tok(8) }),
            )
            .transact()
            .await
            .unwrap(),
    );
    rec.record(
        "carol: fill 5",
        &stack
            .call(
                &carol,
                "fill_offer",
                json!({ "offer_id": id, "quantity": tok(5) }),
            )
            .transact()
            .await
            .unwrap(),
    );
    rec.record(
        "alice: cancel remainder (7)",
        &stack
            .call(&alice, "cancel_offer", json!({ "offer_id": id }))
            .transact()
            .await
            .unwrap(),
    );
    let r = stack.call(&bob, "create_offer", json!({ "market_id": MID, "outcome": "Yes", "side": "Sell", "price": "700000", "quantity": tok(3) })).transact().await.unwrap();
    rec.record("bob: resell offer 3 YES @0.70", &r);
    let id2 = r.json::<Value>().unwrap()["offer_id"]
        .as_str()
        .unwrap()
        .to_string();
    rec.record(
        "carol: fill resale 3",
        &stack
            .call(
                &carol,
                "fill_offer",
                json!({ "offer_id": id2, "quantity": tok(3) }),
            )
            .transact()
            .await
            .unwrap(),
    );

    let snap = |a: &Value| (num(a, "available_collateral"), num(a, "yes"), num(a, "no"));
    assert_eq!(
        snap(&stack.account(alice.id()).await),
        (7_800_000, 87 * ONE, 100 * ONE)
    );
    assert_eq!(
        snap(&stack.account(bob.id()).await),
        (7_300_000, 5 * ONE, 0)
    );
    assert_eq!(
        snap(&stack.account(carol.id()).await),
        (4_900_000, 8 * ONE, 0)
    );
    let totals: Value = stack
        .market
        .view("get_totals")
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(num(&totals, "market_backing"), 100 * ONE);
    assert_eq!(num(&totals, "open_offers"), 0);
    assert!(
        worker.view_block().await.unwrap().timestamp() < stack.cutoff_ns,
        "trading finished after the cutoff; raise the smoke cutoff"
    );

    // Resolution: refused early, then YES by the configured resolver (parent).
    let early = stack
        .call(
            parent,
            "resolve_market",
            json!({ "market_id": MID, "outcome": "Yes", "evidence": "too early" }),
        )
        .transact()
        .await
        .unwrap();
    assert!(
        early.is_failure() || !early.receipt_failures().is_empty(),
        "resolution before the cutoff must fail"
    );
    wait_past(worker, fast, stack.cutoff_ns).await;
    rec.record(
        "resolver: resolve YES",
        &stack
            .call(parent, "resolve_market", json!({ "market_id": MID, "outcome": "Yes", "evidence": "https://nimet.example/report/2026-12-01 (smoke test)" }))
            .transact()
            .await
            .unwrap(),
    );
    let m: Value = stack
        .market
        .view("get_market")
        .args_json(json!({ "market_id": MID }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(m["status"], "Resolved");
    assert_eq!(m["resolution"]["outcome"], "Yes");

    // Redeem (each user), then withdraw.
    for (name, who) in [("alice", &alice), ("bob", &bob), ("carol", &carol)] {
        rec.record(
            &format!("{name}: redeem"),
            &stack
                .call(who, "redeem", json!({ "market_id": MID }))
                .transact()
                .await
                .unwrap(),
        );
    }
    assert_eq!(snap(&stack.account(alice.id()).await).0, 94_800_000);
    assert_eq!(snap(&stack.account(bob.id()).await).0, 12_300_000);
    assert_eq!(snap(&stack.account(carol.id()).await).0, 12_900_000);
    let totals: Value = stack
        .market
        .view("get_totals")
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(num(&totals, "market_backing"), 0);
    assert_eq!(num(&totals, "available_collateral"), 120 * ONE);
    for (name, who, amt) in [
        ("alice", &alice, 94_800_000u128),
        ("bob", &bob, 12_300_000),
        ("carol", &carol, 12_900_000),
    ] {
        rec.record(
            &format!("{name}: withdraw"),
            &stack
                .call(who, "withdraw", json!({ "amount": amt.to_string() }))
                .transact()
                .await
                .unwrap(),
        );
    }
    assert_eq!(stack.token_balance(alice.id()).await, 94_800_000);
    assert_eq!(stack.token_balance(bob.id()).await, 12_300_000);
    assert_eq!(stack.token_balance(carol.id()).await, 12_900_000);
    assert_eq!(stack.token_balance(stack.market.id()).await, 0);

    let accounts = json!({ "market": stack.market.id(), "token": stack.token.id(), "alice": alice.id(), "bob": bob.id(), "carol": carol.id() });
    let mut f = facts(
        worker,
        "smoke-test (market is RESOLVED; do not use for the frontend)",
        parent,
        &stack,
        accounts,
        rec,
    )
    .await;
    if cleanup {
        // Delete the disposable accounts and return their NEAR to the parent.
        let mut deleted = vec![];
        for acct in [alice, bob, carol] {
            let id = acct.id().clone();
            acct.delete_account(parent.id())
                .await
                .unwrap()
                .into_result()
                .unwrap();
            deleted.push(id);
        }
        let (mid, tid) = (stack.market.id().clone(), stack.token.id().clone());
        stack
            .market
            .delete_contract(parent.id())
            .await
            .unwrap()
            .into_result()
            .unwrap();
        stack
            .token
            .delete_contract(parent.id())
            .await
            .unwrap()
            .into_result()
            .unwrap();
        deleted.push(mid);
        deleted.push(tid);
        let parent_after = worker.view_account(parent.id()).await.unwrap().balance;
        f["cleanup"] = json!({
            "accounts_deleted_after_verification": deleted,
            "parent_balance_before": parent_before.to_string(),
            "parent_balance_after_cleanup": parent_after.to_string(),
        });
    }
    f
}

// ---------------------------------------------------------------------------
// 2. Persistent open demo market for the frontend
// ---------------------------------------------------------------------------

/// `mint_to`: `(account id, whole tokens)` demo users who get test tokens.
async fn run_demo<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    tag: &str,
    cutoff_secs: u64,
    mint_to: &[(near_workspaces::AccountId, u128)],
) -> Value {
    check_funding(worker, parent, &DEMO_FUNDING_MILLI).await;
    let mut rec = Recorder { steps: vec![] };
    let stack = deploy_stack(
        worker,
        parent,
        &mut rec,
        tag,
        "demo-",
        &DEMO_FUNDING_MILLI,
        cutoff_secs,
        "Will it rain in Lagos on 2026-12-01?",
    )
    .await;
    let fund_lp = DEMO_FUNDING_MILLI
        .iter()
        .find(|(n, _)| *n == "lp")
        .unwrap()
        .1;
    let lp = user(parent, &format!("lp-demo-{tag}"), fund_lp).await;
    rec.record(
        "token: register market",
        &parent
            .call(stack.token.id(), "storage_deposit")
            .args_json(json!({ "account_id": stack.market.id(), "registration_only": true }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await
            .unwrap(),
    );
    stack.register(&mut rec, parent, &lp).await;
    stack.mint(&mut rec, parent, lp.id(), 200 * ONE).await;
    stack.deposit(&mut rec, &lp, 200 * ONE).await;
    rec.record(
        "lp: split 100",
        &stack
            .call(
                &lp,
                "split_position",
                json!({ "market_id": MID, "amount": tok(100) }),
            )
            .transact()
            .await
            .unwrap(),
    );
    // Liquidity: YES and NO sell ladders and a YES bid (reserves 100 - the rest stays free).
    for (outcome, side, price, qty) in [
        ("Yes", "Sell", 650_000u128, 10u128),
        ("Yes", "Sell", 700_000, 10),
        ("Yes", "Sell", 750_000, 10),
        ("No", "Sell", 350_000, 10),
        ("No", "Sell", 400_000, 10),
        ("Yes", "Buy", 550_000, 10),
        ("Yes", "Buy", 500_000, 10),
    ] {
        rec.record(
            &format!("lp: {side} {qty} {outcome} @{}", price as f64 / 1e6),
            &stack
                .call(&lp, "create_offer", json!({ "market_id": MID, "outcome": outcome, "side": side, "price": price.to_string(), "quantity": tok(qty) }))
                .transact()
                .await
                .unwrap(),
        );
    }
    // Test tokens for demo users (they must also register with the token + market themselves).
    for (id, whole) in mint_to {
        rec.record(
            "token: register demo user",
            &parent
                .call(stack.token.id(), "storage_deposit")
                .args_json(json!({ "account_id": id, "registration_only": true }))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await
                .unwrap(),
        );
        stack.mint(&mut rec, parent, id, whole * ONE).await;
    }
    let m: Value = stack
        .market
        .view("get_market")
        .args_json(json!({ "market_id": MID }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(m["status"], "Open");
    let yes_sells: Vec<Value> = stack
        .market
        .view("list_offers")
        .args_json(json!({ "market_id": MID, "outcome": "Yes", "side": "Sell" }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(yes_sells.len(), 3);
    let accounts = json!({ "market": stack.market.id(), "token": stack.token.id(), "liquidity_provider": lp.id(), "resolver_and_token_owner": parent.id(), "minted_demo_users": mint_to.iter().map(|(a, n)| json!({"account": a, "tokens": n})).collect::<Vec<_>>() });
    facts(
        worker,
        "persistent OPEN demo market for the frontend",
        parent,
        &stack,
        accounts,
        rec,
    )
    .await
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/// Full-access key for a testnet account from the standard credentials
/// directory (`~/.near-credentials/testnet/<id>.json`, mode 600). Never printed.
fn stored_key(account_id: &str) -> Option<SecretKey> {
    let home = std::env::var("HOME").ok()?;
    let path = format!("{home}/.near-credentials/testnet/{account_id}.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    v["private_key"].as_str()?.parse().ok()
}

/// The funded parent. Key: `NEARODDS_TESTNET_PARENT_KEY`, else the stored
/// credentials file for `NEARODDS_TESTNET_PARENT`.
/// Testnet worker. `rpc.testnet.near.org` is deprecated and rate-limited, so
/// default to FastNEAR's public testnet RPC (override with NEARODDS_RPC_URL).
async fn testnet_worker() -> Worker<near_workspaces::network::Testnet> {
    PERSIST_KEYS.store(true, std::sync::atomic::Ordering::SeqCst);
    let url = std::env::var("NEARODDS_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    near_workspaces::testnet().rpc_addr(&url).await.unwrap()
}

fn testnet_parent(worker: &Worker<near_workspaces::network::Testnet>) -> Account {
    let parent_id = std::env::var("NEARODDS_TESTNET_PARENT")
        .expect("set NEARODDS_TESTNET_PARENT to a funded testnet account id");
    let key: SecretKey = match std::env::var("NEARODDS_TESTNET_PARENT_KEY") {
        Ok(k) => k.parse().expect("invalid secret key"),
        Err(_) => stored_key(&parent_id).unwrap_or_else(|| {
            panic!("no NEARODDS_TESTNET_PARENT_KEY and no ~/.near-credentials/testnet/{parent_id}.json")
        }),
    };
    Account::from_secret_key(parent_id.parse().unwrap(), key, worker)
}

fn unique_tag() -> String {
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{}", s % 10_000_000)
}

fn write_facts(default_name: &str, env_var: &str, facts: &Value) {
    let out = std::env::var(env_var).unwrap_or_else(|_| {
        format!(
            "{}/../../deployments/{default_name}",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    std::fs::create_dir_all(std::path::Path::new(&out).parent().unwrap()).unwrap();
    std::fs::write(&out, serde_json::to_string_pretty(facts).unwrap()).unwrap();
    println!("wrote {out}");
}

#[tokio::test]
async fn smoke_on_sandbox() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let facts = run_smoke(&worker, Some(&worker), &root, "sbx", 120, true).await;
    assert!(facts["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["succeeded"] == true));
}

#[tokio::test]
async fn demo_on_sandbox() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let user = new_user(&root, "demouser").await;
    let facts = run_demo(
        &worker,
        &root,
        "sbx",
        7 * 86_400,
        &[(user.id().clone(), 50)],
    )
    .await;
    assert!(facts["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["succeeded"] == true));
}

#[tokio::test]
#[ignore = "needs NEARODDS_TESTNET_PARENT and NEARODDS_TESTNET_PARENT_KEY (funded testnet account)"]
async fn smoke_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    // 10 minutes: enough for ~40 testnet transactions, then the harness waits for the cutoff.
    let cleanup = std::env::var("NEARODDS_SMOKE_CLEANUP")
        .map(|v| v != "0")
        .unwrap_or(true);
    let facts = run_smoke(&worker, None, &parent, &unique_tag(), 600, cleanup).await;
    write_facts("testnet.json", "NEARODDS_DEPLOYMENT_OUT", &facts);
}

#[tokio::test]
#[ignore = "needs NEARODDS_TESTNET_PARENT and NEARODDS_TESTNET_PARENT_KEY (funded testnet account)"]
async fn demo_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    let days: u64 = std::env::var("NEARODDS_DEMO_CUTOFF_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7);
    // NEARODDS_DEMO_MINT="alice.testnet:100,bob.testnet:50"
    let mint: Vec<(near_workspaces::AccountId, u128)> = std::env::var("NEARODDS_DEMO_MINT")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|p| {
            let (a, n) = p
                .split_once(':')
                .expect("NEARODDS_DEMO_MINT entries look like account:tokens");
            (a.trim().parse().unwrap(), n.trim().parse().unwrap())
        })
        .collect();
    let facts = run_demo(&worker, &parent, &unique_tag(), days * 86_400, &mint).await;
    write_facts("testnet-demo.json", "NEARODDS_DEMO_OUT", &facts);
}

/// Moves (almost) all NEAR from faucet-funded accounts into the parent so one
/// dedicated account can fund the deployments. Keys come from the credentials
/// directory. NEARODDS_FUND_FROM="a.testnet,b.testnet".
#[tokio::test]
#[ignore = "testnet only: consolidates faucet funds into NEARODDS_TESTNET_PARENT"]
async fn consolidate_funds_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    for from in std::env::var("NEARODDS_FUND_FROM")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
    {
        let from = from.trim();
        let acct = Account::from_secret_key(
            from.parse().unwrap(),
            stored_key(from).unwrap_or_else(|| panic!("no stored key for {from}")),
            &worker,
        );
        let bal = worker.view_account(acct.id()).await.unwrap().balance;
        let keep = NearToken::from_millinear(200); // leave a little for the transfer fee
        let send =
            NearToken::from_yoctonear(bal.as_yoctonear().saturating_sub(keep.as_yoctonear()));
        let r = acct.transfer_near(parent.id(), send).await.unwrap();
        println!(
            "{from} -> {}: sent {send} (tx {})",
            parent.id(),
            r.outcome().transaction_hash
        );
        assert!(r.is_success());
    }
    let total = worker.view_account(parent.id()).await.unwrap().balance;
    println!("parent {} balance: {total}", parent.id());
}

/// Recovery: deletes sub-accounts left behind by an interrupted run (keys were
/// persisted by `user`) and returns their NEAR to the parent.
/// NEARODDS_DELETE_ACCOUNTS="tok-1.parent.testnet,mkt-1.parent.testnet,..."
#[tokio::test]
#[ignore = "testnet only: deletes the listed sub-accounts into NEARODDS_TESTNET_PARENT"]
async fn delete_testnet_accounts() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    for id in std::env::var("NEARODDS_DELETE_ACCOUNTS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
    {
        let id = id.trim();
        let acct = Account::from_secret_key(
            id.parse().unwrap(),
            stored_key(id).unwrap_or_else(|| panic!("no stored key for {id}")),
            &worker,
        );
        let r = acct.delete_account(parent.id()).await.unwrap();
        println!(
            "deleted {id} -> {} (tx {})",
            parent.id(),
            r.outcome().transaction_hash
        );
    }
    let total = worker.view_account(parent.id()).await.unwrap().balance;
    println!("parent {} balance: {total}", parent.id());
}

/// Funds wallets with TEST collateral. The parent is the fixture owner.
/// NEARODDS_TOKEN=<token account>  NEARODDS_MINT="a.testnet:100,b.testnet:50" (whole tokens).
/// Registers each account with the token first if needed.
#[tokio::test]
#[ignore = "testnet only: mints test collateral as the token owner (NEARODDS_TESTNET_PARENT)"]
async fn mint_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    let token: near_workspaces::AccountId = std::env::var("NEARODDS_TOKEN")
        .expect("set NEARODDS_TOKEN")
        .parse()
        .unwrap();
    for entry in std::env::var("NEARODDS_MINT")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
    {
        let (who, whole) = entry
            .split_once(':')
            .expect("NEARODDS_MINT entries look like account:tokens");
        let (who, whole): (near_workspaces::AccountId, u128) =
            (who.trim().parse().unwrap(), whole.trim().parse().unwrap());
        let reg: Value = worker
            .view(&token, "storage_balance_of")
            .args_json(json!({ "account_id": who }))
            .await
            .unwrap()
            .json()
            .unwrap();
        if reg.is_null() {
            let r = parent
                .call(&token, "storage_deposit")
                .args_json(json!({ "account_id": who, "registration_only": true }))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await
                .unwrap();
            println!(
                "registered {who} with the token (tx {})",
                r.outcome().transaction_hash
            );
            assert!(r.is_success());
        }
        let r = parent
            .call(&token, "mint")
            .args_json(json!({ "account_id": who, "amount": (whole * ONE).to_string() }))
            .transact()
            .await
            .unwrap();
        println!(
            "minted {whole} tNOC to {who} (tx {})",
            r.outcome().transaction_hash
        );
        assert!(
            r.is_success() && r.receipt_failures().is_empty(),
            "{:#?}",
            r.failures()
        );
        let bal: String = worker
            .view(&token, "ft_balance_of")
            .args_json(json!({ "account_id": who }))
            .await
            .unwrap()
            .json()
            .unwrap();
        println!("  {who} token balance: {bal} base units");
    }
}

/// Resolves a market as the resolver (the parent) after its cutoff.
/// NEARODDS_MARKET=<market account>  NEARODDS_OUTCOME=Yes|No  NEARODDS_EVIDENCE="<url or note>"
#[tokio::test]
#[ignore = "testnet only: resolves a market as NEARODDS_TESTNET_PARENT (the configured resolver)"]
async fn resolve_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    let market: near_workspaces::AccountId = std::env::var("NEARODDS_MARKET")
        .expect("set NEARODDS_MARKET")
        .parse()
        .unwrap();
    let outcome = std::env::var("NEARODDS_OUTCOME").expect("set NEARODDS_OUTCOME=Yes|No");
    assert!(outcome == "Yes" || outcome == "No");
    let evidence = std::env::var("NEARODDS_EVIDENCE").expect("set NEARODDS_EVIDENCE");
    let m: Value = worker
        .view(&market, "get_market")
        .args_json(json!({ "market_id": MID }))
        .await
        .unwrap()
        .json()
        .unwrap();
    println!(
        "before: status={} resolver={}",
        m["status"], m["resolver_id"]
    );
    assert_eq!(
        m["resolver_id"],
        parent.id().to_string(),
        "the parent is not this market's resolver"
    );
    assert_eq!(
        m["status"], "AwaitingResolution",
        "can only resolve after the cutoff, once"
    );
    let r = parent
        .call(&market, "resolve_market")
        .args_json(json!({ "market_id": MID, "outcome": outcome, "evidence": evidence }))
        .deposit(YOCTO)
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .unwrap();
    println!("resolve_market tx {}", r.outcome().transaction_hash);
    assert!(
        r.is_success() && r.receipt_failures().is_empty(),
        "{:#?}",
        r.failures()
    );
    let m: Value = worker
        .view(&market, "get_market")
        .args_json(json!({ "market_id": MID }))
        .await
        .unwrap()
        .json()
        .unwrap();
    println!(
        "after: status={} resolution={}",
        m["status"], m["resolution"]
    );
    assert_eq!(m["status"], "Resolved");
}
