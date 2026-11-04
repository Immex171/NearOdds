# Testnet deployment and smoke test

## Status

**Not executed for Milestone 2.** The tooling exists and is exercised on the local Sandbox, but this
repository has no configured testnet accounts: there is no funded parent account and no key on the build
machine (`~/.near-credentials` absent). No testnet account ID, Wasm hash or transaction hash has been
recorded, and `deployments/testnet.json` does not exist yet. Nothing here has been deployed.

**Missing prerequisite:** a funded testnet account (about 20 NEAR) and its full-access secret key.
Create one with your wallet or a testnet faucet; do not use a mainnet key.

## What the smoke test does

`contracts/market/tests/testnet_smoke.rs` runs one scenario against any network:

1. creates fresh sub-accounts of the parent (`tok-*`, `mkt-*`, `alice-*`, `bob-*`, `carol-*`);
2. deploys `test_collateral.wasm` (fixture) and `market.wasm` (**production build**; the
   `market_failure_injection.wasm` build is never deployed) and initializes the market in the same
   transaction as the deploy;
3. registers accounts with the token and the market, mints test tokens (fixture owner = parent);
4. deposits (real `ft_transfer_call`), splits, creates a sell offer, two partial fills, cancels the remainder,
   resells, checks the documented balances, merges and withdraws everyone;
5. records accounts, token metadata, git commit, on-chain contract state (code hash) and every transaction hash.

`smoke_on_sandbox` runs the same code locally on every `cargo test`. `smoke_on_testnet` is `#[ignore]`d.

## Run it

```bash
export NEARODDS_TESTNET_PARENT=<your funded testnet account id>
export NEARODDS_TESTNET_PARENT_KEY=ed25519:<its full-access secret key>   # env only, never written to disk
bash scripts/testnet-smoke.sh
```

The script builds the Wasm (`scripts/build-wasm.sh`), runs the ignored test with `--nocapture` (prints each step
with its transaction hash), and writes `deployments/testnet.json`. Verify afterwards with a testnet explorer
and the contracts' `get_config` / `ft_metadata` views.

## Notes

* The market account keeps a full-access key (the generated one). Decide whether to delete it or hand it to a
  governed account before presenting the deployment as trust-minimised (see `docs/accounting.md`).
* The split/trading cutoff in the smoke test is 24 hours after deployment.
* Costs: each account is created with its own NEAR balance from the parent (4 + 5 + 3×2 NEAR) and all tokens are
  worthless test tokens.
