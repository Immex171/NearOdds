//! NearOdds market contract — Milestone 1.
//!
//! One fixed binary market, one approved NEP-141 collateral token, funded
//! account registration, deposits, complete-set split/merge and withdrawals.
//! Milestone 2 adds fully funded fixed-price offers (create / fill / cancel).
//! NOT implemented (and deliberately not stubbed): resolution, redemption,
//! market creation, pausing, upgrades by an in-contract admin.
//!
//! Trust note: there is no admin method that sets balances, mints shares or
//! moves the reserve. Whoever holds the full-access key of the deployed
//! account can still redeploy code; that key is a separate trust assumption
//! (see docs/accounting.md). Deploy with an init call in the same batch
//! transaction so nobody can front-run `new`.

pub mod balances;
pub mod collateral;
pub mod errors;
pub mod events;
pub mod offers;
pub mod positions;
pub mod state;
pub mod storage;
pub mod types;
pub mod views;

#[cfg(test)]
mod tests;

use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId};

use crate::errors::ERR_BAD_INIT;
pub use crate::state::Contract;
use crate::state::ContractExt;
use crate::state::{Market, StorageKey, Totals, SCHEMA_VERSION};

#[near]
impl Contract {
    /// One-time initialization; terms are immutable afterwards.
    ///
    /// * `collateral_token`: the only token accepted for deposits/withdrawals.
    /// * `market_id`: 1..=64 chars. `question` <= 512, `rules` <= 2048 bytes.
    /// * `split_cutoff_ns`: block timestamp (nanoseconds) after which
    ///   splitting is closed; must be in the future.
    #[init]
    pub fn new(
        collateral_token: AccountId,
        market_id: String,
        question: String,
        rules: String,
        split_cutoff_ns: U64,
    ) -> Self {
        require!(
            !market_id.is_empty()
                && market_id.len() <= 64
                && !question.is_empty()
                && question.len() <= 512
                && rules.len() <= 2048
                && split_cutoff_ns.0 > env::block_timestamp(),
            ERR_BAD_INIT
        );
        Self {
            schema_version: SCHEMA_VERSION,
            collateral_token,
            market: Market {
                id: market_id,
                question,
                rules,
                split_cutoff_ns: split_cutoff_ns.0,
            },
            totals: Totals::default(),
            next_withdrawal_id: 0,
            accounts: LookupMap::new(StorageKey::Accounts),
            withdrawals: LookupMap::new(StorageKey::Withdrawals),
            offers: [
                IterableMap::new(StorageKey::Offers(0)),
                IterableMap::new(StorageKey::Offers(1)),
                IterableMap::new(StorageKey::Offers(2)),
                IterableMap::new(StorageKey::Offers(3)),
            ],
            next_offer_seq: 0,
        }
    }
}
