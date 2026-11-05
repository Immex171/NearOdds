# Backend operations and recovery guide

## Processes
`pnpm api` (stateless HTTP/SSE) and `pnpm worker` (indexer loop + keeper loop). Run any number of workers: job claims are exclusive, nonces serialised in PostgreSQL.
Health: `/v1/health`, `/v1/ready` (DB + indexer lag < 600 blocks), `/v1/ops/status` (indexer lag, worker heartbeats, job counts, unresolved transactions).

## Secrets
Never committed. `KEYSTORE_DIR` (default `./.keystore`, gitignored, dir 0700, files 0600, created O_EXCL so existing keys are never overwritten).
Signer credentials come from near-cli JSON files (`DEPLOYER_CREDENTIALS_FILE`, `RESOLVER_CREDENTIALS_FILE`, `TOKEN_OWNER_CREDENTIALS_FILE`). The API process only checks that the files exist.
Back up the keystore: market-account keys are the only way to administer those accounts. Keys are never logged or returned by the API.

## Job states and what to do
| State | Meaning | Action |
|---|---|---|
| `queued` | waiting / retry later (see `last_error`) | e.g. `insufficient_deployment_funding`: fund the deployer; `signer is not available`: set credentials |
| `running` | leased by a worker | none; a dead worker's lease expires after 60 s and the job **resumes** |
| `uncertain` | a transaction's outcome could not be read | automatic: retried every 60 s with the SAME signed tx. Inspect `tx_journal` (`tx_hash`) on an explorer if it persists |
| `failed` | permanent (validation, budget, chain failure, verification mismatch) | read `last_error`; fix cause; the next template version creates fresh jobs |
| `succeeded` | done | |

## Recovering a market-creation job
All state is in `jobs.payload.intent` (account, key reference, init args), `tx_journal` (`create:<jobId>`, `register:<jobId>`) and `deployment_records`.
* Crash at any point: just restart the worker. It re-reads the journal; an executed tx is reconciled, an unsent signed tx is re-broadcast with the **same bytes**.
* `verification_failed`: `deployment_records.verification.problems` lists the mismatches; the market is NOT published. Investigate on-chain before doing anything; the account and key remain recorded.
* Never delete `tx_journal` rows to "retry": that is how duplicates happen. If a tx expired unincluded (block hash > ~1 day old and unknown to the chain) a human may re-sign under a new op key.

## Indexer
Checkpoint `indexer_checkpoints.main`; markets still scanning appear in `/v1/ops/status` (`marketsCatchingUp`). Anonymous Neardata is rate-limited: expect slow historical scans; set `NEARDATA_API_KEY` for speed.
Drift: `markets.reconcile` / `markets.*.coverage`. Reconcile corrects balances to contract views each cycle; a large `driftCount` on a market that says `historyComplete:true` is a bug to report.
Replays are safe (dedupe on `(receipt_id, log_index)`).

## Faucet
Disabled automatically when the token-owner signer is missing, on non-test networks, or when the native NEAR budget (`FAUCET_NEAR_BUDGET_YOCTO`) would be exceeded. Claims are idempotent per `Idempotency-Key`; duplicates cannot mint twice (journal op `faucet-mint:<claimId>`).

## Resolution of a live market
1. Wait for the cutoff and the end of the observation window; `GET /v1/admin/resolutions` shows each condition.
2. `POST /v1/admin/resolutions` with outcome, evidence reference (the source named in `resolution_source`) and the retrieval time.
3. A second admin approves (`/review`); the keeper submits within ~30 s. Resolution is final.
