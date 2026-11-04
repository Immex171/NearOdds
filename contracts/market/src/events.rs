//! Versioned NEP-297 events, standard `nearodds_market`.
//!
//! Amounts are decimal strings in base units. A `withdrawal_requested` event
//! does NOT mean the wallet was paid; indexers must look at the finalized
//! receipts and at `withdrawal_completed` / `withdrawal_failed_restored`.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

#[near(event_json(standard = "nearodds_market"))]
pub enum MarketEvent {
    #[event_version("1.0.0")]
    StorageRegistered {
        account_id: AccountId,
        payer_id: AccountId,
        storage_deposit_yocto: U128,
    },
    #[event_version("1.0.0")]
    Deposit {
        account_id: AccountId,
        token_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    Split {
        account_id: AccountId,
        market_id: String,
        amount: U128,
    },
    #[event_version("1.0.0")]
    Merge {
        account_id: AccountId,
        market_id: String,
        amount: U128,
    },
    #[event_version("1.0.0")]
    WithdrawalRequested {
        account_id: AccountId,
        withdrawal_id: U64,
        receiver_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    WithdrawalCompleted {
        account_id: AccountId,
        withdrawal_id: U64,
        amount: U128,
    },
    #[event_version("1.0.0")]
    WithdrawalFailedRestored {
        account_id: AccountId,
        withdrawal_id: U64,
        amount: U128,
    },
}
