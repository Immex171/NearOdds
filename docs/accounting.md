# NearOdds accounting model (Milestones 1 and 2)

Scope: one fixed binary market, one approved NEP-141 collateral token, deposit,
split, merge, withdraw (Milestone 1) and fully funded onchain offers (Milestone 2,
see the Trading section). Resolution and redemption do not exist yet.

## Units

| Thing | Unit | Notes |
| - | - | - |
| Collateral | base units, 6 decimals | 1 token = `1_000_000` |
| YES / NO shares | base units, 6 decimals | 1 share = `1_000_000` |
| JSON amounts | decimal strings (`U128`) | `"100000000"` = 100 |
| Timestamps | NEAR block time, nanoseconds (`U64`) | |
| Native NEAR | yoctoNEAR | gas, storage and the 1-yocto authorization; **never collateral** |

All arithmetic is checked `u128`; there is no floating point.

## Complete sets

**One collateral base unit backs one YES base unit plus one NO base unit.**

* `split_position(amount)`: available collateral `-amount`, market backing `+amount`,
  caller YES `+amount`, caller NO `+amount`, outstanding YES/NO `+amount`.
* `merge_positions(amount)`: caller YES/NO `-amount`, outstanding YES/NO `-amount`,
  market backing `-amount`, available collateral `+amount`.

Locking 100 tokens makes 100 YES + 100 NO, backed by 100 tokens. It does **not**
create 200 tokens of backing, and the two sides are not both payable in full:
after resolution (a later milestone) the pair pays 1 token in total.

## State buckets

Per account: `available`, `yes`, `no` (plus a native-NEAR `storage_deposit`
and the last settled withdrawal). Aggregates: `available_collateral`,
`market_backing`, `outstanding_yes`, `outstanding_no`, `pending_withdrawals`.

Invariants checked in O(1) after every local operation:

* `market_backing == outstanding_yes == outstanding_no`
  (true only for this unresolved, split-and-merge-only milestone).

Held by tests (they know every account): the aggregate counters equal the sum
of the accounts' fields, and an account never changes another account.

> **Not a universal invariant.** Once redemption exists, individual redemptions
> leave unequal YES/NO supplies. The resolved-market design must track
> remaining *payout liabilities* against the reserve instead of requiring
> equal supplies.

## Deposits

`ft_on_transfer(sender_id, amount, msg)` credits `available` of `sender_id`
synchronously, with no external call. Accepted only when the immediate caller
is the configured token **and** `msg == "deposit"` **and** the sender is
registered **and** amount > 0 **and** nothing overflows. Anything but the
caller check returns the full amount as "unused", so the token refunds the
sender and no balance changes. A wrong caller panics. `msg` can never choose a
beneficiary.

## Withdrawals and pending state

`withdraw(amount)` executes in this order:

1. Validate caller registered, `amount > 0`, `amount <= available`, no pending
   withdrawal, exactly 1 yocto, enough prepaid gas.
2. **Debit** `available` (account and aggregate), add to `pending_withdrawals`,
   store one `PendingWithdrawal{id, receiver, amount}`. Storage was prepaid at
   registration.
3. Call token `ft_transfer(receiver, amount)` with the 1 yocto, then schedule
   the private callback `on_withdraw_complete(account, id)`.

The callback reads the **real promise result**:

| Transfer result | Effect |
| - | - |
| Success (any return data, including oversized) | pending removed; `pending_withdrawals -= amount`; last result = `Completed` |
| Failure (verified) | same, **plus** `amount` added to the account's *current* `available` and the aggregate; last result = `FailedRestored` |

The pending record is removed on settlement, so a repeated or stale callback
finds nothing and panics without changing balances; a wrong id also panics. The
callback never reads or writes YES/NO shares and never uses a balance snapshot.
A self-signed call (no promise result) cannot settle anything.

### Callback failure (unresolved by design)

If the callback itself fails (for example out of gas) the token transfer may
have succeeded but the contract cannot know. The operation **stays Pending**.
There is no timeout refund, no automatic re-send and no admin refund method.
`get_withdrawal` shows `Pending`; events show the request but no completion.
**Automatic recovery is out of scope for this milestone and needs a separately
verified design** (for example a permissionless, verified re-query of the
transfer outcome). Tested with a test-only build whose callback gas is too small.

## Escrow reconciliation

Internal counters are not a token balance. After every asynchronous operation
has settled:

```
ft_balance_of(market)  >=  available_collateral + reserved_collateral + market_backing   (= settled_escrow_requirement)
```

Anything above that is **unallocated surplus** (e.g. a direct `ft_transfer`
that bypassed the receiver). It credits nobody and no method can move it.

Pending withdrawals are modelled explicitly: their amount was already debited
from `available`, so it is **not** added to the requirement above. While a
withdrawal is in flight the token balance is between `requirement` and
`requirement + pending` (before / after the transfer executes). Once the
callback has run, the transfer's outcome is reflected in both numbers.

## Storage

Native NEAR, separate from collateral. `storage_deposit` charges a fixed
`4096 bytes * storage_byte_cost` per account — an upper bound for one account
record (with its open-offer id list), one pending-withdrawal record and 10 open
offers (measured worst case: 2,619 bytes). No per-call growth: records are
fixed size and created at registration (account) or inside the already-prepaid
bound (pending), and the pending record is removed when settled. Excess
attached NEAR is refunded; re-registering refunds everything. Tests assert the
measured growth stays within the bound. No operation iterates over accounts.

## Trust and authority

* No method sets balances, mints shares, or moves the reserve. Tests assert
  that admin-style and future-feature methods do not exist.
* The collateral token and market terms are immutable after `new`.
* Whoever holds the full-access key of the deployed account could redeploy
  different code. That is a separate trust assumption; for a trust-minimised
  deployment, delete the key after deployment or move it to a governed
  account. Deploy and call `new` in one batch transaction to avoid init
  front-running.
* The test collateral's `mint` belongs to the fixture owner and is not part of
  the market contract.

## Trading (Milestone 2)

Offers are **fully funded when created** and settle against the internal ledger only.

### Reserved vs available

Each account has separate `available` and `reserved` amounts for collateral, YES and NO.
Aggregates: `reserved_collateral`, `reserved_yes`, `reserved_no`, `open_offers`.

| Operation | Available collateral | Reserved collateral | Available shares | Reserved shares |
| - | - | - | - | - |
| Create **Buy** (qty q at p) | `-q*p/1e6` | `+q*p/1e6` | | |
| Create **Sell** (qty q) | | | `-q` | `+q` |
| Fill **Sell** by taker | taker `-cost`, maker `+cost` | | taker `+q` | maker `-q` |
| Fill **Buy** by taker | taker `+cost` | maker `-cost` | taker `-q`, maker `+q` | |
| Cancel (remaining r) | Buy: `+r*p/1e6` | Buy: `-r*p/1e6` | Sell: `+r` | Sell: `-r` |

Only *available* amounts can be offered, merged, split or withdrawn. A fill debits and credits the
same `cost`, delivers the same `q` it removes, and creates or destroys nothing: `available_collateral +
reserved_collateral` summed over all accounts is unchanged by trading, `outstanding_yes/no` and
`market_backing` are unchanged (reserved shares are part of the outstanding supply, never added to it),
and `reserved_yes <= outstanding_yes`, `reserved_no <= outstanding_no` are checked after every operation.

### Exact pricing

`cost = q * p / 1_000_000` with price a multiple of 10,000 and quantity a multiple of 100 is always an
integer, so there is no per-fill rounding: splitting a trade into many fills costs exactly what one fill
costs, nobody gets free shares, and a Buy offer's reservation is exactly consumed by fills plus the
cancellation release. Inexact costs are rejected with an internal error rather than rounded. **Fees are zero.**

### Offer lifecycle and cleanup

Open and partially filled offers hold storage that the maker prepaid at registration (max 10 open offers).
Fully filled and cancelled offers are deleted, freeing the slot. Cancellation works at any time, including
after expiry or the trading cutoff, and releases exactly the unfilled remainder (never anything consumed by
earlier fills). Fills and creation stop at the cutoff, which is the same instant that closes splitting.

### Withdrawals are unchanged

Withdrawal still debits **available** collateral only, so reserved collateral cannot be withdrawn. The
callback policy is unchanged: a verified token failure restores the current available balance once; a
callback that itself fails leaves the withdrawal `Pending` with no automatic resend or restoration.
