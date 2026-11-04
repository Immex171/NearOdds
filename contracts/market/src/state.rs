//! Persistent state. All amounts are `u128` base units (6 decimals: 1 token or
//! share = 1_000_000 base units). Timestamps are NEAR block timestamps in
//! nanoseconds.

use near_sdk::borsh::BorshSerialize;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault};

pub const SCHEMA_VERSION: u32 = 2;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
pub enum StorageKey {
    Accounts,
    Withdrawals,
    /// One map per (outcome, side) bucket; see `offers::bucket`.
    Offers(u8),
}

/// The single, immutable market hosted by this deployment.
#[near(serializers=[borsh])]
#[derive(Clone)]
pub struct Market {
    pub id: String,
    pub question: String,
    pub rules: String,
    /// Splitting is allowed only while `block_timestamp < split_cutoff_ns`.
    pub split_cutoff_ns: u64,
}

/// How the most recent withdrawal of an account ended. One byte on disk.
#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SettlementOutcome {
    None,
    /// The token transfer was verified successful.
    Completed,
    /// The token transfer was verified failed; the amount was re-credited.
    FailedRestored,
}

/// Fixed-size per-account record: it never grows after registration.
#[near(serializers=[borsh])]
#[derive(Clone)]
pub struct Account {
    /// Native NEAR (yoctoNEAR) paid for this account's storage. Not collateral.
    pub storage_deposit: u128,
    /// Free collateral (collateral base units).
    pub available: u128,
    /// YES shares (YES base units).
    pub yes: u128,
    /// NO shares (NO base units).
    pub no: u128,
    pub last_withdrawal_id: u64,
    pub last_withdrawal_amount: u128,
    pub last_withdrawal_outcome: SettlementOutcome,
    /// Collateral locked behind this account's open Buy offers.
    pub reserved_collateral: u128,
    /// YES shares locked behind open Sell offers.
    pub yes_reserved: u128,
    /// NO shares locked behind open Sell offers.
    pub no_reserved: u128,
    /// Ids of this account's open offers (bounded by `MAX_OPEN_OFFERS`).
    pub open_offers: Vec<u64>,
}

/// A withdrawal whose token transfer has been scheduled but whose callback has
/// not yet settled. At most one per account. Removed when settled.
#[near(serializers=[borsh])]
#[derive(Clone)]
pub struct PendingWithdrawal {
    pub id: u64,
    pub receiver_id: AccountId,
    pub amount: u128,
    pub requested_at_ns: u64,
}

/// Aggregate accounting counters (all base units).
#[near(serializers=[borsh])]
#[derive(Clone, Default)]
pub struct Totals {
    /// Sum of every account's `available` collateral.
    pub available_collateral: u128,
    /// Collateral locked behind outstanding complete sets.
    pub market_backing: u128,
    pub outstanding_yes: u128,
    pub outstanding_no: u128,
    /// Sum of pending withdrawal amounts (already debited from `available`).
    pub pending_withdrawals: u128,
    pub registered_accounts: u64,
    /// Sum of accounts' `reserved_collateral` (Buy offers).
    pub reserved_collateral: u128,
    /// Sum of accounts' reserved YES / NO shares (Sell offers). These are part
    /// of `outstanding_*`; reserving does not change supply.
    pub reserved_yes: u128,
    pub reserved_no: u128,
    pub open_offers: u64,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Yes,
    No,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    /// The maker buys shares with reserved collateral.
    Buy,
    /// The maker sells reserved shares.
    Sell,
}

/// An open, fully funded, fixed-price offer. Removed when filled or cancelled.
#[near(serializers=[borsh])]
#[derive(Clone)]
pub struct Offer {
    pub id: u64,
    pub owner: AccountId,
    pub outcome: Outcome,
    pub side: Side,
    /// Collateral base units per 1 whole share (1_000_000 share base units).
    pub price: u128,
    /// Original quantity, share base units.
    pub quantity: u128,
    pub filled: u128,
    /// 0 = no expiry (trading cutoff still applies).
    pub expires_at_ns: u64,
    pub created_at_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) schema_version: u32,
    /// Immutable approved NEP-141 collateral token.
    pub(crate) collateral_token: AccountId,
    pub(crate) market: Market,
    pub(crate) totals: Totals,
    pub(crate) next_withdrawal_id: u64,
    pub(crate) accounts: LookupMap<AccountId, Account>,
    pub(crate) withdrawals: LookupMap<AccountId, PendingWithdrawal>,
    /// Open offers by bucket (see `offers::bucket`). Ids are `(seq << 2) | bucket`.
    pub(crate) offers: [IterableMap<u64, Offer>; 4],
    pub(crate) next_offer_seq: u64,
}
