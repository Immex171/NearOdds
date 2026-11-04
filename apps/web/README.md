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

| Feature | Demo adapter | NEAR adapter (Milestone 1 contract) |
| - | - | - |
| Markets list, categories, search, filters, sort, bookmarks | sample data | one real market from `get_market` (no price, no history) |
| Prices, order book, history, activity | simulated | **not available** (no price source on-chain) |
| Buy/sell, take/limit offers, cancel | simulated, balances stay consistent | disabled with an explanation |
| Deposit / withdraw | simulated | `ft_transfer_call` / `withdraw`, all receipts checked |
| Create / combine YES+NO (split/merge) | simulated | `split_position` / `merge_positions` |
| Register | n/a | `storage_deposit` on the market |
| Resolution / redeem | simulated | **not available** |

## Contract integration requirements (not implemented by the contract yet)

Offers (create/take/cancel, partial fills), a price/trade source or indexer for history and activity, resolution + redemption views, token-contract registration (`storage_deposit` on the token), and an event indexer for account activity. The contract was not modified.

## Not verified

Wallet behaviour on a real testnet, and the NEAR adapter against a live deployment, were **not** exercised (no deployed contract available here). The adapter's view/call shapes follow `docs/contract-interface.md`.
