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
| `cargo test -p nearodds-market --lib` | `47 passed` |
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

## Manual walkthrough on testnet (NOT executed for this milestone)

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
