/** Categories of the built-in demo data. Live categories come from the backend (/v1/categories) and are open-ended. */
export const DEMO_CATEGORIES = ["Crypto", "Sports", "Politics", "Economy", "Technology"] as const;
export type Category = string;
export type MarketStatus = "open" | "closed" | "awaiting" | "resolved";
export type Outcome = "YES" | "NO";
export type Side = "buy" | "sell";

/** Where a price came from. A midpoint is NOT a trade and must never be labelled "last trade". */
export type PriceBasis = "midpoint" | "last_trade" | "none";
export interface OutcomeQuote { bestBid: bigint | null; bestAsk: bigint | null; lastTrade: bigint | null; displayed: bigint | null; basis: PriceBasis }

/** The contract identity behind a market. Wallet calls go to `contractId`; `marketId` is only the `market_id` argument. */
export interface ContractRef { contractId: string; marketId: string; tokenId: string }

/** How complete the indexed data is. Partial history must be labelled partial. */
export interface Coverage { historyComplete: boolean; note: string; reconcileOk: boolean | null; driftCount: number }

export interface Market {
  /** The frontend identity: the backend `marketRef` in live mode (route, caches, watchlist). NOT the contract's market_id. */
  id: string;
  /** Live only. Absent for demo markets. */
  contract?: ContractRef;
  /** Collateral token as verified metadata (live) or the demo token. */
  token: { symbol: string; decimals: number; isTest: boolean };
  /** Trading limits of THIS market's contract (get_config().trading, mirrored by the API). */
  limits: Limits;
  /** Per-outcome quotes (live). Null when the source has none (demo). */
  quotes: { YES: OutcomeQuote; NO: OutcomeQuote } | null;
  coverage?: Coverage;
  /** Live: what the chain must confirm before wallet actions unlock (question, cutoff, trading parameters). */
  chainClaim?: { question: string; cutoffNs: string; trading: import("@nearodds/types").TradingParams };
  /** Live: "fresh" = status and action flags were just read from the contract; "unavailable" = the RPC read failed, so only indexed data is shown. */
  chain?: "fresh" | "unavailable";
  /** Live: true when `volume` may undercount because history is partial. */
  volumePartial?: boolean;
  tradeCount?: number;
  openOfferCount?: number;
  /** Observation window in unix ms (live), separate from the trading cutoff. */
  observationWindow?: { startMs: number; endMs: number } | null;
  /** Live: how the result is produced (reviewed evidence for the Lagos market). */
  resolutionProcess?: { policy: string; cutoffPassed: boolean; observationComplete: boolean; evidence: string; note: string | null };
  trustSummary?: string;
  source?: "imported-demo" | "keeper";
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
  /** Displayed YES probability in base units (1_000_000 = 1.0); see `yesBasis` for what it is. null = no price. */
  lastYes: bigint | null;
  /** Basis of `lastYes` (live). Absent in demo, where it is the last trade. */
  yesBasis?: PriceBasis;
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
  /** Frontend identity: `offerRef` (`<marketRef>:<offerId>`) live. Different contracts reuse local offer ids. */
  id: string;
  /** The contract-local offer id: the only value ever sent to a contract. */
  offerId: string;
  /** marketRef of the market this offer belongs to. */
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
  /** marketRef */
  marketId: string;
  outcome: Outcome;
  qty: bigint;
  /** Average entry price in base units, if known. */
  avgPrice: bigint | null;
  /** Shares locked behind the account's open sell offers (not included in `qty`). */
  reserved: bigint;
}

/** A wallet's balance of ONE token contract, counted once however many markets use that token. null = unavailable. */
export interface WalletBalance { tokenId: string; symbol: string; balance: bigint | null; tokenRegistered: boolean | null }

/** Collateral deposited into ONE market contract. Deposits are per contract and never pooled across markets. */
export interface Holding {
  /** marketRef; "*" = a single pooled balance (demo only). */
  marketRef: string;
  symbol: string;
  /** Registered with the market contract; null = not applicable (demo). */
  registered: boolean | null;
  available: bigint;
  committed: bigint;
  pendingWithdrawal: bigint;
  /** Latest withdrawal record of this market. */
  withdrawal?: { id: string; amount: bigint; status: WithdrawalStatus } | null;
  /** Native NEAR (yoctoNEAR) needed to register with this market. Never collateral. */
  storageCostYocto?: bigint;
  maxOpenOffers: number;
  /** Set when the indexer and the chain disagreed about this account. */
  driftNote?: string | null;
}

/** "Unsettled" = a record from before the indexer started; its outcome is not known to the API. */
export type WithdrawalStatus = "Pending" | "Completed" | "FailedRestored" | "Unsettled";
export interface WithdrawalItem { ref: string; marketRef: string; id: string; amount: bigint; status: WithdrawalStatus; requestedAt: number; settledAt: number | null }

export interface AccountState {
  accountId: string;
  isDemo: boolean;
  wallets: WalletBalance[];
  /** Native NEAR in yoctoNEAR (fees, storage). null = unavailable. */
  nearBalance?: bigint | null;
  holdings: Holding[];
  positions: Position[];
  offers: OpenOffer[];
  activity: ActivityItem[];
  withdrawals: WithdrawalItem[];
  /** Data-quality notices to show with the numbers. */
  notes?: string[];
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
  /** marketRef (the market contract and its market_id are taken from the Market, never from this). */
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

export interface Freshness { blockHeight: number | null; lagBlocks: number | null; generatedAt: string }
export interface CategoryCount { category: string; count: number }

/**
 * Reads take a marketRef; every transaction takes the whole Market so the target contract, market_id and token are
 * unambiguous. Nothing here reads a global "current market".
 */
export interface DataAdapter {
  id: "demo" | "near";
  label: string;
  /** Fallback label only (no market in scope). Prefer `market.token.symbol`. */
  symbol: string;
  capabilities: Capabilities;
  subscribe(cb: () => void): () => void;
  /** Freshness of the most recent backend answer (live); null in demo or before the first answer. */
  freshness(): Freshness | null;
  listMarkets(): Promise<Market[]>;
  listCategories(): Promise<CategoryCount[]>;
  searchMarkets(q: string): Promise<Market[]>;
  getMarket(ref: string): Promise<Market | null>;
  getBook(ref: string): Promise<Offer[]>;
  getHistory(ref: string): Promise<HistoryPoint[] | null>;
  /** 24h YES movement. null unless complete history proves it; never estimated. */
  getMovement(m: Market, now: number): Promise<{ delta: number; label: string } | null>;
  getActivity(ref: string): Promise<ActivityItem[]>;
  /** Without a market: the whole portfolio. With one: that market's contract state, read from the chain. */
  getAccount(accountId: string, market?: Market): Promise<AccountState | null>;
  /** Verifies the market's contract, token and config before wallet actions are enabled. Demo: always ok. */
  deployment(m: Market): Deployment;
  verify(m: Market, force?: boolean): Promise<void>;
  deposit(m: Market, amount: bigint, r: TxReporter): Promise<void>;
  withdraw(m: Market, amount: bigint, r: TxReporter): Promise<void>;
  split(m: Market, amount: bigint, r: TxReporter): Promise<void>;
  merge(m: Market, amount: bigint, r: TxReporter): Promise<void>;
  /** Rests a fully funded offer (contract `create_offer`). */
  createOffer(m: Market, req: CreateOfferRequest, r: TxReporter): Promise<void>;
  /** Takes `qty` (partial allowed) from one specific offer (contract `fill_offer`). Re-reads the offer first. */
  fillOffer(m: Market, offer: Offer, qty: bigint, r: TxReporter): Promise<void>;
  cancelOffer(m: Market, offer: Offer, r: TxReporter): Promise<void>;
  redeem(m: Market, r: TxReporter): Promise<void>;
  /** Preview of `redeem` for the connected account (null when not applicable). */
  redeemPreview(m: Market, accountId: string): Promise<RedeemPreview | null>;
  reset?(): void;
  /** Live only: register with the market's collateral token (NEP-145). */
  registerToken?(m: Market, r: TxReporter): Promise<void>;
  /** Live only: register with the market contract. */
  registerMarket?(m: Market, r: TxReporter): Promise<void>;
  /** Live only, after verification: native NEAR storage costs and the account that can mint this market's token. */
  costs?(m: Market): { tokenStorage: bigint; marketStorage: bigint; tokenOwnerHint: string } | null;
}
