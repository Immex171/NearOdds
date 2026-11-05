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
export interface ApiWithdrawal { marketRef: string; withdrawalId: string; withdrawalRef: string; amount: string; status: "Pending" | "Completed" | "FailedRestored" | "Unsettled"; receiver: string | null; requestedNs: string; settledNs: string | null; confirmed: boolean }

/** SSE event names on GET /v1/stream. Every payload carries `freshness`; refetch snapshots after reconnecting. */
export type ApiStreamEvent = "hello" | "heartbeat" | "market_created" | "market_status" | "book" | "trade" | "account";

// ---------------------------------------------------------------------------------------------------------------
// Errors, market detail, portfolio, auth, watchlist, faucet and SSE payloads. Every error body is ApiErrorBody.

export interface ApiErrorBody { error: { code: string; message: string; details?: unknown } }
/** Stable error codes (HTTP status): bad_request(400) bad_account(400) bad_nonce(400) idempotency_key_required(400) unauthenticated(401)
 *  nonce_invalid(401) bad_signature(401) key_not_on_account(401) key_not_full_access(401) forbidden(403) not_found(404) proposal_exists(409)
 *  not_pending(409) cooldown(429) account_quota(429) global_quota(429) faucet_disabled(503) native_budget(503) rpc_unavailable(503) internal(500). */
export type ApiErrorCode = string;

export interface ApiCategoryCount { category: string; count: number }
export interface ApiResolutionStatus {
  policy: "reviewed" | "automatic"; provider: string | null; cutoffPassed: boolean; observationComplete: boolean;
  evidence: "missing" | "proposed" | "approved" | "ambiguous" | "provider_error" | "submitted"; note: string | null; lastCheckedAt: string | null; rule: string;
}
export interface ApiDeployment { artifactId: string; artifactVersion: string; artifactSha256: string; codeHashBase58: string | null; sourceVersion: string; txHashes: Record<string, string | null>; verification: { ok: boolean; problems?: string[] } & Record<string, unknown> }
export interface ApiMarketDetail extends ApiMarket { resolutionStatus: ApiResolutionStatus | null; deployment: ApiDeployment | null; freshness: ApiFreshness }
export type ApiBookResponse = ApiBook;
export interface ApiTradesResponse { items: ApiTrade[]; nextBefore: string | null; freshness: ApiFreshness }
export interface ApiCandlesResponse { marketRef: string; outcome: Outcome; interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d"; methodology: string; candles: ApiCandle[]; freshness: ApiFreshness }

export interface ApiPortfolioMarket {
  marketRef: string; contract: { contractId: string; marketId: string }; question: string; status: string; registered: boolean;
  token: { symbol: string; decimals: number };
  collateral: { available: string; reserved: string; pendingWithdrawal: string };
  positions: { yes: { available: string; reserved: string; total: string }; no: { available: string; reserved: string; total: string } };
  redeemed: boolean; lastReconciledHeight: number | null; driftNote: string[] | null; redeemHint: string | null;
}
export interface ApiOpenOffer { marketRef: string; offerId: string; offerRef: string; outcome: Outcome; side: "Buy" | "Sell"; price: string; remainingQuantity: string; originalQuantity: string; expiresAtNs: string | null; state: string }
export interface ApiPortfolio { accountId: string; markets: ApiPortfolioMarket[]; openOffers: ApiOpenOffer[]; withdrawals: ApiWithdrawal[]; freshness: ApiFreshness }

export interface ApiAuthChallenge { accountId: string; message: string; recipient: string; /** base64, 32 bytes: pass to wallet signMessage as nonce */ nonce: string; nonceHex: string; expiresAt: string }
export interface ApiAuthVerifyRequest { accountId: string; publicKey: string; /** base64 */ signature: string; /** the challenge nonce, base64 */ nonce: string }
export interface ApiSession { token: string; accountId: string; expiresAt: string; isAdmin: boolean }
export interface ApiWatchlistItem { marketRef: string; question: string; addedAt: string }

/** Faucet claim states: `queued` (accepted, mint pending) -> `minted`; `failed` (chain rejected; does not count toward quotas). */
export type ApiFaucetClaimState = "queued" | "minted" | "failed";
export interface ApiFaucetState {
  enabled: boolean; disabledReason: string | null; tokenId: string | null; amountPerClaim: string;
  limits: { perAccount: string; globalPer24h: string; cooldownSeconds: number };
  globalClaimedLast24h: string; nativeBudgetYocto: string; nativeSpentYocto: string; queuedClaims: number; notice: string; keyIsolation: string;
}
export interface ApiFaucetClaim { claimId: string; accountId: string; amount: string; state: ApiFaucetClaimState; jobState: string | null; replayed: boolean }

export interface ApiSseHello { freshness: ApiFreshness; resync: boolean; hint: string }
export interface ApiSseTrade { marketRef: string; offerId: string; outcome: Outcome; price: string; quantity: string; collateral: string; ts_ns: string; freshness: ApiFreshness }
export interface ApiOpsStatus {
  indexer: { checkpointHeight: number | null; tipHeight: number | null; lagBlocks: number | null; checkpointUpdatedAt: string | null; marketsCatchingUp: number; openGaps: number; gaps: { scope: string; from: number; to: number; reason: string; attempts: number }[] };
  workers: { workerId: string; role: string; lastBeatAt: string; stale: boolean; info: Record<string, unknown> }[];
  jobs: Record<string, number>;
  transactions: { unresolvedCount: number; unresolved: { opKey: string; txHash: string; signer: string; state: string; description: string; note: string | null; updatedAt: string }[] };
  generatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Trading bot (administrator API, /v1/admin/trading-bots). Execution is Sandbox/testnet only and OFF by default.

export type ApiBotMode = "paper" | "execute";
export type ApiBotDesiredState = "disabled" | "running" | "paused" | "stopped";
/** Never `paused`/`stopped` while submissions or cancellations are unresolved (`pausing`/`stopping` instead). */
export type ApiBotState = "disabled" | "paper" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "uncertain" | "needs_funding" | "setup_required";
export type ApiBotSlot = "YES_BUY" | "YES_SELL" | "NO_BUY" | "NO_SELL";

export interface ApiBotReference { yesPrice: string; noPrice: string; label: string; source: string; asOf: string; expiresAt: string; expired: boolean; note: string }
export interface ApiBotReason { code: string; message: string; slot?: ApiBotSlot }
export interface ApiBotQuote { offerId: string; offerRef: string; slot: ApiBotSlot; price: string; quantity: string; remaining: string; expiresAtNs: string | null; origin: "created" | "adopted" }
export interface ApiBotMarketStatus {
  marketRef: string; enabled: boolean; question: string | null;
  /** wallet/contract identity: offers and balances are scoped to this contract */
  contract: { contractId: string; marketId: string; tokenId: string } | null;
  reference: ApiBotReference | null;
  lastChainRead: { at: string | null; blockHeight: number | null } | null;
  balances: { collateral: { available: string; reserved: string } | null; shares: { yes: { available: string; reserved: string }; no: { available: string; reserved: string } } | null; tokenBalance: string; nativeBalanceYocto: string; registeredWithToken: boolean; registeredWithMarket: boolean } | null;
  /** after resolution: remaining positions and what redeem would pay (settlement is a manual wallet step) */
  position: { outcome: Outcome | null; redeemable: boolean; payout: string; releasedCollateral: string; winningShares: string } | null;
  needsFunding: boolean; openQuotes: ApiBotQuote[];
  lastDecision: { id: string; outcome: string; at: string; reasons: ApiBotReason[]; actions: unknown[] } | null;
}
export interface ApiBotStatus {
  id: string; slug: string;
  account: { accountId: string; network: string; credentialsConfigured: boolean };
  mode: ApiBotMode; desiredState: ApiBotDesiredState; state: ApiBotState; stateReason: string | null; configVersion: number;
  execution: { enabledByEnvironment: boolean; networkAllowed: boolean; note: string };
  limits: Record<string, string | number>; strategy: Record<string, string | number>; funding: Record<string, string | number>;
  spending: { nativeSpentYocto: string; nativeLimitYocto: string; collateralDepositedByMarket: Record<string, string> };
  markets: ApiBotMarketStatus[];
  pendingOperations: { id: string; marketRef: string; kind: string; slot: ApiBotSlot | null; opKey: string; state: "proposed" | "submitted" | "uncertain"; txHash: string | null }[];
  fills: { count: number; volume: string; note: string };
}
export interface ApiBotSummary { id: string; slug: string; account: ApiBotStatus["account"]; mode: ApiBotMode; desiredState: ApiBotDesiredState; state: ApiBotState; stateReason: string | null; configVersion: number; markets: number }
export interface ApiBotPreview { botId: string; configVersion: number; tradedNothing: true; markets: { marketRef: string; blockHeight?: number; outcome: string; legs?: { slot: ApiBotSlot; price: string }[]; referenceNo?: string | null; actions: unknown[]; reasons: ApiBotReason[] }[] }
export interface ApiBotConfigInput {
  markets: { marketRef: string; enabled?: boolean; reference: { yesPrice: string; label: string; source: string; asOf: string; expiresAt: string } | null; quantityPerQuote?: string }[];
  strategy: { spread: string; quantityPerQuote: string; quoteLifetimeSeconds: number; requoteThresholdPct?: number; refreshBeforeExpirySeconds?: number };
  funding?: { trancheId?: number; depositCollateral?: string; splitCollateral?: string };
  limits: { maxOrderQuantity: string; maxYesInventory: string; maxNoInventory: string; maxCollateralPerMarket: string; maxCollateralTotal: string; maxActiveOffersPerMarket: number; maxNativeSpendYocto: string; minNativeReserveYocto: string; estimatedTxFeeYocto?: string; maxTransactionsPerMinute: number; referenceMaxAgeSeconds: number; maxChainDataAgeSeconds: number; cutoffBufferSeconds: number };
}
export interface ApiBotCreateInput { slug: string; accountId: string; network: string; credentialsEnv?: string; config: ApiBotConfigInput }
