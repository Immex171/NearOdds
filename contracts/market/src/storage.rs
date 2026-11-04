//! Funded account registration (a SUBSET of NEP-145: `storage_deposit`,
//! `storage_balance_of`, `storage_balance_bounds`). There is no
//! `storage_withdraw` and no `storage_unregister`, so this contract does NOT
//! claim full NEP-145 compliance.
//!
//! Registration prepays a fixed upper bound on the bytes used by one account
//! record plus one pending-withdrawal record, so later operations (including
//! the withdrawal request and its callback) never grow storage unfunded.

use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::errors::*;
use crate::events::MarketEvent;
use crate::state::ContractExt;
use crate::state::{Account, Contract, SettlementOutcome};
use crate::types::{StorageBalance, StorageBalanceBounds};

/// Upper bound on bytes used per registered account (account record + pending
/// withdrawal record, including key and per-record overhead). The measured
/// real usage is asserted below this in the Sandbox tests.
pub const STORAGE_BOUND_BYTES: u128 = 512;

pub fn storage_cost() -> NearToken {
    env::storage_byte_cost().saturating_mul(STORAGE_BOUND_BYTES)
}

#[near]
impl Contract {
    /// Registers `account_id` (default: the caller). Attach at least
    /// `storage_cost_per_account` yoctoNEAR. Anything above that is refunded
    /// to the caller; if the account is already registered the whole deposit
    /// is refunded. `registration_only` is accepted for NEP-145 shape but the
    /// behaviour is always registration-only. Native NEAR is never collateral.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let payer = env::predecessor_account_id();
        let attached = env::attached_deposit();
        let id = account_id.unwrap_or_else(|| payer.clone());
        let cost = storage_cost();

        if let Some(existing) = self.accounts.get(&id) {
            let total = NearToken::from_yoctonear(existing.storage_deposit);
            if !attached.is_zero() {
                Promise::new(payer).transfer(attached).detach();
            }
            return StorageBalance {
                total,
                available: NearToken::from_yoctonear(0),
            };
        }

        require!(attached >= cost, ERR_STORAGE_TOO_LOW);
        self.accounts.insert(
            id.clone(),
            Account {
                storage_deposit: cost.as_yoctonear(),
                available: 0,
                yes: 0,
                no: 0,
                last_withdrawal_id: 0,
                last_withdrawal_amount: 0,
                last_withdrawal_outcome: SettlementOutcome::None,
            },
        );
        self.totals.registered_accounts = self
            .totals
            .registered_accounts
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str(ERR_OVERFLOW));

        let excess = attached.saturating_sub(cost);
        if !excess.is_zero() {
            Promise::new(payer.clone()).transfer(excess).detach();
        }
        MarketEvent::StorageRegistered {
            account_id: id,
            payer_id: payer,
            storage_deposit_yocto: cost.as_yoctonear().into(),
        }
        .emit();
        StorageBalance {
            total: cost,
            available: NearToken::from_yoctonear(0),
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.get(&account_id).map(|a| StorageBalance {
            total: NearToken::from_yoctonear(a.storage_deposit),
            available: NearToken::from_yoctonear(0),
        })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let cost = storage_cost();
        StorageBalanceBounds {
            min: cost,
            max: Some(cost),
        }
    }
}
