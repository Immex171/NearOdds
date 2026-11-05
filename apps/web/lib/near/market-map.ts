import type { ConfigView, MarketView, OfferView } from "@nearodds/types";
import { uiOutcome } from "../trading";
import type { Market, MarketStatus, Offer } from "../types";

export const toMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);

export const STATUS: Record<MarketView["status"], MarketStatus> = { Open: "open", AwaitingResolution: "awaiting", Resolved: "resolved" };

/** The observation period is only known from the market's own rules text. Returns null if the text does not state one. */
export function observationFromRules(rules: string): string | null {
  const m = /Observation period:\s*([^.]+)\./i.exec(rules);
  return m ? m[1].trim() : null;
}

export function toOffer(o: OfferView): Offer {
  return {
    id: o.offer_id, marketId: o.market_id, outcome: uiOutcome(o.outcome), side: o.side === "Buy" ? "buy" : "sell",
    price: BigInt(o.price), qty: BigInt(o.remaining_quantity), owner: o.owner_id, createdAt: toMs(o.created_at_ns),
    fillable: o.fillable, expiresAt: o.expires_at_ns ? toMs(o.expires_at_ns) : null,
  };
}

/**
 * Maps get_market() to the UI model. Nothing here is invented: the contract has no category, creation time, volume or
 * price history, so those are null and the UI says "unavailable".
 */
export function toMarket(mv: MarketView, cfg: ConfigView | null): Market {
  const res = mv.resolution;
  const obs = observationFromRules(mv.rules);
  return {
    id: mv.market_id, question: mv.question, category: null, icon: mv.question.trim().charAt(0).toUpperCase() || "?", description: mv.rules,
    status: STATUS[mv.status], createdAt: null, closesAt: toMs(mv.split_cutoff_ns),
    volume: null, lastYes: null, prevYes: null, hasHistory: false, trendScore: 0,
    flags: { splitOpen: mv.split_open, mergeOpen: mv.merge_open, tradingOpen: mv.trading_open },
    resolution: {
      // The contract's canonical rules text, shown as published. Not rewritten by the frontend.
      yesWins: mv.rules, noWins: "",
      source: { name: mv.resolution_source || "Not provided", field: "As described in the rules text" },
      observation: { at: null, text: obs ?? "Not stated separately; see the rules text" },
      ifMissing: cfg?.resolution_model ?? "Resolved manually by one trusted resolver account. VOID and disputes are not supported.",
      resolver: `${mv.resolver_id} (trusted resolver)`,
      outcome: res ? uiOutcome(res.outcome) : null,
      note: res ? `Resolved by ${res.resolver_id}. Evidence (recorded, not verified): ${res.evidence}` : mv.awaiting_resolution ? "Trading has closed. Waiting for the trusted resolver to record the result." : undefined,
    },
  };
}
