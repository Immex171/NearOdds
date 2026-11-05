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
| Observation period | 2026-11-12 00:00-24:00 WAT (UTC+1) |
| Resolution source | NiMet daily weather report, Lagos, 2026-11-12 |
| Trading cutoff | **2026-11-11T23:00:00Z** = 2026-11-12 00:00 WAT (`1794438000000000000` ns). Immutable. |
| Resolve | by the resolver after the cutoff, once the NiMet report for the observation date is published |
| Token | `NearOdds TEST Collateral (no value)`, symbol **`tNOC`**, **6 decimals** |
| Market code hash (base58) | `D87VzcAmR32hXwqUcwZfRvrC7HLHXREoSTjmsHwsezon` (sha256 `b41ea88129be572c3f3c48e4fcaec31afa12aca4d49c97cf237bea88f4f22d45`, 236408 bytes) |
| Token code hash (base58) | `3csjd1rDuCq3vtAcffZbsawyKRQuT8y2GMDmPhbdQV98` (sha256 `26e81178403522a377ff4039c75923e95bbc0341aa1ae767699910532da25ddf`, 151472 bytes) |
| Deployed from | commit `462871b` (clean tree; contract sources unchanged since `7d50c6c`) |

The question, rules, observation window, source and cutoff were checked to agree (the rules text quotes the date and the
exact cutoff). The cutoff leaves a week for trying the app and closes trading before the observed day starts.

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
* **Tags `3876706` and `3877627`:** aborted when the node dropped a transaction before the harness could handle it
  (see below). Their accounts were deleted with the recovery helper and every NEAR returned. Their journals are in
  `deployments/runs/`.
* **Recovery drill (`drill-3876655`):** a fresh process loaded the saved key, confirmed its public key matched the chain,
  deleted the account and the NEAR returned.

### Harness safety rules (verified on testnet)

* Sub-account keys are written to `~/.near-credentials/testnet/` before the account is created.
* A non-secret journal (`deployments/runs/<kind>-<tag>.jsonl`) records account IDs, transaction hashes and steps as they happen.
* A transaction is submitted at most once. Its hash is polled; a transaction the node never observed within 60 s is
  checked and only then resubmitted (journaled, at most 3 attempts). During the passing smoke run the node dropped two
  `mint` transactions; both hashes were confirmed unknown on chain before resubmission, and the exact final balances prove
  nothing was minted twice. An uncertain submit error stops the run instead of retrying.
* Cleanup is an explicit list of that run's accounts. It refuses the parent, non-sub-accounts and every `-demo-` account.
* The verified record is written before cleanup; cleanup results are added afterwards.

## Funding

The parent now holds about 6 NEAR. A new smoke run needs 7.5 NEAR available and a new demo deployment 8.1 NEAR (sizes in
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
(keys are on disk, the journal lists the accounts).

## Notes and trust

* The market account keeps a full-access key and the parent is both resolver and token owner. That trust is disclosed in
  `get_config()`; decide on key handling before presenting the deployment as trust-minimised.
* The market account must stay funded: resolution adds up to 547 bytes of state paid from its own balance.
* All tokens are worthless test tokens.
