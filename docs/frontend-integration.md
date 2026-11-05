# Frontend integration status (apps/web, testnet demo market)

Scope: `apps/web` against the deployed persistent demo market (`deployments/testnet-demo.json`, verified deployment `462871b`).

## What is wired to the chain
- Config derived and validated from the manifest (`apps/web/scripts/sync-deployment.mjs`); on-chain agreement check at runtime (`get_config`, `get_market`, `ft_metadata`); transactions disabled on any mismatch.
- Token symbol/decimals from `ft_metadata` (`tNOC`, 6); tick, lot, min order, price bounds, max offers and storage costs from `get_config`.
- Registration on both contracts (token 0.00125 NEAR from `storage_balance_bounds`; market `storage_cost_per_account` = 0.04096 NEAR), deposit (`ft_transfer_call`, 300 Tgas, 1 yocto), market calls (100 Tgas, 1 yocto), withdraw with Pending shown as unconfirmed and never resent.
- Screens by `get_market().status`; redemption preview before `redeem`; Redeem vs Withdraw explained.
- Placeholder data removed: no category, creation date, volume, chart or activity for the live market; each is labelled unavailable. Trading cutoff (2026-11-11T23:00:00Z = 2026-11-12 00:00 WAT) shown separately from the observation period (parsed from the market's own rules text).

## Funding (accurate description)
No public faucet exists. Only the token owner (`nearodds-deploy.testnet`) can mint tNOC, by hand, with `scripts/testnet-mint.sh` (registers the wallet with the token first if needed). The Funds page shows the exact command for the connected account. Native testnet NEAR (fees, two storage deposits) comes from elsewhere; the app only reports the balance.

## Verification evidence
See the final report in the task hand-off; commands: `pnpm check`, `pnpm deployment:check`, `NEARODDS_LIVE=1 pnpm vitest run tests/chain-replay.live.test.ts`, `pnpm e2e` (demo build), `node tests/e2e/live.mjs` (live build).

## Remaining blocker
A real funded-wallet transaction run (and transaction hashes for new live actions) requires a signer for a registered and funded testnet account, which was not available to this session.
