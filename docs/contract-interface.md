# NearOdds market contract interface (Milestone 1)

Crate `nearodds-market`; compiled to one Wasm. Amounts are `U128` decimal
strings in base units (6 decimals: `"1000000"` = 1 token/share). Timestamps are
`U64` nanoseconds. "1 yocto" means exactly 1 yoctoNEAR attached — a full-access-key
authorization step that is kept by the contract and is **not** collateral.

Not implemented (and not stubbed): offers/trading, market creation, resolution,
redemption, unregistration, `storage_withdraw`, upgrades or admin refunds. The
storage methods are a *subset* of NEP-145; full compliance is not claimed.

## Initialization

`new(collateral_token: AccountId, market_id: String, question: String, rules: String, split_cutoff_ns: U64)` — `#[init]`, once.
`market_id` 1–64 bytes; `question` 1–512; `rules` ≤ 2048; cutoff must be in the future.
Terms are immutable afterwards. Deploy and init in one batch transaction.

## Registration (payable)

`storage_deposit(account_id?: AccountId, registration_only?: bool) -> {total, available}`
Attach ≥ `get_config().storage_cost_per_account`. Registers `account_id`
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

# Milestone 2 — Trading (PROPOSED, implementation in progress)

> **Status: proposal published early for the frontend team.** Names, argument
> shapes and units below are the intended final interface. This section is
> rewritten with the exact implemented behaviour, errors and examples when the
> milestone is complete. Anything marked *(may change)* is not final.

## Units and precision (decided)

| Item | Value |
| - | - |
| Collateral, shares | 6 decimals; `"1000000"` = 1 token / 1 share |
| Price | collateral base units per **1 whole share**; `price_scale = 1_000_000` |
| Price tick | `10_000` (0.01). Valid price: multiple of tick in `[10_000, 990_000]` |
| Quantity lot | `100` share base units. Quantity must be a multiple of the lot |
| Minimum order | `10_000` share base units (0.01 share); minimum fill = 1 lot |
| Cost of a fill | `quantity * price / 1_000_000`, **always exact** for valid prices and lots, so one big fill and many small fills cost the same |
| Fees | **zero** in this milestone |
| Open offers per account | max 10 (storage is prepaid at registration) |

`get_config().trading` returns these as strings/numbers so the UI never hardcodes them.

## Balances (extended views)

`get_account` / `get_position` gain reserved fields. Existing `available_collateral`, `yes`, `no`
keep meaning **available (spendable, mergeable, withdrawable)**.

```json
{ "available_collateral": "1000000", "reserved_collateral": "4800000",
  "yes": "5000000", "reserved_yes": "7000000",
  "no": "0", "reserved_no": "0" }
```

## Methods (all payable with exactly 1 yoctoNEAR; caller = predecessor)

| Method | Arguments | Returns |
| - | - | - |
| `create_offer` | `market_id, outcome: "Yes"\|"No", side: "Buy"\|"Sell", price: U128, quantity: U128, expires_at_ns?: U64` | `OfferView` |
| `fill_offer` | `offer_id: U64, quantity: U128` | `FillResult` |
| `cancel_offer` | `offer_id: U64` | `CancelResult` |

* **Sell** offers reserve `quantity` of the maker's available shares. **Buy** offers
  reserve `quantity*price/1e6` of available collateral.
* `fill_offer` is for the *taker*: on a Sell offer the taker pays collateral and receives
  shares; on a Buy offer the taker gives shares and receives collateral. Partial fills allowed.
* Offers are fully funded, fixed-price, and cannot be self-filled.
* `cancel_offer`: maker only; allowed at any time, including after expiry or the trading cutoff.
* Creating and filling require `block_timestamp < cutoff` (same cutoff as splitting) and, if set, `< expires_at_ns`.

Reads: `get_offer(offer_id)`, `list_offers(market_id, outcome, side, from_index?, limit?)`,
`get_account_offers(account_id)`.

Offer lifecycle shown by views: `Open`, `PartiallyFilled`, `Expired` (expiry passed or trading
closed; still cancellable). Fully filled and cancelled offers are **removed** from storage; their
final state is reported by the method result and by events (`offer_created`, `offer_filled`,
`offer_cancelled`). Offer IDs are opaque decimal strings.

Registration cost rises because it now prepays storage for up to 10 open offers; always read
`get_config().storage_cost_per_account`.
