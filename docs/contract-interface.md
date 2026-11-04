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
