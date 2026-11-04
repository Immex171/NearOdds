# NearOdds

A binary prediction market on NEAR using Polymarket-style complete-set
economics: **one collateral token backs one YES share plus one NO share**.

**Status: Milestone 1 only** — collateral deposits, YES/NO complete sets,
merging and withdrawals, on one fixed market with a test collateral token.
Trading (offers), market creation, resolution, redemption, backend and
frontend are **not implemented** and not stubbed. See
`NEAR Prediction Market Project Structure.md` for the full plan.

## Layout

```
contracts/market/           market contract (Rust, near-sdk 5.30)
contracts/test-collateral/  TEST-ONLY six-decimal NEP-141 token fixture
scripts/build-wasm.sh       builds the Wasm artifacts into target/wasm/
docs/accounting.md          accounting model, pending withdrawals, surplus, callback failure
docs/contract-interface.md  methods, units, attached deposits, events
docs/demo.md                reproducible demo and test index
```

## Build and test

```bash
bash scripts/build-wasm.sh                 # market.wasm, market_failure_injection.wasm, test_collateral.wasm
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown -p nearodds-market -p test-collateral -- -D warnings
cargo test --workspace                     # 47 unit + 23 Sandbox tests
```

`market_failure_injection.wasm` is a **test-only** build (feature
`test-failure-injection`) whose withdrawal callback gets too little gas so the
callback fails. **Never deploy it.** Prerequisites and OpenSSL notes: `docs/demo.md`.

## How it works (short)

1. `storage_deposit` registers an account (prepays a fixed storage bound in NEAR).
2. `token.ft_transfer_call(market, amount, "deposit")` credits the *sender*.
3. `split_position` / `merge_positions` (1 yocto) move collateral ⇄ backing + shares.
4. `withdraw` (1 yocto) debits, calls `ft_transfer`, and settles in a private
   callback from the real promise result (success finalizes; verified failure
   restores the current balance once).

Trust model: no admin can set balances, mint shares or move the reserve. The
deployed account's full-access key could still redeploy code — see
`docs/accounting.md`. **Known gap:** if the withdrawal callback itself fails, the
withdrawal stays `Pending`; automatic recovery needs a separately verified
design and is not part of this milestone.

## Testnet deployment (not performed here)

No account IDs or deployment hashes exist yet; the commands below use
placeholders and were not executed. Use fresh accounts and the production
`market.wasm` — never `market_failure_injection.wasm`.

```bash
bash scripts/build-wasm.sh
sha256sum target/wasm/market.wasm target/wasm/test_collateral.wasm   # record in deployments/testnet.json

# 1. token fixture (testnet only)
near deploy $TOKEN target/wasm/test_collateral.wasm \
  with-init-call new json-args '{"owner_id":"'$OWNER'"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR'
# 2. market: deploy AND initialize in the same transaction
near deploy $MARKET target/wasm/market.wasm \
  with-init-call new json-args '{"collateral_token":"'$TOKEN'","market_id":"mkt-1","question":"...","rules":"...","split_cutoff_ns":"<future ns timestamp>"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR'
# 3. register the market and each user with the token, then with the market
near contract call-function as-transaction $TOKEN storage_deposit json-args '{"account_id":"'$MARKET'"}' ...
near contract call-function as-transaction $MARKET storage_deposit json-args '{}' ... attached-deposit '<storage_cost_per_account>'
# 4. mint test tokens (owner only): token.mint {"account_id","amount"}
```

`near-cli-rs` syntax varies by version; verify with `near --help`. Fund the
market account with enough NEAR for its code and state storage. Decide what to
do with the deployer's full-access key before announcing the deployment.

## Dependency versions (Cargo.lock)

near-sdk 5.30.0 · near-contract-standards 5.30.0 · near-workspaces 0.24.0 ·
near-sandbox 0.4.0 · near-parameters 0.38.0 · tokio 1.54.1 · rustc 1.97.1 ·
cargo-near 0.22.0.
