# NearOdds

A binary prediction market on NEAR using Polymarket-style complete-set
economics: **one collateral token backs one YES share plus one NO share**.

**Status: Milestones 1 to 3** — collateral deposits, YES/NO complete sets,
merging, withdrawals, fully funded onchain offers (create / partial fill /
cancel / resale), and trusted-resolver YES/NO resolution with redemption into
the internal balance, on one fixed market with a test collateral token and zero
fees. **Trust model: manually resolved MVP** (one configured resolver; no VOID, no
disputes, no 50/50 payout). Market creation and the backend are **not implemented**
and not stubbed. The web app is being built separately in `apps/web`. See
`NEAR Prediction Market Project Structure.md` for the full plan.

## Layout

```
contracts/market/           market contract (Rust, near-sdk 5.30)
contracts/test-collateral/  TEST-ONLY six-decimal NEP-141 token fixture
scripts/build-wasm.sh       builds the Wasm artifacts into target/wasm/
docs/accounting.md          accounting model, pending withdrawals, surplus, callback failure
docs/contract-interface.md  methods, units, attached deposits, events, trading interface
docs/testnet.md             testnet smoke test + persistent demo market (prerequisites, status)
packages/types/             TypeScript shapes of the contract JSON
docs/demo.md                reproducible demo and test index
```

## Build and test

```bash
bash scripts/check-prereqs.sh              # tools, OpenSSL headers, cargo-near
bash scripts/build-wasm.sh                 # market.wasm, market_failure_injection.wasm, test_collateral.wasm
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown -p nearodds-market -p test-collateral -- -D warnings
cargo test --workspace                     # unit + Sandbox tests (counts in docs/demo.md)
```

`market_failure_injection.wasm` is a **test-only** build (feature
`test-failure-injection`) whose withdrawal callback gets too little gas so the
callback fails. **Never deploy it.** Prerequisites and OpenSSL notes: `docs/demo.md`.

## How it works (short)

1. `storage_deposit` registers an account (prepays a fixed storage bound in NEAR).
2. `token.ft_transfer_call(market, amount, "deposit")` credits the *sender*.
3. `split_position` / `merge_positions` (1 yocto) move collateral ⇄ backing + shares.
3b. `create_offer` / `fill_offer` / `cancel_offer` (1 yocto) trade existing shares for
   internal collateral, fully funded, fixed price, exact integer pricing.
3c. After the cutoff the resolver calls `resolve_market` once; holders call `redeem`
   (cancels their offers, burns shares, credits winners 1:1 to their internal balance).
4. `withdraw` (1 yocto) debits, calls `ft_transfer`, and settles in a private
   callback from the real promise result (success finalizes; verified failure
   restores the current balance once).

Trust model: no admin can set balances, mint shares or move the reserve. The
deployed account's full-access key could still redeploy code — see
`docs/accounting.md`. **Known gap:** if the withdrawal callback itself fails, the
withdrawal stays `Pending`; automatic recovery needs a separately verified
design and is not part of this milestone.

## Testnet deployment

Deployed and verified on NEAR testnet (2026-11-05): a full-lifecycle smoke test (record: `deployments/testnet.json`,
its accounts deleted afterwards) and a persistent open demo market for the frontend (`deployments/testnet-demo.json`,
cutoff 2026-11-11T23:00:00Z). Frontend: read IDs from `deployments/testnet-demo.json` and see
`docs/frontend-handoff.md`. Evidence, transaction hashes and the harness's safety rules: `docs/testnet.md`.

## Dependency versions (Cargo.lock)

near-sdk 5.30.0 · near-contract-standards 5.30.0 · near-workspaces 0.24.0 ·
near-sandbox 0.4.0 · near-parameters 0.38.0 · tokio 1.54.1 · rustc 1.97.1 ·
cargo-near 0.22.0.
