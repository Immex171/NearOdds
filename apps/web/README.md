# NearOdds web app

Next.js (App Router) + React + TypeScript (strict) + Tailwind CSS 4. Package manager: pnpm (workspace root is the repo root).

## Run

```bash
pnpm install                 # from the repo root
cd apps/web
pnpm dev                     # http://localhost:3000  (demo mode, no env needed)
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm start -p 3000 &         # then: pnpm e2e   (Playwright-core + system Chrome, demo journey)
```

Live testnet mode is optional: copy `.env.example` to `.env.local` and fill `NEXT_PUBLIC_MARKET_CONTRACT_ID`, `NEXT_PUBLIC_TOKEN_CONTRACT_ID`, `NEXT_PUBLIC_MARKET_ID`. Nothing is hardcoded.

## Routes

`/` featured market + dense grid · `/markets` (filters in the URL: `category`, `status`, `period`, `tag`, `saved`, `q`, `sort`, `view=new`) · `/markets/[marketId]` detail + trade ticket · `/portfolio` · `/funds`.

## Architecture

- `lib/types.ts` — `DataAdapter` interface and domain types. UI never names a contract method.
- `lib/demo/` — **Demo adapter**: 20 deterministic markets, books, history, positions and offers on a fixed demo clock (`DEMO_NOW`). State persists in `localStorage`; **Reset demo** restores it.
- `lib/near/` + `lib/wallet.ts` — **NEAR adapter**: RPC views and wallet-signed calls (`@hot-labs/near-connect`, only imported in `lib/wallet.ts`). Capabilities (`NEAR_CAPABILITIES`) gate what the UI enables.
- `lib/amounts.ts` — bigint fixed-point (6 decimals); no floats for money. `lib/quote.ts` — order-book walking. `lib/filters.ts` — filter/sort logic.
- `components/{shell,discovery,trading,account,ui}` — responsibility-based components.

## Demo vs live

| Feature | Demo adapter | NEAR adapter (contract schema v3) |
| - | - | - |
| Markets, categories, search, filters, sort, bookmarks | sample data | the one real market from `get_market` (status, resolver, resolution) |
| Order book | simulated, per-offer ids | **live**: `list_offers` for both outcomes/sides, read at one pinned final block |
| Take (partial) / limit offers / cancel | simulated, balances stay consistent | **live**: `fill_offer`, `create_offer`, `cancel_offer` (not exercised against a deployment) |
| Deposit / withdraw / split / merge / register | simulated | **live** (`ft_transfer_call`, `withdraw`, `split_position`, `merge_positions`, `storage_deposit`) |
| Redeem | simulated | **live**: `get_redemption_preview` then `redeem` (credits internal collateral; withdraw afterwards) |
| Resolve market | n/a | not in the UI (resolver-only; not a participant action) |
| Prices, headline probability, chart history, activity | simulated | **unavailable**: no price/trade source or indexer exists |
| Wrong-network detection | n/a | heuristic only (`.near` account while configured for testnet) |

Trading rules enforced in the UI (and by the contract): 0.01 price tick (0.01 to 0.99), 100-base-unit lot (0.0001 share),
0.01-share minimum for limit offers, at most 10 open offers, no self-fills, cancellation always allowed. A missing offer
means "no active offer record" (filled, cancelled or released), not a specific outcome.

## Not verified

Wallet behaviour on a real testnet, and the NEAR adapter against a live deployment, were **not** exercised (no deployed contract available here). The adapter's view/call shapes follow `docs/contract-interface.md`.
