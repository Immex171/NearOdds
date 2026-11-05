# Frontend handoff: NearOdds contracts (Milestone 3)

**Deployed and verified on NEAR testnet (2026-11-05).** Read the IDs from **`deployments/testnet-demo.json`** (never from
`deployments/testnet.json`: those smoke-test accounts were deleted). Full evidence: `docs/testnet.md`.

## Fixed facts (persistent demo market)

| Item | Value |
| - | - |
| Network | NEAR testnet; RPC `https://test.rpc.fastnear.com` (`rpc.testnet.near.org` is deprecated and rate-limited) |
| **Market contract** | `mkt-demo-3879869.nearodds-deploy.testnet` |
| **Collateral token contract** | `tok-demo-3879869.nearodds-deploy.testnet` |
| **Resolver** (and token owner, deployer) | `nearodds-deploy.testnet` (only this account can resolve and mint) |
| Market id (argument to calls) | `mkt-1` |
| Question | Will it rain in Lagos on 2026-11-12? |
| Observation / source | 2026-11-12 00:00 WAT to 2026-11-13 00:00 WAT (UTC+1) / NiMet daily weather report, Lagos, 2026-11-12. The contract enforces only the trading cutoff; the trusted resolver must wait for the report (docs/testnet.md, "Timing"). |
| **Trading cutoff** | `2026-11-11T23:00:00Z` = 2026-11-12 00:00 WAT, `1794438000000000000` ns. Immutable; the market is `Open` until then |
| Token metadata (read it, do not hardcode) | name `NearOdds TEST Collateral (no value)`, symbol **`tNOC`**, **6 decimals**; 1 token = `"1000000"` base units. Call `ft_metadata` on the token. Label amounts with the returned symbol and keep a visible "test token, no value" notice (the name says TEST; the symbol is `tNOC`, not `TEST`) |
| Contract schema | 3 |
| Code hashes (on-chain base58 / sha256 hex) | market `D87VzcAmR32hXwqUcwZfRvrC7HLHXREoSTjmsHwsezon` / `b41ea88129be572c3f3c48e4fcaec31afa12aca4d49c97cf237bea88f4f22d45`; token `3csjd1rDuCq3vtAcffZbsawyKRQuT8y2GMDmPhbdQV98` / `26e81178403522a377ff4039c75923e95bbc0341aa1ae767699910532da25ddf` |
| Deployed commit | `462871b` (clean tree; contract sources unchanged since `7d50c6c`) |

Other accounts in the manifest: liquidity provider `lp-demo-3879869.nearodds-deploy.testnet` (owns the seeded offers), probe trader `probe-demo-3879869.nearodds-deploy.testnet`.
Seeded book (all `fillable`): sell YES 10 each @0.65 / 0.70 / 0.75, sell NO 10 each @0.35 / 0.40, bid YES 10 each @0.55 / 0.50.

Verify a deployment: `view_account` code hash of the market must equal the value above.

## Interface

* Methods, arguments, units, events and errors: **`docs/contract-interface.md`** (Milestone 1 to 3 sections).
* Shared types: **`packages/types/src/market.ts`** (`@nearodds/types`). All amounts are decimal strings in base units.
* Decide screens from `get_market().status` (`Open` / `AwaitingResolution` / `Resolved`); read `get_config().trading` for
  tick (`10000`), lot (`100`), min order (`10000`), max 10 open offers; use `get_redemption_preview` for the Redeem panel.

## Registration deposits (tested on testnet)

| Where | Call | Attach | Notes |
| - | - | - | - |
| Token | `storage_deposit {"account_id": "<user>", "registration_only": true}` | `1250000000000000000000` yoctoNEAR (0.00125 NEAR; anything above is refunded) | tested with 0.01 NEAR |
| Market | `storage_deposit {"account_id": null, "registration_only": true}` | `get_config().storage_cost_per_account` = `40960000000000000000000` (0.04096 NEAR; excess refunded) | prepays the account, a pending withdrawal and 10 open offers |

Both are needed before depositing; the token registration is also needed before withdrawing.

## Tested attached gas (all exercised on testnet by the smoke run)

| Call | Receiver | Gas used by the harness | Deposit |
| - | - | - | - |
| `ft_transfer_call` (deposit, `msg: "deposit"`) | token | 300 Tgas | exactly 1 yoctoNEAR |
| `split_position`, `merge_positions`, `create_offer`, `fill_offer`, `cancel_offer`, `redeem` | market | 100 Tgas | exactly 1 yoctoNEAR |
| `withdraw` | market | 100 Tgas (contract refuses under 45) | exactly 1 yoctoNEAR |
| `storage_deposit` | token / market | default | amounts above |

Measured burn: `redeem` 6.9 Tgas with ten open offers (2.1 with none).

## Funding a test wallet with TEST collateral

Only the token owner can mint. A user must first be registered with the token (the mint script does it).

```bash
NEARODDS_TESTNET_PARENT=nearodds-deploy.testnet \
NEARODDS_TOKEN=<accounts.token from deployments/testnet-demo.json> \
NEARODDS_MINT="your-wallet.testnet:100" \
  bash scripts/testnet-mint.sh
```

(tested on testnet; prints the transaction and the resulting token balance). For the demo market set `NEARODDS_TOKEN` to the token ID above. The user then registers with the market and
deposits with `ft_transfer_call`. There is no public faucet button, so the UI should explain this.

## Resolving the market (resolver only, after the cutoff)

```bash
NEARODDS_TESTNET_PARENT=nearodds-deploy.testnet \
NEARODDS_MARKET=<accounts.market> NEARODDS_OUTCOME=Yes \
NEARODDS_EVIDENCE="<link to the source named in resolution_source>" \
  bash scripts/testnet-resolve.sh
```

(tested on testnet). It refuses unless `get_market().status` is `AwaitingResolution` and the signer is the resolver.
Resolution is final and cannot be changed; there is no VOID or dispute.

## `redeem` vs `withdraw` (explain this in the UI)

* **`redeem`** settles a position after resolution. It cancels the user's open offers, burns their shares, and credits
  winning shares 1:1 to their **internal** `available_collateral` inside the market contract. **No tokens move.**
  `payout` is only the winning payout; collateral released from cancelled buy offers is shown separately.
* **`withdraw`** is a separate step that transfers internal available collateral to the user's token wallet through the
  token contract. It is asynchronous: show `Pending` as unconfirmed, `Completed` as paid, `FailedRestored` as
  "returned to your available balance". A `Pending` withdrawal that never settles needs no retry (see
  `docs/contract-interface.md`, "Displaying withdrawals").
