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
