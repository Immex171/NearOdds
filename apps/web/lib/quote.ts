import { mulPrice } from "./amounts";
import type { Offer, Outcome, Quote, Side } from "./types";

/** Walk the existing offers for a take. Buying lifts asks (cheapest first); selling hits bids (highest first).
 *  The YES and NO books are independent: a NO quote is never derived from a YES quote. */
export function quoteTake(book: Offer[], outcome: Outcome, side: Side, qty: bigint, exclude?: string): Quote {
  const wanted = side === "buy" ? "sell" : "buy";
  const levels = book
    .filter((o) => o.outcome === outcome && o.side === wanted && o.qty > 0n && o.owner !== exclude)
    .sort((a, b) => (side === "buy" ? Number(a.price - b.price) : Number(b.price - a.price)));
  let left = qty;
  let total = 0n;
  let filled = 0n;
  const fills: Quote["fills"] = [];
  for (const o of levels) {
    if (left <= 0n) break;
    const take = left < o.qty ? left : o.qty;
    fills.push({ offerId: o.id, price: o.price, qty: take });
    total += mulPrice(o.price, take);
    filled += take;
    left -= take;
  }
  return { fills, filled, unfilled: left, total, avgPrice: filled > 0n ? (total * 1_000_000n) / filled : null };
}

export function bestPrice(book: Offer[], outcome: Outcome, side: Side, exclude?: string): bigint | null {
  const q = quoteTake(book, outcome, side, 1n, exclude);
  return q.fills[0]?.price ?? null;
}

export function depth(book: Offer[], outcome: Outcome, side: Side, exclude?: string): bigint {
  const wanted = side === "buy" ? "sell" : "buy";
  return book.filter((o) => o.outcome === outcome && o.side === wanted && o.owner !== exclude).reduce((a, o) => a + o.qty, 0n);
}
