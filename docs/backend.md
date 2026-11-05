# NearOdds backend (`apps/backend`)

TypeScript + Fastify API, PostgreSQL, and a separate worker (indexer + keeper). OpenAPI: `GET /v1/openapi.json`.
Shared response types: `@nearodds/types` (`backend-api.ts`). Operations/recovery: `docs/backend-operations.md`.

## Run locally
```bash
cd apps/backend
cp .env.example .env            # export the variables (e.g. `set -a; source .env; set +a`)
pnpm db:up                      # PostgreSQL 17 on localhost:5440
pnpm migrate
pnpm import-demo                # validates deployments/testnet-demo.json against the chain, imports, backfills, reconciles
pnpm api                        # http://127.0.0.1:4000
pnpm worker                     # indexer + keeper (separate process)
pnpm test                       # needs Docker Postgres; Sandbox tests need target/wasm/*.wasm and the cargo-built near-sandbox
```

## Modules
`config` · `db` (+ `migrations/`) · `near` (RPC, journaled tx executor, keystore) · `registry` (marketRef, chain verification, demo import) ·
`indexer` (Neardata client, event parsing, projections, reconciliation) · `keeper` (templates, scheduler, durable jobs, market creation, resolution) ·
`auth` (NEP-413) · `faucet` · `api` (routes, DTOs, SSE, OpenAPI).

## Identity
`marketRef = "m_" + sha256(network|contractId|internalMarketId)[0..20]`. Every market response returns
`contract.contractId` (wallet receiver) and `contract.marketId` (the `market_id` argument). Offer/withdrawal ids are contract-local;
the API scopes them as `offerRef` / `withdrawalRef` = `<marketRef>:<id>` (DB keys are `(market_ref, id)`).

## Order book and prices
* The book is an indexed, **sorted** view of onchain offers (`list_offers` is storage-ordered). Bids: highest price first; asks: lowest first; ties by offer id.
* YES and NO books are separate and never derived from each other.
* `bids`/`asks` hold only **executable** offers (not expired, market open, not resolved). Others appear in `unfillable` with a reason and stay cancellable.
* A missing offer record is not treated as "filled": reconcile marks it `gone` (hidden from quotes) and reports drift.
* **Displayed price**: midpoint of best executable bid/ask when both exist and spread <= 0.10; otherwise the last confirmed trade of *that outcome*; otherwise `null`. `basis` says which.
* **Candles**: from confirmed `offer_filled` events of one outcome (O/H/L/C = fill prices, volume = Σ `collateral_amount`). Empty intervals are omitted.
* **Volume** = Σ `offer_filled.collateral_amount`, once per `(receipt_id, log_index)`. Deposits, splits, merges, payouts are not volume.

## Indexing
* Block source: **FastNEAR Neardata** `https://testnet.neardata.xyz` (verified 2026-11-05: testnet blocks served anonymously; `/v0/block/{h}` is finalized data; skipped heights return 404/null). NEAR Lake no longer indexes new blocks. Anonymous access is **rate-limited (HTTP 429)**; the client backs off and retries, and an optional `NEARDATA_API_KEY` is sent as a bearer token. Auth failures raise a clear error.
* Only receipts that **succeeded**, executed **by a registered market account**, with log standard `nearodds_market` version `1.0.0`. Each receipt is judged alone: a later failed callback never undoes an earlier successful one (and its own logs are ignored).
* Dedup key `(receipt_id, log_index)`; projection + checkpoint commit in one transaction. Timestamps are the execution block's.
* Projections keep available / reserved / pending separately. `position_redeemed` adds **only** `payout`; released offer collateral arrives via the `offer_cancelled` events of the same receipt (no double count).
* Withdrawals are tracked by explicit `status` (`Pending` / `Completed` / `FailedRestored`); reconcile also reads `get_withdrawal`.
* **Snapshot boundary:** reconcile anchors balances/offers at block H (`markets.snapshot_height`). Receipts at or before H are history only (events, fills/volume, activity); only newer receipts change balances, offers or withdrawals. Reconcile and ingestion serialise per market, one indexer writes at a time, and a reconcile older than the snapshot is refused.
* **Gaps:** a missing provider block is *not* assumed skipped. A height counts as skipped only when the next existing block's `prev_height` jumps over it; otherwise it is recorded in `index_gaps`, retried, and `historyComplete` stays false.
* **Reconcile** (worker, ~30 s): at the checkpoint block it pages all `list_offers` combos and reads `get_account`/`get_withdrawal`/`get_market`, reports drift, then corrects to the views.
* **History**: a market records `history_start_height` (its deploy block). The indexer scans Neardata from there (resumable; `indexed_through`). Until done, `coverage.historyComplete=false` and trade history/volume may be incomplete. The demo import additionally backfills the manifest's own transactions through RPC. Contract views cannot reconstruct deleted offers or old trades.

## Keeper: automatic market creation
Admin enables a template once (`POST /v1/admin/templates`, `PATCH .../:id {"enabled":true}`). The scheduler enqueues one job per due occurrence, key `tpl:<slug>:v<version>:<date>`.
Per job: validate (placeholders, byte limits, cutoff ahead, approved artifact, per-day limit, budget, deployer balance) → persist intent
(account name + key in the 0600 keystore + `key_refs` + `deployment_records`) **before any funding** → check the name is free (explicit `UNKNOWN_ACCOUNT`) →
**one batch tx**: CreateAccount + Transfer(funding) + AddKey + DeployContract(approved Wasm) + `new()` (atomic: never a funded-but-uninitialised market) →
register the market with the collateral token → verify (code hash, initializer values, token metadata/decimals, registration) → publish to registry + SSE.
Jobs read their **immutable template revision** (`template_revisions`), never the mutable template; changing a template bumps `version` (new dedupe keys) and cannot alter queued/running jobs. Budget and daily capacity are reserved atomically per template (`budget_reservations`) before intent is persisted; funding that may have left the deployer is never released by a job failure. A temporary RPC outage during verification resumes verification; only a confirmed mismatch fails the job. Account names: `mkt-<slug>-<yyyymmdd>-<8 random hex>.<deployer>`. Closed markets are never deleted.
Approved artifacts: `apps/backend/artifacts.json` (`target/wasm/market.wasm`, sha256 `b41ea881…`, the demo's verified production artifact; built by `scripts/build-wasm.sh`).

## Reliability rules
* `tx_journal`: every transaction is signed **once per `op_key`**; bytes + hash are persisted before broadcast. Timeouts leave the op `uncertain`; resume polls the same hash and may re-broadcast the **same bytes**, never re-sign.
* Nonces are allocated under a row lock (`signer_nonces`) across workers, and a transaction is broadcast only after every lower-nonce transaction of the same key is terminal (durable per-key ordering). An unresolved transaction stays `uncertain`; expiry never makes it safe to repeat. Jobs are claimed with `FOR UPDATE SKIP LOCKED` + lease.
* Reads retry with backoff; only reads. `UNKNOWN_ACCOUNT` ≠ RPC unavailable (the latter throws and the job retries).

## Resolution
Three separate conditions are tracked (`resolution_watch`): trading cutoff passed (contract-enforced), observation complete, evidence available.
`reviewed` (default; used for Lagos): admin proposes `{outcome, evidenceRef ≤512 B, retrievedAt, observation window}`, evidence must be retrieved **after** the observation ends, a second admin approves when ≥2 admins are listed, then the keeper submits `resolve_market` from the configured resolver once the chain reports `AwaitingResolution` and observation is over.
Lagos: cutoff 2026-11-12 00:00 WAT (`1794438000000000000`), observation ends 2026-11-13 00:00 WAT; **no NiMet endpoint is assumed**.
`automatic` only with a registered, tested provider and explicit `decisionRule`; the production registry is empty. Pending/ambiguous/error never become NO.
**Trust model (always in API responses):** one resolver sets a final YES/NO; no VOID, no disputes. Redeem and withdraw stay user-wallet actions.

## Auth, admin, faucet
* NEP-413: `POST /v1/auth/challenge {accountId}` → wallet `signMessage({message, recipient, nonce})` → `POST /v1/auth/verify {accountId, publicKey, signature(base64), nonce(base64)}`. Single-use 5-min nonce, recipient `AUTH_RECIPIENT`, key must be a current **full-access** key of the account. Session = bearer token (hash stored).
* Admin = `ADMIN_ACCOUNTS` allowlist.
* Faucet (testnet-like networks only): authenticated, recipient = session account, registers recipient with the token, per-account / 24h-global quotas, cooldown, idempotent via a **required** `Idempotency-Key` header (same key = same claim; every new key obeys the cooldown), registration/mint costs recovered from the tx journal after crashes, native-NEAR budget (`native_spend`), clear disabled state. Distributes tNOC only; no NEAR to users.
* **Signer roles** (deployer, resolver, token owner) are separate config entries, but the demo uses `nearodds-deploy.testnet` for all three. `/v1/admin/jobs` reports `keyIsolation:false` while they share an account.

## Endpoints
See `/v1/openapi.json`. Main: `/v1/markets`, `/v1/markets/:ref`, `/book`, `/trades`, `/candles`, `/activity`, `/v1/accounts/:id/{portfolio,offers,withdrawals,activity}`,
`/v1/stream` (SSE), `/v1/auth/*`, `/v1/watchlist`, `/v1/faucet`, `/v1/admin/*`, `/v1/health`, `/v1/ready`, `/v1/ops/status`.

## Frontend integration
```ts
const api = "http://localhost:4000";
const { items } = await (await fetch(`${api}/v1/markets?status=open&q=lagos`)).json();
const m = items[0];                       // wallet call: receiver m.contract.contractId, args { market_id: m.contract.marketId, ... }
const book = await (await fetch(`${api}/v1/markets/${m.marketRef}/book`)).json();   // book.yes.asks[0].offerId -> fill_offer({offer_id, quantity})
const es = new EventSource(`${api}/v1/stream?markets=${m.marketRef}&account=${me}`);
es.addEventListener("trade", () => refetchBook());            // always refetch the snapshot on events and after reconnects
es.addEventListener("hello", () => refetchAll());
// login
const ch = await post("/v1/auth/challenge", { accountId });
const sig = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: base64ToBytes(ch.nonce) });
const { token } = await post("/v1/auth/verify", { accountId, publicKey: sig.publicKey, signature: toBase64(sig.signature), nonce: ch.nonce });
```
Notes for the frontend developer: amounts are strings (use BigInt); `status` follows the contract (`Open/AwaitingResolution/Resolved`) and flips at the cutoff without waiting for the indexer;
show `coverage.note` when `historyComplete` is false and `freshness.lagBlocks`; an empty book is real (`book.*.empty`).
