# NearOdds web app

Next.js (App Router) + React + TypeScript (strict) + Tailwind CSS 4. Package manager: pnpm (workspace root is the repo root).

## Run

```bash
pnpm install                 # from the repo root
cd apps/web
pnpm dev                     # http://localhost:3000, live mode against NEXT_PUBLIC_API_URL (default http://localhost:4000)
pnpm check                   # lint + typecheck + unit tests + build
pnpm test:sandbox            # real contracts on a throwaway NEAR Sandbox (~2 min)
pnpm e2e:integration         # browser: real build + fixture backend/chain on other origins (builds into .next-e2e)
```

### Configuration

Markets are **not** configured. The NearOdds backend (`apps/backend`, `docs/backend.md`) lists every market contract, including
ones its keeper creates later, and each response names the market's `contract.contractId`, `contract.marketId` and `contract.tokenId`.
`pnpm dev` / `pnpm build` run `scripts/sync-deployment.mjs`, which validates `../../deployments/testnet-demo.json` and writes
`apps/web/.env` (git-ignored) with `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_API_URL` (from the environment,
default `http://localhost:4000`). The backend must allow the web origin in `CORS_ORIGINS`. An empty `NEXT_PUBLIC_API_URL` builds a demo-only app.
`pnpm deployment:check` compares the manifest with the chain.

**Before wallet actions are enabled for a market** (`lib/near/deployment.ts`) the app reads that market's `get_config`, `get_market`
and its token's `ft_metadata`, and requires them to agree with each other **and with the API** (token symbol/decimals, question, cutoff, every
trading parameter, schema 3, collateral token, market id). A mismatch disables that market only.

## Identities

| Name | Meaning |
| - | - |
| `marketRef` (`Market.id`) | frontend route, cache, watchlist and selection identity |
| `market.contract.contractId` | the contract that receives the wallet call |
| `market.contract.marketId` | the contract's own `market_id` argument (several contracts share `mkt-1`) |
| `market.contract.tokenId` | the collateral token contract |
| `offerRef` (`Offer.id`) / `Offer.offerId` | frontend identity / contract-local id, the only value sent to a contract |

Every transaction method takes the **Market** (`adapter.fillOffer(market, offer, qty)`), never a global "current market".
Deposits are per market contract; the wallet balance is per token and is counted once.

## Routes

`/` featured market + grid · `/markets` (filters in the URL) · `/markets/[marketRef]` · `/portfolio` · `/funds?market=<marketRef>`.

## Architecture

- `lib/api/` typed backend client (`client.ts`), response mapping (`map.ts`), SSE (`stream.ts`). Response types come from `@nearodds/types`; the few the shared package lacks are in `lib/api/types.ts` (to be moved there).
- `lib/near/` + `lib/wallet.ts` market-specific wallet adapter: chain views, preflight re-reads, wallet calls, final-outcome checks. The wallet connector is imported only in `lib/wallet.ts`.
- `lib/demo/` deterministic demo adapter. `lib/auth.ts` NEP-413 sign-in. `lib/faucet.ts` faucet claims with idempotency keys. `lib/app-context.tsx` session, data, stream and watchlist state.
- `components/{shell,discovery,trading,account,ui}`.

## Data sources

| Data | Source |
| - | - |
| Discovery, search, categories, prices, books, history, activity, portfolio | backend `/v1/*` (indexed; freshness, `coverage` and reconcile state are shown) |
| Market status and action flags, account balances, the selected offer, redemption preview | the market's own contract, re-read before anything is signed |
| Registration, deposit, withdraw, split/merge, create/fill/cancel, redeem | user's wallet (token `ft_transfer_call` 300 Tgas, market calls 100 Tgas, 1 yocto; registrations their own storage deposits) |
| Sign-in, watchlist, faucet | backend `/v1/auth/*`, `/v1/watchlist`, `/v1/faucet` |

Price display: `displayed` is a midpoint (or last trade) and is labelled with its `basis`; "last trade" only ever shows a confirmed fill; YES and NO books are separate.
24h movement is shown only when history is complete and a confirmed price from at least 24h ago exists. Partial history, indexer lag, API/RPC outages and
reconcile drift each have their own visible state; unavailable data is never replaced by zeros or fabricated charts.

Updates: one `/v1/stream` connection per connected account carries all markets (so new markets reach discovery even while another is open). Events only trigger REST refetches; every
`hello` (each connect/reconnect) refetches everything; a silent connection is reopened. The connection is closed and reopened when the account changes.

## Tests

- `pnpm test`: unit tests (client, mapping, stream, sign-in, faucet refusals, two-market adapter behaviour with a mocked wallet/RPC).
- `pnpm test:sandbox`: the real `NearAdapter` against the real contracts on a local Sandbox: two contracts sharing `mkt-1`, one token and offer id `1`; registration, deposits, split, offers, partial fill, cancel, cutoff, resolve, redeem, withdraw.
- `NEARODDS_LIVE=1 pnpm vitest run tests/chain-replay.live.test.ts`: read-only against the real backend and testnet.
- `pnpm e2e:integration`: browser flows against a stateful backend/chain **simulation** on separate origins (CORS), with a build-time test wallet (`NEXT_PUBLIC_E2E_WALLET=1`, absent from normal builds).
- `pnpm e2e` (demo build, `NEXT_PUBLIC_API_URL=` empty) and `node tests/e2e/live.mjs` (real backend + testnet, read-only; needs a build with the API URL served on :3000).

## Not verified

Real wallet (HOT/near-connect) signing was not run: the test wallet and the Sandbox harness sign with generated keys. See `docs/frontend-integration.md`.
