import { slotOf, type Slot } from "./config.js";

/** Trading parameters as read from get_config().trading (never hard-coded). */
export interface Trading { scale: bigint; tick: bigint; minPrice: bigint; maxPrice: bigint; lot: bigint; minOrder: bigint; maxOpenOffers: number }
export const tradingFrom = (t: { price_scale: string; price_tick: string; min_price: string; max_price: string; quantity_lot: string; min_order_quantity: string; max_open_offers_per_account: number }): Trading => ({
  scale: BigInt(t.price_scale), tick: BigInt(t.price_tick), minPrice: BigInt(t.min_price), maxPrice: BigInt(t.max_price), lot: BigInt(t.quantity_lot), minOrder: BigInt(t.min_order_quantity), maxOpenOffers: t.max_open_offers_per_account,
});

export interface Reason { code: string; message: string; slot?: Slot }
export interface Leg { slot: Slot; outcome: "Yes" | "No"; side: "Buy" | "Sell"; price: bigint }

export const floorTick = (x: bigint, tick: bigint) => x - (x % tick);
export const ceilTick = (x: bigint, tick: bigint) => (x % tick === 0n ? x : x + (tick - (x % tick)));
export const floorLot = (q: bigint, lot: bigint) => q - (q % lot);

/**
 * Four target prices around a reference YES price. referenceNo = scale - referenceYes.
 * Bids round DOWN to a tick, asks round UP. Legs are skipped (with a reason) when outside [minPrice, maxPrice], when bid >= ask,
 * or when the combined YES/NO constraints fail:  YES bid + NO bid <= scale  and  YES ask + NO ask >= scale.
 */
export function computeLegs(t: Trading, referenceYes: bigint, spread: bigint): { legs: Leg[]; reasons: Reason[]; referenceNo: bigint } {
  const reasons: Reason[] = [];
  const referenceNo = t.scale - referenceYes;
  if (referenceYes <= 0n || referenceYes >= t.scale) return { legs: [], reasons: [{ code: "reference_out_of_range", message: `reference YES price ${referenceYes} must be between 0 and ${t.scale}` }], referenceNo };
  const per = (outcome: "Yes" | "No", ref: bigint) => {
    const bid = floorTick(ref - spread, t.tick), ask = ceilTick(ref + spread, t.tick);
    const out: { bid?: bigint; ask?: bigint } = {};
    const bidSlot = slotOf(outcome, "Buy"), askSlot = slotOf(outcome, "Sell");
    if (bid >= ask) { reasons.push({ code: "crossed_quote", message: `${outcome}: bid ${bid} >= ask ${ask}`, slot: bidSlot }); return out; }
    if (bid < t.minPrice || bid > t.maxPrice) reasons.push({ code: "price_out_of_range", message: `${outcome} bid ${bid} outside [${t.minPrice}, ${t.maxPrice}]`, slot: bidSlot }); else out.bid = bid;
    if (ask < t.minPrice || ask > t.maxPrice) reasons.push({ code: "price_out_of_range", message: `${outcome} ask ${ask} outside [${t.minPrice}, ${t.maxPrice}]`, slot: askSlot }); else out.ask = ask;
    return out;
  };
  const y = per("Yes", referenceYes), n = per("No", referenceNo);
  if (y.bid !== undefined && n.bid !== undefined && y.bid + n.bid > t.scale) { reasons.push({ code: "bids_exceed_scale", message: `YES bid + NO bid = ${y.bid + n.bid} > ${t.scale}` }); delete y.bid; delete n.bid; }
  if (y.ask !== undefined && n.ask !== undefined && y.ask + n.ask < t.scale) { reasons.push({ code: "asks_below_scale", message: `YES ask + NO ask = ${y.ask + n.ask} < ${t.scale}` }); delete y.ask; delete n.ask; }
  const legs: Leg[] = [];
  const add = (outcome: "Yes" | "No", side: "Buy" | "Sell", price?: bigint) => { if (price !== undefined) legs.push({ slot: slotOf(outcome, side), outcome, side, price }); };
  add("Yes", "Buy", y.bid); add("Yes", "Sell", y.ask); add("No", "Buy", n.bid); add("No", "Sell", n.ask);
  return { legs, reasons, referenceNo };
}

/** Exact cost in collateral of `qty` shares at `price` (the contract guarantees exactness for tick/lot multiples). */
export const cost = (qty: bigint, price: bigint, scale: bigint) => (qty * price) / scale;
