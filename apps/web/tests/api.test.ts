import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "@/lib/api/client";
import { movementFromCandles, observationText, toActivity, toHistory, toMarket, toOffers } from "@/lib/api/map";
import { openStream } from "@/lib/api/stream";
import { authenticate, base58ToBytes, base64ToBytes, signatureToBase64 } from "@/lib/auth";
import { basisLabel } from "@/lib/format";
import { faucetRefusal } from "@/lib/faucet";
import { FRESH, apiMarket } from "./helpers";

const C = { contractId: "mkt-a.testnet", marketId: "mkt-1", tokenId: "tok.testnet" };
const res = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) }) as unknown as Response;

describe("typed API client", () => {
  it("builds the documented URLs, encodes refs and never sends auth on public routes", async () => {
    const f = vi.fn(async () => res(200, { items: [], page: { limit: 100, offset: 0, total: 0 }, freshness: FRESH }));
    const api = createApi({ baseUrl: "http://api.test/", fetchImpl: f as unknown as typeof fetch, token: () => "T" });
    await api.markets({ q: "rain", category: "Weather", status: "open", sort: "closing", limit: 20 });
    await api.market("m_1/x"); await api.book("m_1"); await api.trades("m_1", { limit: 10 }); await api.candles("m_1", { outcome: "No", interval: "1h" }); await api.activity("m_1", 5);
    await api.portfolio("alice.testnet"); await api.accountOffers("alice.testnet"); await api.accountWithdrawals("alice.testnet"); await api.accountActivity("alice.testnet", 5); await api.categories();
    const urls = f.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual([
      "http://api.test/v1/markets?q=rain&category=Weather&status=open&sort=closing&limit=20", "http://api.test/v1/markets/m_1%2Fx", "http://api.test/v1/markets/m_1/book",
      "http://api.test/v1/markets/m_1/trades?limit=10", "http://api.test/v1/markets/m_1/candles?outcome=No&interval=1h", "http://api.test/v1/markets/m_1/activity?limit=5",
      "http://api.test/v1/accounts/alice.testnet/portfolio", "http://api.test/v1/accounts/alice.testnet/offers", "http://api.test/v1/accounts/alice.testnet/withdrawals",
      "http://api.test/v1/accounts/alice.testnet/activity?limit=5", "http://api.test/v1/categories",
    ]);
    expect(f.mock.calls.every((c) => !JSON.stringify((c as unknown as [string, RequestInit])[1].headers).includes("authorization"))).toBe(true);
  });
  it("authenticated routes send the bearer token and refuse to run without one", async () => {
    let tok: string | null = null;
    const f = vi.fn(async () => res(200, { items: [] }));
    const api = createApi({ baseUrl: "http://api.test", fetchImpl: f as unknown as typeof fetch, token: () => tok });
    await expect(api.watchlist()).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(f).not.toHaveBeenCalled();
    tok = "abc";
    await api.watchlist(); await api.watch("m_1"); await api.unwatch("m_1");
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual(["GET http://api.test/v1/watchlist", "PUT http://api.test/v1/watchlist/m_1", "DELETE http://api.test/v1/watchlist/m_1"]);
    expect(calls.every(([, i]) => (i.headers as Record<string, string>).authorization === "Bearer abc")).toBe(true);
  });
  it("faucet claims carry the Idempotency-Key header; the same key is sent on a retry", async () => {
    const f = vi.fn(async () => res(202, { claimId: "c1", amount: "1", state: "queued", jobState: "queued" }));
    const api = createApi({ baseUrl: "http://api.test", fetchImpl: f as unknown as typeof fetch, token: () => "T" });
    await api.claimFaucet("key-12345678"); await api.claimFaucet("key-12345678");
    const keys = (f.mock.calls as unknown as Array<[string, RequestInit]>).map(([, i]) => (i.headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toEqual(["key-12345678", "key-12345678"]);
  });
  it("turns error bodies, outages and non-JSON answers into typed ApiErrors", async () => {
    const mk = (r: Promise<Response> | (() => Promise<Response>)) => createApi({ baseUrl: "http://api.test", fetchImpl: (typeof r === "function" ? r : () => r) as unknown as typeof fetch });
    await expect(mk(async () => res(429, { error: { code: "cooldown", message: "wait 60s between claims" } })).faucet()).rejects.toMatchObject({ status: 429, code: "cooldown", message: "wait 60s between claims" });
    await expect(mk(async () => res(503, { error: { code: "rpc_unavailable", message: "x" } })).book("m")).rejects.toMatchObject({ status: 503, code: "rpc_unavailable" });
    await expect(mk(async () => res(502, undefined)).book("m")).rejects.toMatchObject({ status: 502 });
    const down = await mk(async () => { throw new TypeError("Failed to fetch"); }).book("m").catch((e) => e);
    expect(down).toBeInstanceOf(ApiError);
    expect(down.unreachable).toBe(true);
  });
});

describe("backend market -> UI model", () => {
  it("never labels a midpoint as a last trade and keeps bid/ask/last/displayed apart", () => {
    const m = toMarket(apiMarket("m_1", C, { quotes: { Yes: { bestBid: "550000", bestAsk: "650000", lastTrade: "650000", displayed: "600000", basis: "midpoint" }, No: { bestBid: null, bestAsk: "350000", lastTrade: null, displayed: null, basis: "none" } } }));
    expect(m.lastYes).toBe(600_000n);
    expect(m.yesBasis).toBe("midpoint");
    expect(m.quotes!.YES).toMatchObject({ bestBid: 550_000n, bestAsk: 650_000n, lastTrade: 650_000n, displayed: 600_000n });
    expect(m.quotes!.NO).toMatchObject({ displayed: null, lastTrade: null, bestAsk: 350_000n });
    expect(basisLabel(m.yesBasis)).toBe("midpoint of the best bid and ask");
    expect(basisLabel("last_trade")).not.toMatch(/midpoint/);
  });
  it("uses the contract identity for wallet calls and the marketRef for the frontend identity", () => {
    const m = toMarket(apiMarket("m_abc", { contractId: "mkt-x.testnet", marketId: "mkt-1", tokenId: "tok-x.testnet" }));
    expect(m.id).toBe("m_abc");
    expect(m.contract).toEqual({ contractId: "mkt-x.testnet", marketId: "mkt-1", tokenId: "tok-x.testnet" });
  });
  it("keeps the trading cutoff apart from the observation window and states both in UTC and WAT", () => {
    const m = toMarket(apiMarket("m_1", C));
    expect(new Date(m.closesAt).toISOString()).toBe("2026-11-11T23:00:00.000Z");
    expect(m.observationWindow).toEqual({ startMs: Date.parse("2026-11-11T23:00:00Z"), endMs: Date.parse("2026-11-12T23:00:00Z") });
    expect(observationText(m.observationWindow!.startMs, m.observationWindow!.endMs)).toBe("Nov 11, 2026, 11:00 PM UTC to Nov 12, 2026, 11:00 PM UTC (Nov 12, 2026, 12:00 AM WAT to Nov 13, 2026, 12:00 AM WAT)");
  });
  it("accepts any category (e.g. Weather) and invents nothing for an imported market", () => {
    const m = toMarket(apiMarket("m_1", C, { category: "Weather", source: "imported-demo" }));
    expect(m.category).toBe("Weather");
    expect(m.createdAt).toBeNull();
    expect(toMarket(apiMarket("m_2", C, { source: "keeper" })).createdAt).toBe(Date.parse("2026-11-01T00:00:00.000Z"));
    expect(toMarket(apiMarket("m_3", C, { category: null })).category).toBeNull();
  });
  it("flags volume as partial while history is incomplete", () => {
    const partial = toMarket(apiMarket("m_1", C, { volume: "65", coverage: { historyComplete: false, historyStartHeight: 1, indexedThrough: null, note: "Trade history may be incomplete" } }));
    expect(partial.volumePartial).toBe(true);
    expect(partial.coverage).toMatchObject({ historyComplete: false, note: "Trade history may be incomplete" });
    expect(toMarket(apiMarket("m_2", C)).volumePartial).toBe(false);
  });
  it("carries the reconcile state so drift can be shown", () => {
    const m = toMarket(apiMarket("m_1", C, { reconcile: { ok: false, blockHeight: 1, at: "x", driftCount: 5 } }));
    expect(m.coverage).toMatchObject({ reconcileOk: false, driftCount: 5 });
  });
  it("YES and NO books stay separate; unfillable offers are marked not fillable; ids are refs with local offer ids kept", () => {
    const o = (id: string, price: string) => ({ offerId: id, offerRef: `m_1:${id}`, owner: "lp", price, remainingQuantity: "10", originalQuantity: "10", expiresAtNs: null, createdAtNs: "1" });
    const book = { marketRef: "m_1", contract: C, status: "Open", yes: { bids: [o("1", "500000")], asks: [o("2", "650000")], bidLevels: [], askLevels: [], empty: false }, no: { bids: [], asks: [o("3", "350000")], bidLevels: [], askLevels: [], empty: false }, unfillable: [{ ...o("9", "400000"), outcome: "No", side: "Sell", reason: "expired", cancellable: true }], note: "", freshness: FRESH } as never;
    const offers = toOffers(book, "m_1");
    expect(offers.map((x) => [x.offerId, x.outcome, x.side, x.fillable])).toEqual([["1", "YES", "buy", true], ["2", "YES", "sell", true], ["3", "NO", "sell", true], ["9", "NO", "sell", false]]);
    expect(offers[0].id).toBe("m_1:1");
  });
});

describe("history and movement come only from confirmed fills", () => {
  const H = 3_600_000;
  const now = Date.UTC(2026, 10, 5, 12);
  const c = (ago: number, close: string) => ({ startNs: String(BigInt(now - ago) * 1_000_000n), open: close, high: close, low: close, close, volume: "1", shares: "1", trades: 1 });
  it("returns null (unavailable) with no fills, never a fabricated line", () => expect(toHistory([])).toBeNull());
  it("maps candle closes to probability points", () => expect(toHistory([c(2 * H, "650000")])).toEqual([{ t: now - 2 * H, p: 0.65 }]));
  it("shows a 24h movement only with complete history and a price from at least 24h ago", () => {
    const candles = [c(30 * H, "500000"), c(2 * H, "650000")];
    expect(movementFromCandles(candles, now, 600_000n, true)).toEqual({ delta: 10, label: "▲ 10 pts vs 24h ago" });
    expect(movementFromCandles(candles, now, 600_000n, false)).toBeNull(); // partial history
    expect(movementFromCandles([c(2 * H, "650000")], now, 600_000n, true)).toBeNull(); // nothing old enough
    expect(movementFromCandles(candles, now, null, true)).toBeNull(); // no current price
  });
  it("activity text describes trades with the market's own token symbol", () => {
    expect(toActivity({ id: "1", marketRef: "m", account: "probe.testnet", kind: "fill_taker", amount: "65", detail: { price: "650000", quantity: "100", outcome: "Yes" }, timestampNs: "1000000", receiptId: null }, "tNOC").text).toBe("probe.testnet traded 0.0001 YES at 0.65 tNOC");
  });
});

describe("SSE as notifications", () => {
  class FakeES {
    static all: FakeES[] = [];
    readyState = 1; closed = false; onerror: ((e: unknown) => void) | null = null;
    private h = new Map<string, Array<(e: MessageEvent) => void>>();
    constructor(readonly url: string) { FakeES.all.push(this); }
    addEventListener(t: string, f: (e: MessageEvent) => void) { this.h.set(t, [...(this.h.get(t) ?? []), f]); }
    emit(t: string, data: unknown) { (this.h.get(t) ?? []).forEach((f) => f({ data: JSON.stringify(data) } as MessageEvent)); }
    close() { this.closed = true; this.readyState = 2; }
  }
  it("reports every event type with its market and account, and a hello on each (re)connect", () => {
    vi.useFakeTimers(); FakeES.all = [];
    const seen: string[] = []; const states: string[] = [];
    const h = openStream({ url: "http://api/v1/stream?account=a", create: (u) => new FakeES(u) as never, onEvent: (e) => seen.push(`${e.type}:${e.marketRef ?? ""}:${e.account ?? ""}`), onState: (s) => states.push(s), retryMs: 100, staleMs: 1000 });
    const es = FakeES.all[0];
    es.emit("hello", { freshness: FRESH });
    for (const t of ["market_created", "market_status", "book", "trade"]) es.emit(t, { marketRef: "m_1" });
    es.emit("account", { account: "a" });
    expect(seen).toEqual(["hello::", "market_created:m_1:", "market_status:m_1:", "book:m_1:", "trade:m_1:", "account::a"]);
    // the browser connection errors out and is closed: the stream reopens and the new hello triggers a resync
    es.readyState = 2; es.onerror?.({}); expect(states.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(150);
    expect(FakeES.all).toHaveLength(2);
    FakeES.all[1].emit("hello", { resync: true });
    expect(seen.at(-1)).toBe("hello::");
    expect(states.at(-1)).toBe("live");
    h.close(); vi.useRealTimers();
  });
  it("a silent connection is reopened by the watchdog, and close() cancels everything", () => {
    vi.useFakeTimers(); FakeES.all = [];
    const h = openStream({ url: "u", create: (u) => new FakeES(u) as never, onEvent: () => undefined, retryMs: 50, staleMs: 1000 });
    vi.advanceTimersByTime(1000); vi.advanceTimersByTime(60);
    expect(FakeES.all).toHaveLength(2);
    expect(FakeES.all[0].closed).toBe(true);
    h.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeES.all).toHaveLength(2); // nothing reopens after close
    expect(FakeES.all[1].closed).toBe(true);
    vi.useRealTimers();
  });
});

describe("NEP-413 sign-in", () => {
  const nonce32 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const mkApi = () => {
    const verify = vi.fn(async () => ({ token: "TOK", accountId: "alice.testnet", expiresAt: "2099-01-01T00:00:00Z", isAdmin: false }));
    return { api: { challenge: vi.fn(async (a: string) => ({ accountId: a, message: "Sign in to NearOdds as alice.testnet. Nonce 0102.", recipient: "nearodds.app", nonce: b64(nonce32), nonceHex: "", expiresAt: "" })), verify } as never, verify };
  };
  it("asks the wallet to sign the returned message, recipient and DECODED 32-byte nonce, then submits the response", async () => {
    const { api, verify } = mkApi();
    const signMessage = vi.fn(async () => ({ accountId: "alice.testnet", publicKey: "ed25519:PK", signature: "c2ln" }));
    const s = await authenticate(api, { signMessage }, "alice.testnet", "testnet");
    expect(signMessage).toHaveBeenCalledWith("Sign in to NearOdds as alice.testnet. Nonce 0102.", "nearodds.app", expect.any(Uint8Array));
    expect([...(signMessage.mock.calls[0] as unknown as [string, string, Uint8Array])[2]]).toEqual([...nonce32]);
    expect(verify).toHaveBeenCalledWith({ accountId: "alice.testnet", publicKey: "ed25519:PK", signature: "c2ln", nonce: b64(nonce32) });
    expect(s).toMatchObject({ token: "TOK", accountId: "alice.testnet", network: "testnet" });
  });
  it("refuses a signature made by a different account than the one that signed in", async () => {
    const { api, verify } = mkApi();
    await expect(authenticate(api, { signMessage: async () => ({ accountId: "mallory.testnet", publicKey: "k", signature: "s" }) }, "alice.testnet", "testnet")).rejects.toThrow(/signed as mallory\.testnet/);
    expect(verify).not.toHaveBeenCalled();
  });
  it("converts an ed25519:<base58> signature to the base64 the backend expects", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256);
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x);
    let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const x of bytes) { if (x === 0) s = "1" + s; else break; }
    expect([...base58ToBytes(s)]).toEqual([...bytes]);
    expect(signatureToBase64(`ed25519:${s}`)).toBe(b64(bytes));
    expect(signatureToBase64("c2ln")).toBe("c2ln");
    expect([...base64ToBytes(b64(bytes))]).toEqual([...bytes]);
  });
});

describe("faucet refusals are explained", () => {
  it.each([
    ["cooldown", "cooldown"], ["account_quota", "quota"], ["global_quota", "quota"], ["native_budget", "disabled"], ["faucet_disabled", "disabled"], ["unauthenticated", "auth"],
  ])("%s -> %s", (code, kind) => expect(faucetRefusal(new ApiError(429, code, "wait 60s")).kind).toBe(kind));
});
