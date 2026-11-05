# NearOdds web app

Next.js (App Router) + React + TypeScript (strict) + Tailwind CSS 4. Package manager: pnpm (workspace root is the repo root).

## Run

```bash
pnpm install                 # from the repo root
cd apps/web
pnpm dev                     # http://localhost:3000 — LIVE testnet data by default (see below)
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm start -p 3000 &         # then: pnpm e2e (demo journey) / node tests/e2e/live.mjs (live, read-only)
```

### Deployment configuration

Nothing is hardcoded and you do not write env files by hand. `pnpm dev` and `pnpm build` first run
`scripts/sync-deployment.mjs`, which derives `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_MARKET_CONTRACT_ID`,
`NEXT_PUBLIC_TOKEN_CONTRACT_ID` and `NEXT_PUBLIC_MARKET_ID` from `../../deployments/testnet-demo.json`, validates them
(testnet accounts, token/market/decimals/cutoff agree, schema 3, manifest verified) and writes `apps/web/.env` (git-ignored).
An explicit env value that disagrees with the manifest fails the run. `pnpm deployment:check` additionally compares the
manifest with the chain (`get_config`, `ft_metadata`, `get_market`, trading params and both code hashes).

At runtime (`lib/near/deployment.ts`) the app re-checks that `get_config`, `get_market`, `ft_metadata` and the configured IDs
agree (schema 3, collateral token, market id, resolver, 6 decimals). **If they do not, transactions stay disabled** and the header says why.
The token symbol and all trading limits (tick, lot, min order, price bounds, max offers, storage costs) come from the chain.
Unset the three contract IDs to build a demo-only app.

## Routes

`/` featured market + dense grid · `/markets` (filters in the URL: `category`, `status`, `period`, `tag`, `saved`, `q`, `sort`, `view=new`) · `/markets/[marketId]` detail + trade ticket · `/portfolio` · `/funds`.

## Architecture

- `lib/types.ts` — `DataAdapter` interface and domain types. UI never names a contract method.
- `lib/demo/` — **Demo adapter**: 20 deterministic markets, books, history, positions and offers on a fixed demo clock (`DEMO_NOW`). State persists in `localStorage`; **Reset demo** restores it.
- `lib/near/` + `lib/wallet.ts` — **NEAR adapter**: RPC views and wallet-signed calls (`@hot-labs/near-connect`, only imported in `lib/wallet.ts`). Capabilities (`NEAR_CAPABILITIES`) gate what the UI enables.
- `lib/amounts.ts` — bigint fixed-point (6 decimals); no floats for money. `lib/quote.ts` — order-book walking. `lib/filters.ts` — filter/sort logic.
- `components/{shell,discovery,trading,account,ui}` — responsibility-based components.

## Demo vs live

Live testnet data is the default whenever the deployment is configured. **Demo mode is only entered explicitly** ("Use demo account"), shows an orange banner and `TEST` labels, and can be left with "Switch to live testnet".

| Feature | Demo adapter | NEAR adapter (contract schema v3) |
| - | - | - |
| Market | 20 sample markets with categories, volume, history | the one real market from `get_market`. **No category, creation date, volume or history is shown: the contract has none** |
| Order book and quotes | simulated | **live** `list_offers` for both outcomes/sides, every page, read at one pinned final block, sorted by price; fills use the offer's real id |
| Take (partial) / limit offers / cancel | simulated | `fill_offer`, `create_offer`, `cancel_offer` (100 Tgas, 1 yoctoNEAR) |
| Registration | n/a | token `storage_deposit` (0.00125 NEAR, read from `storage_balance_bounds`) and market `storage_deposit` (`storage_cost_per_account`, 0.04096 NEAR), each a separate wallet transaction |
| Deposit | simulated | token `ft_transfer_call` to the market, `msg` from `get_config`, 1 yoctoNEAR, **300 Tgas**; result = the amount the market accepted (a refund is reported as such) |
| Withdraw | simulated | `withdraw` (100 Tgas); `Pending` is shown as **unconfirmed** and is never resent |
| Split / merge | simulated | `split_position` / `merge_positions`, gated by the contract's `split_open` / `merge_open` flags |
| Screens by status | by sample status | decided by `get_market().status`: **Open** = trade ticket; **AwaitingResolution** = "Trading has ended" (cancel, withdraw and merge stay available); **Resolved** = result + redemption preview + Redeem |
| Redeem | simulated | `get_redemption_preview` then `redeem`; credits **internal** available collateral. Withdraw is a separate step |
| Price, headline probability, chart, activity | simulated | **unavailable** (explicitly labelled): no trade source or indexer exists |
| Funding tNOC | n/a | owner-operated: only the token owner can mint, with `scripts/testnet-mint.sh`. **There is no public faucet.** The Funds page shows the exact command for your account |

Every live transaction is signed in the user's wallet. After the wallet returns, the app asks the chain for the **final** outcome
(`tx`, `wait_until: FINAL`), fails on any failed receipt, and re-reads contract state before saying "confirmed".

Trading rules enforced in the UI (and by the contract): tick/lot/min-order/price bounds from `get_config().trading`, at most
`max_open_offers_per_account` open offers, no self-fills. A missing offer means "no active offer record" (filled, cancelled or released).

## Tests

- `pnpm test` — unit tests: amounts, quoting, limits, manifest derivation/validation, deployment agreement, market mapping, receipt parsing, and `tests/adapter.test.ts` (every transaction's receiver, method, args, deposit and gas; failure/pending/refund handling; pagination at one block) with a mocked wallet and RPC.
- `NEARODDS_LIVE=1 pnpm vitest run tests/chain-replay.live.test.ts` — read-only: replays real testnet transactions from the manifest through the parsing code and reads the real book and accounts.
- `pnpm e2e` — demo journey in Chrome (build with the three contract IDs empty, see the report in `docs/frontend-integration.md`); `node tests/e2e/live.mjs` — live testnet, read-only, plus **fixture** Awaiting/Resolved screens (real RPC responses with `get_market` rewritten).

## Not verified

A funded-wallet journey (register, deposit, trade, limit offer, cancel, split/merge, withdraw, redeem) against the deployed contracts through a real wallet has **not** been run from here. See `docs/frontend-integration.md`.
