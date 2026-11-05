import { ONE, formatUnits, mulPrice, tryParseUnits } from "./amounts";
import type { Limits, Offer, Outcome, Side } from "./types";

/** Documented schema-v3 defaults (docs/contract-interface.md). The live adapter replaces them with get_config().trading. */
export const DEFAULT_LIMITS: Limits = {
  priceScale: 1_000_000n, tick: 10_000n, minPrice: 10_000n, maxPrice: 990_000n, lot: 100n, minOrder: 10_000n, maxOpenOffers: 10,
};
export const PRICE_TICK = DEFAULT_LIMITS.tick;
export const MIN_PRICE = DEFAULT_LIMITS.minPrice;
export const MAX_PRICE = DEFAULT_LIMITS.maxPrice;
export const QUANTITY_LOT = DEFAULT_LIMITS.lot;
export const MIN_ORDER_QUANTITY = DEFAULT_LIMITS.minOrder;
export const MAX_OPEN_OFFERS = DEFAULT_LIMITS.maxOpenOffers;

const dec = (v: bigint) => formatUnits(v, 0, 6);

export type Parsed = { ok: true; value: bigint } | { ok: false; error: string };

/** Share quantity input -> base units; must be a multiple of the lot. */
export function parseQuantity(input: string, opts: { min?: bigint; limits?: Limits } = {}): Parsed {
  const L = opts.limits ?? DEFAULT_LIMITS;
  const r = tryParseUnits(input);
  if (!r.ok) return r;
  if (r.value === 0n) return { ok: false, error: "Enter an amount above zero" };
  if (r.value % L.lot !== 0n) return { ok: false, error: `Shares must be a multiple of ${dec(L.lot)}` };
  if (opts.min && r.value < opts.min) return { ok: false, error: `Minimum order is ${dec(opts.min)} shares` };
  return r;
}

/** Price input ("0.62") -> base units; multiple of the 0.01 tick within [0.01, 0.99]. */
export function parsePrice(input: string, L: Limits = DEFAULT_LIMITS): Parsed {
  const r = tryParseUnits(input);
  if (!r.ok) return r;
  if (r.value % L.tick !== 0n) return { ok: false, error: `Price must be a multiple of ${dec(L.tick)}` };
  if (r.value < L.minPrice || r.value > L.maxPrice) return { ok: false, error: `Price must be between ${dec(L.minPrice)} and ${dec(L.maxPrice)}` };
  return r;
}

/** Exact cost; exact whenever the tick and lot rules hold, otherwise null. */
export function exactCost(price: bigint, qty: bigint): bigint | null {
  return (price * qty) % ONE === 0n ? mulPrice(price, qty) : null;
}

export const contractOutcome = (o: "YES" | "NO") => (o === "YES" ? "Yes" : "No") as "Yes" | "No";
export const uiOutcome = (o: "Yes" | "No") => (o === "Yes" ? "YES" : "NO") as "YES" | "NO";


export interface TicketValue { outcome: Outcome; side: Side; mode: "take" | "limit"; offerId: string | null }

/** Offers the user could take: the maker's side is the opposite of the user's, never the user's own, fillable, best price first. */
export function takeCandidates(book: Offer[], outcome: Outcome, side: Side, exclude?: string | null): Offer[] {
  const makerSide: Side = side === "buy" ? "sell" : "buy";
  return book
    .filter((o) => o.outcome === outcome && o.side === makerSide && o.fillable !== false && o.qty > 0n && o.owner !== exclude)
    .sort((a, b) => (side === "buy" ? Number(a.price - b.price) : Number(b.price - a.price)));
}

/** The offer a take would use: the explicit pick if still executable, else (when none was picked) the best one. */
export function resolveOffer(book: Offer[], v: TicketValue, exclude?: string | null): { offer: Offer | undefined; gone: boolean; candidates: Offer[] } {
  const candidates = takeCandidates(book, v.outcome, v.side, exclude);
  if (!v.offerId) return { offer: candidates[0], gone: false, candidates };
  const offer = candidates.find((o) => o.id === v.offerId);
  return { offer, gone: !offer, candidates };
}
