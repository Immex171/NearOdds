//! Complete-set operations.
//!
//! One collateral base unit backs one YES base unit plus one NO base unit.
//! `split_position` locks collateral and mints both; `merge_positions` burns
//! both and releases the same amount. Neither calls another contract.
//!
//! Authorization: the account is ALWAYS `predecessor_account_id()`, and
//! exactly 1 yoctoNEAR must be attached. That yocto is a native-NEAR
//! authorization step (it forces a full-access-key signature) and is entirely
//! separate from collateral; it is kept by the contract.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, require};

use crate::errors::*;
use crate::events::MarketEvent;
use crate::state::Contract;
use crate::state::ContractExt;

#[near]
impl Contract {
    /// Locks `amount` collateral base units and credits `amount` YES base
    /// units and `amount` NO base units to the caller. Only before the split
    /// cutoff. Requires exactly 1 yoctoNEAR attached.
    #[payable]
    pub fn split_position(&mut self, market_id: String, amount: U128) {
        assert_one_yocto();
        self.require_market(&market_id);
        require!(
            env::block_timestamp() < self.market.split_cutoff_ns,
            ERR_SPLIT_CLOSED
        );
        let account_id = env::predecessor_account_id();
        self.apply_split(&account_id, amount.0)
            .unwrap_or_else(|e| env::panic_str(e));
        MarketEvent::Split {
            account_id,
            market_id,
            amount,
        }
        .emit();
    }

    /// Burns `amount` YES and `amount` NO base units from the caller and
    /// credits `amount` collateral. Allowed before and after the cutoff.
    /// Requires exactly 1 yoctoNEAR attached.
    #[payable]
    pub fn merge_positions(&mut self, market_id: String, amount: U128) {
        assert_one_yocto();
        self.require_market(&market_id);
        let account_id = env::predecessor_account_id();
        self.apply_merge(&account_id, amount.0)
            .unwrap_or_else(|e| env::panic_str(e));
        MarketEvent::Merge {
            account_id,
            market_id,
            amount,
        }
        .emit();
    }
}
