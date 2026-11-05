import type { ApiActivity, ApiAccountOffer, ApiBook, ApiBookOffer, ApiCandle, ApiMarket, ApiMarketDetail, ApiPortfolio, ApiTrade } from "./types";
import type { MarketView } from "@nearodds/types";
import { dateTimeUtc, dateTimeWat } from "../format";
import { DEFAULT_LIMITS, uiOutcome } from "../trading";
import type { ActivityItem, HistoryPoint, Limits, Market, MarketStatus, Offer, OpenOffer, OutcomeQuote, Position, PriceBasis } from "../types";

export const nsToMs = (ns: string | null | undefined): number | null => (ns == null ? null : Number(BigInt(ns) / 1_000_000n));
const big = (v: string | null | undefined) => (v == null ? null : BigInt(v));

export const STATUS: Record<ApiMarket["status"], MarketStatus> = { Open: "open", AwaitingResolution: "awaiting", Resolved: "resolved" };

export function limitsOf(t: ApiMarket["trading"] | undefined): Limits {
  if (!t) return DEFAULT_LIMITS;
  return {
    priceScale: BigInt(t.price_scale), tick: BigInt(t.price_tick), minPrice: BigInt(t.min_price), maxPrice: BigInt(t.max_price),
    lot: BigInt(t.quantity_lot), minOrder: BigInt(t.min_order_quantity), maxOpenOffers: t.max_open_offers_per_account,
  };
}

const quote = (q: ApiMarket["quotes"] extends infer Q ? (Q extends { Yes: infer Y } ? Y : never) : never): OutcomeQuote => ({
  bestBid: big(q.bestBid), bestAsk: big(q.bestAsk), lastTrade: big(q.lastTrade), displayed: big(q.displayed), basis: q.basis as PriceBasis,
});

/** "Nov 11, 2026, 11:00 PM UTC to Nov 12, 2026, 11:00 PM UTC (Nov 12, 12:00 AM to Nov 13, 12:00 AM WAT)" */
export function observationText(startMs: number, endMs: number): string {
  return `${dateTimeUtc(startMs)} to ${dateTimeUtc(endMs)} (${dateTimeWat(startMs)} to ${dateTimeWat(endMs)})`;
}

/**
 * Backend market -> UI model. Nothing is invented: a missing quote stays null, volume is flagged as partial while the
 * history is incomplete, and the registry's own `createdAt` (when the backend listed it) is only shown for keeper-created
 * markets, never for an imported one.
 */
export function toMarket(a: ApiMarket | ApiMarketDetail): Market {
  const detail = a as Partial<ApiMarketDetail>;
  const start = nsToMs(a.observation.startNs), end = nsToMs(a.observation.endNs);
  const obs = start != null && end != null ? { startMs: start, endMs: end } : null;
  const res = a.resolution;
  const rs = detail.resolutionStatus ?? null;
  const yes = a.quotes ? quote(a.quotes.Yes) : null;
  const no = a.quotes ? quote(a.quotes.No) : null;
  return {
    id: a.marketRef,
    contract: { contractId: a.contract.contractId, marketId: a.contract.marketId, tokenId: a.contract.tokenId },
    token: { symbol: a.token.symbol, decimals: a.token.decimals, isTest: a.token.isTestToken },
    limits: limitsOf(a.trading),
    chainClaim: { question: a.question, cutoffNs: a.tradingCutoff.ns, trading: a.trading },
    quotes: yes && no ? { YES: yes, NO: no } : null,
    coverage: { historyComplete: a.coverage.historyComplete, note: a.coverage.note, reconcileOk: a.reconcile ? a.reconcile.ok : null, driftCount: a.reconcile?.driftCount ?? 0 },
    volumePartial: !a.coverage.historyComplete,
    tradeCount: a.tradeCount, openOfferCount: a.openOfferCount,
    observationWindow: obs,
    resolutionProcess: rs ? { policy: rs.policy, cutoffPassed: rs.cutoffPassed, observationComplete: rs.observationComplete, evidence: rs.evidence, note: rs.note } : undefined,
    trustSummary: a.trustModel.summary,
    source: a.source,
    question: a.question,
    category: a.category, tag: a.tag ?? undefined,
    icon: a.tag?.charAt(0).toUpperCase() || a.category?.charAt(0).toUpperCase() || a.question.trim().charAt(0).toUpperCase() || "?",
    description: a.rules,
    status: STATUS[a.status],
    createdAt: a.source === "keeper" ? Date.parse(a.createdAt) : null,
    closesAt: nsToMs(a.tradingCutoff.ns) ?? 0,
    volume: BigInt(a.volume),
    lastYes: yes?.displayed ?? null, yesBasis: yes?.basis ?? "none",
    prevYes: null, hasHistory: false,
    // Ordering by real activity, never a made-up popularity score.
    trendScore: a.tradeCount * 100 + a.openOfferCount,
    resolution: {
      yesWins: a.rules, noWins: "",
      source: { name: a.resolutionSource || "Not provided", field: "As described in the rules text" },
      observation: { at: null, text: obs ? observationText(obs.startMs, obs.endMs) : "Not stated separately; see the rules text" },
      ifMissing: rs?.rule ?? a.trustModel.summary,
      resolver: `${a.resolver} (trusted resolver)`,
      outcome: res ? uiOutcome(res.outcome) : null,
      note: res ? `Resolved by ${res.resolver_id}. Evidence (recorded, not verified): ${res.evidence}` : undefined,
    },
  };
}

/** Fresh contract view on top of the indexed market: status and action flags always come from the chain. */
export function withChainView(m: Market, mv: MarketView): Market {
  const res = mv.resolution;
  return {
    ...m,
    status: ({ Open: "open", AwaitingResolution: "awaiting", Resolved: "resolved" } as const)[mv.status],
    flags: { splitOpen: mv.split_open, mergeOpen: mv.merge_open, tradingOpen: mv.trading_open },
    resolution: {
      ...m.resolution,
      outcome: res ? uiOutcome(res.outcome) : m.resolution.outcome,
      note: res ? `Resolved by ${res.resolver_id}. Evidence (recorded, not verified): ${res.evidence}` : mv.awaiting_resolution ? "Trading has closed. Waiting for the trusted resolver to record the result." : m.resolution.note,
    },
  };
}

export function toOffers(book: ApiBook, marketRef: string): Offer[] {
  const out: Offer[] = [];
  const one = (o: ApiBookOffer, outcome: "Yes" | "No", side: "Buy" | "Sell", fillable: boolean) => out.push({
    id: o.offerRef, offerId: o.offerId, marketId: marketRef, outcome: uiOutcome(outcome), side: side === "Buy" ? "buy" : "sell",
    price: BigInt(o.price), qty: BigInt(o.remainingQuantity), owner: o.owner, createdAt: nsToMs(o.createdAtNs) ?? 0,
    fillable, expiresAt: nsToMs(o.expiresAtNs),
  });
  for (const [outcome, s] of [["Yes", book.yes], ["No", book.no]] as const) {
    s.bids.forEach((o) => one(o, outcome, "Buy", true));
    s.asks.forEach((o) => one(o, outcome, "Sell", true));
  }
  // Expired or closed offers stay visible to their owner (cancellable) but are never offered as takeable.
  book.unfillable.forEach((u) => one(u, u.outcome, u.side, false));
  return out;
}

export function toAccountOffer(o: ApiAccountOffer): OpenOffer {
  return {
    id: o.offerRef, offerId: o.offerId, marketId: o.marketRef, outcome: uiOutcome(o.outcome), side: o.side === "Buy" ? "buy" : "sell",
    price: BigInt(o.price), qty: BigInt(o.remainingQuantity), owner: "", createdAt: 0, expiresAt: nsToMs(o.expiresAtNs), status: "open",
  };
}

/**
 * Probability history for one outcome from confirmed fills. YES uses YES fills; NO fills are shown as their YES
 * equivalent (1 - price) only if the caller asks for it. Returns null when there are no confirmed fills at all.
 */
export function toHistory(candles: ApiCandle[]): HistoryPoint[] | null {
  if (!candles.length) return null;
  return candles.map((c) => ({ t: nsToMs(c.startNs) ?? 0, p: Number(BigInt(c.close)) / 1_000_000 }));
}

/** 24h movement of the YES price: only when a confirmed price at or before now-24h exists AND the history is complete. */
export function movementFromCandles(candles: ApiCandle[], now: number, current: bigint | null, complete: boolean): { delta: number; label: string } | null {
  if (!complete || current == null) return null;
  const cutoff = now - 86_400_000;
  const before = [...candles].reverse().find((c) => (nsToMs(c.startNs) ?? Infinity) <= cutoff);
  if (!before) return null;
  const d = Math.round(Number(current) / 10_000) - Math.round(Number(BigInt(before.close)) / 10_000);
  return { delta: d, label: `${d >= 0 ? "▲" : "▼"} ${Math.abs(d)} pts vs 24h ago` };
}

const num = (s: string | undefined) => (s ? Number(BigInt(s)) / 1_000_000 : 0);

export function toActivity(a: ApiActivity, symbol: string): ActivityItem {
  const d = a.detail ?? {};
  const who = a.account ? shortId(a.account) : "Someone";
  const side = String(d.side ?? ""), outcome = d.outcome ? String(d.outcome).toUpperCase() : "";
  let text: string; let kind: ActivityItem["kind"] = "event";
  switch (a.kind) {
    case "fill_taker": kind = "trade"; text = `${who} traded ${num(d.quantity as string)} ${outcome} at ${num(d.price as string)} ${symbol}`; break;
    case "offer_created": kind = "offer"; text = `${who} posted ${side.toLowerCase()} ${outcome} at ${num(d.price as string)} ${symbol}`; break;
    case "offer_cancelled": kind = "offer"; text = `${who} cancelled an offer`; break;
    case "redeem": text = `${who} redeemed a position`; break;
    default: text = `${who}: ${a.kind.replace(/_/g, " ")}`;
  }
  return { id: a.id, t: nsToMs(a.timestampNs) ?? 0, text, kind };
}
const shortId = (id: string) => (id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

export function toTradeActivity(t: ApiTrade, symbol: string): ActivityItem {
  return { id: `t${t.tradeId}`, t: nsToMs(t.timestampNs) ?? 0, kind: "trade", text: `${shortId(t.taker)} ${t.takerSide === "Buy" ? "bought" : "sold"} ${num(t.quantity)} ${t.outcome.toUpperCase()} at ${num(t.price)} ${symbol}` };
}

export function positionsFromPortfolio(p: ApiPortfolio): Position[] {
  const out: Position[] = [];
  for (const m of p.markets) {
    for (const [o, v] of [["YES", m.positions.yes], ["NO", m.positions.no]] as const) {
      if (BigInt(v.total) > 0n) out.push({ marketId: m.marketRef, outcome: o, qty: BigInt(v.available), reserved: BigInt(v.reserved), avgPrice: null });
    }
  }
  return out;
}
