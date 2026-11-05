# Frontend handoff: NearOdds backend API (`/v1`)

Types: `@nearodds/types` (`packages/types/src/backend-api.ts`). Samples below come from the running API against the imported testnet demo.
The wallet still signs every trade, deposit, cancel, redeem and withdrawal; the API only reads and indexes. Contract call data (receiver, `market_id`) is always taken from the response's `contract` object.

## Base URL and configuration
| Variable (frontend, suggested) | Value |
| - | - |
| `NEXT_PUBLIC_API_BASE_URL` | local `http://localhost:4000`; the API process listens on `API_HOST:API_PORT` |
Backend side: `CORS_ORIGINS` is an allowlist (comma separated; default `http://localhost:3000`). Preflight is answered for `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS` with headers `authorization, content-type, idempotency-key, last-event-id`; other origins get no CORS headers (also on `/v1/stream`).
Send `Authorization: Bearer <session token>` for authenticated routes. All amounts, prices and ids are decimal **strings** (use `BigInt`). Timestamps with `Ns` are nanoseconds.

## Errors
Every non-2xx response: `{"error":{"code":"…","message":"…","details":…}}`.
| HTTP | codes |
| - | - |
| 400 | `bad_request`, `bad_account`, `bad_nonce`, `idempotency_key_required` |
| 401 | `unauthenticated`, `nonce_invalid`, `bad_signature`, `key_not_on_account`, `key_not_full_access` |
| 403 | `forbidden` (not on admin allowlist) |
| 404 | `not_found` |
| 409 | `proposal_exists`, `not_pending` |
| 429 | `cooldown`, `account_quota`, `global_quota` |
| 503 | `faucet_disabled`, `native_budget`, `rpc_unavailable` (retry later) |

## Freshness and history coverage (show them)
Every snapshot carries `freshness`: `{ blockHeight, tipHeight, lagBlocks, checkpointUpdatedAt, generatedAt }` (`lagBlocks` null until the worker has recorded the chain tip).
Every market carries `coverage`: `{ historyComplete, historyStartHeight, indexedThrough, note }`. When `historyComplete` is false, **trades, volume, candles and activity may be incomplete** (the demo market is in this state until the history scan finishes or after any unresolved provider gap); show `coverage.note`. `historyComplete` is only true after the scan reached the live checkpoint and no unproven gap remains; an API key never changes that. `reconcile` shows the last comparison with contract views (`ok`, `driftCount`).
Market `status` (`Open | AwaitingResolution | Resolved`) is computed from the contract cutoff, so it flips at the cutoff without waiting for the indexer. An **empty book is real** (`yes.empty`/`no.empty`), not an error.

## Discovery
`GET /v1/markets?q=&category=&status=open|awaiting|resolved&sort=newest|closing|volume&limit=&offset=` → `{ items: ApiMarket[], page:{limit,offset,total}, freshness }`; `GET /v1/categories` → `{ items:[{category,count}] }`.
```json
{ "marketRef": "m_c01fd991933182b9c42c", "network": "testnet",
  "contract": { "contractId": "mkt-demo-3879869.nearodds-deploy.testnet", "marketId": "mkt-1", "tokenId": "tok-demo-3879869.nearodds-deploy.testnet" },
  "question": "Will it rain in Lagos on 2026-11-12?", "category": "Weather",
  "token": { "symbol": "tNOC", "decimals": 6, "isTestToken": true },
  "status": "Open", "uiStatus": "open", "tradingOpen": true,
  "tradingCutoff": { "ns": "1794438000000000000", "iso": "2026-11-11T23:00:00.000Z" },
  "observation": { "endIso": "2026-11-12T23:00:00.000Z" }, "resolver": "nearodds-deploy.testnet", "resolution": null,
  "trustModel": { "model": "manual-trusted-resolver", "voidSupported": false, "disputesSupported": false },
  "volume": "65", "tradeCount": 1, "openOfferCount": 7,
  "quotes": { "Yes": { "bestBid": "550000", "bestAsk": "650000", "lastTrade": "650000", "displayed": "600000", "basis": "midpoint" },
              "No":  { "bestBid": null, "bestAsk": "350000", "lastTrade": null, "displayed": null, "basis": "none" } },
  "coverage": { "historyComplete": false, "historyStartHeight": 276338187, "indexedThrough": null, "note": "Trade history may be incomplete: …" } }
```
Display price: midpoint of best bid/ask when both exist and spread ≤ 0.10, else the last trade **of that outcome**, else none (`basis`). YES and NO are never derived from each other. Volume = Σ confirmed fills' `collateral_amount`.

## Market detail
`GET /v1/markets/:marketRef` → `ApiMarketDetail` = market + `resolutionStatus` (`policy`, `cutoffPassed`, `observationComplete`, `evidence: missing|proposed|approved|ambiguous|provider_error|submitted`) + `deployment` (artifact hash, tx hashes, verification) + `freshness`. Always show `trustModel.summary` (one resolver, final YES/NO, no VOID/dispute). Redeem and withdraw are separate wallet steps.

## Order book
`GET /v1/markets/:marketRef/book` → separate `yes` / `no`, each `{ bids, asks, bidLevels, askLevels, empty }`. `bids` best (highest) first, `asks` best (lowest) first, ties by offer id.
```json
{ "yes": { "asks": [ { "offerId": "4", "offerRef": "m_c01…:4", "owner": "lp-demo-….testnet", "price": "650000", "remainingQuantity": "8461500", "originalQuantity": "10000000", "expiresAtNs": null } ],
           "bids": [ { "offerId": "25", "price": "550000", "remainingQuantity": "10000000" } ], "askLevels": [ { "price": "650000", "quantity": "8461500" } ], "empty": false },
  "no": { "asks": [ { "offerId": "18", "price": "350000" } ], "bids": [], "empty": false },
  "unfillable": [] }
```
To trade: `fill_offer({ offer_id: offer.offerId, quantity })` on `contract.contractId` (1 yocto). `unfillable` lists expired / market-closed offers (`reason`) that their owners can still cancel; they never appear in quotes.

## Trades and candles
`GET …/trades?limit=&before=` → `{ items:[{tradeId, offerId, outcome, price, quantity, collateralAmount, maker, taker, makerSide, takerSide, blockHeight, timestampNs, receiptId}], nextBefore, freshness }` (cursor: pass `nextBefore` as `before`).
`GET …/candles?outcome=Yes|No&interval=1m|5m|15m|1h|4h|1d` → `{ candles:[{startNs, open, high, low, close, volume, shares, trades}], methodology }`. Built from confirmed fills only; empty intervals are omitted (do not interpolate).

## Accounts
`GET /v1/accounts/:id/portfolio` → per market `collateral{available,reserved,pendingWithdrawal}`, `positions{yes,no:{available,reserved,total}}`, `redeemed`, `redeemHint`, plus `openOffers[]` and `withdrawals[]`; also `/offers`, `/withdrawals`, `/activity`.
Withdrawals: `status` is explicit: `Pending` (unconfirmed, never retry), `Completed`, `FailedRestored` (returned to available), or `Unsettled` (history shows a request but its settlement has not been seen; treat like Pending). `confirmed` = status is not Pending/Unsettled. A non-null withdrawal can already be Completed.

## Authentication (NEP-413)
1. `POST /v1/auth/challenge {accountId}` → `{ message, recipient, nonce(base64), expiresAt }` (5 minutes, single use).
2. Wallet `signMessage({ message, recipient, nonce })`.
3. `POST /v1/auth/verify {accountId, publicKey, signature(base64), nonce}` → `{ token, accountId, expiresAt, isAdmin }`. The key must be a current **full-access** key of the account.
4. `GET /v1/auth/session`, `POST /v1/auth/logout`. Watchlist: `GET /v1/watchlist`, `PUT|DELETE /v1/watchlist/:marketRef` (idempotent).

## Faucet (tNOC, test networks only)
`GET /v1/faucet` → `{ enabled, disabledReason, tokenId, amountPerClaim, limits:{perAccount,globalPer24h,cooldownSeconds}, … }`. Show the button only when `enabled`; otherwise show `disabledReason` (e.g. "token-owner signer is not available").
`POST /v1/faucet/claim` with **required** `Idempotency-Key` (UUID) and the session token → `202 {claimId, state:"queued", replayed:false}`; repeating the same key returns `200` with `replayed:true` and the same claim. A fresh key within the cooldown → `429 cooldown`; over the quota → `429 account_quota|global_quota`. Poll `GET /v1/faucet/claims/:id` until `state` is `minted` (or `failed`). The recipient is always the signed-in account; it is registered with the token automatically. Tokens only; users receive no NEAR.

## Live updates (SSE)
`new EventSource(`${API}/v1/stream?markets=ref1,ref2&account=me.testnet`)`. Events: `hello`, `heartbeat`, `market_created`, `market_status`, `book`, `trade`, `account`; each payload includes `freshness`.
Reconnect: `EventSource` retries automatically (`retry: 3000`). The stream carries **changes only** and does not replay: on every `hello` (first connect or reconnect) and after any error, refetch the snapshots you display (market, book, trades, portfolio). Treat events as invalidation hints. Historical backfill never emits events.

## Resolution sources actually implemented
* **Reviewed evidence** (all markets today, including Lagos): an admin proposes outcome + evidence reference + retrieval time, evidence must be retrieved after the observation period ends, then approval, then the keeper submits `resolve_market`. Missing, late or ambiguous evidence stays pending; it is never turned into NO.
* **Automatic providers:** none registered in production. No NiMet API is assumed.

## Trading bot administration (admin sessions only)
`/v1/admin/trading-bots` (list, create, status, versioned config, preview, start paper|execute, pause, stop, orders/fills/decisions/operations). Full behaviour, state machine, response example and the bounded testnet procedure: **`docs/trading-bot.md`**. Types: `ApiBotStatus`, `ApiBotPreview`, `ApiBotConfigInput` in `@nearodds/types`. Render `state` with `stateReason`, list `reasons[]` for skipped decisions, show `lastChainRead` age, and never present `pausing`/`stopping` as finished (open offers can still be filled). Execute mode is refused with `409 execution_disabled` unless the environment enables it (Sandbox/testnet only).
