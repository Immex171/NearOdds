/**
 * JSON shapes of the NearOdds market contract (schema version 3).
 * All amounts are DECIMAL STRINGS in base units (6 decimals): parse with BigInt,
 * never Number. Timestamps are NEAR block time in nanoseconds (decimal string).
 * Source of truth: docs/contract-interface.md.
 */

export type U128 = string;
export type U64 = string;
export type AccountId = string;

export type Outcome = "Yes" | "No";
export type Side = "Buy" | "Sell";

export interface TradingParams {
  price_scale: U128; // "1000000"
  price_tick: U128; // "10000"
  min_price: U128; // "10000"
  max_price: U128; // "990000"
  quantity_lot: U128; // "100"
  min_order_quantity: U128; // "10000"
  max_open_offers_per_account: number; // 10
  fee_bps: number; // 0
}

export interface ConfigView {
  schema_version: number; // 3
  collateral_token_id: AccountId;
  /** The ONLY account that can resolve the market (trusted, manual MVP). */
  resolver_id: AccountId;
  /** Plain-language trust statement (constant). */
  resolution_model: string;
  market_id: string;
  deposit_msg: string; // "deposit"
  decimals: number; // 6
  storage_cost_per_account: U128; // yoctoNEAR
  trading: TradingParams;
}

/** Open -> AwaitingResolution (at the cutoff) -> Resolved. */
export type MarketStatus = "Open" | "AwaitingResolution" | "Resolved";

export interface ResolutionView {
  outcome: Outcome; // "Yes" | "No" (no VOID)
  resolver_id: AccountId;
  resolved_at_ns: U64;
  evidence: string; // 1..512 bytes, recorded not verified
}

export interface MarketView {
  market_id: string;
  question: string;
  rules: string;
  /** Where the resolver checks the outcome; fixed at creation. */
  resolution_source: string;
  split_cutoff_ns: U64;
  split_open: boolean;
  trading_cutoff_ns: U64; // same instant as split_cutoff_ns
  trading_open: boolean; // false once resolved
  status: MarketStatus;
  awaiting_resolution: boolean; // cutoff passed, no result yet
  resolved: boolean;
  merge_open: boolean; // true until resolved (even after the cutoff)
  resolver_id: AccountId;
  resolution: ResolutionView | null;
  collateral_token_id: AccountId;
  outstanding_yes: U128; // includes reserved shares
  outstanding_no: U128;
  market_backing: U128;
}

export type WithdrawalStatus = "Pending" | "Completed" | "FailedRestored";

export interface WithdrawalView {
  withdrawal_id: U64;
  receiver_id: AccountId | null; // null once settled
  amount: U128;
  status: WithdrawalStatus;
}

export interface AccountView {
  account_id: AccountId;
  storage_deposit: U128; // yoctoNEAR, not collateral
  available_collateral: U128; // spendable / withdrawable
  reserved_collateral: U128; // locked behind open Buy offers
  yes: U128; // AVAILABLE YES (can be offered or merged)
  no: U128;
  reserved_yes: U128; // locked behind open Sell offers
  reserved_no: U128;
  open_offer_ids: U64[];
  pending_withdrawal: WithdrawalView | null;
}

export interface PositionView {
  account_id: AccountId;
  market_id: string;
  yes: U128; // available
  no: U128;
  reserved_yes: U128;
  reserved_no: U128;
}

/** Internal accounting counters, NOT a token balance. */
export interface TotalsView {
  available_collateral: U128;
  market_backing: U128;
  outstanding_yes: U128;
  outstanding_no: U128;
  pending_withdrawals: U128;
  registered_accounts: U64;
  reserved_collateral: U128;
  reserved_yes: U128;
  reserved_no: U128;
  open_offers: U64;
  /** available + reserved collateral + backing */
  settled_escrow_requirement: U128;
}

/** Views only ever return these; filled and cancelled offers are removed. */
export type OfferStatus = "Open" | "PartiallyFilled" | "Expired";

/** `get_offer` returns null for "no active offer record" (never existed, filled, cancelled or released by redeem). */
export interface OfferView {
  offer_id: U64; // opaque
  market_id: string;
  owner_id: AccountId;
  outcome: Outcome;
  side: Side; // the maker's side
  price: U128; // collateral base units per whole share
  quantity: U128; // original, share base units
  filled_quantity: U128;
  remaining_quantity: U128;
  reserved_collateral: U128; // Buy offers
  reserved_shares: U128; // Sell offers
  expires_at_ns: U64 | null;
  created_at_ns: U64;
  status: OfferStatus;
  fillable: boolean;
}

/** What `redeem` would do now. `payout` never includes released offer collateral. */
export interface RedemptionPreview {
  resolved: boolean;
  outcome: Outcome | null;
  redeemable: boolean; // resolved AND (shares or offers remain)
  offers_to_release: OfferView[]; // at most 10
  released_collateral: U128; // from Buy offers; NOT payout
  released_shares: U128; // YES+NO from Sell offers (settled in the same call)
  winning_shares: U128; // incl. shares reserved by Sell offers
  losing_shares: U128;
  payout: U128; // == winning_shares (1 share unit = 1 collateral unit)
  available_collateral_after: U128; // available + released_collateral + payout
}

export interface RedeemResult {
  outcome: Outcome;
  winning_shares: U128;
  losing_shares: U128;
  payout: U128; // winning payout only
  released_offers: CancelResult[];
  released_collateral: U128;
  released_shares: U128;
  available_collateral: U128; // balance after settlement
  yes: U128; // "0"
  no: U128; // "0"
}

export interface ResolveMarketArgs {
  market_id: string;
  outcome: Outcome;
  evidence: string; // 1..512 bytes
}

export interface RedeemArgs {
  market_id: string;
}

export type FillStatus = "PartiallyFilled" | "Filled";

export interface FillResult {
  offer_id: U64;
  quantity: U128;
  collateral_amount: U128; // exact: quantity * price / 1_000_000
  remaining_quantity: U128;
  status: FillStatus;
}

export interface CancelResult {
  offer_id: U64;
  remaining_quantity: U128;
  released_collateral: U128;
  released_shares: U128;
}

export interface CreateOfferArgs {
  market_id: string;
  outcome: Outcome;
  side: Side;
  price: U128;
  quantity: U128;
  expires_at_ns?: U64;
}

export interface FillOfferArgs {
  offer_id: U64;
  quantity: U128;
}

export interface CancelOfferArgs {
  offer_id: U64;
}

export interface ListOffersArgs {
  market_id: string;
  outcome: Outcome;
  side: Side;
  from_index?: U64;
  limit?: number; // default 20, max 50
}

/** NEP-297 events, standard "nearodds_market", version "1.0.0". */
export type MarketEvent =
  | { event: "offer_created"; data: { offer_id: U64; owner_id: AccountId; market_id: string; outcome: Outcome; side: Side; price: U128; quantity: U128; expires_at_ns: U64 | null; reserved_collateral: U128; reserved_shares: U128 } }
  | { event: "offer_filled"; data: { offer_id: U64; maker_id: AccountId; taker_id: AccountId; market_id: string; outcome: Outcome; maker_side: Side; price: U128; quantity: U128; collateral_amount: U128; remaining_quantity: U128 } }
  | { event: "offer_cancelled"; data: { offer_id: U64; owner_id: AccountId; market_id: string; outcome: Outcome; side: Side; remaining_quantity: U128; released_collateral: U128; released_shares: U128 } }
  | { event: "market_resolved"; data: { market_id: string; outcome: Outcome; resolver_id: AccountId; resolved_at_ns: U64; evidence: string } }
  | { event: "position_redeemed"; data: { account_id: AccountId; market_id: string; outcome: Outcome; winning_shares: U128; losing_shares: U128; payout: U128; released_offers: number; released_collateral: U128; released_shares: U128 } }
  | { event: "deposit"; data: { account_id: AccountId; token_id: AccountId; amount: U128 } }
  | { event: "split" | "merge"; data: { account_id: AccountId; market_id: string; amount: U128 } }
  | { event: "withdrawal_requested"; data: { account_id: AccountId; withdrawal_id: U64; receiver_id: AccountId; amount: U128 } }
  | { event: "withdrawal_completed" | "withdrawal_failed_restored"; data: { account_id: AccountId; withdrawal_id: U64; amount: U128 } }
  | { event: "storage_registered"; data: { account_id: AccountId; payer_id: AccountId; storage_deposit_yocto: U128 } };
