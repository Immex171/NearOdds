/**
 * Backend responses that @nearodds/types (backend-api.ts) does not define yet. They mirror apps/backend/src/api
 * exactly (routes-markets, routes-accounts, routes-auth, routes-faucet). Shapes already in the shared package
 * are imported from there, never redeclared. TODO(sync): move these into packages/types/src/backend-api.ts
 * together with the backend developer so both sides share one definition.
 */
import type { ApiBook, ApiCandle, ApiFreshness, ApiMarket, ApiTrade, ApiWithdrawal, Outcome } from "@nearodds/types";

export type { ApiBook, ApiCandle, ApiFreshness, ApiMarket, ApiTrade, ApiWithdrawal };
export type { ApiBookOffer, ApiPage } from "@nearodds/types";

export interface ApiCategory { category: string; count: number }

export interface ApiMarketDetail extends ApiMarket {
  resolutionStatus: {
    policy: string; provider: string | null; cutoffPassed: boolean; observationComplete: boolean;
    evidence: string; note: string | null; lastCheckedAt: string | null; rule: string;
  } | null;
  deployment: { artifactId: string | null; artifactVersion: string | null; artifactSha256: string | null; codeHashBase58: string | null; sourceVersion: string | null; txHashes: unknown; verification: unknown } | null;
  freshness: ApiFreshness;
}

export interface ApiTradesPage { items: ApiTrade[]; nextBefore: string | null; freshness: ApiFreshness }
export interface ApiCandlesResponse { marketRef: string; outcome: "Yes" | "No"; interval: string; methodology: string; candles: ApiCandle[]; freshness: ApiFreshness }

export interface ApiActivity {
  id: string; marketRef: string; account: string | null; kind: string; amount: string | null;
  detail: Record<string, unknown> | null; timestampNs: string; receiptId: string | null;
}
export interface ApiActivityPage { items: ApiActivity[]; freshness: ApiFreshness }

export interface ApiAccountOffer {
  marketRef: string; offerId: string; offerRef: string; outcome: Outcome; side: "Buy" | "Sell";
  price: string; remainingQuantity: string; originalQuantity: string; expiresAtNs: string | null; state: string;
}
export interface ApiPortfolioMarket {
  marketRef: string; contract: { contractId: string; marketId: string }; question: string; status: string; registered: boolean;
  token: { symbol: string; decimals: number };
  collateral: { available: string; reserved: string; pendingWithdrawal: string };
  positions: { yes: { available: string; reserved: string; total: string }; no: { available: string; reserved: string; total: string } };
  redeemed: boolean; lastReconciledHeight: number | null;
  /** The backend returns a list of drift lines (or null). */
  driftNote: string[] | string | null; redeemHint: string | null;
}
/** The API may also return "Unsettled" for records that predate the indexer (docs/backend.md, Snapshot boundaries). */
export type ApiAccountWithdrawal = Omit<ApiWithdrawal, "status"> & { status: ApiWithdrawal["status"] | "Unsettled" };
export interface ApiPortfolio { accountId: string; markets: ApiPortfolioMarket[]; openOffers: ApiAccountOffer[]; withdrawals: ApiAccountWithdrawal[]; freshness: ApiFreshness }
export interface ApiOffersPage { items: ApiAccountOffer[]; freshness: ApiFreshness }
export interface ApiWithdrawalsPage { items: ApiAccountWithdrawal[]; freshness: ApiFreshness }

export interface ApiChallenge { accountId: string; message: string; recipient: string; /** base64, 32 bytes */ nonce: string; nonceHex: string; expiresAt: string }
export interface ApiVerified { token: string; accountId: string; expiresAt: string; isAdmin: boolean }
export interface ApiSessionInfo { accountId: string; expiresAt: string; isAdmin: boolean }
export interface ApiWatchItem { marketRef: string; question: string; addedAt: string }

export interface ApiFaucetState {
  enabled: boolean; disabledReason: string | null; tokenId: string | null; amountPerClaim: string;
  limits: { perAccount: string; globalPer24h: string; cooldownSeconds: number };
  globalClaimedLast24h: string; nativeBudgetYocto: string; nativeSpentYocto: string; queuedClaims: number;
  notice: string; keyIsolation?: string;
}
export type FaucetClaimState = "queued" | "minted" | "failed";
export interface ApiFaucetClaim { claimId: string; accountId?: string; amount: string; state: FaucetClaimState; jobState: string | null; replayed?: boolean; note?: string | null }

export interface ApiErrorBody { error?: { code?: string; message?: string; details?: unknown } }

/** Event payloads on /v1/stream. Treated as notifications; snapshots are always refetched. */
export interface StreamEvent { type: "hello" | "heartbeat" | "market_created" | "market_status" | "book" | "trade" | "account"; marketRef?: string | null; account?: string | null; freshness?: ApiFreshness; resync?: boolean }
