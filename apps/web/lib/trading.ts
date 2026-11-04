import { ONE, mulPrice, tryParseUnits } from "./amounts";
import type { Offer, Outcome, Side } from "./types";

/** Contract trading parameters (docs/contract-interface.md, schema v3). */
export const PRICE_TICK = 10_000n; // 0.01
export const MIN_PRICE = 10_000n;
export const MAX_PRICE = 990_000n;
export const QUANTITY_LOT = 100n; // share base units
export const MIN_ORDER_QUANTITY = 10_000n; // 0.01 share
export const MAX_OPEN_OFFERS = 10;

export type Parsed = { ok: true; value: bigint } | { ok: false; error: string };

/** Share quantity input -> base units; must be a multiple of the lot. */
export function parseQuantity(input: string, opts: { min?: bigint } = {}): Parsed {
  const r = tryParseUnits(input);
  if (!r.ok) return r;
  if (r.value === 0n) return { ok: false, error: "Enter an amount above zero" };
  if (r.value % QUANTITY_LOT !== 0n) return { ok: false, error: "Shares must be a multiple of 0.0001" };
  if (opts.min && r.value < opts.min) return { ok: false, error: "Minimum order is 0.01 shares" };
  return r;
}

/** Price input ("0.62") -> base units; multiple of the 0.01 tick within [0.01, 0.99]. */
export function parsePrice(input: string): Parsed {
  const r = tryParseUnits(input);
  if (!r.ok) return r;
  if (r.value % PRICE_TICK !== 0n) return { ok: false, error: "Price must be a multiple of 0.01" };
  if (r.value < MIN_PRICE || r.value > MAX_PRICE) return { ok: false, error: "Price must be between 0.01 and 0.99" };
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
