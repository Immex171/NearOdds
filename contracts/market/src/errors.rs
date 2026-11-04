//! Error messages. Every user-facing panic string lives here so tests and
//! docs can refer to one stable list. All are plain `&'static str`.

pub const ERR_ZERO_AMOUNT: &str = "amount must be greater than zero";
pub const ERR_UNKNOWN_MARKET: &str = "unknown market id (this contract hosts one fixed market)";
pub const ERR_NOT_REGISTERED: &str = "account is not registered: call storage_deposit first";
pub const ERR_INSUFFICIENT_COLLATERAL: &str = "insufficient available collateral";
pub const ERR_INSUFFICIENT_SHARES: &str = "insufficient YES/NO shares";
pub const ERR_OVERFLOW: &str = "arithmetic overflow";
pub const ERR_UNDERFLOW: &str = "arithmetic underflow";
pub const ERR_SPLIT_CLOSED: &str = "splitting is closed: the split cutoff has passed";
pub const ERR_WRONG_TOKEN: &str = "ft_on_transfer must be called by the approved collateral token";
pub const ERR_STORAGE_TOO_LOW: &str = "attached deposit is below the storage registration cost";
pub const ERR_PENDING_WITHDRAWAL: &str = "a withdrawal is already pending for this account";
pub const ERR_NO_PENDING_WITHDRAWAL: &str = "no pending withdrawal for this account";
pub const ERR_WRONG_WITHDRAWAL_ID: &str = "withdrawal id does not match the pending record";
pub const ERR_BAD_PROMISE_COUNT: &str = "callback requires exactly one promise result";
pub const ERR_UNEXPECTED_PROMISE_RESULT: &str = "unexpected promise result state";
pub const ERR_LOW_GAS: &str = "not enough prepaid gas for withdrawal and its callback";
pub const ERR_BAD_INIT: &str = "invalid initialization arguments";
pub const ERR_INVARIANT: &str = "accounting invariant violated";

// ---- trading (Milestone 2) ----
pub const ERR_TRADING_CLOSED: &str = "trading is closed: the market cutoff has passed";
pub const ERR_BAD_PRICE: &str =
    "invalid price: must be a multiple of the price tick within [min, max]";
pub const ERR_BAD_QUANTITY: &str =
    "invalid quantity: must be a multiple of the lot and at least the minimum order";
pub const ERR_BAD_FILL_QUANTITY: &str =
    "invalid fill quantity: must be a positive multiple of the lot";
pub const ERR_BAD_EXPIRY: &str = "invalid expiry: must be in the future";
pub const ERR_TOO_MANY_OFFERS: &str = "too many open offers for this account";
pub const ERR_OFFER_NOT_FOUND: &str = "offer not found (never existed, fully filled or cancelled)";
pub const ERR_NOT_OFFER_OWNER: &str = "only the offer owner can cancel it";
pub const ERR_OFFER_EXPIRED: &str = "offer has expired";
pub const ERR_SELF_TRADE: &str = "you cannot fill your own offer";
pub const ERR_FILL_EXCEEDS_REMAINING: &str = "fill quantity exceeds the offer's remaining quantity";
pub const ERR_INEXACT_COST: &str = "internal error: cost is not exactly representable";
pub const ERR_INSUFFICIENT_RESERVE: &str =
    "internal error: reserve is smaller than the amount to release";

// ---- resolution and redemption (Milestone 3) ----
pub const ERR_NOT_RESOLVER: &str = "only the configured resolver can resolve the market";
pub const ERR_RESOLVE_TOO_EARLY: &str = "the market cannot be resolved before its cutoff";
pub const ERR_ALREADY_RESOLVED: &str = "the market is already resolved; the result is final";
pub const ERR_BAD_EVIDENCE: &str = "evidence must be 1 to 512 bytes";
pub const ERR_NOT_RESOLVED: &str = "the market is not resolved yet";
pub const ERR_MARKET_RESOLVED: &str = "the market is resolved: this action is no longer available";
pub const ERR_NOTHING_TO_REDEEM: &str = "nothing to redeem: no shares and no open offers";
