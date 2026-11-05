/**
 * Response shapes of the NearOdds backend (apps/backend, /v1). Additive: contract types live in market.ts.
 * All amounts, prices and ids are DECIMAL STRINGS (base units). Source of truth: apps/backend/src/api/dto.ts + docs/backend.md.
 */
import type { MarketStatus, Outcome, ResolutionView, TradingParams } from "./market";

export interface ApiFreshness { blockHeight: number | null; tipHeight: number | null; lagBlocks: number | null; checkpointUpdatedAt: string | null; generatedAt: string }
export interface ApiOutcomeQuote { bestBid: string | null; bestAsk: string | null; lastTrade: string | null; displayed: string | null; basis: "midpoint" | "last_trade" | "none" }

export interface ApiMarket {
  marketRef: string;
  network: string;
  /** Use these for wallet calls: receiver = contractId, `market_id` argument = marketId. */
  contract: { contractId: string; marketId: string; tokenId: string };
  question: string; rules: string; resolutionSource: string; category: string | null; tag: string | null;
  token: { symbol: string; name: string; decimals: number; isTestToken: boolean };
  status: MarketStatus; uiStatus: "open" | "awaiting" | "resolved"; tradingOpen: boolean;
  tradingCutoff: { ns: string; iso: string | null };
  observation: { startNs: string | null; endNs: string | null; startIso: string | null; endIso: string | null };
  resolver: string; resolution: ResolutionView | null;
  trustModel: { model: string; summary: string; voidSupported: false; disputesSupported: false };
  trading: TradingParams;
  volume: string; tradeCount: number; openOfferCount: number;
  quotes: { Yes: ApiOutcomeQuote; No: ApiOutcomeQuote } | null;
  supply: { outstandingYes: string; outstandingNo: string; marketBacking: string };
  source: "imported-demo" | "keeper"; templateId: string | null; occurrenceKey: string | null;
  createdAt: string; verifiedAt: string;
  coverage: { historyComplete: boolean; historyStartHeight: number | null; indexedThrough: number | null; note: string };
  reconcile: { ok: boolean; blockHeight: number; at: string; driftCount: number } | null;
}
export interface ApiPage<T> { items: T[]; page: { limit: number; offset: number; total: number }; freshness: ApiFreshness }

export interface ApiBookOffer { offerId: string; offerRef: string; owner: string; price: string; remainingQuantity: string; originalQuantity: string; expiresAtNs: string | null; createdAtNs: string }
export interface ApiBookSide { bids: ApiBookOffer[]; asks: ApiBookOffer[]; bidLevels: { price: string; quantity: string }[]; askLevels: { price: string; quantity: string }[]; empty: boolean }
export interface ApiBook {
  marketRef: string; contract: { contractId: string; marketId: string }; status: MarketStatus;
  yes: ApiBookSide; no: ApiBookSide;
  unfillable: (ApiBookOffer & { outcome: Outcome; side: "Buy" | "Sell"; reason: "expired" | "market_closed"; cancellable: true })[];
  note: string; freshness: ApiFreshness;
}
export interface ApiTrade { tradeId: string; offerId: string; outcome: Outcome; price: string; quantity: string; collateralAmount: string; maker: string; taker: string; makerSide: "Buy" | "Sell"; takerSide: "Buy" | "Sell"; blockHeight: number; timestampNs: string; receiptId: string }
export interface ApiCandle { startNs: string; open: string; high: string; low: string; close: string; volume: string; shares: string; trades: number }
export interface ApiWithdrawal { marketRef: string; withdrawalId: string; withdrawalRef: string; amount: string; status: "Pending" | "Completed" | "FailedRestored"; receiver: string | null; requestedNs: string; settledNs: string | null; confirmed: boolean }

/** SSE event names on GET /v1/stream. Every payload carries `freshness`; refetch snapshots after reconnecting. */
export type ApiStreamEvent = "hello" | "heartbeat" | "market_created" | "market_status" | "book" | "trade" | "account";
