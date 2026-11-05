# Testnet deployment, smoke test and demo market

## Status (2026-11-05): deployed and verified

| | Result |
| - | - |
| Deployment parent / resolver / token owner | `nearodds-deploy.testnet` (key only in `~/.near-credentials/testnet/`, never committed) |
| Corrected smoke test (tag `3879067`) | **Passed on testnet**, verified record in `deployments/testnet.json`, its accounts then deleted |
| Persistent frontend demo market (tag `3879869`) | **Deployed, Open, verified**, manifest in `deployments/testnet-demo.json` |
| Network | NEAR testnet via `https://test.rpc.fastnear.com` (`rpc.testnet.near.org` is deprecated) |

**The frontend must use `deployments/testnet-demo.json`. Never use the smoke-test accounts: they are deleted.**

### Persistent demo market (use this one)

| Item | Value |
| - | - |
| Market contract | `mkt-demo-3879869.nearodds-deploy.testnet` |
| Collateral token contract | `tok-demo-3879869.nearodds-deploy.testnet` |
| Resolver and token owner | `nearodds-deploy.testnet` |
| Liquidity provider (seeded offers) | `lp-demo-3879869.nearodds-deploy.testnet` |
| Probe trader (proved the book is usable) | `probe-demo-3879869.nearodds-deploy.testnet` |
| Market id | `mkt-1` |
| Question | Will it rain in Lagos on 2026-11-12? |
| Observation period | 2026-11-12 00:00 WAT to 2026-11-13 00:00 WAT (UTC+1), i.e. 2026-11-11T23:00Z to 2026-11-12T23:00Z |
| Resolution source | NiMet daily weather report, Lagos, 2026-11-12 |
| Trading cutoff | **2026-11-11T23:00:00Z** = 2026-11-12 00:00 WAT (`1794438000000000000` ns). Immutable. |
| Resolve | by the resolver after the cutoff, **once the NiMet report for the observation date is published** (see "Timing" below) |
| Token | `NearOdds TEST Collateral (no value)`, symbol **`tNOC`**, **6 decimals** |
| Market code hash (base58) | `D87VzcAmR32hXwqUcwZfRvrC7HLHXREoSTjmsHwsezon` (sha256 `b41ea88129be572c3f3c48e4fcaec31afa12aca4d49c97cf237bea88f4f22d45`, 236408 bytes) |
| Token code hash (base58) | `3csjd1rDuCq3vtAcffZbsawyKRQuT8y2GMDmPhbdQV98` (sha256 `26e81178403522a377ff4039c75923e95bbc0341aa1ae767699910532da25ddf`, 151472 bytes) |
| Deployed from | commit `462871b` (clean tree; contract sources unchanged since `7d50c6c`). Later commits changed only deployment tooling, tests, docs and the frontend; the deployed Wasm was **not** rebuilt or redeployed. |

The question, rules, observation window, source and cutoff were checked to agree (the rules text quotes the date and the
exact cutoff). Trading closes at the moment the observed day starts.

Seeded liquidity (all from `lp-demo-3879869.nearodds-deploy.testnet`, read back from the chain as `fillable`): sell YES 10 each @0.65 / 0.70 / 0.75
(the first has 0.0001 fewer after the probe's fill), sell NO 10 each @0.35 / 0.40, bid YES 10 each @0.55 / 0.50.
Chain totals at deployment: backing 100, reserved collateral 10.5, available 90.5, 7 open offers, 201 tNOC escrowed
(200 liquidity provider + 1 probe). **If the demo needs to run past 2026-11-12, the cutoff cannot be changed: deploy a new
market with `NEARODDS_DEMO_OBSERVATION_DATE=<YYYY-MM-DD> bash scripts/testnet-demo.sh`.**

### Smoke test (disposable market, tag `3879067`, now deleted)

Run on testnet with the production Wasm, from a clean tree, with the same artifacts (code hashes identical to the demo's).

| Result | Value |
| - | - |
| Steps | 36 transactions, all as expected (7 deliberate refusals) |
| Final balances before cleanup | Alice 94.80, Bob 12.30, Carol 12.90 tNOC in their token wallets; all internal balances 0 |
| Market at the end | `Resolved` (YES), backing 0, market token balance 0 |
| Withdrawals | all three `Completed` |
| Cleanup | accounts deleted after the record was saved; 6.50 NEAR returned of 6.50 NEAR held; parent 6.63 NEAR to 13.12 NEAR |
| Account status | deleted, kept only as historical test evidence (explorer history remains): `mkt-3879067.nearodds-deploy.testnet`, `tok-3879067.nearodds-deploy.testnet`, `alice-3879067.nearodds-deploy.testnet`, `bob-3879067.nearodds-deploy.testnet`, `carol-3879067.nearodds-deploy.testnet` |

Transactions (sender is the account named in the step; look them up on a testnet explorer):

| Outcome | Step | Tx hash |
| - | - | - |
| ok | token: deploy + init (one tx) | `BFwYtnKZ9jEkXnH9Q1zLooAvC2VsLVAFrzz6ciD18LLF` |
| ok | market: deploy + init (one tx) | `5317hx5mPPjUC4b88vc5ppuQjdHbJKmtmb5rHkuhsKz1` |
| ok | token: storage_deposit | `6B3G7w8hr4M3DT7aqcdB6Zb4LpydpP6tTF36hpEdMZGc` |
| ok | token: storage_deposit | `8gJ162SxbEfDeDgKTtuHoMh1sU4sAW36KCRveKB9yD2L` |
| ok | market: storage_deposit | `HehP5hG25Zan22cyAHmPnNr4m2S8P7WDizH5CdSyh146` |
| ok | token: mint (fixture owner) | `Fg6m3uF95zynowT8jZ3GSXTnAMTNzniFKqu3JBcjxxzC` |
| ok | token: storage_deposit | `AXKf9gadTvBbVKf3xkBcsyvZYACaSFbJPgPZjzFTk8zU` |
| ok | market: storage_deposit | `gKiJZbsakPf7sPFwfxp4EYcaMC2cFjC6ncA3PeMaZjd` |
| ok | token: mint (fixture owner) | `2iY21HsHaavLqd2Tzm2qsrg6XuY3VTeY4iYvmVh4MPmo` |
| ok | token: storage_deposit | `3ve5Ktak2vdc71DFGC9dmYyR5xZ9M39Ctj5RJVChyHjd` |
| ok | market: storage_deposit | `7EAzGsAjWNWvXJrcTY3isthzYiAGEXmo3dWe8x5VnT4m` |
| ok | token: mint (fixture owner) | `NoGPaYfRcPGniNKFtWEFrbqvPyGacSLMX6rDKG9YPWh` |
| ok | deposit (ft_transfer_call) | `6ertCAbeiLx5u8vZLwEZTHsxaFCrHUWWPRNfWszPRpkx` |
| ok | deposit (ft_transfer_call) | `DXh253v7VoCetQYaEs3hdNMV3yGUCKCRikm6e5W5Z5ue` |
| ok | deposit (ft_transfer_call) | `CkhFEM3PQYPdEWuNKXCUxD7MTwK2pPq1XvXnnqMCqchB` |
| ok | alice: split 100 | `8ft2pRn8ML4Pg8fpJrq8kLpNHeDAetUK23LLWiggRfSN` |
| ok | alice: create_offer 20 YES @0.60 | `4aioaxrhSB2Eoyc2Bu3FoUfSgWWAGov9j5xnmKjiTSVe` |
| ok | bob: fill 8 | `6pjpSiYNP2D1RhF3t99Dj8nSqx7BdTeCC5UWcVMV73MQ` |
| ok | carol: fill 5 | `GNyZjcAaieFh9tPbrHGDnmvJHnXp7xGfJvB7K1TY1eN8` |
| ok | alice: cancel remainder (7) | `AfG58cRP6ngFQUG1ZbyCQVpMAtguZ7dKYZjkdJJxGR89` |
| ok | bob: resell offer 3 YES @0.70 | `2MqbjywFtn2SGsVkDmZ4MGtcYpU9wqVfPGJ84h2hdwMo` |
| ok | carol: fill resale 3 | `A8jBjK86tXVTsyHd7RaNymcRcWo1nAPLcdMwwC76hXwG` |
| refused (expected) | resolver: resolve before the cutoff (refused) | `EkTwY4GeZCQXZbconrYHZc1Z9qY1VVVaVTmrcbK5VXdk` |
| refused (expected) | alice: resolve as a non-resolver (refused) | `ShuxCnQhdv7kv8Y1dAmay72aRsSiH3Xz7BcQpiTgLqS` |
| ok | resolver: resolve YES | `7dhetiSQkhaQa8xVjiKwrdZszqf34jXWGTSn9b7tagUZ` |
| refused (expected) | resolver: resolve again (refused) | `ZpJFb6WHp2hvVLRZ7WSYMFdipGdgaZouaGkpwa6aaEG` |
| refused (expected) | bob: split after resolution (refused) | `6hFegtgge26LyETMPu2m6KGczRadcGTs2puDrxBJGMiF` |
| refused (expected) | alice: merge after resolution (refused) | `4Avrx8RV2oVmGTtYjA3Qd4YeCeU4mBYNK17JWLXw64LP` |
| refused (expected) | alice: create_offer after resolution (refused) | `8Ct7ayCR18nPbgZ32KEjqQ3krRmJXDYNaB4pytRdFq9F` |
| ok | carol: redeem | `CbedEWdwjLc5AxCQZB3K4HzGZHNZG2roTsXWdmu9QUAx` |
| ok | alice: redeem | `FVStiG3LLsuYd8rfg1VtinqFyRY7Ryv6nohrPHWMXtoG` |
| ok | bob: redeem | `DNEgnaysPNz8KAGt7y5hhxUZ3MQ5Wsc8Y5EhZ9ZFgdTX` |
| refused (expected) | alice: redeem again (refused) | `H4cVgnuJBqh7pXfKU5EpJV3pTkt1RUu46g9QRd24BANH` |
| ok | alice: withdraw | `7jePoUEZUTnrWYxEc9VGmjRUpCvPaNy7fr7hcjYy4jhE` |
| ok | bob: withdraw | `7SNqWk9Bp31LMTHqJxsEYYUTYgd7BAikcq2hFE9sHgue` |
| ok | carol: withdraw | `A1PUxyRY14vDNTc7PTZf4T9wpdHWTj9iEqvRRLs5LsHx` |

### Earlier partial attempts (not completed smoke tests)

* **Tag `3872357` (first attempt):** trading half only. It stopped at the cutoff wait because the deprecated RPC
  rate-limited, and the sub-account keys were not yet persisted, so those 5 sub-accounts (~6.5 NEAR) are unrecoverable.
  Its on-chain state (accounts `*-3872357.nearodds-deploy.testnet`) shows the trading balances and one owner mint and one
  resolver resolution done afterwards with the helper scripts. It is **not** a completed smoke test.
* **Tags `3876706` and `3877627`:** aborted when a transaction's status was never reported by the node before the harness gave up
  (the transaction was not proven dropped; see "History of the earlier retry behaviour"). Their accounts were deleted with the recovery helper and every NEAR returned. Their journals are in
  `deployments/runs/`.
* **Recovery drill (`drill-3876655`):** a fresh process loaded the saved key, confirmed its public key matched the chain,
  deleted the account and the NEAR returned.

### Timing (demo market)

| Moment | Time |
| - | - |
| Trading stops (contract cutoff, immutable) | **2026-11-12 00:00 WAT** = 2026-11-11T23:00:00Z |
| Observation day ends | **2026-11-13 00:00 WAT** = 2026-11-12T23:00:00Z |
| Earliest sensible resolution | after the NiMet daily report for 2026-11-12 is published |

The contract only checks the **trading cutoff**: `resolve_market` is accepted by the resolver at any time at or after
2026-11-12 00:00 WAT, including while the observed day is still in progress. It does not know about the observation day or
the report. Waiting for the specified report is a **rule the trusted resolver must follow**, not something the contract
enforces. Resolution is final.

### Harness safety rules

* Sub-account keys are created **exclusively** (`create_new`, mode 600, directory 700) in `~/.near-credentials/testnet/` before
  the account is created. An existing key file is never overwritten. If one exists it is reused only if it is
  self-consistent and the chain agrees (the account is absent, or present with exactly that key); anything else stops the
  run as a collision and leaves the file untouched.
* Run ids are `<6 base-36 chars of unix seconds><8 random hex chars>` (14 characters; the longest account id, `probe-demo-<id>.<parent>`, stays under
  the 64-character limit for parents up to 38 characters).
* A non-secret journal (`deployments/runs/<kind>-<tag>.jsonl`) records account ids, and for every transaction its hash, signer and
  operation, as they happen.
* **A transaction is signed and submitted exactly once.** Its recorded hash is polled for 60 s. If its status cannot be read
  (still pending, request timeout, RPC error, rate limit) the outcome is **uncertain**: the harness journals `step_uncertain`
  (hash, signer, operation, last reason) and stops the run. A timeout does not prove the transaction failed or was dropped, so it is
  never re-signed or resubmitted because of one. A submit call that itself errors also stops the run.
* Account deletion and absence are decided from the raw RPC answer, not from whether a query "worked": **absent** only on an explicit
  `UNKNOWN_ACCOUNT`; transport errors, rate limits, timeouts and unparseable bodies are **uncertain**. (near-workspaces flattens
  every query failure into one message, so the harness reads `query/view_account` itself.)
* Cleanup is an explicit list of that run's accounts. It refuses the parent, non-sub-accounts and every `-demo-` account.
  Its result reports per account `deleted` / `still_present` / `uncertain`, and, **separately**, the refund
  (`confirmed` / `shortfall` / `unknown`), plus an `overall` verdict. Uncertainty is recorded and the run exits non-zero; it is not
  reported as success.
* The verified record is written before cleanup; cleanup results are added afterwards.

### Uncertain transactions

If a run stops with `UNCERTAIN: ... was submitted but its outcome could not be read`:

1. Do **not** start a new run to "retry" the step; it may already have executed.
2. Resolve the recorded hash(es) by polling them (read-only, signs nothing):
   `NEARODDS_RESUME_JOURNAL=deployments/runs/<kind>-<tag>.jsonl cargo test -p nearodds-market --test testnet_smoke resolve_uncertain_on_testnet -- --ignored --nocapture`.
   It appends `step_resolved` to the journal for each transaction whose final result it finds, and **fails** (it never prints "reconciled")
   if the journal is missing, unreadable, empty or malformed, if any hash is still unknown, or if any `step_submit_error` / unmatched `step_submitting`
   remains: those have no hash, may or may not have executed, and need manual investigation of the account's activity. After investigating, append
   `{"event":"step_manual_resolved","step":"<step name>","note":"..."}` to the journal to close the item.
   A node that has no record of a hash (`UNKNOWN_TRANSACTION`) is **not** proof it never executed; check the affected account's balances
   and state on the chain before redoing anything.
3. The interrupted run is not continued automatically. Finish the remaining operations by hand or with the single-purpose scripts
   (`testnet-mint.sh`, `testnet-resolve.sh`), after confirming the state of the uncertain step. Disposable accounts of an abandoned
   run are removed with `delete_testnet_accounts` (below).

Failure-injection tests (they run in CI): `status_outage_after_success_is_uncertain_and_never_resubmitted` (the operation succeeds but every
status read fails; it executes exactly once and the journal names its hash/signer/operation), `deletion_with_rpc_outage_stays_uncertain`,
`name_collision_with_a_foreign_key_refuses_and_keeps_the_original`, `key_files_are_created_exclusively_and_never_overwritten`.

### History of the earlier retry behaviour (commits up to `a9cbee0`)

The harness used to resubmit a step when its hash had not been observed for 60 s (at most 3 attempts), treating that as "the node
dropped it". That was not safe: an unreadable status does not prove the transaction did not run, and a fresh submission can repeat a
mint, deposit, offer or fill. The recorded smoke run (tag `3879067`) hit this path twice, for two `mint` steps. Its journal
(`deployments/runs/smoke-3879067.jsonl`) shows only that polling gave up and a new transaction was signed; it does **not** record any check that the
first hashes were unknown. The record is still correct for its outcome: the final balances (Alice 94.80, Bob 12.30, Carol 12.90 tNOC)
are exactly what single mints produce, so nothing was minted twice. As a read-only check made on 2026-11-05, `test.rpc.fastnear.com`
answered `UNKNOWN_TRANSACTION` for both abandoned hashes (`7rbNPeaR7cgZ4qo7SgNnjHCdSt2pkdrHFJoFYjjYe7b4`,
`D6xqAeLPus67gRxiV4nJdDcp1DzXiwBcH5HGHaEevSUo`) while returning a normal result for a known hash, which supports but does not by itself prove that.
The historical records and journals were left unchanged.

## Funding

The parent held about 6 NEAR at last check. A new smoke run needs 7.5 NEAR available (token 2 + market 3 + alice/bob/carol 0.5 each + 1 margin) and a new demo deployment 8.1 NEAR (token 2 + market 3 + liquidity provider 1.5 + probe 0.6 + 1 margin) (sizes in
`contracts/market/tests/testnet_smoke.rs`; the harness checks and stops with a message naming any shortfall). The smoke
accounts return their NEAR on cleanup. Funding sources used: the official faucet helper created `nearodds-deploy.testnet`
(10 NEAR) and, on your instruction, `nearodds-fund.testnet` (10 NEAR, whose 9.8 NEAR were then transferred to the parent;
it keeps about 0.2 NEAR).

## Scripts

```bash
export NEARODDS_TESTNET_PARENT=nearodds-deploy.testnet     # key is read from ~/.near-credentials/testnet/
bash scripts/testnet-smoke.sh                              # ~20 min: disposable lifecycle market, then cleanup
NEARODDS_DEMO_OBSERVATION_DATE=2026-11-12 bash scripts/testnet-demo.sh     # open demo market
NEARODDS_TOKEN=<token> NEARODDS_MINT="you.testnet:100" bash scripts/testnet-mint.sh
NEARODDS_MARKET=<market> NEARODDS_OUTCOME=Yes NEARODDS_EVIDENCE="<source link>" bash scripts/testnet-resolve.sh
```

Interrupted runs: recover with `NEARODDS_DELETE_ACCOUNTS="a.nearodds-deploy.testnet,..." cargo test -p nearodds-market --test testnet_smoke delete_testnet_accounts -- --ignored --nocapture`
(keys are on disk, the journal lists the accounts). It prints per-account `deleted` / `still_present` / `uncertain` and the refund
status separately, and exits non-zero unless everything is confirmed; re-run it later for accounts reported `uncertain`.

## Deployment and initialization workflow (for the keeper / market-creation backend)

The contract has **no `create_market` method**: one deployment is one market. The harness (`deploy_stack` in
`contracts/market/tests/testnet_smoke.rs`) creates a market like this, and a backend can reuse the same sequence:

1. Create sub-accounts of a funded parent for the token and the market (2 NEAR and 3 NEAR in the demo; the market account must also pay for state,
   see "Notes"). Save each new key **before** creating its account.
2. Token (test fixture only; a real deployment points at an existing NEP-141): deploy `test_collateral.wasm` and call
   `new({ owner_id })` in the same batch transaction.
3. Market: deploy `market.wasm` and call `new` in the same batch transaction (100 Tgas) with
   `{ collateral_token, market_id, question, rules, resolution_source, split_cutoff_ns (decimal string, ns), resolver_id }`.
   `split_cutoff_ns` is immutable and must be in the future; the rules text should quote the question date and the exact cutoff.
4. Read `get_config` and verify `resolver_id` and `collateral_token_id`; register the token contract's storage for the market account if needed;
   verify the on-chain code hashes against the built artifacts.
5. Optionally seed liquidity (`storage_deposit`, `ft_transfer_call` with msg `deposit`, `split_position`, `create_offer`, as in `run_demo`).
6. After the cutoff, and once the source named in `resolution_source` has published, the resolver calls `resolve_market({ market_id, outcome, evidence })`.

Attached deposits are **method-specific**; do not apply one rule to every call:

| Call | Attached deposit |
| - | - |
| market `new`, token `new` (initialization, in the deploy batch) | **0** (not payable) |
| token `mint` (fixture, owner only) | **0** (not payable) |
| market `storage_deposit` | the registration cost from `get_config().storage_cost_per_account` (0.04096 NEAR for 4096 bytes); see below |
| token `storage_deposit` (NEP-145, to register an account with the token) | the harness attaches 0.01 NEAR for `registration_only` (the token's own minimum is 0.00125 NEAR) |
| token `ft_transfer_call` (deposit into the market, msg `deposit`) | exactly **1 yoctoNEAR** (NEP-141) |
| market `withdraw`, `split_position`, `merge_positions`, `create_offer`, `fill_offer`, `cancel_offer`, `resolve_market`, `redeem` | exactly **1 yoctoNEAR** each (`assert_one_yocto`) |
| views, `ft_on_transfer`, `on_withdraw_complete` | none (views are free; the other two are only called by contracts) |

Storage deposits are separate from the 1 yoctoNEAR rule. A market account is registered once with `storage_deposit` (the cost above buys a
4096-byte allowance: an account record, a pending-withdrawal record and 10 open offers); it is not attached to trading calls.
The account-creating transactions fund the new sub-account's balance instead (token 2 NEAR, market 3 NEAR in the demo).
Treat any transaction whose result you cannot read as **uncertain** (see above), never as failed.

## Notes and trust

* The market account keeps a full-access key and the parent is both resolver and token owner. That trust is disclosed in
  `get_config()`; decide on key handling before presenting the deployment as trust-minimised.
* The market account must stay funded: resolution adds up to 547 bytes of state paid from its own balance.
* All tokens are worthless test tokens.
