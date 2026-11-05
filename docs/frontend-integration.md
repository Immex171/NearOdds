# Frontend integration status (apps/web)

The frontend is multi-market: discovery and history come from the backend API, and every wallet action targets the selected
market's own contract after the chain has been re-read. Details: `apps/web/README.md`.

## Identities (use these consistently)
`marketRef` = frontend identity (route, cache, watchlist). `contract.contractId` = wallet-call receiver. `contract.marketId` = the contract's
`market_id` argument (contracts can share `mkt-1`). `contract.tokenId` = collateral token. `offerRef`/`withdrawalRef` = frontend identities;
`offerId`/`withdrawalId` = contract-local ids sent to contracts.

## Behaviour worth knowing
- Per market: verification (contract, token, config, identity, and agreement with the API's claim), registration, deposits, limits, offers, balances, redemption preview.
- Wallet token balance is per token and counted once; deposits are shown per market and never pooled.
- Preflight before every wallet call: `get_market` flags, `get_account`, `get_offer`, `get_redemption_preview`. A vanished/changed offer is explained and the wallet is not opened.
- A submitted transaction whose result cannot be read is "unconfirmed", stored by hash (localStorage) and only re-read, never resent. Withdrawal `Pending` is unconfirmed; a second withdrawal is refused meanwhile.
- Sign-in is NEP-413 (challenge -> wallet signs message, recipient, decoded nonce -> verify). The application session is tab-scoped and ends when the wallet account changes.
- Faucet: one idempotency key per intended claim (kept across reloads and retries); queued is not funded; native NEAR is separate.
- Stream: one connection per account for all markets; events are hints, REST is the truth.

## Backend observations (for the backend team)
- Real demo market reports `reconcile.ok=false, driftCount=5` and `tipHeight/lagBlocks=null` (lag unknown); the UI shows the drift notice and treats unknown lag as unknown.
- `driftNote` in `/portfolio` is an array of strings (typed as such locally).
- Response types missing from `packages/types/src/backend-api.ts` and defined locally in `apps/web/lib/api/types.ts`: market detail, trades, candles, activity, portfolio, account offers/withdrawals (incl. status `Unsettled`), auth, watchlist, faucet, categories, stream events. Please move them into the shared package so both sides share one definition.
- `market_created` events carry the new `marketRef`; clients that filter the stream by `markets=` would miss them, so the app subscribes to all markets.

## Verification evidence
See the hand-off report: unit tests, Sandbox run (real contracts, transaction hashes in the report), browser integration (simulation), real-backend read-only run.
