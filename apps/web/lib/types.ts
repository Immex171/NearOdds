export const CATEGORIES = ["Crypto", "Sports", "Politics", "Economy", "Technology"] as const;
export type Category = (typeof CATEGORIES)[number];
export type MarketStatus = "open" | "closed" | "awaiting" | "resolved";
export type Outcome = "YES" | "NO";
export type Side = "buy" | "sell";

export interface Market {
  id: string;
  question: string;
  category: Category;
  /** Category-specific tag, e.g. crypto asset. */
  tag?: string;
  /** Short glyph for the topic thumbnail. */
  icon: string;
  description: string;
  status: MarketStatus;
  /** Unix ms. */
  createdAt: number;
  closesAt: number;
  /** Total traded collateral, base units. */
  volume: bigint;
  /** Display probability: last YES trade price in base units (1_000_000 = 1.0). null = no trades. */
  lastYes: bigint | null;
  /** Price 24h ago, for movement. */
  prevYes: bigint | null;
  hasHistory: boolean;
  featured?: boolean;
  trendScore: number;
  resolution: {
    yesWins: string;
    noWins: string;
    source: string;
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
  withdrawalStatus?: "Pending" | "Completed" | "FailedRestored" | null;
}

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

export type TxPhase = "idle" | "review" | "awaiting-wallet" | "submitted" | "confirming" | "confirmed" | "failed";
export interface TxState { phase: TxPhase; message?: string; hash?: string }
export type TxReporter = (s: TxState) => void;

export interface TradeRequest {
  marketId: string;
  outcome: Outcome;
  side: Side;
  mode: "take" | "limit";
  qty: bigint;
  /** limit only */
  price?: bigint;
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
  trade(req: TradeRequest, r: TxReporter): Promise<void>;
  cancelOffer(offerId: string, r: TxReporter): Promise<void>;
  redeem(marketId: string, r: TxReporter): Promise<void>;
  reset?(): void;
  /** Live only: register the account with the market and the token. */
  register?(r: TxReporter): Promise<void>;
}
