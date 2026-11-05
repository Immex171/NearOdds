import type {
  ApiAccountOffer, ApiActivityPage, ApiBook, ApiCandlesResponse, ApiCategory, ApiChallenge, ApiFaucetClaim, ApiFaucetState, ApiMarket, ApiMarketDetail,
  ApiOffersPage, ApiPage, ApiPortfolio, ApiSessionInfo, ApiTradesPage, ApiVerified, ApiWatchItem, ApiWithdrawalsPage, ApiErrorBody,
} from "./types";

/** status 0 = the request never got an answer (offline, CORS, DNS, timeout). */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = "ApiError"; }
  get unreachable() { return this.status === 0; }
  get unauthenticated() { return this.status === 401; }
}

export interface ApiOptions {
  baseUrl: string;
  /** Bearer token for authenticated routes; read at call time so a sign-out takes effect immediately. */
  token?: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface MarketQuery { q?: string; category?: string; status?: "open" | "awaiting" | "resolved"; sort?: "newest" | "closing" | "volume"; limit?: number; offset?: number }

const enc = encodeURIComponent;

export function createApi(opts: ApiOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const f = () => opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? 12_000;

  async function req<T>(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(init.headers ?? {}) };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.auth) {
      const t = opts.token?.();
      if (!t) throw new ApiError(401, "unauthenticated", "Sign in with your wallet first.");
      headers.authorization = `Bearer ${t}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    init.signal?.addEventListener("abort", () => ctl.abort());
    let res: Response;
    try {
      res = await f()(`${base}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: ctl.signal });
    } catch (e) {
      throw new ApiError(0, "unreachable", init.signal?.aborted ? "Request cancelled" : `Could not reach the NearOdds API at ${base}${e instanceof Error && e.name === "AbortError" ? " (timed out)" : ""}.`);
    } finally { clearTimeout(timer); }
    let body: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) { try { body = JSON.parse(text); } catch { body = null; } }
    if (!res.ok) {
      const e = (body as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? `The API answered ${res.status}.`, e?.details);
    }
    return body as T;
  }
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return {
    baseUrl: base,
    markets: (q: MarketQuery = {}) => req<ApiPage<ApiMarket>>("GET", `/v1/markets${qs({ ...q })}`),
    categories: () => req<{ items: ApiCategory[] }>("GET", "/v1/categories"),
    market: (ref: string) => req<ApiMarketDetail>("GET", `/v1/markets/${enc(ref)}`),
    book: (ref: string) => req<ApiBook>("GET", `/v1/markets/${enc(ref)}/book`),
    trades: (ref: string, o: { limit?: number; before?: string } = {}) => req<ApiTradesPage>("GET", `/v1/markets/${enc(ref)}/trades${qs(o)}`),
    candles: (ref: string, o: { outcome?: "Yes" | "No"; interval?: string; limit?: number } = {}) => req<ApiCandlesResponse>("GET", `/v1/markets/${enc(ref)}/candles${qs(o)}`),
    activity: (ref: string, limit = 50) => req<ApiActivityPage>("GET", `/v1/markets/${enc(ref)}/activity${qs({ limit })}`),

    portfolio: (acct: string) => req<ApiPortfolio>("GET", `/v1/accounts/${enc(acct)}/portfolio`),
    accountOffers: (acct: string) => req<ApiOffersPage>("GET", `/v1/accounts/${enc(acct)}/offers`),
    accountWithdrawals: (acct: string) => req<ApiWithdrawalsPage>("GET", `/v1/accounts/${enc(acct)}/withdrawals`),
    accountActivity: (acct: string, limit = 50) => req<ApiActivityPage>("GET", `/v1/accounts/${enc(acct)}/activity${qs({ limit })}`),

    challenge: (accountId: string) => req<ApiChallenge>("POST", "/v1/auth/challenge", { body: { accountId } }),
    verify: (b: { accountId: string; publicKey: string; signature: string; nonce: string }) => req<ApiVerified>("POST", "/v1/auth/verify", { body: b }),
    session: () => req<ApiSessionInfo>("GET", "/v1/auth/session", { auth: true }),
    logout: () => req<{ ok: boolean }>("POST", "/v1/auth/logout", { auth: true }),

    watchlist: () => req<{ items: ApiWatchItem[] }>("GET", "/v1/watchlist", { auth: true }),
    watch: (ref: string) => req<{ marketRef: string; watching: boolean }>("PUT", `/v1/watchlist/${enc(ref)}`, { auth: true }),
    unwatch: (ref: string) => req<{ marketRef: string; watching: boolean }>("DELETE", `/v1/watchlist/${enc(ref)}`, { auth: true }),

    faucet: () => req<ApiFaucetState>("GET", "/v1/faucet"),
    /** The same idempotencyKey always returns the same claim; reuse it for every retry of one intended claim. */
    claimFaucet: (idempotencyKey: string) => req<ApiFaucetClaim>("POST", "/v1/faucet/claim", { auth: true, headers: { "idempotency-key": idempotencyKey } }),
    faucetClaim: (id: string) => req<ApiFaucetClaim>("GET", `/v1/faucet/claims/${enc(id)}`, { auth: true }),

    /** URL for EventSource (which cannot send headers). No secrets: the stream is public. */
    streamUrl: (o: { account?: string | null; markets?: string[] } = {}) => `${base}/v1/stream${qs({ account: o.account ?? undefined, markets: o.markets?.length ? o.markets.join(",") : undefined })}`,
  };
}
export type Api = ReturnType<typeof createApi>;
export type { ApiAccountOffer };
