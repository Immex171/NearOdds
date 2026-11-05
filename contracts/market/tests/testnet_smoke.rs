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
//! * a transaction is signed and submitted exactly once. Its hash, signer and
//!   operation are journaled. If its status cannot be read (pending, timeout, RPC
//!   error) the outcome is UNCERTAIN: the run stops and journals `step_uncertain`.
//!   Nothing is ever re-signed because of a timeout; the uncertain hash is
//!   resolved later by polling THAT hash (`resolve_uncertain_on_testnet`).
//! * account deletion and absence are only reported when the evidence is explicit
//!   (`UNKNOWN_ACCOUNT`); transport errors and rate limits stay "uncertain".
//! * run ids are collision-resistant and key files are created exclusively,
//!   never overwritten.
//!
//! Both deploy the production `market.wasm` (never the failure-injection build)
//! and the `test_collateral.wasm` fixture. See docs/testnet.md.

mod common;
use common::*;

use near_workspaces::network::NetworkInfo;
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

/// `~/.near-credentials/testnet` (mode 700).
fn default_creds_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME");
    PathBuf::from(home).join(".near-credentials/testnet")
}

/// Non-secret, append-only run journal (account ids, tx hashes, steps). It also
/// carries the credentials directory used for the run's keys (`None` on Sandbox,
/// where nothing is persisted).
#[derive(Clone)]
struct Journal {
    path: Option<PathBuf>,
    creds_dir: Option<PathBuf>,
}

impl Journal {
    fn open(kind: &str, tag: &str) -> Journal {
        if !PERSIST_KEYS.load(std::sync::atomic::Ordering::SeqCst) {
            return Journal {
                path: None,
                creds_dir: None,
            }; // Sandbox runs are not journaled
        }
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../deployments/runs");
        std::fs::create_dir_all(&dir).unwrap();
        Journal {
            path: Some(dir.join(format!("{kind}-{tag}.jsonl"))),
            creds_dir: Some(default_creds_dir()),
        }
    }

    /// Explicit journal file and credentials directory (used by the tests).
    fn at(path: PathBuf, creds_dir: Option<PathBuf>) -> Journal {
        Journal {
            path: Some(path),
            creds_dir,
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

    /// Every event recorded so far (empty when not journaling).
    fn events(&self) -> Vec<Value> {
        self.path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|t| {
                t.lines()
                    .filter_map(|l| serde_json::from_str(l).ok())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// A transaction that was signed and submitted once but whose final outcome
/// could not be read. It may have succeeded, failed or still be in flight.
#[derive(Debug, Clone)]
struct Uncertain {
    step: String,
    tx_hash: String,
    signer: String,
    reason: String,
}

/// Signer of a submitted transaction. `TransactionStatus` does not expose it, but
/// its `Debug` output does (`sender_id`); `signer_parsing_matches_debug_format`
/// pins that format so a library upgrade fails loudly rather than silently.
fn signer_of(status: &TransactionStatus) -> String {
    parse_signer(&format!("{status:?}"))
}

fn parse_signer(debug: &str) -> String {
    debug
        .split("sender_id:")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or("unknown")
        .to_string()
}

struct Recorder {
    steps: Vec<Value>,
    journal: Journal,
    last_hash: String,
    /// How long to read a transaction's status before declaring it uncertain.
    patience: std::time::Duration,
    /// Failure injection (tests only): every status read fails as if the RPC
    /// were unavailable, while the transaction itself still executes.
    inject_status_unavailable: bool,
}

impl Recorder {
    fn new(kind: &str, tag: &str, parent: &Account) -> Recorder {
        let journal = Journal::open(kind, tag);
        journal.event(json!({ "event": "run_start", "kind": kind, "tag": tag,
            "parent": parent.id(), "git_commit": git(&["rev-parse", "HEAD"]) }));
        Recorder::with_journal(journal)
    }

    fn with_journal(journal: Journal) -> Recorder {
        Recorder {
            steps: vec![],
            journal,
            last_hash: String::new(),
            patience: std::time::Duration::from_secs(60),
            inject_status_unavailable: false,
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

    /// The transaction WAS submitted (hash known) but its outcome is unknown.
    fn stop_uncertain(&self, u: &Uncertain) -> ! {
        panic!(
            "UNCERTAIN: '{}' (tx {} signed by {}) was submitted but its outcome could not be \
             read ({}). It may have succeeded. NOT resubmitting. Resolve it with \
             resolve_uncertain_on_testnet (see docs/testnet.md) before running anything again.",
            u.step, u.tx_hash, u.signer, u.reason
        );
    }

    /// Polls the RECORDED hash. `Ok` once the transaction has finished.
    /// `Err(Uncertain)` if its status could not be read within `patience`
    /// (pending, timeout or RPC error). That does NOT mean the transaction was
    /// dropped or failed, so nothing is ever re-signed because of it.
    async fn finish(
        &mut self,
        step: &str,
        status: TransactionStatus,
    ) -> Result<ExecutionFinalResult, Uncertain> {
        let hash = status.hash().to_string();
        let signer = signer_of(&status);
        self.journal
            .event(json!({ "event": "step_submitted", "step": step,
            "tx_hash": hash, "signer": signer, "operation": step }));
        let start = std::time::Instant::now();
        let mut polls = 0;
        let mut last = String::from("transaction still pending");
        while start.elapsed() < self.patience {
            polls += 1;
            if self.inject_status_unavailable {
                last = "injected: RPC unavailable".to_string();
            } else {
                match tokio::time::timeout(std::time::Duration::from_secs(15), status.status())
                    .await
                {
                    Ok(Ok(Poll::Ready(r))) => {
                        self.last_hash = hash;
                        return Ok(r);
                    }
                    Ok(Ok(Poll::Pending)) => last = "transaction still pending".to_string(),
                    Err(_) => last = "status request timed out".to_string(),
                    Ok(Err(e)) => {
                        last = e.to_string();
                        if polls % 8 == 1 {
                            eprintln!("  ... polling '{step}' ({hash}): {e}");
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                if self.inject_status_unavailable {
                    50
                } else {
                    2000
                },
            ))
            .await;
        }
        let u = Uncertain {
            step: step.to_string(),
            tx_hash: hash,
            signer,
            reason: last,
        };
        self.journal
            .event(json!({ "event": "step_uncertain", "step": u.step,
            "tx_hash": u.tx_hash, "signer": u.signer, "operation": u.step,
            "reason": u.reason }));
        Err(u)
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

/// Sign and submit ONCE, then poll the recorded hash. If the status cannot be
/// read within the patience window the outcome is UNCERTAIN and the run stops:
/// a timeout is not proof the transaction failed, so it is never re-signed.
/// A submit call that errored (outcome unknown) also stops the run.
/// Evaluates to the final result.
macro_rules! tx {
    ($rec:expr, $name:expr, $txn:expr) => {{
        $rec.journal.event(json!({ "event": "step_submitting", "step": $name }));
        match $txn.transact_async().await {
            Ok(s) => match $rec.finish($name, s).await {
                Ok(r) => r,
                Err(u) => $rec.stop_uncertain(&u),
            },
            Err(e) => $rec.uncertain($name, e.to_string()),
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

#[derive(Debug)]
enum KeyError {
    /// A credentials file for this account already exists; it is never overwritten.
    AlreadyExists(PathBuf),
    Io(String),
}

fn key_path(dir: &std::path::Path, account_id: &str) -> PathBuf {
    dir.join(format!("{account_id}.json"))
}

/// Writes `<dir>/<account>.json` EXCLUSIVELY (`create_new`): if the file exists
/// it is left untouched and `AlreadyExists` is returned. Created with mode 600
/// from the start (no window where it is world-readable); `dir` is mode 700.
fn save_key_in(dir: &std::path::Path, account_id: &str, sk: &SecretKey) -> Result<(), KeyError> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| KeyError::Io(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| KeyError::Io(e.to_string()))?;
    }
    let path = key_path(dir, account_id);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            KeyError::AlreadyExists(path.clone())
        } else {
            KeyError::Io(e.to_string())
        }
    })?;
    let body = json!({
        "account_id": account_id,
        "public_key": sk.public_key().to_string(),
        "private_key": sk.to_string(),
    });
    f.write_all(serde_json::to_string_pretty(&body).unwrap().as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|e| KeyError::Io(e.to_string()))
}

/// The stored key for `account_id`, if the file exists AND is self-consistent
/// (account id matches; the public key matches the private key). Never printed.
fn load_verified_key(dir: &std::path::Path, account_id: &str) -> Option<SecretKey> {
    let v: Value =
        serde_json::from_str(&std::fs::read_to_string(key_path(dir, account_id)).ok()?).ok()?;
    let sk: SecretKey = v["private_key"].as_str()?.parse().ok()?;
    let consistent = v["account_id"].as_str().is_none_or(|a| a == account_id)
        && v["public_key"]
            .as_str()
            .is_none_or(|pk| pk == sk.public_key().to_string());
    consistent.then_some(sk)
}

/// What the chain says about an account. Only `Absent` is evidence that it does
/// not exist: it requires an explicit `UNKNOWN_ACCOUNT` response.
#[derive(Debug, Clone, PartialEq)]
enum AccountState {
    Present(u128),
    Absent,
    Unknown(String),
}

/// Interprets a raw JSON-RPC `query/view_account` response body. near-workspaces
/// flattens every failure into "unable to fulfill the query request", which cannot
/// tell a missing account from a rate limit, so the harness reads the RPC itself:
/// only `error.cause.name == "UNKNOWN_ACCOUNT"` is absence; everything else
/// that is not a clear success (HTTP errors, rate limits, INTERNAL_ERROR,
/// timeouts, unparseable bodies) is `Unknown`.
fn classify_account_response(body: &Value) -> AccountState {
    if let Some(err) = body.get("error") {
        return if err["cause"]["name"].as_str() == Some("UNKNOWN_ACCOUNT") {
            AccountState::Absent
        } else {
            AccountState::Unknown(err.to_string())
        };
    }
    match body["result"]["amount"]
        .as_str()
        .and_then(|a| a.parse::<u128>().ok())
    {
        Some(b) => AccountState::Present(b),
        None => AccountState::Unknown(format!("unexpected response: {body}")),
    }
}

/// One bounded raw `view_account` query against `rpc_url`.
fn raw_view_account(rpc_url: &str, id: &str) -> AccountState {
    let req = json!({ "jsonrpc": "2.0", "id": "nearodds", "method": "query",
        "params": { "request_type": "view_account", "finality": "optimistic", "account_id": id } });
    let out = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "20",
            "-H",
            "content-type: application/json",
            "-d",
        ])
        .arg(req.to_string())
        .arg(rpc_url)
        .output();
    match out {
        Ok(o) if o.status.success() => match serde_json::from_slice::<Value>(&o.stdout) {
            Ok(v) => classify_account_response(&v),
            Err(e) => AccountState::Unknown(format!("unparseable response: {e}")),
        },
        Ok(o) => AccountState::Unknown(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) => AccountState::Unknown(e.to_string()),
    }
}

/// Reads an account with bounded time. `rpc_down` injects "RPC unavailable".
async fn account_state<T: Network + 'static>(
    worker: &Worker<T>,
    id: &near_workspaces::AccountId,
    rpc_down: bool,
) -> AccountState {
    if rpc_down {
        return AccountState::Unknown("injected: RPC unavailable".into());
    }
    let (url, id) = (worker.info().rpc_url.to_string(), id.to_string());
    tokio::task::spawn_blocking(move || raw_view_account(&url, &id))
        .await
        .unwrap_or_else(|e| AccountState::Unknown(e.to_string()))
}

/// Polls until the account state is conclusive (`Present` or `Absent`) or the
/// window ends; the last (possibly `Unknown`) state is returned.
async fn settle_account_state<T: Network + 'static>(
    worker: &Worker<T>,
    id: &near_workspaces::AccountId,
    rpc_down: bool,
    window: std::time::Duration,
) -> AccountState {
    let start = std::time::Instant::now();
    loop {
        let st = account_state(worker, id, rpc_down).await;
        if !matches!(st, AccountState::Unknown(_)) || start.elapsed() >= window {
            return st;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Creates a funded sub-account.
/// * The key is saved EXCLUSIVELY before the call; an existing key file is never
///   overwritten. If one exists (an interrupted earlier attempt) it is reused
///   only when it is self-consistent and the chain agrees: the account does not
///   exist yet, or it exists with that very key. Any other combination refuses.
/// * The id is journaled before the call. If the call errors we check whether
///   the account exists with OUR key before ever creating it again.
async fn user<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    name: &str,
    milli: u128,
    journal: &Journal,
) -> Account {
    let id = format!("{name}.{}", parent.id());
    let account_id: near_workspaces::AccountId = id.parse().unwrap();
    let sk = match &journal.creds_dir {
        None => SecretKey::from_random(KeyType::ED25519),
        Some(dir) => {
            let fresh = SecretKey::from_random(KeyType::ED25519);
            match save_key_in(dir, &id, &fresh) {
                Ok(()) => fresh,
                Err(KeyError::AlreadyExists(path)) => {
                    let existing = load_verified_key(dir, &id).unwrap_or_else(|| {
                        panic!("a key file for {id} exists at {path:?} but is unreadable or inconsistent. \
                                Refusing to overwrite it; move it aside yourself if you are sure.")
                    });
                    let probe =
                        Account::from_secret_key(account_id.clone(), existing.clone(), worker);
                    match account_state(worker, &account_id, false).await {
                        AccountState::Absent => {}
                        AccountState::Present(_) => {
                            let ours = probe.view_access_key(&existing.public_key()).await.is_ok();
                            assert!(
                                ours,
                                "COLLISION: {id} exists on chain but not with the key stored at {path:?}. \
                                 Refusing to continue; the stored key was left untouched."
                            );
                            journal.event(json!({ "event": "account_reused", "account": id,
                                "public_key": existing.public_key().to_string() }));
                            println!("  reusing existing {id} (stored key verified on chain)");
                            return probe;
                        }
                        AccountState::Unknown(e) => panic!(
                            "UNCERTAIN: cannot tell whether {id} exists ({e}); keeping the stored key and stopping."
                        ),
                    }
                    journal.event(json!({ "event": "key_reused", "account": id }));
                    existing
                }
                Err(KeyError::Io(e)) => panic!("could not save the key for {id}: {e}"),
            }
        }
    };
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
            let probe = Account::from_secret_key(account_id, sk.clone(), worker);
            let exists_with_our_key = probe.view_account().await.is_ok()
                && probe.view_access_key(&sk.public_key()).await.is_ok();
            journal.event(json!({ "event": "account_create_uncertain", "account": id,
                "error": e.to_string(), "exists_with_our_key": exists_with_our_key }));
            assert!(
                exists_with_our_key,
                "UNCERTAIN: creating {id} failed ({e}) and it is not visible with our key. \
                 Not retrying; the key stays in the credentials directory. Check the journal."
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

/// Refuses anything that must never be deleted by this tooling: the parent,
/// persistent `-demo-` accounts, and anything that is not a sub-account of the parent.
fn assert_deletable(id: &str, parent: &near_workspaces::AccountId) {
    assert_ne!(id, parent.as_str(), "refusing to delete the parent");
    assert!(
        !id.contains("-demo-"),
        "refusing to delete a demo account: {id}"
    );
    assert!(
        id.ends_with(&format!(".{parent}")),
        "{id} is not a sub-account of the parent"
    );
}

/// Deletes `accounts` into `parent` and reports, SEPARATELY:
/// * per account: `deleted` (the delete transaction was observed to succeed, or
///   the account is explicitly `UNKNOWN_ACCOUNT`), `still_present`, or
///   `uncertain` (transport errors, rate limits, timeouts);
/// * the refund: `confirmed`, `shortfall` or `unknown` from the parent's balance.
///
/// A failed query is never read as "the account is gone".
///
/// `inject_rpc_down` (tests): the delete executes for real, but its result is
/// discarded and every later query fails, as if the RPC had gone away.
async fn delete_accounts<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &near_workspaces::AccountId,
    accounts: Vec<Account>,
    journal: &Journal,
    inject_rpc_down: bool,
) -> Value {
    for a in &accounts {
        assert_deletable(a.id().as_str(), parent);
    }
    let ids: Vec<String> = accounts.iter().map(|a| a.id().to_string()).collect();
    journal.event(json!({ "event": "cleanup_start", "accounts": ids }));
    let window = std::time::Duration::from_secs(if inject_rpc_down { 1 } else { 30 });
    let parent_before = settle_account_state(worker, parent, inject_rpc_down, window).await;
    let mut per_account = vec![];
    let mut expected_refund = 0u128;
    let mut refund_known = matches!(parent_before, AccountState::Present(_));
    for a in accounts {
        let id = a.id().clone();
        let before = settle_account_state(worker, &id, false, window).await;
        let held = match &before {
            AccountState::Present(b) => Some(*b),
            _ => None,
        };
        journal.event(json!({ "event": "account_deleting", "account": id,
            "balance_before_delete": held.map(|b| NearToken::from_yoctonear(b).to_string()),
            "state_before": format!("{before:?}") }));
        // Delete transaction: Some(Ok(hash)) succeeded, Some(Err(msg)) executed
        // but failed, None = outcome unknown (error, or injected).
        let mut tx_hash = None;
        let mut tx_succeeded = None;
        let mut tx_error = None;
        if before != AccountState::Absent {
            match a.delete_account(parent).await {
                Ok(r) if !inject_rpc_down => {
                    tx_hash = Some(r.outcome().transaction_hash.to_string());
                    tx_succeeded = Some(r.is_success());
                }
                Ok(r) => {
                    tx_hash = Some(r.outcome().transaction_hash.to_string());
                    tx_error = Some("injected: delete status unavailable".to_string());
                }
                Err(e) => tx_error = Some(e.to_string()),
            }
        }
        let after = settle_account_state(worker, &id, inject_rpc_down, window).await;
        let (status, evidence) = match (tx_succeeded, &after) {
            (Some(true), _) => ("deleted", "delete transaction observed to succeed"),
            (_, AccountState::Absent) if before == AccountState::Absent => {
                ("deleted", "explicit UNKNOWN_ACCOUNT before any delete (already absent)")
            }
            (_, AccountState::Absent) => ("deleted", "explicit UNKNOWN_ACCOUNT after the delete"),
            (Some(false), AccountState::Present(_)) => {
                ("still_present", "delete transaction failed and the account is present")
            }
            (_, AccountState::Present(_)) => (
                "uncertain",
                "account still present but the delete transaction's outcome is unknown (it may still land)",
            ),
            (_, AccountState::Unknown(_)) => (
                "uncertain",
                "delete outcome and account state could not be read (transport error, rate limit or timeout)",
            ),
        };
        if status == "deleted" {
            match held {
                Some(b) => expected_refund += b,
                None => refund_known = false,
            }
        } else {
            refund_known = false;
        }
        journal.event(
            json!({ "event": format!("account_delete_{status}"), "account": id,
            "evidence": evidence, "tx_hash": tx_hash, "tx_error": tx_error,
            "state_after": format!("{after:?}") }),
        );
        println!("  {id}: {status} ({evidence})");
        per_account.push(json!({
            "account": id,
            "status": status,
            "evidence": evidence,
            "delete_tx_hash": tx_hash,
            "delete_tx_error": tx_error,
            "state_after": format!("{after:?}"),
            "balance_before_delete": held.map(|b| NearToken::from_yoctonear(b).to_string()),
        }));
    }
    // Refund confirmation is recorded separately from deletion.
    let parent_after = settle_account_state(worker, parent, inject_rpc_down, window).await;
    let slack = NearToken::from_millinear(100).as_yoctonear();
    let (refund_status, returned) = match (&parent_before, &parent_after) {
        (AccountState::Present(b), AccountState::Present(a)) if refund_known => {
            let returned = a.saturating_sub(*b);
            if returned + slack >= expected_refund {
                ("confirmed", Some(returned))
            } else {
                ("shortfall", Some(returned))
            }
        }
        _ => ("unknown", None),
    };
    let all_deleted = per_account.iter().all(|p| p["status"] == "deleted");
    let overall = if all_deleted && refund_status == "confirmed" {
        "confirmed"
    } else if per_account.iter().any(|p| p["status"] == "still_present") {
        "failed"
    } else {
        "uncertain"
    };
    journal.event(json!({ "event": "cleanup_done", "overall": overall,
        "refund": refund_status }));
    let fmt = |s: &AccountState| match s {
        AccountState::Present(b) => NearToken::from_yoctonear(*b).to_string(),
        other => format!("{other:?}"),
    };
    json!({
        "overall": overall,
        "accounts": per_account,
        "accounts_deleted": per_account.iter().filter(|p| p["status"] == "deleted")
            .map(|p| p["account"].clone()).collect::<Vec<_>>(),
        "refund": {
            "status": refund_status,
            "expected_from_confirmed_deletions": NearToken::from_yoctonear(expected_refund).to_string(),
            "returned_to_beneficiary": returned.map(|r| NearToken::from_yoctonear(r).to_string()),
            "slack_allowed": NearToken::from_yoctonear(slack).to_string(),
        },
        "beneficiary": parent,
        "parent_balance_before_cleanup": fmt(&parent_before),
        "parent_balance_after_cleanup": fmt(&parent_after),
    })
}

/// Deletes exactly the accounts created by this smoke run and returns their
/// NEAR to the parent. Never panics on uncertainty: the returned value says
/// `overall: confirmed | uncertain | failed` so the caller can record it.
async fn cleanup_smoke<T: Network + 'static>(
    worker: &Worker<T>,
    parent: &Account,
    run: SmokeRun,
) -> Value {
    delete_accounts(worker, parent.id(), run.disposable, &run.journal, false).await
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
    load_verified_key(&default_creds_dir(), account_id)
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

/// Collision-resistant run id: 6 base-36 chars of the unix time in seconds plus
/// 8 random hex chars (32 bits, from the OS-seeded hasher and the nanoseconds).
/// 14 chars total, so the longest id (`probe-demo-<tag>.<parent>`) stays under
/// NEAR's 64-character limit for any parent up to 38 characters.
fn unique_tag() -> String {
    use std::hash::{BuildHasher, Hasher};
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(now.as_nanos());
    h.write_u32(std::process::id());
    let rand = (h.finish() & 0xFFFF_FFFF) as u32;
    let mut secs = now.as_secs();
    let mut b36 = String::new();
    for _ in 0..6 {
        let d = (secs % 36) as u8;
        b36.insert(
            0,
            if d < 10 {
                (b'0' + d) as char
            } else {
                (b'a' + d - 10) as char
            },
        );
        secs /= 36;
    }
    format!("{b36}{rand:08x}")
}

/// Reads a run journal strictly: a missing or unreadable file, an empty journal,
/// a malformed line or a record without an `event` is an ERROR, never "nothing to do".
fn read_journal(path: &std::path::Path) -> Result<Vec<Value>, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read journal {}: {e}", path.display()))?;
    let mut events = vec![];
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| format!("{}: line {} is not valid JSON: {e}", path.display(), i + 1))?;
        if !v["event"].is_string() {
            return Err(format!(
                "{}: line {} has no \"event\" field",
                path.display(),
                i + 1
            ));
        }
        events.push(v);
    }
    if events.is_empty() {
        return Err(format!(
            "{} contains no records; refusing to treat an empty journal as reconciled",
            path.display()
        ));
    }
    Ok(events)
}

/// A journal entry that cannot be resolved by polling a hash.
#[derive(Debug, Clone, PartialEq)]
struct ManualItem {
    step: String,
    why: String,
}

/// Everything in a journal that lacks a final outcome.
#[derive(Debug, Default)]
struct Unreconciled {
    /// Submitted transactions (hash known) without a recorded final result.
    by_hash: Vec<Uncertain>,
    /// Submissions with NO hash and no outcome: `step_submit_error`, or a
    /// `step_submitting` never followed by `step_submitted`. They may or may not
    /// have executed and need a human to inspect the account's activity.
    manual: Vec<ManualItem>,
}

/// Finds what is still unresolved. A `step_manual_resolved` record (written by a
/// human after investigating) closes a manual item for that step.
fn find_unreconciled(events: &[Value]) -> Unreconciled {
    let finished: std::collections::HashSet<String> = events
        .iter()
        .filter(|e| e["event"] == "step_done" || e["event"] == "step_resolved")
        .filter_map(|e| e["tx_hash"].as_str().map(String::from))
        .collect();
    let mut out = Unreconciled::default();
    let mut open_submitting: Vec<String> = vec![];
    let mut manual: Vec<ManualItem> = vec![];
    let step_of = |e: &Value| e["step"].as_str().unwrap_or("?").to_string();
    for e in events {
        match e["event"].as_str().unwrap_or("") {
            "step_submitting" => open_submitting.push(step_of(e)),
            "step_submitted" | "step_uncertain" => {
                let s = step_of(e);
                if e["event"] == "step_submitted" {
                    if let Some(i) = open_submitting.iter().position(|x| *x == s) {
                        open_submitting.remove(i);
                    }
                }
                let Some(hash) = e["tx_hash"].as_str() else {
                    continue;
                };
                if finished.contains(hash) || out.by_hash.iter().any(|u| u.tx_hash == hash) {
                    continue;
                }
                out.by_hash.push(Uncertain {
                    step: s,
                    tx_hash: hash.to_string(),
                    signer: e["signer"].as_str().unwrap_or("unknown").to_string(),
                    reason: e["reason"]
                        .as_str()
                        .unwrap_or("no result recorded")
                        .to_string(),
                });
            }
            "step_submit_error" => {
                let s = step_of(e);
                if let Some(i) = open_submitting.iter().position(|x| *x == s) {
                    open_submitting.remove(i);
                }
                manual.push(ManualItem {
                    step: s,
                    why: format!(
                        "the submit call failed ({}); it may or may not have been sent and no hash was recorded",
                        e["error"].as_str().unwrap_or("unknown error")
                    ),
                });
            }
            "step_manual_resolved" => {
                let s = step_of(e);
                manual.retain(|m| m.step != s);
                open_submitting.retain(|x| *x != s);
            }
            _ => {}
        }
    }
    for s in open_submitting {
        manual.push(ManualItem {
            step: s,
            why: "submission started but neither a hash nor an error was recorded".into(),
        });
    }
    out.manual = manual;
    out
}

/// Result of reconciling a journal.
#[derive(Debug)]
struct Reconciliation {
    resolved: usize,
    still_unknown: Vec<Uncertain>,
    manual: Vec<ManualItem>,
}

impl Reconciliation {
    /// Only true when every submission has a final outcome and nothing needs a human.
    fn complete(&self) -> bool {
        self.still_unknown.is_empty() && self.manual.is_empty()
    }
}

/// Reads the journal (strictly), looks every unresolved hash up with `lookup`
/// and appends `step_resolved` for those with a final result.
fn reconcile_journal(
    path: &std::path::Path,
    lookup: impl Fn(&Uncertain) -> TxLookup,
) -> Result<Reconciliation, String> {
    let events = read_journal(path)?;
    let pending = find_unreconciled(&events);
    let journal = Journal::at(path.to_path_buf(), None);
    let (mut resolved, mut still_unknown) = (0, vec![]);
    for u in pending.by_hash {
        let r = lookup(&u);
        println!(
            "  {} ({}) tx {} signer {}: {r:?}",
            u.step, u.reason, u.tx_hash, u.signer
        );
        match r {
            TxLookup::Succeeded | TxLookup::Failed(_) => {
                journal.event(json!({ "event": "step_resolved", "step": u.step,
                    "tx_hash": u.tx_hash, "signer": u.signer, "outcome": format!("{r:?}") }));
                resolved += 1;
            }
            _ => still_unknown.push(u),
        }
    }
    Ok(Reconciliation {
        resolved,
        still_unknown,
        manual: pending.manual,
    })
}

/// What a node says about one transaction hash.
#[derive(Debug, PartialEq)]
enum TxLookup {
    Succeeded,
    Failed(String),
    /// This node has no record of it. NOT proof that it never executed.
    NotFound,
    Unknown(String),
}

/// Interprets a JSON-RPC `tx` response body.
fn classify_tx_response(body: &Value) -> TxLookup {
    if let Some(err) = body.get("error") {
        let name = err["cause"]["name"].as_str().unwrap_or("");
        return if name == "UNKNOWN_TRANSACTION" {
            TxLookup::NotFound
        } else {
            TxLookup::Unknown(err.to_string())
        };
    }
    let Some(result) = body.get("result") else {
        return TxLookup::Unknown(format!("unexpected response: {body}"));
    };
    if result["final_execution_status"].as_str() != Some("FINAL") {
        return TxLookup::Unknown(format!(
            "not final yet ({})",
            result["final_execution_status"]
        ));
    }
    let failed = |v: &Value| v.get("Failure").is_some();
    let receipts_failed = result["receipts_outcome"]
        .as_array()
        .map(|rs| rs.iter().any(|r| failed(&r["outcome"]["status"])))
        .unwrap_or(false);
    if failed(&result["status"]) || receipts_failed {
        TxLookup::Failed(result["status"].to_string())
    } else {
        TxLookup::Succeeded
    }
}

/// JSON-RPC `tx` for one hash (via curl, bounded to 20 s).
fn lookup_tx(rpc_url: &str, tx_hash: &str, signer: &str) -> TxLookup {
    let req = json!({ "jsonrpc": "2.0", "id": "nearodds", "method": "tx",
        "params": { "tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "NONE" } });
    let out = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "20",
            "-H",
            "content-type: application/json",
            "-d",
        ])
        .arg(req.to_string())
        .arg(rpc_url)
        .output();
    match out {
        Ok(o) if o.status.success() => match serde_json::from_slice::<Value>(&o.stdout) {
            Ok(v) => classify_tx_response(&v),
            Err(e) => TxLookup::Unknown(format!("unparseable response: {e}")),
        },
        Ok(o) => TxLookup::Unknown(String::from_utf8_lossy(&o.stderr).into_owned()),
        Err(e) => TxLookup::Unknown(e.to_string()),
    }
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
    assert_eq!(cleanup["overall"], "confirmed", "{cleanup:#}");
    assert_eq!(cleanup["refund"]["status"], "confirmed", "{cleanup:#}");
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
        assert_eq!(
            facts["cleanup"]["overall"], "confirmed",
            "cleanup is not confirmed; see the record and the journal: {:#}",
            facts["cleanup"]
        );
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
    let mut accounts = vec![];
    for id in std::env::var("NEARODDS_DELETE_ACCOUNTS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
    {
        let id = id.trim();
        assert_deletable(id, parent.id());
        let sk = stored_key(id).unwrap_or_else(|| panic!("no verified stored key for {id}"));
        let acct = Account::from_secret_key(id.parse().unwrap(), sk.clone(), &worker);
        // Present accounts must carry our key; an absent account needs no key check.
        match account_state(&worker, acct.id(), false).await {
            AccountState::Present(_) => assert!(
                acct.view_access_key(&sk.public_key()).await.is_ok(),
                "the saved key does not match {id}"
            ),
            AccountState::Absent => println!("{id}: already absent (explicit UNKNOWN_ACCOUNT)"),
            AccountState::Unknown(e) => {
                println!("{id}: state unknown ({e}); will be reported as uncertain")
            }
        }
        accounts.push(acct);
    }
    let result = delete_accounts(&worker, parent.id(), accounts, &journal, false).await;
    println!("{result:#}");
    assert_eq!(
        result["overall"], "confirmed",
        "recovery not confirmed; see the output above"
    );
}

/// Resolves transactions a run left UNCERTAIN, by polling THEIR hashes (never by
/// signing anything). NEARODDS_RESUME_JOURNAL=deployments/runs/<kind>-<tag>.jsonl
/// Appends `step_resolved` to the journal for each transaction whose final
/// result is found. The run itself is NOT continued automatically; once every
/// uncertain step is resolved, continue by hand with the remaining operations
/// (docs/testnet.md).
#[tokio::test]
#[ignore = "testnet only: reads a run journal and polls its uncertain transaction hashes"]
async fn resolve_uncertain_on_testnet() {
    let path = PathBuf::from(
        std::env::var("NEARODDS_RESUME_JOURNAL")
            .expect("set NEARODDS_RESUME_JOURNAL to a journal file"),
    );
    let url = std::env::var("NEARODDS_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    let rec = reconcile_journal(&path, |u| lookup_tx(&url, &u.tx_hash, &u.signer))
        .unwrap_or_else(|e| panic!("CANNOT RECONCILE: {e}"));
    println!("{} transaction(s) resolved in this pass", rec.resolved);
    for u in &rec.still_unknown {
        println!(
            "STILL UNRESOLVED: {} tx {} (signer {})",
            u.step, u.tx_hash, u.signer
        );
    }
    for m in &rec.manual {
        println!("MANUAL INVESTIGATION REQUIRED: '{}': {}", m.step, m.why);
    }
    assert!(
        rec.complete(),
        "NOT reconciled: {} hash(es) still unresolved, {} item(s) need manual investigation (see above). \
         After checking the account's activity, record a decision with a `step_manual_resolved` line.",
        rec.still_unknown.len(),
        rec.manual.len()
    );
    println!("journal fully reconciled");
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

// ---------------------------------------------------------------------------
// Failure-injection and unit tests for the harness itself (all run in CI)
// ---------------------------------------------------------------------------

fn scratch_dir(label: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nearodds-harness-{label}-{}", unique_tag()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The operation SUCCEEDS but every status read fails. The harness must call the
/// outcome uncertain, journal hash/signer/operation, and must NOT sign or submit
/// the operation again. The destination balance proves a single execution.
#[tokio::test]
async fn status_outage_after_success_is_uncertain_and_never_resubmitted() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let dst = root
        .create_subaccount("dst")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let before = worker
        .view_account(dst.id())
        .await
        .unwrap()
        .balance
        .as_yoctonear();
    let amount = NearToken::from_millinear(250);

    let dir = scratch_dir("outage");
    let journal = Journal::at(dir.join("run.jsonl"), None);
    let mut rec = Recorder::with_journal(journal.clone());
    rec.patience = std::time::Duration::from_secs(2);
    rec.inject_status_unavailable = true;

    let (root2, dst_id) = (root.clone(), dst.id().clone());
    let task = tokio::spawn(async move {
        // The real `tx!` path: this is the code a testnet run executes.
        tx!(
            rec,
            "transfer (injected status outage)",
            root2.batch(&dst_id).transfer(amount)
        );
    });
    let err = task
        .await
        .expect_err("an uncertain outcome must stop the run");
    let msg = err
        .into_panic()
        .downcast::<String>()
        .map(|b| *b)
        .unwrap_or_default();
    assert!(
        msg.contains("UNCERTAIN") && msg.contains("NOT resubmitting"),
        "{msg}"
    );

    // The transaction really executed (once) even though the harness could not see it.
    let mut after = before;
    for _ in 0..40 {
        after = worker
            .view_account(dst.id())
            .await
            .unwrap()
            .balance
            .as_yoctonear();
        if after > before {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    tokio::time::sleep(std::time::Duration::from_secs(2)).await; // a duplicate would have landed by now
    after = after.max(
        worker
            .view_account(dst.id())
            .await
            .unwrap()
            .balance
            .as_yoctonear(),
    );
    assert_eq!(
        after - before,
        amount.as_yoctonear(),
        "the operation must have executed exactly once"
    );

    // Journal: one submission, one uncertain verdict with identity, no resubmission.
    let ev = journal.events();
    let count = |name: &str| ev.iter().filter(|e| e["event"] == name).count();
    assert_eq!(count("step_submitting"), 1, "{ev:#?}");
    assert_eq!(count("step_submitted"), 1);
    assert_eq!(count("step_resubmitting"), 0);
    assert_eq!(count("step_done"), 0);
    let u = ev
        .iter()
        .find(|e| e["event"] == "step_uncertain")
        .expect("step_uncertain");
    assert_eq!(u["signer"], root.id().as_str());
    assert_eq!(u["operation"], "transfer (injected status outage)");
    assert!(u["tx_hash"].as_str().unwrap().len() >= 40);
    // And the journal tells a resumer exactly which hash to poll.
    let pending = find_unreconciled(&ev).by_hash;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].tx_hash, u["tx_hash"].as_str().unwrap());
    assert_eq!(pending[0].signer, root.id().as_str());
}

#[test]
fn resolved_and_done_steps_are_not_reported_unresolved() {
    let ev = vec![
        json!({"event":"step_submitted","step":"a","tx_hash":"H1","signer":"x.testnet"}),
        json!({"event":"step_done","step":"a","tx_hash":"H1"}),
        json!({"event":"step_submitted","step":"b","tx_hash":"H2","signer":"y.testnet"}),
        json!({"event":"step_uncertain","step":"b","tx_hash":"H2","signer":"y.testnet","reason":"rpc"}),
        json!({"event":"step_submitted","step":"c","tx_hash":"H3","signer":"z.testnet"}),
        json!({"event":"step_resolved","step":"c","tx_hash":"H3"}),
    ];
    let p = find_unreconciled(&ev).by_hash;
    assert_eq!(p.len(), 1);
    assert_eq!(
        (
            p[0].step.as_str(),
            p[0].tx_hash.as_str(),
            p[0].signer.as_str()
        ),
        ("b", "H2", "y.testnet")
    );
}

#[test]
fn signer_parsing_matches_debug_format() {
    // Pins the `Debug` format of `TransactionStatus` relied on by `signer_of`.
    assert_eq!(
        parse_signer(r#"TransactionStatus { sender_id: AccountId("a.testnet"), hash: Ab }"#),
        "a.testnet"
    );
    assert_eq!(parse_signer("garbage"), "unknown");
}

#[tokio::test]
async fn signer_of_real_status_is_the_signing_account() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let dst = root
        .create_subaccount("d2")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let st = root
        .batch(dst.id())
        .transfer(NearToken::from_millinear(1))
        .transact_async()
        .await
        .unwrap();
    assert_eq!(signer_of(&st), root.id().as_str());
    st.await.unwrap();
}

#[test]
fn tx_responses_are_classified_without_guessing() {
    let ok = json!({"result":{"final_execution_status":"FINAL","status":{"SuccessValue":""},"receipts_outcome":[{"outcome":{"status":{"SuccessValue":""}}}]}});
    assert_eq!(classify_tx_response(&ok), TxLookup::Succeeded);
    let receipt_fail = json!({"result":{"final_execution_status":"FINAL","status":{"SuccessValue":""},"receipts_outcome":[{"outcome":{"status":{"Failure":{}}}}]}});
    assert!(matches!(
        classify_tx_response(&receipt_fail),
        TxLookup::Failed(_)
    ));
    let missing = json!({"error":{"cause":{"name":"UNKNOWN_TRANSACTION"}}});
    assert_eq!(classify_tx_response(&missing), TxLookup::NotFound);
    let rate = json!({"error":{"cause":{"name":"INTERNAL_ERROR"},"message":"429"}});
    assert!(matches!(classify_tx_response(&rate), TxLookup::Unknown(_)));
    let pending = json!({"result":{"final_execution_status":"INCLUDED"}});
    assert!(matches!(
        classify_tx_response(&pending),
        TxLookup::Unknown(_)
    ));
}

/// The delete executes for real, but its status and every later query are
/// unavailable. The harness must NOT claim the account is deleted or the NEAR refunded.
#[tokio::test]
async fn deletion_with_rpc_outage_stays_uncertain() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let journal = Journal::at(scratch_dir("del").join("run.jsonl"), None);
    let acct = user(&worker, &root, "victim", 500, &journal).await;
    let id = acct.id().clone();

    let res = delete_accounts(&worker, root.id(), vec![acct], &journal, true).await;
    assert_eq!(res["overall"], "uncertain", "{res:#}");
    assert_eq!(res["accounts"][0]["status"], "uncertain", "{res:#}");
    assert_eq!(res["refund"]["status"], "unknown", "{res:#}");
    assert!(
        res["accounts_deleted"].as_array().unwrap().is_empty(),
        "{res:#}"
    );
    // Ground truth: the account IS gone. The harness just must not claim it without evidence.
    let truth = account_state(&worker, &id, false).await;
    assert_eq!(truth, AccountState::Absent);
    assert!(journal
        .events()
        .iter()
        .any(|e| e["event"] == "account_delete_uncertain"));
}

#[tokio::test]
async fn healthy_deletion_is_confirmed_with_refund_recorded_separately() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let journal = Journal::at(scratch_dir("del-ok").join("run.jsonl"), None);
    let acct = user(&worker, &root, "victim2", 500, &journal).await;
    let res = delete_accounts(&worker, root.id(), vec![acct], &journal, false).await;
    assert_eq!(res["overall"], "confirmed", "{res:#}");
    assert_eq!(res["accounts"][0]["status"], "deleted");
    assert_eq!(res["refund"]["status"], "confirmed");
}

#[tokio::test]
async fn only_explicit_unknown_account_means_absent() {
    // Real node: a missing account answers UNKNOWN_ACCOUNT.
    let worker = near_workspaces::sandbox().await.unwrap();
    let ghost: near_workspaces::AccountId = "ghost.test.near".parse().unwrap();
    assert_eq!(
        account_state(&worker, &ghost, false).await,
        AccountState::Absent
    );
    let root = worker.root_account().unwrap();
    assert!(
        matches!(account_state(&worker, root.id(), false).await, AccountState::Present(b) if b > 0)
    );
    // Injected outage and an unreachable node are Unknown, never Absent.
    assert!(matches!(
        account_state(&worker, &ghost, true).await,
        AccountState::Unknown(_)
    ));
    assert!(matches!(
        raw_view_account("http://127.0.0.1:1", "ghost.test.near"),
        AccountState::Unknown(_)
    ));
    // Responses that are not an explicit UNKNOWN_ACCOUNT.
    for body in [
        json!({"error":{"name":"INTERNAL_ERROR","cause":{"name":"INTERNAL_ERROR"},"message":"429 Too Many Requests"}}),
        json!({"error":{"name":"HANDLER_ERROR","cause":{"name":"UNAVAILABLE_SHARD"}}}),
        json!({"error":{"name":"TIMEOUT_ERROR","cause":{"name":"TIMEOUT_ERROR"}}}),
        json!({"unexpected": true}),
    ] {
        assert!(
            matches!(classify_account_response(&body), AccountState::Unknown(_)),
            "{body}"
        );
    }
    let unknown =
        json!({"error":{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT","info":{}}}});
    assert_eq!(classify_account_response(&unknown), AccountState::Absent);
}

#[test]
#[should_panic(expected = "refusing to delete the parent")]
fn deletion_refuses_the_parent() {
    assert_deletable("p.testnet", &"p.testnet".parse().unwrap());
}

#[test]
#[should_panic(expected = "refusing to delete a demo account")]
fn deletion_refuses_persistent_demo_accounts() {
    assert_deletable("mkt-demo-1.p.testnet", &"p.testnet".parse().unwrap());
}

#[test]
#[should_panic(expected = "not a sub-account of the parent")]
fn deletion_refuses_unrelated_accounts() {
    assert_deletable("other.testnet", &"p.testnet".parse().unwrap());
}

#[test]
fn key_files_are_created_exclusively_and_never_overwritten() {
    let dir = scratch_dir("keys");
    let a = SecretKey::from_random(KeyType::ED25519);
    let b = SecretKey::from_random(KeyType::ED25519);
    save_key_in(&dir, "alice-x.p.testnet", &a).unwrap();
    // A colliding second attempt is refused...
    assert!(matches!(
        save_key_in(&dir, "alice-x.p.testnet", &b),
        Err(KeyError::AlreadyExists(_))
    ));
    // ...and the original key is intact, mode 600, dir mode 700.
    let kept = load_verified_key(&dir, "alice-x.p.testnet").unwrap();
    assert_eq!(kept.public_key(), a.public_key());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&key_path(&dir, "alice-x.p.testnet")), 0o600);
        assert_eq!(mode(&dir), 0o700);
    }
    // An inconsistent file (public key does not match) is not trusted.
    std::fs::write(key_path(&dir, "bad.p.testnet"),
        json!({"account_id":"bad.p.testnet","public_key":b.public_key().to_string(),"private_key":a.to_string()}).to_string()).unwrap();
    assert!(load_verified_key(&dir, "bad.p.testnet").is_none());
}

/// A run-name collision: the account already exists and a key file for it
/// already exists. The original key must survive and the run must refuse.
#[tokio::test]
async fn name_collision_with_a_foreign_key_refuses_and_keeps_the_original() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let dir = scratch_dir("collide");
    let journal = Journal::at(dir.join("run.jsonl"), Some(dir.join("creds")));

    // Someone else already created collide.<root> with an unrelated key,
    // and an earlier run left a different key file for that id.
    let foreign = SecretKey::from_random(KeyType::ED25519);
    root.create_subaccount("collide")
        .keys(foreign)
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let id = format!("collide.{}", root.id());
    let original = SecretKey::from_random(KeyType::ED25519);
    save_key_in(&dir.join("creds"), &id, &original).unwrap();

    let (w, r, j) = (worker.clone(), root.clone(), journal.clone());
    let res = tokio::spawn(async move { user(&w, &r, "collide", 500, &j).await }).await;
    let msg = res
        .expect_err("must refuse")
        .into_panic()
        .downcast::<String>()
        .map(|b| *b)
        .unwrap_or_default();
    assert!(msg.contains("COLLISION"), "{msg}");
    assert_eq!(
        load_verified_key(&dir.join("creds"), &id)
            .unwrap()
            .public_key(),
        original.public_key()
    );
}

/// An interrupted earlier attempt: the key file exists, the account does not
/// (or exists with exactly that key). The verified key is reused, not replaced.
#[tokio::test]
async fn resume_reuses_the_verified_stored_key() {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let dir = scratch_dir("resume");
    let creds = dir.join("creds");
    let journal = Journal::at(dir.join("run.jsonl"), Some(creds.clone()));
    let id = format!("resumed.{}", root.id());
    let stored = SecretKey::from_random(KeyType::ED25519);
    save_key_in(&creds, &id, &stored).unwrap();

    // Account not created yet: created with the stored key.
    let a1 = user(&worker, &root, "resumed", 500, &journal).await;
    assert!(a1.view_access_key(&stored.public_key()).await.is_ok());
    // Account now exists with that key: reused, nothing recreated or rotated.
    let a2 = user(&worker, &root, "resumed", 500, &journal).await;
    assert_eq!(a2.id(), a1.id());
    assert_eq!(
        load_verified_key(&creds, &id).unwrap().public_key(),
        stored.public_key()
    );
    assert!(journal
        .events()
        .iter()
        .any(|e| e["event"] == "account_reused"));
}

#[test]
fn run_ids_are_unique_and_fit_account_name_limits() {
    let tags: std::collections::HashSet<String> = (0..500).map(|_| unique_tag()).collect();
    assert_eq!(tags.len(), 500, "collision among 500 run ids");
    let t = unique_tag();
    assert_eq!(t.len(), 14);
    assert!(t
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    let longest = format!("probe-demo-{t}.nearodds-deploy.testnet");
    assert!(longest.len() <= 64, "{longest}");
    assert!(longest.parse::<near_workspaces::AccountId>().is_ok());
}

// ---- journal reconciliation ------------------------------------------------

fn write_journal(label: &str, lines: &[Value]) -> PathBuf {
    let p = scratch_dir(label).join("run.jsonl");
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(&p, body).unwrap();
    p
}

#[test]
fn reconcile_fails_clearly_when_the_journal_is_missing() {
    let p = scratch_dir("missing").join("nope.jsonl");
    let e = reconcile_journal(&p, |_| panic!("no lookups expected")).unwrap_err();
    assert!(e.contains("cannot read journal"), "{e}");
}

#[test]
fn reconcile_fails_clearly_on_malformed_or_empty_journals() {
    // malformed JSON on line 2
    let p = scratch_dir("bad").join("run.jsonl");
    std::fs::write(&p, "{\"event\":\"run_start\"}\n{not json\n").unwrap();
    let e = reconcile_journal(&p, |_| panic!("no lookups")).unwrap_err();
    assert!(e.contains("line 2") && e.contains("not valid JSON"), "{e}");
    // valid JSON that is not a journal record
    let p = scratch_dir("bad2").join("run.jsonl");
    std::fs::write(&p, "{\"step\":\"a\"}\n").unwrap();
    assert!(reconcile_journal(&p, |_| panic!())
        .unwrap_err()
        .contains("no \"event\""));
    // a truncated final line
    let p = scratch_dir("bad3").join("run.jsonl");
    std::fs::write(&p, "{\"event\":\"run_start\"}\n{\"event\":\"step_subm").unwrap();
    assert!(reconcile_journal(&p, |_| panic!()).is_err());
    // an empty journal is not "0 unresolved"
    let p = scratch_dir("empty").join("run.jsonl");
    std::fs::write(&p, "\n\n").unwrap();
    assert!(reconcile_journal(&p, |_| panic!())
        .unwrap_err()
        .contains("no records"));
    // a directory is unreadable
    assert!(reconcile_journal(&scratch_dir("dir"), |_| panic!()).is_err());
}

#[test]
fn submit_errors_and_unmatched_submissions_need_manual_investigation() {
    let p = write_journal(
        "manual",
        &[
            json!({"event":"run_start"}),
            json!({"event":"step_submitting","step":"alice: fill 8"}),
            json!({"event":"step_submit_error","step":"alice: fill 8","error":"error sending request"}),
            json!({"event":"step_submitting","step":"bob: withdraw"}), // process died before any outcome
        ],
    );
    let r = reconcile_journal(&p, |_| panic!("no hash to look up")).unwrap();
    assert!(!r.complete());
    assert!(r.still_unknown.is_empty());
    let steps: Vec<_> = r.manual.iter().map(|m| m.step.as_str()).collect();
    assert_eq!(steps, ["alice: fill 8", "bob: withdraw"]);
    assert!(r.manual[0].why.contains("no hash was recorded"));
    assert!(r.manual[1].why.contains("neither a hash nor an error"));
    // A human's recorded decision closes the item; nothing else does.
    let j = Journal::at(p.clone(), None);
    j.event(json!({"event":"step_manual_resolved","step":"alice: fill 8","note":"checked explorer: not executed"}));
    let r = reconcile_journal(&p, |_| panic!()).unwrap();
    assert_eq!(r.manual.len(), 1);
    assert_eq!(r.manual[0].step, "bob: withdraw");
}

#[test]
fn hash_unresolved_steps_stay_unresolved_until_a_final_result_is_found() {
    let p = write_journal(
        "hash",
        &[
            json!({"event":"step_submitting","step":"mint"}),
            json!({"event":"step_submitted","step":"mint","tx_hash":"H1","signer":"o.testnet"}),
            json!({"event":"step_uncertain","step":"mint","tx_hash":"H1","signer":"o.testnet","reason":"rpc"}),
        ],
    );
    let r = reconcile_journal(&p, |_| TxLookup::NotFound).unwrap();
    assert!(!r.complete());
    assert_eq!(r.still_unknown.len(), 1);
    assert_eq!(r.resolved, 0);
    // Not found must not have been journaled as resolved.
    assert!(!read_journal(&p)
        .unwrap()
        .iter()
        .any(|e| e["event"] == "step_resolved"));
    let r = reconcile_journal(&p, |_| TxLookup::Succeeded).unwrap();
    assert!(r.complete() && r.resolved == 1);
    // Idempotent: a second pass finds nothing left.
    let r = reconcile_journal(&p, |_| panic!("already resolved")).unwrap();
    assert!(r.complete() && r.resolved == 0);
}

#[test]
fn fully_reconciled_valid_journal_is_complete() {
    let p = write_journal(
        "ok",
        &[
            json!({"event":"run_start"}),
            json!({"event":"step_submitting","step":"a"}),
            json!({"event":"step_submitted","step":"a","tx_hash":"H1","signer":"x.testnet"}),
            json!({"event":"step_done","step":"a","tx_hash":"H1","ok":true}),
            json!({"event":"step_submitting","step":"a"}), // same step name, run twice
            json!({"event":"step_submitted","step":"a","tx_hash":"H2","signer":"x.testnet"}),
            json!({"event":"step_resolved","step":"a","tx_hash":"H2"}),
        ],
    );
    let r = reconcile_journal(&p, |_| panic!("nothing to look up")).unwrap();
    assert!(r.complete());
    assert_eq!(
        (r.resolved, r.still_unknown.len(), r.manual.len()),
        (0, 0, 0)
    );
}
