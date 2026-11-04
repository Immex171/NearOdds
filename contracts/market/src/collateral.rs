//! Collateral in and out: the NEP-141 deposit receiver, `withdraw`, and the
//! private callback that settles it from the REAL promise result.
//!
//! Deposits are synchronous: no external call is made inside `ft_on_transfer`.
//! Withdrawals debit first, then call `ft_transfer`, then settle in
//! `on_withdraw_complete`.

use near_sdk::json_types::{U128, U64};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, NearToken, PromiseError,
    PromiseOrValue,
};

use crate::errors::*;
use crate::events::MarketEvent;
use crate::state::ContractExt;
use crate::state::{Contract, SettlementOutcome};
use crate::views::DEPOSIT_MSG;

/// Gas reserved for the token's `ft_transfer`.
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);

/// Gas reserved for the settlement callback (kept small and bounded).
#[cfg(not(feature = "test-failure-injection"))]
pub const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// TEST-ONLY build: too little gas, so the callback itself fails. Never deploy.
#[cfg(feature = "test-failure-injection")]
pub const CALLBACK_GAS: Gas = Gas::from_gas(1_000_000_000);

/// Weight of the callback in the distribution of leftover gas. Production
/// keeps the SDK default (1) so any gas left over goes to the callback and
/// token call. The test-only build pins the callback to exactly its static gas.
#[cfg(not(feature = "test-failure-injection"))]
const CALLBACK_UNUSED_GAS_WEIGHT: u64 = 1;
#[cfg(feature = "test-failure-injection")]
const CALLBACK_UNUSED_GAS_WEIGHT: u64 = 0;

/// Minimum prepaid gas for `withdraw` (its own work + both promises).
pub const MIN_WITHDRAW_PREPAID_GAS: Gas = Gas::from_tgas(45);

/// Upper bound when reading the transfer's return data. Any success, including
/// oversized return data, counts as a successful transfer.
const MAX_RESULT_LEN: usize = 1024;

#[ext_contract(ext_collateral)]
pub trait CollateralToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn on_withdraw_complete(
        &mut self,
        account_id: AccountId,
        withdrawal_id: U64,
    ) -> SettlementOutcome;
}

#[near]
impl Contract {
    /// NEP-141 receiver. Credits `sender_id` (never anyone named in `msg`).
    ///
    /// * Panics if the caller is not the approved collateral token.
    /// * `msg` must be exactly `"deposit"`.
    /// * Returns the UNUSED amount: `0` when accepted; the full `amount` when
    ///   rejected (bad msg, unregistered sender, zero amount, overflow), which
    ///   makes the token refund the sender. No balance changes on rejection.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.collateral_token,
            ERR_WRONG_TOKEN
        );
        if msg != DEPOSIT_MSG {
            return PromiseOrValue::Value(amount);
        }
        if self.apply_deposit(&sender_id, amount.0).is_err() {
            return PromiseOrValue::Value(amount);
        }
        MarketEvent::Deposit {
            account_id: sender_id,
            token_id: self.collateral_token.clone(),
            amount,
        }
        .emit();
        PromiseOrValue::Value(U128(0))
    }

    /// Withdraws `amount` collateral base units from the caller's AVAILABLE
    /// balance to the caller's own token wallet. Requires exactly 1 yoctoNEAR
    /// (forwarded to the token's `ft_transfer`), a registered caller, and no
    /// pending withdrawal. The caller must be registered with the token.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> near_sdk::Promise {
        assert_one_yocto();
        require!(env::prepaid_gas() >= MIN_WITHDRAW_PREPAID_GAS, ERR_LOW_GAS);
        let account_id = env::predecessor_account_id();
        let pending = self
            .apply_begin_withdrawal(&account_id, amount.0, env::block_timestamp())
            .unwrap_or_else(|e| env::panic_str(e));
        MarketEvent::WithdrawalRequested {
            account_id: account_id.clone(),
            withdrawal_id: U64(pending.id),
            receiver_id: pending.receiver_id.clone(),
            amount,
        }
        .emit();
        ext_collateral::ext(self.collateral_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                pending.receiver_id,
                amount,
                Some("NearOdds withdrawal".into()),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(CALLBACK_UNUSED_GAS_WEIGHT)
                    .on_withdraw_complete(account_id, U64(pending.id)),
            )
    }

    /// Private. Settles a withdrawal from the real result of `ft_transfer`.
    ///
    /// * The pending record must exist and match `withdrawal_id`; otherwise it
    ///   panics WITHOUT changing balances (stale / repeated / wrong-id calls).
    /// * Success (including oversized return data) finalizes.
    /// * Verified failure re-credits the account's CURRENT available balance
    ///   exactly once. Outcome shares are never touched.
    /// * If this callback itself fails (e.g. out of gas) nothing changes and
    ///   the withdrawal stays pending. There is no automatic recovery in this
    ///   milestone.
    #[private]
    pub fn on_withdraw_complete(
        &mut self,
        account_id: AccountId,
        withdrawal_id: U64,
    ) -> SettlementOutcome {
        // Check the record first so a self-signed call with no promise result
        // can never settle anything.
        let pending = self
            .withdrawals
            .get(&account_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(ERR_NO_PENDING_WITHDRAWAL));
        require!(pending.id == withdrawal_id.0, ERR_WRONG_WITHDRAWAL_ID);
        require!(env::promise_results_count() == 1, ERR_BAD_PROMISE_COUNT);

        let transferred = match env::promise_result_checked(0, MAX_RESULT_LEN) {
            Ok(_) => true,
            // Successful execution whose return data was longer than we read.
            Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => env::panic_str(ERR_UNEXPECTED_PROMISE_RESULT),
        };
        let settled = self
            .apply_settle_withdrawal(&account_id, withdrawal_id.0, transferred)
            .unwrap_or_else(|e| env::panic_str(e));
        if transferred {
            MarketEvent::WithdrawalCompleted {
                account_id,
                withdrawal_id,
                amount: U128(settled.amount),
            }
            .emit();
            SettlementOutcome::Completed
        } else {
            MarketEvent::WithdrawalFailedRestored {
                account_id,
                withdrawal_id,
                amount: U128(settled.amount),
            }
            .emit();
            SettlementOutcome::FailedRestored
        }
    }
}
