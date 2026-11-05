# NearOdds trading bot (testnet market maker)

A project-owned bot that quotes **fully funded onchain limit offers** (`create_offer`) in explicitly selected, existing markets. It trades only its **own** funds from a dedicated account; it never touches users' wallets or keys.
The keeper creates markets; the bot never does. Code: `apps/backend/src/trading-bot/`; worker `pnpm bot:worker` (`src/entry/trading-bot.ts`); admin API `/v1/admin/trading-bots`.

> The reference price is a **strategy input** set by an administrator. The bot does not estimate the probability of any event.

## Safety defaults
| Setting | Default |
| - | - |
| Mode | `paper`: reads state and records proposed actions; **signs and broadcasts nothing** |
| Desired state | `disabled` until an administrator starts it |
| Execution | needs mode `execute` **and** `BOT_EXECUTION_ENABLED=true` **and** network `sandbox`/`testnet` (equal to the worker's `NEAR_NETWORK`) **and** a verified signer |
| Persistence | the requested state lives in PostgreSQL: a restart never re-enables a paused/stopped/disabled bot |

## Dedicated account and credentials
* `BOT_ACCOUNT` / `BOT_CREDENTIALS_FILE` (a near-cli credentials JSON). Per bot, `credentialsEnv` names the environment variable that holds the file path (default `BOT_CREDENTIALS_FILE`). Secrets are read by the worker only; the API reports `credentialsConfigured: true|false`.
* The bot account must **differ** from the deployer, resolver and token-owner accounts (refused at creation and at signing).
* The worker verifies that the key is a current **full-access** key of the bot account (payable contract calls need it). Missing/invalid credentials => state `setup_required`.
* Funding is the project's: the token owner mints test collateral to the bot account; native NEAR comes from the project's own accounts. The bot never creates faucet accounts.

## Configuration (versioned)
`POST /v1/admin/trading-bots` / `PUT .../:id/config` take (all amounts are base-unit decimal strings, prices are collateral base units per whole share, 6 decimals):
```jsonc
{
  "markets": [{ "marketRef": "m_…", "enabled": true,
     "reference": { "yesPrice": "500000", "label": "...", "source": "...", "asOf": "ISO", "expiresAt": "ISO" } }],
  "strategy": { "spread": "50000", "quantityPerQuote": "10000000", "quoteLifetimeSeconds": 3600, "requoteThresholdPct": 50, "refreshBeforeExpirySeconds": 30 },
  "funding":  { "trancheId": 1, "depositCollateral": "20000000", "splitCollateral": "10000000" },
  "limits": { "maxOrderQuantity", "maxYesInventory", "maxNoInventory", "maxCollateralPerMarket", "maxCollateralTotal",
              "maxActiveOffersPerMarket", "maxNativeSpendYocto", "minNativeReserveYocto", "estimatedTxFeeYocto",
              "maxTransactionsPerMinute", "referenceMaxAgeSeconds", "maxChainDataAgeSeconds", "cutoffBufferSeconds" }
}
```
Each change creates a new immutable version. Operations already proposed keep the version recorded on them; new decisions use the new one. A proposal made under an older version is refused (`config_changed`).

## Strategy: four funded quotes
Per enabled market the bot keeps at most one offer in each slot: `YES_BUY`, `YES_SELL`, `NO_BUY`, `NO_SELL`.
* `referenceNo = priceScale - referenceYes`; bids = reference − spread, asks = reference + spread.
* Price scale, tick, lot, min/max price, minimum order and max open offers come from `get_config().trading` (never hard-coded).
* Bids round **down** to a tick, asks **up**. Required: bid < ask per outcome; YES bid + NO bid ≤ scale; YES ask + NO ask ≥ scale. Legs outside `[min_price, max_price]` are skipped with a recorded reason.
* Quantities are floored to the lot, capped by `maxOrderQuantity`, and must reach the minimum order.
* No reference / expired / older than `referenceMaxAgeSeconds` => no new quotes and existing quotes are cancelled.
* **No churn:** a quote is replaced only if it expired or is about to (`refreshBeforeExpirySeconds`), its price differs from the target, it exceeds current limits, it is below `requoteThresholdPct` of the size the bot may now offer (e.g. after a partial fill), or it duplicates a slot. Cancellations are confirmed and chain state re-read **before** released assets are reused. A replacement is sized by what the bot actually holds, never blindly at full size.
* Offer expiry = `min(now + quoteLifetime, cutoff − cutoffBuffer)` (chain time).
* Unexpected offers already owned by the account are adopted: they count toward exposure and are cancelled/replaced if they do not match the slot.

## Funding and inventory
Setup runs stepwise and is journaled (stable operation ids), so a restart never repeats it: register with the token (`storage_balance_bounds().min`), register with the market (`get_config().storage_cost_per_account`), `ft_transfer_call` deposit (`funding.depositCollateral`), `split_position` (`funding.splitCollateral`). A deposit/split runs once per `funding.trancheId`; bump the tranche in a new config version to top up. Deposits are bounded by `maxCollateralPerMarket`, `maxCollateralTotal` and the bot's token balance.
* Sell offers reserve **existing** shares; buy offers reserve **available** internal collateral. Reserved assets are never reused. Expected proceeds of unfilled sells are not spendable.
* Native NEAR (fees, registration deposits) is separate from collateral: spending is capped by `maxNativeSpendYocto`, and the balance must stay above `minNativeReserveYocto`. Spend is recorded from the transaction journal, so a crash cannot lose the record.
* No automatic redemption or withdrawal. After resolution the bot stops quoting, cancels leftovers, and reports its positions plus `get_redemption_preview` (what redeem would pay) for a manual wallet step.

## Limits and commitments (chain views authorise spending)
Every cycle reads **one coherent finalized block** (config, market, account, offers, token and native balances) and never trusts the indexer's cached balances. Checked limits: quantity per order; YES/NO inventory (owned = available + reserved; open buys may acquire more); collateral per market and in total; active offers (including unexpected ones); native spend and reserve; transactions per minute; reference freshness; chain-data age; cutoff buffer. Proposed work is reserved **atomically** per bot (advisory lock): pending operations, token-balance, native-balance and spend limits are re-checked together, so concurrent workers cannot allocate the same budget twice. A quote that would exceed a limit is reduced to a permitted size or skipped, and the reason is recorded.

## Recovery and duplicate prevention
`bot → market → config version → slot/generation → operation id (op_key) → tx_hash → confirmed offer id` is persisted (`bot_operations`, `bot_quotes`, `tx_journal`).
* Operation ids are stable (`bot:<bot>:<marketRef>:create:<slot>:g<n>` …). Signed bytes and hash are stored before broadcast (shared transaction executor); a timeout leaves the operation `uncertain` and it is **reconciled, never re-created**. The signer's transactions are broadcast strictly by nonce across all markets.
* After a crash following a successful `create_offer`, the journal outcome supplies the offer id and the offer is recovered instead of placed again.
* A missing offer is not assumed filled: `bot_quotes.state` is `filled`/`cancelled` only when confirmed (events or its own cancel), otherwise `gone_unconfirmed`. Offer ids are contract-local; everything is keyed by `marketRef`.
* One owner per bot/market: a job lease plus a session advisory lock; a second worker defers.

## Pause and stop
`POST .../pause|stop` immediately sets the desired state (persisted), cancels operations that were proposed but never signed, and refuses new proposals. Signed operations are reconciled; the worker then cancels the bot's open offers (they can still be filled until the cancellation is effective). State is **`pausing`/`stopping` until nothing is unresolved**, `uncertain` if an outcome is unknown. Stop quoting also happens automatically `cutoffBufferSeconds` before the cutoff; after the cutoff or resolution the worker keeps reconciling and cancelling and reports retained shares.

## Operating states
`disabled`, `paper`, `running`, `pausing`, `paused`, `stopping`, `stopped`, `uncertain`, `needs_funding`, `setup_required`.

## Administrator API (all routes need an admin session; CORS preflight supported)
| Route | Purpose |
| - | - |
| `GET /v1/admin/trading-bots` | list |
| `POST /v1/admin/trading-bots` | create `{slug, accountId, network, credentialsEnv?, config}` (paper, disabled) |
| `GET /v1/admin/trading-bots/:id` | status (below) |
| `PUT /v1/admin/trading-bots/:id/config` | new config version |
| `POST /:id/preview` | proposed quotes, **no trading** |
| `POST /:id/start` `{mode:"paper"\|"execute"}` | `409 execution_disabled / network_not_allowed / setup_required` when not permitted |
| `POST /:id/pause`, `/stop` | see above |
| `GET /:id/orders\|fills\|decisions\|operations` | histories (`?limit=`) |

Types: `ApiBotStatus`, `ApiBotPreview`, `ApiBotConfigInput`, … in `@nearodds/types` (`backend-api.ts`). Status example (trimmed):
```json
{ "id": "1", "slug": "mm-lagos", "account": { "accountId": "nearodds-bot.testnet", "network": "testnet", "credentialsConfigured": true },
  "mode": "execute", "desiredState": "running", "state": "running", "configVersion": 3,
  "markets": [{ "marketRef": "m_c01f…", "contract": { "contractId": "mkt-….testnet", "marketId": "mkt-1", "tokenId": "tok-….testnet" },
     "reference": { "yesPrice": "500000", "noPrice": "500000", "label": "…", "expiresAt": "…", "expired": false },
     "balances": { "collateral": { "available": "1000000", "reserved": "9000000" }, "shares": { "yes": { "available": "0", "reserved": "10000000" }, "no": { "available": "0", "reserved": "10000000" } } },
     "openQuotes": [{ "offerId": "1", "offerRef": "m_c01f…:1", "slot": "YES_BUY", "price": "450000", "remaining": "10000000" }],
     "lastChainRead": { "at": "…", "blockHeight": 276400000 },
     "lastDecision": { "outcome": "noop", "reasons": [{ "code": "operations_in_flight", "message": "…" }] } }],
  "pendingOperations": [], "spending": { "nativeSpentYocto": "42210000000000000000000", "nativeLimitYocto": "5000000000000000000000000" } }
```
Frontend: render `state` with `stateReason`; show `reasons[].code/message` for skipped/paused decisions; format amounts with the market token's decimals; show `lastChainRead` age. Browser calls need `Authorization: Bearer <admin session>` and (for PUT/POST) `Content-Type: application/json`; preflight from the configured origin is answered.

## Controlled testnet procedure (bounded)
Prerequisites: a bot account (e.g. `nearodds-bot.testnet`) created and funded by the project (≈2 NEAR native), its credentials JSON on the worker host, test collateral minted to it by the token owner (≥ the deposit), the target market already in the registry (the demo, or one the keeper created).
1. Worker env: `NEAR_NETWORK=testnet`, `BOT_CREDENTIALS_FILE=/secure/path/nearodds-bot.testnet.json`, keep `BOT_EXECUTION_ENABLED=false` for now.
2. `POST /v1/admin/trading-bots` with the explicit `marketRef`, a small config (e.g. deposit 20, split 10, quantity 10, spread 0.05, a reference with a short expiry) → bot is `disabled`/paper.
3. `POST …/preview` and `…/start {"mode":"paper"}`; inspect `/decisions` for what it *would* do (register, deposit, split, four quotes) and the numbers.
4. Enable execution: set `BOT_EXECUTION_ENABLED=true`, restart `pnpm bot:worker`, then `POST …/start {"mode":"execute"}`.
5. Watch `/operations` (tx hashes), `/orders`, `/fills`; stop with `POST …/stop` (state stays `stopping` until its offers are cancelled).
Nothing in this procedure creates faucet accounts; limits (`maxCollateralTotal`, native spend) bound the exposure.
