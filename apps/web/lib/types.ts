export const CATEGORIES = ["Crypto", "Sports", "Politics", "Economy", "Technology"] as const;
export type Category = (typeof CATEGORIES)[number];
export type MarketStatus = "open" | "closed" | "awaiting" | "resolved";
export type Outcome = "YES" | "NO";
export type Side = "buy" | "sell";

export interface Market {
  id: string;
  question: string;
  /** null = the source has no category (live markets never invent one). */
  category: Category | null;
  /** Category-specific tag, e.g. crypto asset. */
  tag?: string;
  /** Short glyph for the topic thumbnail. */
  icon: string;
  description: string;
  status: MarketStatus;
  /** Unix ms. null = the source does not record a creation time. */
  createdAt: number | null;
  /** Trading cutoff, unix ms. This is NOT the observation period. */
  closesAt: number;
  /** Total traded collateral, base units. null = unavailable (no indexer). */
  volume: bigint | null;
  /** Live only: the contract's own action flags (get_market). Absent in demo. */
  flags?: { splitOpen: boolean; mergeOpen: boolean; tradingOpen: boolean };
  /** Display probability: last YES trade price in base units (1_000_000 = 1.0). null = no trades. */
  lastYes: bigint | null;
  /** Price 24h ago, for movement. */
  prevYes: bigint | null;
  hasHistory: boolean;
  featured?: boolean;
  trendScore: number;
  resolution: {
    yesWins: string;
    /** Empty when the canonical config provides a single rules text. */
    noWins: string;
    source: { name: string; field: string };
    /** `at` is a single instant (ms) when the result is read at one moment; null for window/event markets. */
    observation: { at: number | null; text: string };
    /** What happens when source data is missing. */
    ifMissing: string;
    resolver: string;
    outcome: Outcome | null;
    note?: string;
  };
}

export interface Offer {
  id: string;
  marketId: string;
  outcome: Outcome;
  /** buy = bid, sell = ask */
  side: Side;
  price: bigint;
  qty: bigint;
  owner: string;
  createdAt: number;
  /** Absent/true = fillable now; false = expired or trading closed (still cancellable). */
  fillable?: boolean;
  /** Unix ms; null/absent = no expiry (the market cutoff still applies). */
  expiresAt?: number | null;
}

export interface OpenOffer extends Offer {
  status: "open";
}

export interface HistoryPoint { t: number; p: number }

export interface ActivityItem {
  id: string;
  t: number;
  text: string;
  kind: "trade" | "offer" | "event";
}

export interface Position {
  marketId: string;
  outcome: Outcome;
  qty: bigint;
  /** Average entry price in base units, if known. */
  avgPrice: bigint | null;
  /** Shares locked behind the account's open sell offers (not included in `qty`). */
  reserved: bigint;
}

export interface AccountState {
  accountId: string;
  isDemo: boolean;
  walletBalance: bigint;
  available: bigint;
  committed: bigint;
  pendingWithdrawal: bigint;
  positions: Position[];
  offers: OpenOffer[];
  activity: ActivityItem[];
  /** live only */
  registered?: boolean;
  /** Native NEAR (yoctoNEAR) needed to register with the market. Never collateral. */
  storageCostYocto?: bigint;
  maxOpenOffers: number;
  withdrawalStatus?: "Pending" | "Completed" | "FailedRestored" | null;
  /** Live only: the latest withdrawal record (pending or last settled). */
  withdrawal?: { id: string; amount: bigint; status: "Pending" | "Completed" | "FailedRestored" } | null;
  /** Live only: registered with the collateral token (NEP-145). */
  tokenRegistered?: boolean;
  /** Live only: native NEAR balance in yoctoNEAR (fees, storage). */
  nearBalance?: bigint;
}

/** Trading limits. Live values come from get_config(); demo uses the documented defaults. All base units. */
export interface Limits {
  priceScale: bigint;
  tick: bigint;
  minPrice: bigint;
  maxPrice: bigint;
  lot: bigint;
  minOrder: bigint;
  maxOpenOffers: number;
}

/** What redeem would do now (get_redemption_preview). */
export interface RedeemPreview {
  redeemable: boolean;
  outcome: Outcome | null;
  winningShares: bigint;
  losingShares: bigint;
  payout: bigint;
  releasedCollateral: bigint;
  releasedShares: bigint;
  offersToRelease: number;
  availableAfter: bigint;
}

/** Live deployment verification state. Transactions stay disabled until it is "ok". */
export type Deployment = { state: "idle" | "checking" } | { state: "ok" } | { state: "error"; problems: string[] };

export interface Capabilities {
  trading: boolean;
  limitOffers: boolean;
  partialFills: boolean;
  cancelOffers: boolean;
  deposit: boolean;
  withdraw: boolean;
  completeSets: boolean;
  redeem: boolean;
  history: boolean;
}

/** "unconfirmed" = finished but the outcome is not proven (e.g. a withdrawal still Pending). Never treat it as success or failure. */
export type TxPhase = "idle" | "review" | "awaiting-wallet" | "submitted" | "confirming" | "confirmed" | "unconfirmed" | "failed";
export interface TxState { phase: TxPhase; message?: string; hash?: string }
export type TxReporter = (s: TxState) => void;

export interface CreateOfferRequest {
  marketId: string;
  outcome: Outcome;
  side: Side;
  /** Collateral base units per whole share (multiple of the price tick). */
  price: bigint;
  /** Share base units (multiple of the lot). */
  qty: bigint;
  /** Optional expiry, unix ms in the future (contract `expires_at_ns`). */
  expiresAt?: number;
}

export interface Fill { offerId: string; price: bigint; qty: bigint }
export interface Quote {
  fills: Fill[];
  filled: bigint;
  unfilled: bigint;
  /** Total collateral cost (buy) or proceeds (sell). */
  total: bigint;
  avgPrice: bigint | null;
}

export interface DataAdapter {
  id: "demo" | "near";
  label: string;
  symbol: string;
  capabilities: Capabilities;
  subscribe(cb: () => void): () => void;
  listMarkets(): Promise<Market[]>;
  getMarket(id: string): Promise<Market | null>;
  getBook(id: string): Promise<Offer[]>;
  getHistory(id: string): Promise<HistoryPoint[] | null>;
  getActivity(id: string): Promise<ActivityItem[]>;
  getAccount(accountId: string): Promise<AccountState | null>;
  deposit(amount: bigint, r: TxReporter): Promise<void>;
  withdraw(amount: bigint, r: TxReporter): Promise<void>;
  split(marketId: string, amount: bigint, r: TxReporter): Promise<void>;
  merge(marketId: string, amount: bigint, r: TxReporter): Promise<void>;
  /** Rests a fully funded offer (contract `create_offer`). */
  createOffer(req: CreateOfferRequest, r: TxReporter): Promise<void>;
  /** Takes `qty` (partial allowed) from one specific offer (contract `fill_offer`). */
  fillOffer(offerId: string, qty: bigint, r: TxReporter): Promise<void>;
  cancelOffer(offerId: string, r: TxReporter): Promise<void>;
  redeem(marketId: string, r: TxReporter): Promise<void>;
  /** Trading limits in force for this adapter. */
  limits: Limits;
  /** Preview of `redeem` for the connected account (null when not applicable). */
  redeemPreview(marketId: string, accountId: string): Promise<RedeemPreview | null>;
  reset?(): void;
  /** Live only: register with the collateral token (NEP-145). */
  registerToken?(r: TxReporter): Promise<void>;
  /** Live only: register with the market contract. */
  registerMarket?(r: TxReporter): Promise<void>;
}
