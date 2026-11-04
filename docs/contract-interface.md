# NearOdds market contract interface (Milestone 1)

Crate `nearodds-market`; compiled to one Wasm. Amounts are `U128` decimal
strings in base units (6 decimals: `"1000000"` = 1 token/share). Timestamps are
`U64` nanoseconds. "1 yocto" means exactly 1 yoctoNEAR attached — a full-access-key
authorization step that is kept by the contract and is **not** collateral.

Not implemented (and not stubbed): market creation, resolution, redemption,
unregistration, `storage_withdraw`, upgrades or admin refunds. Trading is described in
"Milestone 2" below. The
storage methods are a *subset* of NEP-145; full compliance is not claimed.

## Initialization

`new(collateral_token: AccountId, market_id: String, question: String, rules: String, split_cutoff_ns: U64)` — `#[init]`, once.
`market_id` 1–64 bytes; `question` 1–512; `rules` ≤ 2048; cutoff must be in the future.
Terms are immutable afterwards. Deploy and init in one batch transaction.

## Registration (payable)

`storage_deposit(account_id?: AccountId, registration_only?: bool) -> {total, available}`
Attach ≥ `get_config().storage_cost_per_account` (Milestone 2: 4096 bytes of storage, i.e. 0.04096 NEAR; it prepays the account record, a pending-withdrawal record and 10 open offers). Registers `account_id`
(default caller). Excess is refunded to the caller; if already registered the
whole deposit is refunded. Underpayment panics. `registration_only` is accepted
for shape only.

`storage_balance_of(account_id) -> {total, available} | null` ·
`storage_balance_bounds() -> {min, max}`

## Deposit receiver

`ft_on_transfer(sender_id, amount: U128, msg: String) -> U128` (unused amount)
Caller must be the approved token (else panic). `msg` must be `"deposit"`.
Returns `"0"` when accepted, or the full amount when rejected (bad msg,
unregistered, zero, overflow). Credits `sender_id` only. No attached deposit.
Deposit flow: `token.ft_transfer_call(receiver_id=market, amount, msg="deposit")` with 1 yocto.

## Complete sets (payable, 1 yocto, caller = predecessor)

`split_position(market_id: String, amount: U128)` — before the cutoff only.
`merge_positions(market_id: String, amount: U128)` — any time.
Both reject zero, unknown market, insufficient funds/shares, overflow.

## Withdrawals

`withdraw(amount: U128) -> Promise` — payable, **1 yocto** (forwarded to the
token's `ft_transfer`), ≥ 45 Tgas prepaid. Caller must be registered with the
market *and* with the token. One pending withdrawal per account.
Reserved gas: 15 Tgas for `ft_transfer`, 10 Tgas for the callback.
`on_withdraw_complete(account_id, withdrawal_id: U64) -> "Completed" | "FailedRestored"` —
**private**, not callable by users.

## Views

| Method | Returns |
| - | - |
| `get_config()` | `schema_version, collateral_token_id, market_id, deposit_msg, decimals, storage_cost_per_account` |
| `get_market(market_id)` | terms, `split_cutoff_ns`, `split_open`, outstanding YES/NO, `market_backing` |
| `get_account(account_id)` | `null` if unregistered; else `storage_deposit, available_collateral, yes, no, pending_withdrawal` |
| `get_position(account_id, market_id)` | `yes, no` (zeros if unregistered) |
| `get_totals()` | `available_collateral, market_backing, outstanding_yes, outstanding_no, pending_withdrawals, registered_accounts, settled_escrow_requirement` — **internal counters, not a token balance** |
| `get_withdrawal(account_id)` | pending one (`status: "Pending"`), else the last settled (`"Completed"`/`"FailedRestored"`), else `null` |

## Events (NEP-297, standard `nearodds_market`, version `1.0.0`)

`storage_registered`, `deposit`, `split`, `merge`, `withdrawal_requested`,
`withdrawal_completed`, `withdrawal_failed_restored`. Fields: `account_id`,
`market_id`/`token_id` where relevant, `withdrawal_id`, `amount` (base units).
`withdrawal_requested` does **not** mean the wallet was paid. Indexers must only
use events from successful finalized receipts and must treat a request without
a later `withdrawal_completed` / `withdrawal_failed_restored` as unresolved.

## Panic messages (stable strings)

See `contracts/market/src/errors.rs`.

## Test fixture token (`test-collateral`)

Standard NEP-141 + NEP-145 (`near-contract-standards`), 6 decimals, name
`NearOdds TEST Collateral (no value)`, symbol `tNOC`. `new(owner_id)`;
`mint(account_id, amount)` is owner-only and exists only on the fixture.

---

# Milestone 2 — Trading (implemented)

Fully funded, fixed-price, onchain offers on the single market. Trading moves **existing**
shares and **internal** collateral between accounts inside this contract; it never calls
another contract, never mints shares, and never touches the market backing. Deposits and
withdrawals remain the only token transfers. **Trading fees are zero.**

Schema version is now `2`. Share and collateral balances are split into *available* and *reserved*.

## Units, precision and limits

Read these from `get_config().trading`; never hardcode them in the UI.

| Item | Value | Meaning |
| - | - | - |
| Collateral / share decimals | 6 | `"1000000"` = 1 token / 1 share |
| `price_scale` | `1000000` | Price is collateral base units per **one whole share** |
| `price_tick` | `10000` | Price must be a multiple of 0.01 collateral |
| `min_price` / `max_price` | `10000` / `990000` | 0.01 to 0.99 per share |
| `quantity_lot` | `100` | Quantity (share base units) must be a multiple of 100 |
| `min_order_quantity` | `10000` | Smallest offer is 0.01 share |
| Minimum fill | one lot (`100`) | A fill is any positive multiple of the lot up to the remaining quantity |
| `max_open_offers_per_account` | `10` | Storage for these is prepaid at registration |
| `fee_bps` | `0` | No fees |

**Cost of a fill** = `quantity * price / 1_000_000`. With the tick and lot above, the
division is **always exact** (`100a * 10000b = 1_000_000ab`). So there is no rounding and no
dust, and one big fill costs exactly the same as the same quantity in many small fills. The
buy-offer reservation equals the sum of all its possible fills plus its release.
Examples: 20 shares (`"20000000"`) at `"600000"` costs `"12000000"`; 100 units at price `"10000"` costs `"1"` base unit.

Milestone 1's one-base-unit split/merge/withdraw precision is unchanged; only trading has the lot.

## Balances

`get_account`, `get_position` and `get_totals` expose reserved amounts. Existing names keep their
Milestone 1 meaning: `available_collateral`, `yes`, `no` are the **available** (spendable,
mergeable, withdrawable) amounts.

```json
{
  "account_id": "alice.testnet", "storage_deposit": "40960000000000000000000",
  "available_collateral": "7800000", "reserved_collateral": "0",
  "yes": "87000000", "reserved_yes": "0",
  "no": "100000000", "reserved_no": "0",
  "open_offer_ids": [],
  "pending_withdrawal": null
}
```

* Sell offers lock **shares** (`reserved_yes` / `reserved_no`); Buy offers lock **collateral**
  (`reserved_collateral`). Reserved amounts cannot be offered again, merged, split, or withdrawn.
* Share supply (`outstanding_yes/no`) includes reserved shares. `market_backing` never changes while trading.
* `get_totals()` adds `reserved_collateral`, `reserved_yes`, `reserved_no`, `open_offers`.
  `settled_escrow_requirement = available_collateral + reserved_collateral + market_backing`.

## Methods

All three are `#[payable]`: attach **exactly 1 yoctoNEAR** (an authorization step, not collateral).
The acting account is always `predecessor_account_id`. They are single-receipt and synchronous:
when the transaction's final status is `SuccessValue` the ledger change is final and the JSON
result below is the return value. Recommended gas: 50 Tgas. No storage deposit is attached
(it was prepaid at registration).

### `create_offer`

| Argument | Type | Notes |
| - | - | - |
| `market_id` | string | Must equal the configured market id |
| `outcome` | `"Yes"` \| `"No"` | |
| `side` | `"Buy"` \| `"Sell"` | The maker's side |
| `price` | `U128` string | Tick multiple in [min_price, max_price] |
| `quantity` | `U128` string | Share base units; lot multiple, >= `min_order_quantity` |
| `expires_at_ns` | `U64` string, optional | Must be in the future. Trading also ends at the market cutoff |

Returns an `OfferView` (below). `Sell` reserves `quantity` available shares of `outcome`; `Buy` reserves
`quantity * price / 1e6` available collateral. Allowed only before the cutoff.

### `fill_offer`

| Argument | Type | Notes |
| - | - | - |
| `offer_id` | `U64` string | Opaque id from `create_offer`, `list_offers` or events |
| `quantity` | `U128` string | Share base units to trade: positive multiple of the lot, <= remaining |

The **caller is the taker**. Filling a `Sell` offer: taker pays `cost` collateral and receives shares.
Filling a `Buy` offer: taker gives shares and receives `cost` collateral. The price is the offer's
fixed price (no slippage). Returns `FillResult`. Offers are removed once fully filled.

### `cancel_offer`

`offer_id: U64`. Maker only. Releases exactly the unfilled remainder (shares for Sell,
`remaining * price / 1e6` collateral for Buy), removes the offer, returns `CancelResult`. Allowed at
**any** time, including after expiry or the trading cutoff, so reserves can always be recovered.

### Views

| Method | Returns |
| - | - |
| `get_offer(offer_id)` | `OfferView` or `null` (never existed, fully filled, or cancelled) |
| `list_offers(market_id, outcome, side, from_index?, limit?)` | `OfferView[]` for one (outcome, side). `from_index` default `"0"`, `limit` default 20, max 50. Order is storage order, **not** price order: sort in the client. Page by increasing `from_index` until fewer than `limit` come back |
| `get_account_offers(account_id)` | `OfferView[]` (at most 10) |
| `get_account`, `get_position`, `get_totals` | include reserved amounts (see above) |
| `get_config().trading` | the table above |
| `get_market` | also `trading_cutoff_ns` and `trading_open` (the same instant as `split_cutoff_ns`) |

## Offer lifecycle

| State | Where it is visible | Meaning |
| - | - | - |
| `Open` | views | Created, nothing filled, fillable |
| `PartiallyFilled` | views | `filled_quantity > 0`, remainder still fillable |
| `Expired` | views | `expires_at_ns` passed **or** trading closed. Not fillable (`fillable: false`); the owner can still cancel to release the remainder |
| Filled | `FillResult.status = "Filled"` and the `offer_filled` event with `remaining_quantity = "0"` | Fully filled; the offer is **removed**, `get_offer` returns `null` |
| Cancelled | `cancel_offer` result and `offer_cancelled` event | Remainder released; the offer is **removed** |

Terminal offers are removed so the contract's storage stays bounded and funded. Use events (or the
method results) for history. Offer ids are never reused.

## Result and view shapes (JSON)

```json
// OfferView
{ "offer_id": "4", "market_id": "mkt-1", "owner_id": "alice.testnet",
  "outcome": "Yes", "side": "Sell", "price": "600000",
  "quantity": "20000000", "filled_quantity": "8000000", "remaining_quantity": "12000000",
  "reserved_collateral": "0", "reserved_shares": "12000000",
  "expires_at_ns": null, "created_at_ns": "1762272000000000000",
  "status": "PartiallyFilled", "fillable": true }

// FillResult
{ "offer_id": "4", "quantity": "8000000", "collateral_amount": "4800000",
  "remaining_quantity": "12000000", "status": "PartiallyFilled" }   // or "Filled"

// CancelResult   (Sell: released_shares > 0; Buy: released_collateral > 0)
{ "offer_id": "4", "remaining_quantity": "7000000",
  "released_collateral": "0", "released_shares": "7000000" }
```

Example calls (amounts are base units; 1 yoctoNEAR attached):

```json
{ "method": "create_offer", "args": { "market_id": "mkt-1", "outcome": "Yes", "side": "Sell",
    "price": "600000", "quantity": "20000000" } }
{ "method": "fill_offer",   "args": { "offer_id": "4", "quantity": "8000000" } }
{ "method": "cancel_offer", "args": { "offer_id": "4" } }
{ "view": "list_offers", "args": { "market_id": "mkt-1", "outcome": "Yes", "side": "Sell",
    "from_index": "0", "limit": 20 } }
```

TypeScript types for all of the above: `packages/types/src/market.ts`.

## Events (NEP-297, standard `nearodds_market`, version `1.0.0`)

| Event | Data |
| - | - |
| `offer_created` | `offer_id, owner_id, market_id, outcome, side, price, quantity, expires_at_ns, reserved_collateral, reserved_shares` |
| `offer_filled` | `offer_id, maker_id, taker_id, market_id, outcome, maker_side, price, quantity, collateral_amount, remaining_quantity` (`"0"` = now fully filled) |
| `offer_cancelled` | `offer_id, owner_id, market_id, outcome, side, remaining_quantity, released_collateral, released_shares` |

## Errors (panic messages, matched as substrings)

| Message | When |
| - | - |
| `trading is closed: the market cutoff has passed` | create or fill at/after the cutoff |
| `invalid price: must be a multiple of the price tick within [min, max]` | bad `price` |
| `invalid quantity: must be a multiple of the lot and at least the minimum order` | bad `quantity` on create |
| `invalid fill quantity: must be a positive multiple of the lot` | bad `quantity` on fill |
| `invalid expiry: must be in the future` | `expires_at_ns` not in the future |
| `too many open offers for this account` | already 10 open offers |
| `offer not found (never existed, fully filled or cancelled)` | unknown / finished offer id |
| `only the offer owner can cancel it` | cancel by a non-owner |
| `offer has expired` | fill after `expires_at_ns` |
| `you cannot fill your own offer` | taker is the maker |
| `fill quantity exceeds the offer's remaining quantity` | overfill |
| `insufficient available collateral` | Buy reservation or taker payment too large |
| `insufficient YES/NO shares` | Sell reservation or taker delivery too large |
| `arithmetic overflow` | a computation would overflow `u128` |
| `unknown market id ...`, `account is not registered ...`, `Requires attached deposit of exactly 1 yoctoNEAR` | as in Milestone 1 |
| `Failed to deserialize input from JSON` | bad enum value (e.g. `"Maybe"`) or malformed number |

A failed call changes nothing (the receipt reverts). Concurrent fills and a cancel on the same offer
are ordered by the chain: whichever executes first wins, the other either gets
`offer not found` (fill after cancel) or releases only the remaining reserve (cancel after fill).

## Displaying withdrawals (frontend guidance)

Read `get_withdrawal(account_id)` (or `get_account(...).pending_withdrawal`). Only a `Pending`
withdrawal is unconfirmed. Treat the states differently:

| `status` | What is known | What to show |
| - | - | - |
| `null` | No withdrawal yet | nothing |
| `Pending` | Debited from the internal balance; the settlement callback has **not** been recorded. The token transfer may or may not have been paid. The callback can also have *failed*, which leaves this state unchanged | "Withdrawal in progress, not confirmed". Do **not** show it as sent or failed. Never offer retry. After roughly a minute add: "This has not settled. Do not retry. Automatic recovery is not available yet." |
| `Completed` | Transfer verified successful | "Withdrawn", with the amount; link the token wallet |
| `FailedRestored` | The token transfer **verifiably failed** and the callback re-credited the amount to the current available balance (exactly once) | "Transfer failed, your collateral was returned to your available balance" (it is spendable again) |

`FailedRestored` is a *settled* outcome that changes the numbers; `Pending` is *unresolved* and the
amount is excluded from `available_collateral`. Pending amounts are also summed in `get_totals().pending_withdrawals`.
