#![allow(unused_must_use, clippy::too_many_arguments)]
//! Deployment harness. The SAME code runs on the local Sandbox (always, as
//! `*_on_sandbox`) and on NEAR testnet (only when you provide a funded parent
//! account; the testnet tests are `#[ignore]`d).
//!
//! 1. `smoke_*`: a COMPLETE lifecycle on a throw-away market:
//!    deposit -> split -> offer -> partial fills -> cancel -> resale ->
//!    resolve -> post-resolution restrictions -> redeem -> withdraw. The verified
//!    record is saved FIRST (`deployments/testnet.json`); only then are exactly
//!    this run's disposable accounts deleted and their NEAR returned.
//! 2. `demo_*`: a separate, persistent OPEN market with an explicit observation
//!    date, a matching cutoff and seeded liquidity for the frontend
//!    (`deployments/testnet-demo.json`). Never cleaned up or resolved here.
//!
//! Safety rules the harness follows on testnet:
//! * every sub-account key is written to `~/.near-credentials/testnet/` BEFORE
//!   the account is created;
//! * a non-secret journal (`deployments/runs/<kind>-<tag>.jsonl`) records account
//!   IDs, transaction hashes and completed steps as they happen;
//! * a transaction is submitted at most once. Its hash is journaled, and an
//!   uncertain outcome is resolved by polling THAT hash, never by resubmitting.
//!   If a submit itself fails (outcome unknown) the run stops and says so.
//!
//! Both deploy the production `market.wasm` (never the failure-injection build)
//! and the `test_collateral.wasm` fixture. See docs/testnet.md.

mod common;
use common::*;

use near_workspaces::operations::TransactionStatus;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, CryptoHash, Network, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::task::Poll;

/// milliNEAR given to each created account (kept in sync with docs/testnet.md).
/// Sized for a single faucet-funded parent: the smoke accounts are deleted
/// afterwards and their NEAR returned, so smoke then demo fit in the same parent.
const SMOKE_FUNDING_MILLI: [(&str, u128); 5] = [
    ("token", 2000),
    ("market", 3000),
    ("alice", 500),
    ("bob", 500),
    ("carol", 500),
];
const DEMO_FUNDING_MILLI: [(&str, u128); 4] = [
    ("token", 2000),
    ("market", 3000),
    ("lp", 1500),
    ("probe", 600),
];
/// Spare milliNEAR the parent must keep for transaction fees.
const FEE_MARGIN_MILLI: u128 = 1000;

// ---------------------------------------------------------------------------
// Journal and recorder
// ---------------------------------------------------------------------------

/// When set (testnet runs), every created sub-account's key is written to the
/// credentials directory BEFORE the account is created, so a crashed run can
/// always be cleaned up and its NEAR recovered; runs are also journaled.
static PERSIST_KEYS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Non-secret, append-only run journal (account ids, tx hashes, steps).
#[derive(Clone)]
struct Journal {
    path: Option<PathBuf>,
}

impl Journal {
    fn open(kind: &str, tag: &str) -> Journal {
        if !PERSIST_KEYS.load(std::sync::atomic::Ordering::SeqCst) {
            return Journal { path: None }; // Sandbox runs are not journaled
        }
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../deployments/runs");
        std::fs::create_dir_all(&dir).unwrap();
        Journal {
            path: Some(dir.join(format!("{kind}-{tag}.jsonl"))),
        }
    }

    fn event(&self, mut v: Value) {
        use std::io::Write;
        if let Some(p) = &self.path {
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            v["unix_time"] = json!(t);
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .unwrap();
            writeln!(f, "{v}").unwrap();
        }
    }
}

struct Recorder {
    steps: Vec<Value>,
    journal: Journal,
    last_hash: String,
}

impl Recorder {
    fn new(kind: &str, tag: &str, parent: &Account) -> Recorder {
        let journal = Journal::open(kind, tag);
        journal.event(json!({ "event": "run_start", "kind": kind, "tag": tag,
            "parent": parent.id(), "git_commit": git(&["rev-parse", "HEAD"]) }));
        Recorder {
            steps: vec![],
            journal,
            last_hash: String::new(),
        }
    }

    /// The submit call failed, so the transaction may or may not have been sent.
    /// Never resubmit blindly: stop and let a human check account activity.
    fn uncertain(&self, step: &str, err: String) -> ! {
        self.journal
            .event(json!({ "event": "step_submit_error", "step": step, "error": err }));
        panic!(
            "UNCERTAIN: submitting '{step}' failed ({err}); it may or may not have been sent. \
             NOT retrying. Check the journal and the account's activity before re-running."
        );
    }

    /// Polls the RECORDED hash. Returns the result once the transaction has
    /// finished, or `None` if the node never observed it within ~90 s (it was
    /// dropped, e.g. by a lagging RPC node). It never resubmits by itself.
    async fn finish(
        &mut self,
        step: &str,
        status: TransactionStatus,
    ) -> Option<ExecutionFinalResult> {
        let hash = status.hash().to_string();
        self.journal
            .event(json!({ "event": "step_submitted", "step": step, "tx_hash": hash }));
        for poll in 0..45 {
            match status.status().await {
                Ok(Poll::Ready(r)) => {
                    self.last_hash = hash;
                    return Some(r);
                }
                Ok(Poll::Pending) => {}
                Err(e) => {
                    if poll % 10 == 1 {
                        eprintln!("  ... polling '{step}' ({hash}): {e}");
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        self.journal
            .event(json!({ "event": "step_never_observed", "step": step, "tx_hash": hash }));
        None
    }

    fn push(&mut self, step: &str, ok: bool, expected_failure: bool) {
        let label = match (ok, expected_failure) {
            (true, true) => "REFUSED(expected)",
            (true, false) => "OK",
            _ => "FAIL",
        };
        println!("  {step:<44} {label} {}", self.last_hash);
        self.journal
            .event(json!({ "event": "step_done", "step": step,
            "tx_hash": self.last_hash, "ok": ok, "expected_failure": expected_failure }));
        self.steps
            .push(json!({ "step": step, "tx_hash": self.last_hash,
            "succeeded": ok, "expected_failure": expected_failure }));
    }

    fn expect_ok(&mut self, step: &str, r: &ExecutionFinalResult) {
        let ok = r.is_success() && r.receipt_failures().is_empty();
        self.push(step, ok, false);
        assert!(ok, "step {step} failed: {:#?}", r.failures());
    }

    /// The call must FAIL with `needle` in the contract's error.
    fn expect_fail(&mut self, step: &str, r: &ExecutionFinalResult, needle: &str) {
        let failed = r.is_failure() || !r.receipt_failures().is_empty();
        let ok = failed && failed_with(r, needle);
        self.push(step, ok, true);
        assert!(
            ok,
            "step {step} should have failed with {needle:?}; got {:#?}",
            r.failures()
        );
    }
}

/// Submit, then poll the recorded hash. If (and only if) the node never
/// observed that hash within the patience window, the step is submitted again
/// (journaled, at most 3 attempts). A transaction whose submit call errored with
/// an unknown outcome is never resubmitted. Evaluates to the final result.
macro_rules! tx {
    ($rec:expr, $name:expr, $txn:expr) => {{
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            $rec.journal.event(json!({ "event": "step_submitting", "step": $name, "attempt": attempt }));
            match $txn.transact_async().await {
                Ok(s) => match $rec.finish($name, s).await {
                    Some(r) => break r,
                    None => {
                        assert!(
                            attempt < 3,
                            "'{}' was never observed on chain after {} submissions; see the journal",
                            $name,
                            attempt
                        );
                        $rec.journal.event(json!({ "event": "step_resubmitting", "step": $name,
                            "reason": "previous hash never observed on chain (dropped by the node)" }));
                    }
                },
                Err(e) => $rec.uncertain($name, e.to_string()),
            }
        }
    }};
}
/// `tx!` and assert full success.
macro_rules! tx_ok {
    ($rec:expr, $name:expr, $txn:expr) => {{
        let r = tx!($rec, $name, $txn);
        $rec.expect_ok($name, &r);
        r
    }};
}
/// `tx!` and assert it failed with `$needle`.
macro_rules! tx_fail {
    ($rec:expr, $name:expr, $needle:expr, $txn:expr) => {{
        let r = tx!($rec, $name, $txn);
        $rec.expect_fail($name, &r, $needle);
        r
    }};
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

/// Creates a funded sub-account. The key is saved first; the id is journaled
/// before the call. If the call errors we check whether the account exists with
/// OUR key before ever creating it again.
async fn user<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    name: &str,
    milli: u128,
    journal: &Journal,
) -> Account {
    let sk = SecretKey::from_random(KeyType::ED25519);
    let id = format!("{name}.{}", parent.id());
    if PERSIST_KEYS.load(std::sync::atomic::Ordering::SeqCst) {
        save_key(&id, &sk);
    }
    journal.event(json!({ "event": "account_creating", "account": id,
        "funding_milli": milli, "public_key": sk.public_key().to_string() }));
    match parent
        .create_subaccount(name)
        .keys(sk.clone())
        .initial_balance(NearToken::from_millinear(milli))
        .transact()
        .await
    {
        Ok(ex) => {
            let acct = ex.into_result().expect("account creation failed");
            journal.event(json!({ "event": "account_created", "account": id }));
            println!("  created {id} ({milli} milliNEAR)");
            acct
        }
        Err(e) => {
            let probe = Account::from_secret_key(id.parse().unwrap(), sk.clone(), worker);
            let exists_with_our_key = probe.view_account().await.is_ok()
                && probe.view_access_key(&sk.public_key()).await.is_ok();
            journal.event(json!({ "event": "account_create_uncertain", "account": id,
                "error": e.to_string(), "exists_with_our_key": exists_with_our_key }));
            assert!(
                exists_with_our_key,
                "UNCERTAIN: creating {id} failed ({e}) and it is not visible with our key. \
                 Not retrying; check the journal."
            );
            journal.event(json!({ "event": "account_created", "account": id, "recovered": true }));
            probe
        }
    }
}

fn num(v: &Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

fn sha256_b58(bytes: &[u8]) -> (String, String) {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(bytes);
    let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
    (hex, CryptoHash::try_from(d.to_vec()).unwrap().to_string())
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// UTC `YYYY-MM-DDTHH:MM:SSZ` for unix seconds.
fn rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Trading closes at 00:00 WAT (UTC+1) at the START of the observation day.
fn cutoff_secs_for_observation_date(date: &str) -> i64 {
    let p: Vec<i64> = date
        .split('-')
        .map(|x| x.parse().expect("date YYYY-MM-DD"))
        .collect();
    assert_eq!(p.len(), 3, "date must be YYYY-MM-DD");
    days_from_civil(p[0], p[1], p[2]) * 86400 - 3600
}

struct Stack {
    token: Contract,
    market: Contract,
    token_acct: Account,
    market_acct: Account,
    config: Value,
    cutoff_ns: u64,
    storage_cost: NearToken,
}

/// Creates and initializes the token and the market (deploy + init, one tx each).
async fn deploy_stack<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    rec: &mut Recorder,
    tag: &str,
    prefix: &str,
    table: &[(&str, u128)],
    cutoff_ns: u64,
    question: &str,
    rules: &str,
    resolution_source: &str,
) -> Stack {
    let fund = |name: &str| table.iter().find(|(n, _)| *n == name).unwrap().1;
    let token_acct = user(
        worker,
        parent,
        &format!("tok-{prefix}{tag}"),
        fund("token"),
        &rec.journal,
    )
    .await;
    tx_ok!(
        rec,
        "token: deploy + init (one tx)",
        token_acct
            .batch(token_acct.id())
            .deploy(&wasm("test_collateral"))
            .call(
                near_workspaces::operations::Function::new("new")
                    .args_json(json!({ "owner_id": parent.id() }))
                    .gas(Gas::from_tgas(30)),
            )
    );
    let token = Contract::from_secret_key(
        token_acct.id().clone(),
        token_acct.secret_key().clone(),
        worker,
    );
    let market_acct = user(
        worker,
        parent,
        &format!("mkt-{prefix}{tag}"),
        fund("market"),
        &rec.journal,
    )
    .await;
    tx_ok!(
        rec,
        "market: deploy + init (one tx)",
        market_acct
            .batch(market_acct.id())
            .deploy(&wasm("market"))
            .call(
                near_workspaces::operations::Function::new("new")
                    .args_json(json!({
                        "collateral_token": token.id(),
                        "market_id": MID,
                        "question": question,
                        "rules": rules,
                        "resolution_source": resolution_source,
                        "split_cutoff_ns": cutoff_ns.to_string(),
                        "resolver_id": parent.id(),
                    }))
                    .gas(Gas::from_tgas(100)),
            )
    );
    let market = Contract::from_secret_key(
        market_acct.id().clone(),
        market_acct.secret_key().clone(),
        worker,
    );
    let config: Value = market.view("get_config").await.unwrap().json().unwrap();
    assert_eq!(config["resolver_id"], parent.id().to_string());
    assert_eq!(config["collateral_token_id"], token.id().to_string());
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
        token_acct,
        market_acct,
        config,
        cutoff_ns,
        storage_cost,
    }
}

impl Stack {
    async fn register_token(
        &self,
        rec: &mut Recorder,
        parent: &Account,
        id: &near_workspaces::AccountId,
    ) {
        tx_ok!(
            rec,
            "token: storage_deposit",
            parent
                .call(self.token.id(), "storage_deposit")
                .args_json(json!({ "account_id": id, "registration_only": true }))
                .deposit(NearToken::from_millinear(10))
        );
    }

    async fn register(&self, rec: &mut Recorder, parent: &Account, who: &Account) {
        self.register_token(rec, parent, who.id()).await;
        tx_ok!(
            rec,
            "market: storage_deposit",
            who.call(self.market.id(), "storage_deposit")
                .args_json(json!({ "account_id": null, "registration_only": true }))
                .deposit(self.storage_cost)
        );
    }

    async fn mint(
        &self,
        rec: &mut Recorder,
        parent: &Account,
        to: &near_workspaces::AccountId,
        amt: u128,
    ) {
        tx_ok!(
            rec,
            "token: mint (fixture owner)",
            parent
                .call(self.token.id(), "mint")
                .args_json(json!({ "account_id": to, "amount": amt.to_string() }))
        );
    }

    async fn deposit(&self, rec: &mut Recorder, who: &Account, amt: u128) {
        tx_ok!(
            rec,
            "deposit (ft_transfer_call)",
            who.call(self.token.id(), "ft_transfer_call")
                .args_json(json!({ "receiver_id": self.market.id(), "amount": amt.to_string(), "msg": "deposit" }))
                .deposit(YOCTO)
                .gas(MAX_GAS)
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

    async fn view(&self, method: &str, args: Value) -> Value {
        self.market
            .view(method)
            .args_json(args)
            .await
            .unwrap()
            .json()
            .unwrap()
    }

    async fn account(&self, id: &near_workspaces::AccountId) -> Value {
        self.view("get_account", json!({ "account_id": id })).await
    }

    async fn market_view(&self) -> Value {
        self.view("get_market", json!({ "market_id": MID })).await
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

/// Verified deployment facts, including the code-hash check against the
/// artifacts that were actually deployed.
async fn facts<T: Network + 'static>(
    worker: &Worker<T>,
    kind: &str,
    parent: &Account,
    stack: &Stack,
    accounts: Value,
    rec: &Recorder,
) -> Value {
    let md: Value = stack
        .token
        .view("ft_metadata")
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(md["symbol"], "tNOC");
    assert_eq!(md["decimals"], 6);
    assert_eq!(stack.config["decimals"], 6);
    assert!(md["name"].as_str().unwrap().contains("TEST"));
    let state = |id: &near_workspaces::AccountId| {
        let w = worker.clone();
        let id = id.clone();
        async move { format!("{:?}", w.view_account(&id).await.unwrap().contract_state) }
    };
    let (mstate, tstate) = (
        state(stack.market.id()).await,
        state(stack.token.id()).await,
    );
    let (m_hex, m_b58) = sha256_b58(&wasm("market"));
    let (t_hex, t_b58) = sha256_b58(&wasm("test_collateral"));
    assert!(
        mstate.contains(&m_b58),
        "market code hash {mstate} != built artifact {m_b58}"
    );
    assert!(
        tstate.contains(&t_b58),
        "token code hash {tstate} != built artifact {t_b58}"
    );
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
        "artifacts": {
            "market_wasm": { "sha256_hex": m_hex, "code_hash_base58": m_b58, "bytes": wasm("market").len() },
            "token_wasm": { "sha256_hex": t_hex, "code_hash_base58": t_b58, "bytes": wasm("test_collateral").len() },
            "onchain_code_hashes_match_artifacts": true,
        },
        "onchain_contract_state": { "market": mstate, "token": tstate },
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
// 1. Full-lifecycle smoke test (+ explicit cleanup of its own accounts)
// ---------------------------------------------------------------------------

struct SmokeRun {
    facts: Value,
    /// Exactly the accounts this run created (never the parent, never demo accounts).
    disposable: Vec<Account>,
    journal: Journal,
}

async fn run_smoke<T: Network + 'static>(
    worker: &Worker<T>,
    fast: Option<&Worker<near_workspaces::network::Sandbox>>,
    parent: &Account,
    tag: &str,
    cutoff_secs: u64,
) -> SmokeRun {
    check_funding(worker, parent, &SMOKE_FUNDING_MILLI).await;
    let mut rec = Recorder::new("smoke", tag, parent);
    let now = worker.view_block().await.unwrap().timestamp();
    let cutoff_ns = now + cutoff_secs * 1_000_000_000;
    let stack = deploy_stack(
        worker,
        parent,
        &mut rec,
        tag,
        "",
        &SMOKE_FUNDING_MILLI,
        cutoff_ns,
        "Will it rain in Lagos on 2026-12-01? (smoke-test market)",
        "Smoke-test market. Resolves YES if the NiMet daily report records measurable rain, otherwise NO. A trusted resolver sets the result; there is no VOID or dispute path.",
        "NiMet daily weather report, Lagos (smoke test)",
    )
    .await;
    let fund = |n: &str| SMOKE_FUNDING_MILLI.iter().find(|(x, _)| *x == n).unwrap().1;
    let alice = user(
        worker,
        parent,
        &format!("alice-{tag}"),
        fund("alice"),
        &rec.journal,
    )
    .await;
    let bob = user(
        worker,
        parent,
        &format!("bob-{tag}"),
        fund("bob"),
        &rec.journal,
    )
    .await;
    let carol = user(
        worker,
        parent,
        &format!("carol-{tag}"),
        fund("carol"),
        &rec.journal,
    )
    .await;
    stack
        .register_token(&mut rec, parent, stack.market.id())
        .await;
    for (who, amt) in [(&alice, 100), (&bob, 10), (&carol, 10)] {
        stack.register(&mut rec, parent, who).await;
        stack.mint(&mut rec, parent, who.id(), amt * ONE).await;
    }
    for (who, amt) in [(&alice, 100), (&bob, 10), (&carol, 10)] {
        stack.deposit(&mut rec, who, amt * ONE).await;
    }

    // Split, offer, partial fills, cancel, resale.
    tx_ok!(
        rec,
        "alice: split 100",
        stack.call(
            &alice,
            "split_position",
            json!({ "market_id": MID, "amount": tok(100) })
        )
    );
    let r = tx_ok!(
        rec,
        "alice: create_offer 20 YES @0.60",
        stack.call(
            &alice,
            "create_offer",
            json!({ "market_id": MID, "outcome": "Yes", "side": "Sell", "price": "600000", "quantity": tok(20) })
        )
    );
    let id = r.json::<Value>().unwrap()["offer_id"]
        .as_str()
        .unwrap()
        .to_string();
    tx_ok!(
        rec,
        "bob: fill 8",
        stack.call(
            &bob,
            "fill_offer",
            json!({ "offer_id": id, "quantity": tok(8) })
        )
    );
    tx_ok!(
        rec,
        "carol: fill 5",
        stack.call(
            &carol,
            "fill_offer",
            json!({ "offer_id": id, "quantity": tok(5) })
        )
    );
    tx_ok!(
        rec,
        "alice: cancel remainder (7)",
        stack.call(&alice, "cancel_offer", json!({ "offer_id": id }))
    );
    let r = tx_ok!(
        rec,
        "bob: resell offer 3 YES @0.70",
        stack.call(
            &bob,
            "create_offer",
            json!({ "market_id": MID, "outcome": "Yes", "side": "Sell", "price": "700000", "quantity": tok(3) })
        )
    );
    let id2 = r.json::<Value>().unwrap()["offer_id"]
        .as_str()
        .unwrap()
        .to_string();
    tx_ok!(
        rec,
        "carol: fill resale 3",
        stack.call(
            &carol,
            "fill_offer",
            json!({ "offer_id": id2, "quantity": tok(3) })
        )
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
    let totals = stack.view("get_totals", json!({})).await;
    assert_eq!(num(&totals, "market_backing"), 100 * ONE);
    assert_eq!(num(&totals, "open_offers"), 0);
    assert!(
        worker.view_block().await.unwrap().timestamp() < stack.cutoff_ns,
        "trading finished after the cutoff; raise the smoke cutoff"
    );

    // Resolution rules: refused early, refused for non-resolvers, final once set.
    let resolve_args =
        |outcome: &str, ev: &str| json!({ "market_id": MID, "outcome": outcome, "evidence": ev });
    tx_fail!(
        rec,
        "resolver: resolve before the cutoff (refused)",
        "cannot be resolved before its cutoff",
        stack.call(parent, "resolve_market", resolve_args("Yes", "too early"))
    );
    rec.journal
        .event(json!({ "event": "waiting_for_cutoff", "cutoff_ns": stack.cutoff_ns.to_string() }));
    wait_past(worker, fast, stack.cutoff_ns).await;
    assert_eq!(stack.market_view().await["status"], "AwaitingResolution");
    tx_fail!(
        rec,
        "alice: resolve as a non-resolver (refused)",
        "only the configured resolver",
        stack.call(&alice, "resolve_market", resolve_args("No", "not allowed"))
    );
    tx_ok!(
        rec,
        "resolver: resolve YES",
        stack.call(
            parent,
            "resolve_market",
            resolve_args(
                "Yes",
                "https://nimet.example/report (smoke test, no real source)"
            )
        )
    );
    let m = stack.market_view().await;
    assert_eq!(m["status"], "Resolved");
    assert_eq!(m["resolution"]["outcome"], "Yes");
    tx_fail!(
        rec,
        "resolver: resolve again (refused)",
        "already resolved",
        stack.call(
            parent,
            "resolve_market",
            resolve_args("No", "change of mind")
        )
    );

    // Post-resolution restrictions.
    tx_fail!(
        rec,
        "bob: split after resolution (refused)",
        "market is resolved",
        stack.call(
            &bob,
            "split_position",
            json!({ "market_id": MID, "amount": "1000000" })
        )
    );
    tx_fail!(
        rec,
        "alice: merge after resolution (refused)",
        "market is resolved",
        stack.call(
            &alice,
            "merge_positions",
            json!({ "market_id": MID, "amount": "1000000" })
        )
    );
    tx_fail!(
        rec,
        "alice: create_offer after resolution (refused)",
        "market is resolved",
        stack.call(
            &alice,
            "create_offer",
            json!({ "market_id": MID, "outcome": "Yes", "side": "Sell", "price": "600000", "quantity": "1000000" })
        )
    );

    // Redeem (each user, different order), repeat redeem refused, then withdraw.
    for (name, who) in [("carol", &carol), ("alice", &alice), ("bob", &bob)] {
        let nm = format!("{name}: redeem");
        tx_ok!(
            rec,
            nm.as_str(),
            stack.call(who, "redeem", json!({ "market_id": MID }))
        );
    }
    tx_fail!(
        rec,
        "alice: redeem again (refused)",
        "nothing to redeem",
        stack.call(&alice, "redeem", json!({ "market_id": MID }))
    );
    assert_eq!(snap(&stack.account(alice.id()).await).0, 94_800_000);
    assert_eq!(snap(&stack.account(bob.id()).await).0, 12_300_000);
    assert_eq!(snap(&stack.account(carol.id()).await).0, 12_900_000);
    let totals = stack.view("get_totals", json!({})).await;
    assert_eq!(num(&totals, "market_backing"), 0);
    assert_eq!(num(&totals, "available_collateral"), 120 * ONE);
    for (name, who, amt) in [
        ("alice", &alice, 94_800_000u128),
        ("bob", &bob, 12_300_000),
        ("carol", &carol, 12_900_000),
    ] {
        let nm = format!("{name}: withdraw");
        tx_ok!(
            rec,
            nm.as_str(),
            stack.call(who, "withdraw", json!({ "amount": amt.to_string() }))
        );
    }
    assert_eq!(stack.token_balance(alice.id()).await, 94_800_000);
    assert_eq!(stack.token_balance(bob.id()).await, 12_300_000);
    assert_eq!(stack.token_balance(carol.id()).await, 12_900_000);
    assert_eq!(stack.token_balance(stack.market.id()).await, 0);
    for who in [&alice, &bob, &carol] {
        let w = stack
            .view("get_withdrawal", json!({ "account_id": who.id() }))
            .await;
        assert_eq!(w["status"], "Completed");
    }

    // Final state, captured BEFORE any cleanup.
    let mut final_state = json!({ "market_token_balance": stack.token_balance(stack.market.id()).await.to_string(),
        "market_totals": stack.view("get_totals", json!({})).await,
        "market": stack.market_view().await });
    for (name, who) in [("alice", &alice), ("bob", &bob), ("carol", &carol)] {
        final_state[name] = json!({
            "internal_account": stack.account(who.id()).await,
            "token_wallet_balance": stack.token_balance(who.id()).await.to_string(),
            "last_withdrawal": stack.view("get_withdrawal", json!({ "account_id": who.id() })).await,
        });
    }
    let accounts = json!({ "market": stack.market.id(), "token": stack.token.id(),
        "alice": alice.id(), "bob": bob.id(), "carol": carol.id() });
    let mut f = facts(
        worker,
        "smoke-test (market is RESOLVED; do not use for the frontend)",
        parent,
        &stack,
        accounts,
        &rec,
    )
    .await;
    f["final_state_before_cleanup"] = final_state;
    f["verified"] = json!(true);
    rec.journal
        .event(json!({ "event": "verified", "steps": rec.steps.len() }));
    SmokeRun {
        facts: f,
        disposable: vec![
            alice,
            bob,
            carol,
            stack.market_acct.clone(),
            stack.token_acct.clone(),
        ],
        journal: rec.journal.clone(),
    }
}

/// Deletes exactly the accounts created by this smoke run and returns their
/// NEAR to the parent. Refuses the parent and any demo account.
async fn cleanup_smoke<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    run: SmokeRun,
) -> Value {
    let ids: Vec<String> = run.disposable.iter().map(|a| a.id().to_string()).collect();
    for id in &ids {
        assert_ne!(id, parent.id().as_str(), "refusing to delete the parent");
        assert!(
            !id.contains("-demo-"),
            "refusing to delete a demo account: {id}"
        );
        assert!(
            id.ends_with(&format!(".{}", parent.id())),
            "{id} is not a sub-account of the parent"
        );
    }
    run.journal
        .event(json!({ "event": "cleanup_start", "accounts": ids }));
    let before = worker.view_account(parent.id()).await.unwrap().balance;
    let mut per_account = vec![];
    let mut sum = 0u128;
    for a in &run.disposable {
        let b = worker.view_account(a.id()).await.unwrap().balance;
        sum += b.as_yoctonear();
        per_account.push(json!({ "account": a.id(), "balance_before_delete": b.to_string() }));
    }
    for a in run.disposable {
        let id = a.id().clone();
        match a.delete_account(parent.id()).await {
            Ok(r) => {
                assert!(r.is_success(), "deleting {id} failed: {:#?}", r.failures());
                run.journal
                    .event(json!({ "event": "account_deleted", "account": id,
                    "tx_hash": r.outcome().transaction_hash.to_string() }));
                println!("  deleted {id} (tx {})", r.outcome().transaction_hash);
            }
            Err(e) => {
                let still_exists = worker.view_account(&id).await.is_ok();
                run.journal
                    .event(json!({ "event": "account_delete_uncertain", "account": id,
                    "error": e.to_string(), "still_exists": still_exists }));
                assert!(
                    !still_exists,
                    "UNCERTAIN: deleting {id} failed ({e}) and it still exists. Not retrying; check the journal."
                );
            }
        }
    }
    let after = worker.view_account(parent.id()).await.unwrap().balance;
    let returned = after.as_yoctonear().saturating_sub(before.as_yoctonear());
    let slack = NearToken::from_millinear(100).as_yoctonear();
    assert!(
        returned + slack >= sum,
        "only {} came back of {} held by the deleted accounts",
        NearToken::from_yoctonear(returned),
        NearToken::from_yoctonear(sum)
    );
    run.journal.event(json!({ "event": "cleanup_done", "returned": NearToken::from_yoctonear(returned).to_string() }));
    json!({
        "status": "deleted after verification; kept only as historical test evidence (explorer history remains)",
        "accounts_deleted": ids,
        "per_account": per_account,
        "beneficiary": parent.id(),
        "held_by_deleted_accounts": NearToken::from_yoctonear(sum).to_string(),
        "returned_to_beneficiary": NearToken::from_yoctonear(returned).to_string(),
        "parent_balance_before_cleanup": before.to_string(),
        "parent_balance_after_cleanup": after.to_string(),
    })
}

// ---------------------------------------------------------------------------
// 2. Persistent open demo market for the frontend
// ---------------------------------------------------------------------------

/// `mint_to`: `(account id, whole tokens)` demo users who get test tokens.
async fn run_demo<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    tag: &str,
    observation_date: &str,
    mint_to: &[(near_workspaces::AccountId, u128)],
) -> Value {
    check_funding(worker, parent, &DEMO_FUNDING_MILLI).await;
    let cutoff_s = cutoff_secs_for_observation_date(observation_date);
    let now_s = (worker.view_block().await.unwrap().timestamp() / 1_000_000_000) as i64;
    assert!(
        cutoff_s > now_s + 3600,
        "the cutoff for {observation_date} is not at least an hour in the future"
    );
    let cutoff_ns = cutoff_s as u64 * 1_000_000_000;
    let cutoff_utc = rfc3339(cutoff_s);
    let question = format!("Will it rain in Lagos on {observation_date}?");
    let rules = format!(
        "Observation period: the Lagos calendar day {observation_date}, 00:00 to 24:00 WAT (UTC+1). \
         Resolves YES if the NiMet daily weather report for Lagos for {observation_date} records measurable rain, otherwise NO. \
         Trading closes at the start of that day, 00:00 WAT = {cutoff_utc}. \
         A trusted resolver (the market's resolver_id) sets the final result once, after the cutoff and after the NiMet report is published. \
         There is no VOID or dispute path."
    );
    let source = format!("NiMet daily weather report, Lagos, {observation_date}");

    let mut rec = Recorder::new("demo", tag, parent);
    let stack = deploy_stack(
        worker,
        parent,
        &mut rec,
        tag,
        "demo-",
        &DEMO_FUNDING_MILLI,
        cutoff_ns,
        &question,
        &rules,
        &source,
    )
    .await;
    let fund = |n: &str| DEMO_FUNDING_MILLI.iter().find(|(x, _)| *x == n).unwrap().1;
    let lp = user(
        worker,
        parent,
        &format!("lp-demo-{tag}"),
        fund("lp"),
        &rec.journal,
    )
    .await;
    stack
        .register_token(&mut rec, parent, stack.market.id())
        .await;
    stack.register(&mut rec, parent, &lp).await;
    stack.mint(&mut rec, parent, lp.id(), 200 * ONE).await;
    stack.deposit(&mut rec, &lp, 200 * ONE).await;
    tx_ok!(
        rec,
        "lp: split 100",
        stack.call(
            &lp,
            "split_position",
            json!({ "market_id": MID, "amount": tok(100) })
        )
    );

    // Liquidity: YES and NO sell ladders and YES bids.
    let mut seeded = vec![];
    for (outcome, side, price, qty) in [
        ("Yes", "Sell", 650_000u128, 10u128),
        ("Yes", "Sell", 700_000, 10),
        ("Yes", "Sell", 750_000, 10),
        ("No", "Sell", 350_000, 10),
        ("No", "Sell", 400_000, 10),
        ("Yes", "Buy", 550_000, 10),
        ("Yes", "Buy", 500_000, 10),
    ] {
        let nm = format!("lp: {side} {qty} {outcome} @{}", price as f64 / 1e6);
        let r = tx_ok!(
            rec,
            nm.as_str(),
            stack.call(
                &lp,
                "create_offer",
                json!({ "market_id": MID, "outcome": outcome, "side": side, "price": price.to_string(), "quantity": tok(qty) })
            )
        );
        let offer_id = r.json::<Value>().unwrap()["offer_id"]
            .as_str()
            .unwrap()
            .to_string();
        seeded.push(
            json!({ "offer_id": offer_id, "outcome": outcome, "side": side,
            "price": price.to_string(), "quantity": tok(qty) }),
        );
    }

    // Prove the liquidity is usable by ANOTHER account: a probe fills 0.0001 share.
    let probe = user(
        worker,
        parent,
        &format!("probe-demo-{tag}"),
        fund("probe"),
        &rec.journal,
    )
    .await;
    stack.register(&mut rec, parent, &probe).await;
    stack.mint(&mut rec, parent, probe.id(), ONE).await;
    stack.deposit(&mut rec, &probe, ONE).await;
    let first_id = seeded[0]["offer_id"].as_str().unwrap().to_string();
    let r = tx_ok!(
        rec,
        "probe: fill 0.0001 of the first YES sell offer",
        stack.call(
            &probe,
            "fill_offer",
            json!({ "offer_id": first_id, "quantity": "100" })
        )
    );
    let probe_fill: Value = r.json().unwrap();
    assert_eq!(probe_fill["collateral_amount"], "65");
    assert_eq!(probe_fill["status"], "PartiallyFilled");

    // Test tokens for demo users (they must also register with the market themselves).
    for (id, whole) in mint_to {
        stack.register_token(&mut rec, parent, id).await;
        stack.mint(&mut rec, parent, id, whole * ONE).await;
    }

    // Verify the published terms and the live book.
    let m = stack.market_view().await;
    assert_eq!(m["status"], "Open");
    assert_eq!(m["trading_open"], true);
    assert_eq!(m["resolved"], false);
    assert_eq!(m["question"], question);
    assert_eq!(m["resolution_source"], source);
    assert!(m["rules"].as_str().unwrap().contains(observation_date));
    assert!(m["rules"].as_str().unwrap().contains(&cutoff_utc));
    assert_eq!(m["trading_cutoff_ns"], cutoff_ns.to_string());
    assert_eq!(m["resolver_id"], parent.id().to_string());
    let list = |outcome: &'static str, side: &'static str| {
        let market = stack.market.clone();
        async move {
            let v: Vec<Value> = market
                .view("list_offers")
                .args_json(json!({ "market_id": MID, "outcome": outcome, "side": side }))
                .await
                .unwrap()
                .json()
                .unwrap();
            v
        }
    };
    let (ys, ns, yb) = (
        list("Yes", "Sell").await,
        list("No", "Sell").await,
        list("Yes", "Buy").await,
    );
    assert_eq!((ys.len(), ns.len(), yb.len()), (3, 2, 2));
    for o in ys.iter().chain(ns.iter()).chain(yb.iter()) {
        assert_eq!(o["fillable"], true);
        assert_eq!(o["owner_id"], lp.id().to_string());
    }
    let pa = stack.account(probe.id()).await;
    assert_eq!(pa["yes"], "100");

    let accounts = json!({
        "market": stack.market.id(), "token": stack.token.id(),
        "resolver_and_token_owner": parent.id(),
        "liquidity_provider": lp.id(), "probe_trader": probe.id(),
        "minted_demo_users": mint_to.iter().map(|(a, n)| json!({"account": a, "tokens": n})).collect::<Vec<_>>(),
    });
    let mut f = facts(
        worker,
        "persistent OPEN demo market for the frontend",
        parent,
        &stack,
        accounts,
        &rec,
    )
    .await;
    f["market_terms"] = json!({
        "question": question, "rules": rules, "resolution_source": source,
        "observation_date": observation_date,
        "observation_window": format!("{observation_date} 00:00-24:00 WAT (UTC+1)"),
        "split_cutoff_ns": cutoff_ns.to_string(), "split_cutoff_utc": cutoff_utc,
        "resolve_after": "the cutoff, once the NiMet report for the observation date is published",
    });
    f["seeded_offers"] = json!(seeded);
    f["probe_fill"] = probe_fill;
    f["frontend"] = json!({
        "read_ids_from": "this file (accounts.market, accounts.token, market_id)",
        "token_symbol_decimals_note": "read ft_metadata from the token contract instead of hardcoding",
        "registration": {
            "token_storage_deposit_yocto": "1250000000000000000000",
            "market_storage_deposit_yocto": stack.config["storage_cost_per_account"],
        },
        "tested_gas": { "ft_transfer_call": "300 Tgas", "market_calls": "100 Tgas" },
    });
    f["verified"] = json!(true);
    rec.journal
        .event(json!({ "event": "verified", "steps": rec.steps.len() }));
    f
}

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

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

#[tokio::test]
async fn smoke_on_sandbox() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let run = run_smoke(&worker, Some(&worker), &root, "sbx", 120).await;
    let facts = run.facts.clone();
    assert!(facts["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["succeeded"] == true));
    assert!(facts["steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["expected_failure"] == true));
    // Cleanup only deletes this run's accounts and returns their NEAR.
    let cleanup = cleanup_smoke(&worker, &root, run).await;
    assert_eq!(cleanup["accounts_deleted"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn demo_on_sandbox() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let user = new_user(&root, "demouser").await;
    let now_s = (worker.view_block().await.unwrap().timestamp() / 1_000_000_000) as i64;
    let date = rfc3339(now_s + 30 * 86_400)[..10].to_string();
    let facts = run_demo(&worker, &root, "sbx", &date, &[(user.id().clone(), 50)]).await;
    assert!(facts["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["succeeded"] == true));
    assert_eq!(facts["market_terms"]["observation_date"], date);
}

#[test]
fn observation_date_maps_to_a_matching_cutoff() {
    // 2026-11-12 00:00 WAT is 2026-11-11 23:00 UTC.
    let c = cutoff_secs_for_observation_date("2026-11-12");
    assert_eq!(rfc3339(c), "2026-11-11T23:00:00Z");
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
}

#[tokio::test]
#[ignore = "needs NEARODDS_TESTNET_PARENT (+ its key in ~/.near-credentials or NEARODDS_TESTNET_PARENT_KEY)"]
async fn smoke_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    let cleanup = std::env::var("NEARODDS_SMOKE_CLEANUP")
        .map(|v| v != "0")
        .unwrap_or(true);
    // 10 minutes: enough for the testnet transactions, then the harness waits for the cutoff.
    let run = run_smoke(&worker, None, &parent, &unique_tag(), 600).await;
    // 1. Save the VERIFIED record first.
    let mut facts = run.facts.clone();
    facts["cleanup"] = json!({ "status": "pending (verified record saved before cleanup)" });
    write_facts("testnet.json", "NEARODDS_DEPLOYMENT_OUT", &facts);
    // 2. Then delete exactly this run's disposable accounts.
    if cleanup {
        facts["cleanup"] = cleanup_smoke(&worker, &parent, run).await;
        write_facts("testnet.json", "NEARODDS_DEPLOYMENT_OUT", &facts);
    }
}

#[tokio::test]
#[ignore = "needs NEARODDS_TESTNET_PARENT (+ its key in ~/.near-credentials or NEARODDS_TESTNET_PARENT_KEY)"]
async fn demo_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    let date =
        std::env::var("NEARODDS_DEMO_OBSERVATION_DATE").unwrap_or_else(|_| "2026-11-12".into());
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
    let facts = run_demo(&worker, &parent, &unique_tag(), &date, &mint).await;
    write_facts("testnet-demo.json", "NEARODDS_DEMO_OUT", &facts);
}

/// Recovery drill, step 1 (run as its own process): creates a tiny disposable
/// sub-account with a persisted key and journals it. Step 2 is
/// `delete_testnet_accounts` in a FRESH process.
#[tokio::test]
#[ignore = "testnet only: creates one 0.2 NEAR drill sub-account of NEARODDS_TESTNET_PARENT"]
async fn drill_create_on_testnet() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    let tag = unique_tag();
    let journal = Journal::open("drill", &tag);
    let name = format!("drill-{tag}");
    let acct = user(&worker, &parent, &name, 200, &journal).await;
    let saved = stored_key(acct.id().as_str()).expect("key was persisted");
    let on_chain = acct.view_access_key(&saved.public_key()).await.is_ok();
    println!("drill account: {}", acct.id());
    println!(
        "saved public key {} matches an on-chain access key: {on_chain}",
        saved.public_key()
    );
    assert!(on_chain);
}

/// Recovery: deletes the listed sub-accounts (keys were persisted when they were
/// created) and returns their NEAR to the parent. Refuses the parent, anything
/// that is not a sub-account of the parent, and every `-demo-` (persistent) account.
/// NEARODDS_DELETE_ACCOUNTS="tok-1.parent.testnet,mkt-1.parent.testnet,..."
#[tokio::test]
#[ignore = "testnet only: deletes the listed sub-accounts into NEARODDS_TESTNET_PARENT"]
async fn delete_testnet_accounts() {
    let worker = testnet_worker().await;
    let parent = testnet_parent(&worker);
    let journal = Journal::open("recovery", &unique_tag());
    let before = worker.view_account(parent.id()).await.unwrap().balance;
    let mut deleted = 0;
    for id in std::env::var("NEARODDS_DELETE_ACCOUNTS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
    {
        let id = id.trim();
        assert_ne!(id, parent.id().as_str(), "refusing to delete the parent");
        assert!(
            id.ends_with(&format!(".{}", parent.id())),
            "{id} is not a sub-account of the parent"
        );
        assert!(
            !id.contains("-demo-"),
            "refusing to delete persistent demo account {id}"
        );
        let sk = stored_key(id).unwrap_or_else(|| panic!("no stored key for {id}"));
        let acct = Account::from_secret_key(id.parse().unwrap(), sk.clone(), &worker);
        let matches = acct.view_access_key(&sk.public_key()).await.is_ok();
        println!(
            "{id}: saved public key {} matches an on-chain access key: {matches}",
            sk.public_key()
        );
        assert!(matches, "saved key does not match {id}");
        let bal = worker.view_account(acct.id()).await.unwrap().balance;
        journal.event(
            json!({ "event": "account_deleting", "account": id, "balance": bal.to_string() }),
        );
        match acct.delete_account(parent.id()).await {
            Ok(r) => {
                assert!(r.is_success(), "{:#?}", r.failures());
                journal.event(json!({ "event": "account_deleted", "account": id,
                    "tx_hash": r.outcome().transaction_hash.to_string() }));
                println!(
                    "deleted {id} (held {bal}), tx {}",
                    r.outcome().transaction_hash
                );
                deleted += 1;
            }
            Err(e) => {
                let still = worker.view_account(&id.parse().unwrap()).await.is_ok();
                journal.event(json!({ "event": "account_delete_uncertain", "account": id,
                    "error": e.to_string(), "still_exists": still }));
                assert!(
                    !still,
                    "UNCERTAIN: deleting {id} failed ({e}) and it still exists; not retrying"
                );
            }
        }
    }
    let after = worker.view_account(parent.id()).await.unwrap().balance;
    println!(
        "parent {} balance: {before} -> {after} ({deleted} accounts deleted)",
        parent.id()
    );
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
