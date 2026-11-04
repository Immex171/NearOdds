# Demo: deposit → split → merge → withdraw (local Sandbox)

Everything runs against a real local NEAR Sandbox with the real market and
test-token Wasm, moving real tokens. No testnet account is needed.

## Prerequisites

* Rust toolchain from `rust-toolchain.toml` (1.97.1, `wasm32-unknown-unknown`).
* `cargo-near` (`cargo install cargo-near --locked`; on machines without
  libudev headers add `--no-default-features`). Without it,
  `scripts/build-wasm.sh` falls back to a plain `cargo build`
  (`-C target-cpu=mvp`).
* First Sandbox run downloads the `near-sandbox` binary (needs network).
* `near-workspaces` pulls `openssl-sys`. If the build says it cannot find
  OpenSSL (no `pkg-config`), create `.cargo/config.toml`:
  ```toml
  [env]
  OPENSSL_LIB_DIR = "/usr/lib/x86_64-linux-gnu"
  OPENSSL_INCLUDE_DIR = "/usr/include"
  ```

## Do this, see this

| Do | See |
| - | - |
| `bash scripts/build-wasm.sh` | `target/wasm/{market,market_failure_injection,test_collateral}.wasm` listed |
| `cargo test -p nearodds-market --lib` | `99 passed` (47 Milestone 1 + 31 trading + 21 resolution) |
| `cargo test --workspace` | 78 unit + 33 Sandbox tests pass, 1 ignored (the testnet smoke test) |
| `cargo test -p nearodds-market --test collateral_flow -- acceptance_scenario_and_complete_exit --nocapture` | `1 passed` |

The acceptance test performs, with Alice funded with 100 test tokens:

| Action | Alice internal collateral | Alice YES | Alice NO | Market backing |
| - | -: | -: | -: | -: |
| Deposit 100 (`ft_transfer_call`, msg `deposit`) | 100 | 0 | 0 | 0 |
| `split_position` 100 | 0 | 100 | 100 | 100 |
| `merge_positions` 40 | 40 | 60 | 60 | 60 |
| `withdraw` 40 (token transfer succeeds) | 0 | 60 | 60 | 60 |

Afterwards Alice's token wallet holds 40 and the market's token balance holds 60
(`"40000000"` and `"60000000"` base units). The test then merges the remaining
60 and withdraws, ending with Alice holding all 100 and the market holding 0.

Other scenarios, each a named test (`cargo test -p nearodds-market -- <name>`):

| Scenario | Test |
| - | - |
| Wrong token / forged receiver call | `wrong_token_deposit_is_refunded_and_never_credited`, `forged_direct_receiver_call_cannot_create_credit` |
| Unregistered or malformed deposit refunded | `unregistered_sender_is_refunded_without_credit`, `bad_msg_is_refunded_and_cannot_name_a_beneficiary` |
| Direct `ft_transfer` creates no balance | `unsolicited_direct_transfer_creates_no_user_balance` |
| One-base-unit precision | `fractional_and_one_base_unit_quantities` |
| Cutoff: split closes, merge/withdraw stay open | `split_closes_at_cutoff_but_merge_and_withdraw_stay_open` |
| Verified token failure restores once | `verified_transfer_failure_restores_collateral_once` |
| Deposit during a failing withdrawal | `deposit_arriving_during_a_failing_withdrawal_is_preserved` (+ unit test for the same account) |
| Callback fails, stays pending, one payment | `failed_callback_leaves_withdrawal_pending_without_double_payment` |
| Unauthorized / wrong-id / replayed callback | `private_callback_rejects_outside_callers`, unit tests `callback_*`, and the test above |
| Storage funding and bounds | `storage_funding_is_bounded_and_enforced` |

## Manual walkthrough on testnet (NOT executed)

See README "Testnet deployment". The same calls the tests make, from a shell:

```bash
# deposit 100 tokens, split, merge 40, withdraw 40
near contract call-function as-transaction $TOKEN ft_transfer_call json-args \
  '{"receiver_id":"'$MARKET'","amount":"100000000","msg":"deposit"}' \
  prepaid-gas '300 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ALICE ...
near contract call-function as-transaction $MARKET split_position json-args \
  '{"market_id":"'$MARKET_ID'","amount":"100000000"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ALICE ...
near contract call-function as-transaction $MARKET merge_positions json-args \
  '{"market_id":"'$MARKET_ID'","amount":"40000000"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ALICE ...
near contract call-function as-transaction $MARKET withdraw json-args \
  '{"amount":"40000000"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ALICE ...
near contract call-function as-read-only $MARKET get_account json-args '{"account_id":"'$ALICE'"}' network-config testnet now
```

These command lines use `near-cli-rs` syntax from memory of its interactive
mode and were **not** run here; check `near --help` for your installed version.

## Milestone 2: trading demo

`cargo test -p nearodds-market --test trading -- acceptance_scenario_with_real_tokens --nocapture` runs, with real
tokens, the zero-fee scenario below (prices per share, quantities in whole shares):

| Step | Result |
| - | - |
| Alice deposits and splits 100 | 100 YES, 100 NO, backing 100 |
| Bob and Carol deposit 10 each | |
| Alice `create_offer` Yes/Sell 20 @ 0.60 | 20 YES reserved |
| Bob `fill_offer` 8, Carol `fill_offer` 5 | pay 4.80 and 3.00 |
| Alice `cancel_offer` | the unfilled 7 YES return |
| Bob `create_offer` Yes/Sell 3 @ 0.70, Carol fills | 2.10 changes hands |

| Account | Collateral | YES | NO |
| - | -: | -: | -: |
| Alice | 7.80 | 87 | 100 |
| Bob | 7.30 | 5 | 0 |
| Carol | 4.90 | 8 | 0 |

No reserves remain; backing is still 100 for 100 YES + 100 NO and 20 collateral is available to users. The test
then merges and withdraws everyone and checks the token balances (Alice 94.8, Bob 7.3, Carol 4.9, market 13).

| Scenario | Test |
| - | - |
| Validation, authorization, reuse of reserved assets | `validation_authorization_and_reuse_errors_change_nothing` |
| Buy offer partial fill, exact return on cancel | `buy_offer_partial_fill_and_exact_return_on_cancel` |
| One fill == many fills; smallest tick and lot | `precision_one_fill_equals_many_fills` |
| Cutoff: no create/fill, cancel still works | `trading_closes_at_cutoff_but_makers_can_always_cancel` |
| Fill vs cancel race | `fill_and_cancel_race_never_double_spends` |
| Trading with deposit, merge, withdrawal in flight | `trading_interleaved_with_withdrawal_and_deposit` |
| Storage prepaid and bounded (measured 2,619 of 4,096 bytes) | `offer_storage_is_prepaid_and_bounded` |
| Pagination and account offers | `views_paginate_offers_and_report_account_offers` |
| Same flow on testnet | `scripts/testnet-smoke.sh` (see `docs/testnet.md`; not run) |

Unit tests for the same rules (including per-fill exactness and expiry) are in `contracts/market/src/tests/trading.rs`.

## Milestone 3: resolution and redemption demo

`cargo test -p nearodds-market --test resolution -- yes_wins_full_lifecycle_with_real_tokens --nocapture` runs the
Alice/Bob/Carol scenario with real tokens through resolution:

| Step | Result |
| - | - |
| Trades as in Milestone 2 | Alice 7.80/87 YES/100 NO, Bob 7.30/5/0, Carol 4.90/8/0 |
| Resolver tries early | `cannot be resolved before its cutoff` |
| Non-resolver tries after the cutoff | `only the configured resolver` |
| Resolver resolves YES; a second resolution (any outcome) | success; `already resolved` |
| Split, merge, create/fill offer | `market is resolved` |
| Carol, Alice, Bob redeem | 12.90, 94.80, 12.30 available; backing 0; total 120 |
| Redeem again | `nothing to redeem` |
| Everyone withdraws | token balances 94.8 / 12.3 / 12.9, market holds 0 |

`no_wins_full_lifecycle_with_real_tokens` gives 107.80 / 7.30 / 4.90.

| Scenario | Test |
| - | - |
| Offers outstanding at resolution; redeem releases them (payout vs released collateral) | `offers_outstanding_at_resolution_are_cancellable_and_redeem_releases_them` |
| All ten offer slots occupied; gas measurement (6.9 Tgas burned; 2.1 with none) | `redeem_with_all_ten_offer_slots_measures_gas` |
| Preview, unregistered, empty account, mixed position, max-evidence storage (547 bytes) | `views_and_redeem_edge_cases` |
| Testnet-ready lifecycle harness (Sandbox run) | `smoke_on_sandbox`; demo market: `demo_on_sandbox` |

Unit tests for the same rules, including the exact cutoff boundary, are in `contracts/market/src/tests/resolution.rs`.
