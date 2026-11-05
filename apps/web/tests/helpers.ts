import type { ApiMarket } from "@nearodds/types";

export const TRADING = { price_scale: "1000000", price_tick: "10000", min_price: "10000", max_price: "990000", quantity_lot: "100", min_order_quantity: "10000", max_open_offers_per_account: 10, fee_bps: 0 };
export const CUTOFF_NS = "1794438000000000000";
export const FRESH = { blockHeight: 100, tipHeight: 100, lagBlocks: 0, checkpointUpdatedAt: "2026-11-05T00:00:00Z", generatedAt: "2026-11-05T00:00:00Z" };
export interface Contract { contractId: string; marketId: string; tokenId: string }

/** A backend market fixture. Override anything; contracts may share a market id and a token. */
export function apiMarket(ref: string, c: Contract, over: Partial<ApiMarket> = {}): ApiMarket {
  return {
    marketRef: ref, network: "testnet", contract: c, question: `Question for ${ref}?`, rules: "Observation period: the day. Trading closes first.", resolutionSource: "Source", category: "Weather", tag: "Lagos",
    token: { symbol: "tNOC", name: "NearOdds TEST Collateral (no value)", decimals: 6, isTestToken: true },
    status: "Open", uiStatus: "open", tradingOpen: true, tradingCutoff: { ns: CUTOFF_NS, iso: "2026-11-11T23:00:00.000Z" },
    observation: { startNs: CUTOFF_NS, endNs: "1794524400000000000", startIso: "2026-11-11T23:00:00.000Z", endIso: "2026-11-12T23:00:00.000Z" },
    resolver: "resolver.testnet", resolution: null,
    trustModel: { model: "manual-trusted-resolver", summary: "One resolver sets a final result.", voidSupported: false, disputesSupported: false },
    trading: TRADING, volume: "0", tradeCount: 0, openOfferCount: 0,
    quotes: { Yes: { bestBid: null, bestAsk: null, lastTrade: null, displayed: null, basis: "none" }, No: { bestBid: null, bestAsk: null, lastTrade: null, displayed: null, basis: "none" } },
    supply: { outstandingYes: "0", outstandingNo: "0", marketBacking: "0" },
    source: "keeper", templateId: null, occurrenceKey: null, createdAt: "2026-11-01T00:00:00.000Z", verifiedAt: "2026-11-01T00:00:00.000Z",
    coverage: { historyComplete: true, historyStartHeight: 1, indexedThrough: 100, note: "Event history is complete from historyStartHeight." }, reconcile: { ok: true, blockHeight: 100, at: "2026-11-05T00:00:00Z", driftCount: 0 },
    ...over,
  } as ApiMarket;
}

/** Contract-side views for a market (what the RPC returns). */
export function chainMarket(c: Contract, over: Record<string, unknown> = {}, question = `Question for ${c.contractId}?`) {
  return {
    market_id: c.marketId, question, rules: "r", resolution_source: "s", split_cutoff_ns: CUTOFF_NS, split_open: true, trading_cutoff_ns: CUTOFF_NS, trading_open: true,
    status: "Open", awaiting_resolution: false, resolved: false, merge_open: true, resolver_id: "resolver.testnet", resolution: null, collateral_token_id: c.tokenId, ...over,
  };
}
export const chainConfig = (c: Contract) => ({
  schema_version: 3, market_id: c.marketId, collateral_token_id: c.tokenId, resolver_id: "resolver.testnet", decimals: 6, deposit_msg: "deposit",
  storage_cost_per_account: "40960000000000000000000", resolution_model: "manual", trading: TRADING,
});
