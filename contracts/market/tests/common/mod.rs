//! Shared Sandbox harness. Every test starts its own local NEAR Sandbox, deploys
//! the REAL market and test-collateral Wasm, and moves REAL tokens.
#![allow(dead_code, unused_must_use)]

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Once;

pub const ONE: u128 = 1_000_000;
pub const MID: &str = "mkt-1";
pub const YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const MAX_GAS: Gas = Gas::from_tgas(300);
pub const STORAGE_BOUND_BYTES: u64 = 512;

/// Decimal-string base units for `n` whole tokens/shares.
pub fn tok(n: u128) -> String {
    (n * ONE).to_string()
}

fn root_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

static BUILD: Once = Once::new();

/// Builds (once per test process) the three Wasm artifacts via
/// `scripts/build-wasm.sh` and returns the bytes of `name`.
pub fn wasm(name: &str) -> Vec<u8> {
    BUILD.call_once(|| {
        let root = root_dir();
        if std::env::var("NEARODDS_SKIP_WASM_BUILD").is_ok() {
            return;
        }
        let status = Command::new("bash")
            .arg(root.join("scripts/build-wasm.sh"))
            .current_dir(&root)
            .status()
            .expect("failed to run scripts/build-wasm.sh");
        assert!(status.success(), "scripts/build-wasm.sh failed");
    });
    let p = root_dir().join("target/wasm").join(format!("{name}.wasm"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("missing {}: {e}", p.display()))
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub token: Contract,
    pub market: Contract,
    pub alice: Account,
    pub bob: Account,
    pub cutoff_ns: u64,
}

pub struct Opts {
    /// Use the TEST-ONLY market build whose callback gas is too small.
    pub failure_injection: bool,
    /// Split cutoff, seconds after the market is initialized.
    pub cutoff_secs: u64,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            failure_injection: false,
            cutoff_secs: 86_400,
        }
    }
}

pub fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

/// Panics with the failure details unless the whole transaction, including
/// every receipt, succeeded.
pub fn ok(r: ExecutionFinalResult) -> ExecutionFinalResult {
    assert!(
        r.is_success() && r.receipt_failures().is_empty(),
        "expected full success, failures: {:#?}",
        r.failures()
    );
    r
}

/// True if the top-level result or any receipt failed with a message
/// containing `needle`.
pub fn failed_with(r: &ExecutionFinalResult, needle: &str) -> bool {
    format!("{:?}", r.failures()).contains(needle) || format!("{:?}", r).contains(needle)
}

pub async fn now_ns(worker: &Worker<Sandbox>) -> u64 {
    worker.view_block().await.unwrap().timestamp()
}

pub async fn setup(opts: Opts) -> Env {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();

    // Test collateral token (fixture; owner = root can mint).
    let token_acct = root
        .create_subaccount("token")
        .initial_balance(near(30))
        .transact()
        .await
        .unwrap()
        .unwrap();
    let token = token_acct
        .deploy(&wasm("test_collateral"))
        .await
        .unwrap()
        .unwrap();
    ok(token
        .call("new")
        .args_json(json!({ "owner_id": root.id() }))
        .transact()
        .await
        .unwrap());

    // Market: deploy + init in ONE batch transaction (no front-running window).
    let market_acct = root
        .create_subaccount("market")
        .initial_balance(near(30))
        .transact()
        .await
        .unwrap()
        .unwrap();
    let cutoff_ns = now_ns(&worker).await + opts.cutoff_secs * 1_000_000_000;
    let name = if opts.failure_injection {
        "market_failure_injection"
    } else {
        "market"
    };
    let code = wasm(name);
    ok(market_acct
        .batch(market_acct.id())
        .deploy(&code)
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(json!({
                    "collateral_token": token.id(),
                    "market_id": MID,
                    "question": "Will it rain in Lagos on 2026-12-01?",
                    "rules": "Resolves YES if the NiMet daily report records measurable rain.",
                    "split_cutoff_ns": cutoff_ns.to_string(),
                }))
                .gas(Gas::from_tgas(100)),
        )
        .transact()
        .await
        .unwrap());
    let market = Contract::from_secret_key(
        market_acct.id().clone(),
        market_acct.secret_key().clone(),
        &worker,
    );

    let alice = new_user(&root, "alice").await;
    let bob = new_user(&root, "bob").await;

    let env = Env {
        worker,
        root,
        token,
        market,
        alice,
        bob,
        cutoff_ns,
    };
    // The market must be registered with the token to hold balances.
    env.register_with_token(env.market.id()).await;
    env.register_with_token(env.alice.id()).await;
    env.register_with_token(env.bob.id()).await;
    env.register_with_market(&env.alice).await;
    env.register_with_market(&env.bob).await;
    env
}

pub async fn new_user(root: &Account, name: &str) -> Account {
    root.create_subaccount(name)
        .initial_balance(near(20))
        .transact()
        .await
        .unwrap()
        .unwrap()
}

impl Env {
    pub async fn register_with_token(&self, id: &near_workspaces::AccountId) {
        ok(self
            .root
            .call(self.token.id(), "storage_deposit")
            .args_json(json!({ "account_id": id, "registration_only": true }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await
            .unwrap());
    }

    pub async fn storage_cost(&self) -> NearToken {
        let c: Value = self
            .market
            .view("get_config")
            .await
            .unwrap()
            .json()
            .unwrap();
        NearToken::from_yoctonear(
            c["storage_cost_per_account"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        )
    }

    pub async fn register_with_market(&self, who: &Account) {
        let cost = self.storage_cost().await;
        ok(who
            .call(self.market.id(), "storage_deposit")
            .args_json(json!({ "account_id": null, "registration_only": true }))
            .deposit(cost)
            .transact()
            .await
            .unwrap());
    }

    /// Owner-mints test tokens to a token-registered account.
    pub async fn mint(&self, to: &near_workspaces::AccountId, base_units: u128) {
        ok(self
            .root
            .call(self.token.id(), "mint")
            .args_json(json!({ "account_id": to, "amount": base_units.to_string() }))
            .transact()
            .await
            .unwrap());
    }

    pub async fn token_balance(&self, id: &near_workspaces::AccountId) -> u128 {
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

    /// Real `ft_transfer_call` of `base_units` from `who` to the market.
    pub async fn deposit_raw(
        &self,
        who: &Account,
        base_units: u128,
        msg: &str,
    ) -> ExecutionFinalResult {
        who.call(self.token.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.market.id(),
                "amount": base_units.to_string(),
                "msg": msg,
            }))
            .deposit(YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await
            .unwrap()
    }

    pub async fn deposit(&self, who: &Account, base_units: u128) {
        ok(self.deposit_raw(who, base_units, "deposit").await);
    }

    pub async fn call_market(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> ExecutionFinalResult {
        who.call(self.market.id(), method)
            .args_json(args)
            .deposit(YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await
            .unwrap()
    }

    pub async fn split(&self, who: &Account, base_units: u128) -> ExecutionFinalResult {
        self.call_market(
            who,
            "split_position",
            json!({ "market_id": MID, "amount": base_units.to_string() }),
        )
        .await
    }

    pub async fn merge(&self, who: &Account, base_units: u128) -> ExecutionFinalResult {
        self.call_market(
            who,
            "merge_positions",
            json!({ "market_id": MID, "amount": base_units.to_string() }),
        )
        .await
    }

    pub async fn withdraw(&self, who: &Account, base_units: u128) -> ExecutionFinalResult {
        self.call_market(who, "withdraw", json!({ "amount": base_units.to_string() }))
            .await
    }

    pub async fn account(&self, id: &near_workspaces::AccountId) -> Value {
        self.market
            .view("get_account")
            .args_json(json!({ "account_id": id }))
            .await
            .unwrap()
            .json()
            .unwrap()
    }

    /// `(available, yes, no)` in base units.
    pub async fn snapshot(&self, id: &near_workspaces::AccountId) -> (u128, u128, u128) {
        let a = self.account(id).await;
        let n = |k: &str| a[k].as_str().unwrap().parse::<u128>().unwrap();
        (n("available_collateral"), n("yes"), n("no"))
    }

    pub async fn totals(&self) -> Value {
        self.market
            .view("get_totals")
            .await
            .unwrap()
            .json()
            .unwrap()
    }

    pub async fn total(&self, key: &str) -> u128 {
        self.totals().await[key].as_str().unwrap().parse().unwrap()
    }

    pub async fn withdrawal(&self, id: &near_workspaces::AccountId) -> Value {
        self.market
            .view("get_withdrawal")
            .args_json(json!({ "account_id": id }))
            .await
            .unwrap()
            .json()
            .unwrap()
    }

    /// Off-chain check: after all async work settled, the token balance of the
    /// market must cover internal obligations (available + backing).
    pub async fn assert_escrow_covers_obligations(&self) -> u128 {
        let bal = self.token_balance(self.market.id()).await;
        let need = self.total("settled_escrow_requirement").await;
        assert!(bal >= need, "token balance {bal} < obligations {need}");
        bal - need // unallocated surplus
    }

    /// Fast-forwards until the chain clock passes `ts_ns`.
    pub async fn wait_past(&self, ts_ns: u64) {
        for _ in 0..240 {
            if now_ns(&self.worker).await > ts_ns {
                return;
            }
            self.worker.fast_forward(20).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        panic!("chain clock never passed {ts_ns}");
    }
}
