import type { AccountView, OfferView } from "@nearodds/types";
import { SLOTS, slotOf, slotParts, type BotConfig, type Slot } from "./config.js";
import { ceilTick, computeLegs, cost, floorLot, type Leg, type Reason, type Trading } from "./strategy.js";

/** Everything the decision needs. Chain values come from ONE finalized-block snapshot; DB values are commitments/history only. */
export interface Snapshot {
  blockHeight: number; blockTsNs: bigint;
  trading: Trading; storageCostPerAccount: bigint; tokenRegistrationDeposit: bigint;
  market: { status: "Open" | "AwaitingResolution" | "Resolved"; tradingOpen: boolean; cutoffNs: bigint; resolved: boolean };
  account: AccountView | null; offers: OfferView[];
  tokenBalance: bigint; tokenRegistered: boolean; nativeBalance: bigint;
}
export interface Facts {
  desired: "disabled" | "running" | "paused" | "stopped"; mode: "paper" | "execute";
  hasPendingOps: boolean;
  allocatedCollateral: bigint; allocatedTotal: bigint;        // confirmed deposits: this market / all markets of the bot
  nativeSpent: bigint; txLastMinute: number; recentFailures: number;
  trancheDone: { deposit: boolean; split: boolean };
}
export type Action =
  | { type: "register_token"; deposit: bigint }
  | { type: "register_market"; deposit: bigint }
  | { type: "deposit"; amount: bigint }
  | { type: "split"; amount: bigint }
  | { type: "cancel"; offerId: string; slot: Slot; reason: string }
  | { type: "create"; slot: Slot; outcome: "Yes" | "No"; side: "Buy" | "Sell"; price: bigint; quantity: bigint; expiresAtNs: bigint };

export interface Decision {
  outcome: "noop" | "acted" | "skipped" | "wind_down";
  actions: Action[]; reasons: Reason[]; needsFunding: boolean;
  legs: { slot: Slot; price: string }[]; referenceNo: string | null;
}

export interface DecideInput {
  nowMs: number; snap: Snapshot; facts: Facts; cfg: BotConfig; marketRef: string;
}

const slotOfOffer = (o: OfferView): Slot => slotOf(o.outcome, o.side);
const big = (v: string) => BigInt(v);

export function decide(inp: DecideInput): Decision {
  const { snap, facts, cfg } = inp;
  const L = cfg.limits, S = cfg.strategy, T = snap.trading;
  const configured = cfg.markets.find((m) => m.marketRef === inp.marketRef);
  // A market removed from the configuration is cancellation/reconciliation-only until its quotes and operations are gone.
  const mcfg = configured ?? { marketRef: inp.marketRef, enabled: false, reference: null, quantityPerQuote: undefined };
  const reasons: Reason[] = [];
  let legInfo: Pick<Decision, "legs" | "referenceNo"> = { legs: [], referenceNo: null };
  const out = (outcome: Decision["outcome"], actions: Action[] = [], extra: Partial<Decision> = {}): Decision => ({ outcome, actions, reasons, needsFunding: false, ...legInfo, ...extra });

  // Chain data must be recent.
  const nowNs = snap.blockTsNs;
  const ageSec = (inp.nowMs - Number(snap.blockTsNs / 1_000_000n)) / 1000;
  if (ageSec > L.maxChainDataAgeSeconds) { reasons.push({ code: "stale_chain_data", message: `latest finalized block is ${Math.round(ageSec)}s old (limit ${L.maxChainDataAgeSeconds}s)` }); return out("skipped"); }

  // ---- may we quote at all?
  let canQuote = true;
  const stop = (code: string, message: string) => { canQuote = false; reasons.push({ code, message }); };
  if (facts.desired !== "running") stop("not_running", `bot desired state is ${facts.desired}`);
  if (!configured) stop("market_removed", "market was removed from the bot configuration: only reconciliation and cancellation continue");
  else if (!mcfg.enabled) stop("market_disabled", "market is disabled in the bot configuration");
  if (snap.market.resolved || snap.market.status === "Resolved") stop("market_resolved", "market is resolved: no new quotes; remaining positions are reported");
  else if (snap.market.status !== "Open" || !snap.market.tradingOpen) stop("market_closed", `market status is ${snap.market.status}`);
  const bufferNs = BigInt(L.cutoffBufferSeconds) * 1_000_000_000n;
  if (canQuote && nowNs + bufferNs >= snap.market.cutoffNs) stop("cutoff_buffer", `inside the ${L.cutoffBufferSeconds}s buffer before the trading cutoff`);
  const ref = mcfg.reference;
  if (!ref) stop("no_reference", "no reference price configured");
  else if (inp.nowMs >= Date.parse(ref.expiresAt)) stop("reference_expired", `reference expired at ${ref.expiresAt}`);
  else if ((inp.nowMs - Date.parse(ref.asOf)) / 1000 > L.referenceMaxAgeSeconds) stop("reference_stale", `reference is older than ${L.referenceMaxAgeSeconds}s`);

  if (canQuote && ref) { const pre = computeLegs(T, big(ref.yesPrice), big(S.spread)); legInfo = { legs: pre.legs.map((l) => ({ slot: l.slot, price: l.price.toString() })), referenceNo: pre.referenceNo.toString() }; }
  if (facts.hasPendingOps) { reasons.push({ code: "operations_in_flight", message: "earlier operations are unresolved; waiting before making new decisions" }); return out("noop"); }

  const mine = snap.offers;
  // ---- wind-down: cancel everything the bot has open (cancellation is allowed at any time).
  if (!canQuote) {
    const actions: Action[] = mine.map((o) => ({ type: "cancel", offerId: o.offer_id, slot: slotOfOffer(o), reason: reasons[0]?.code ?? "wind_down" }) as Action);
    return out(actions.length ? "wind_down" : "noop", capByRate(actions, facts, L.maxTransactionsPerMinute, reasons));
  }

  if (facts.recentFailures >= 3) { reasons.push({ code: "recent_failures", message: `${facts.recentFailures} operations failed in the last 5 minutes; pausing new actions` }); return out("skipped"); }

  // ---- setup: registration, deposit, split (one step per cycle; the next cycle re-reads the chain)
  const fee = BigInt(L.estimatedTxFeeYocto), reserve = BigInt(L.minNativeReserveYocto), nativeCap = BigInt(L.maxNativeSpendYocto);
  const nativeOk = (need: bigint) => {
    if (snap.nativeBalance < need + reserve) { reasons.push({ code: "needs_native", message: `native balance ${snap.nativeBalance} is below ${need} + reserve ${reserve}` }); return false; }
    if (facts.nativeSpent + need > nativeCap) { reasons.push({ code: "native_spend_limit", message: `native spending limit ${nativeCap} would be exceeded` }); return false; }
    return true;
  };
  if (!snap.tokenRegistered) {
    if (!nativeOk(snap.tokenRegistrationDeposit + fee)) return out("skipped", [], { needsFunding: true });
    return out("acted", capByRate([{ type: "register_token", deposit: snap.tokenRegistrationDeposit }], facts, L.maxTransactionsPerMinute, reasons));
  }
  if (!snap.account) {
    if (!nativeOk(snap.storageCostPerAccount + fee)) return out("skipped", [], { needsFunding: true });
    return out("acted", capByRate([{ type: "register_market", deposit: snap.storageCostPerAccount }], facts, L.maxTransactionsPerMinute, reasons));
  }
  const account = snap.account;
  const dep = big(cfg.funding.depositCollateral), split = big(cfg.funding.splitCollateral);
  if (!facts.trancheDone.deposit && dep > 0n) {
    if (facts.allocatedCollateral + dep > big(L.maxCollateralPerMarket)) { reasons.push({ code: "market_collateral_limit", message: `deposit ${dep} would exceed the per-market collateral limit ${L.maxCollateralPerMarket}` }); return out("skipped"); }
    if (facts.allocatedTotal + dep > big(L.maxCollateralTotal)) { reasons.push({ code: "total_collateral_limit", message: `deposit ${dep} would exceed the total collateral limit ${L.maxCollateralTotal}` }); return out("skipped"); }
    if (snap.tokenBalance < dep) { reasons.push({ code: "needs_collateral", message: `bot token balance ${snap.tokenBalance} is below the deposit ${dep}` }); return out("skipped", [], { needsFunding: true }); }
    if (!nativeOk(fee)) return out("skipped", [], { needsFunding: true });
    return out("acted", capByRate([{ type: "deposit", amount: dep }], facts, L.maxTransactionsPerMinute, reasons));
  }
  if (!facts.trancheDone.split && split > 0n) {
    // A split adds the same amount of YES and NO. Check the RESULTING exposure: owned (available + reserved) + open buys that may
    // still acquire shares + the split must stay within both inventory limits (also for later funding tranches).
    const buysOf = (o: "Yes" | "No") => mine.filter((x) => x.outcome === o && x.side === "Buy").reduce((a, x) => a + big(x.remaining_quantity), 0n);
    const headYes = big(L.maxYesInventory) - (big(account.yes) + big(account.reserved_yes)) - buysOf("Yes");
    const headNo = big(L.maxNoInventory) - (big(account.no) + big(account.reserved_no)) - buysOf("No");
    const head = headYes < headNo ? headYes : headNo;
    let allowed = floorLot(split < head ? split : head > 0n ? head : 0n, T.lot);
    if (allowed < split) {
      if (allowed >= T.minOrder) reasons.push({ code: "split_reduced", message: `split reduced from ${split} to ${allowed} by the YES/NO inventory limits (headroom YES ${headYes}, NO ${headNo})` });
      else { reasons.push({ code: "split_blocked_by_inventory_limit", message: `a split of ${split} would exceed the YES/NO inventory limits (headroom YES ${headYes}, NO ${headNo}); no split` }); allowed = 0n; }
    }
    if (allowed > 0n) {
      if (big(account.available_collateral) < allowed) { reasons.push({ code: "needs_collateral", message: `available market collateral ${account.available_collateral} is below the split ${allowed}` }); return out("skipped", [], { needsFunding: true }); }
      if (!nativeOk(fee)) return out("skipped", [], { needsFunding: true });
      return out("acted", capByRate([{ type: "split", amount: allowed }], facts, L.maxTransactionsPerMinute, reasons));
    }
    // blocked by limits: keep going and quote with what is held
  }

  // ---- quotes
  const { legs, reasons: legReasons, referenceNo } = computeLegs(T, big(ref!.yesPrice), big(S.spread));
  reasons.push(...legReasons);
  const outLegs = legs.map((l) => ({ slot: l.slot, price: l.price.toString() }));
  const legBySlot = new Map<Slot, Leg>(legs.map((l) => [l.slot, l]));
  const baseQty = floorLot([big(mcfg.quantityPerQuote ?? S.quantityPerQuote), big(L.maxOrderQuantity)].reduce((a, b) => (a < b ? a : b)), T.lot);
  const maxOffers = Math.min(L.maxActiveOffersPerMarket, T.maxOpenOffers);

  const owned = { Yes: big(account.yes) + big(account.reserved_yes), No: big(account.no) + big(account.reserved_no) };
  const freeShares = { Yes: big(account.yes), No: big(account.no) };
  const maxInv = { Yes: big(L.maxYesInventory), No: big(L.maxNoInventory) };
  let freeCollateral = big(account.available_collateral);
  const bySlot = new Map<Slot, OfferView[]>(SLOTS.map((s) => [s, mine.filter((o) => slotOfOffer(o) === s)]));
  const buyRemaining = (o: "Yes" | "No", exceptSlot?: Slot) => mine.filter((x) => x.outcome === o && x.side === "Buy" && slotOfOffer(x) !== exceptSlot).reduce((a, x) => a + big(x.remaining_quantity), 0n);

  /** Largest permitted size for a slot; `own` = what the slot's existing offer already reserves (it is being re-evaluated). */
  const sizeFor = (leg: Leg, ownShares: bigint, ownCollateral: bigint, collateralLeft: bigint) => {
    let q = baseQty; let limit = "";
    if (leg.side === "Sell") {
      const cap = floorLot(freeShares[leg.outcome] + ownShares, T.lot);
      if (cap < q) { q = cap; limit = "insufficient_inventory"; }
    } else {
      const head = maxInv[leg.outcome] - owned[leg.outcome] - buyRemaining(leg.outcome, leg.slot) + 0n;
      const byInv = floorLot(head > 0n ? head : 0n, T.lot);
      const byCash = floorLot(((collateralLeft + ownCollateral) * T.scale) / leg.price, T.lot);
      if (byInv < q) { q = byInv; limit = "inventory_limit"; }
      if (byCash < q) { q = byCash; limit = "insufficient_collateral"; }
    }
    return { q, limit };
  };

  const cancels: Action[] = []; const keep = new Map<Slot, OfferView>();
  const refreshNs = BigInt(S.refreshBeforeExpirySeconds) * 1_000_000_000n;
  for (const slot of SLOTS) {
    const offers = bySlot.get(slot)!; const leg = legBySlot.get(slot);
    if (!offers.length) continue;
    if (!leg) { offers.forEach((o) => cancels.push({ type: "cancel", offerId: o.offer_id, slot, reason: "leg_not_quoted" })); continue; }
    const sorted = [...offers].sort((a, b) => (a.price === leg.price.toString() ? 0 : 1) - (b.price === leg.price.toString() ? 0 : 1) || Number(big(b.remaining_quantity) - big(a.remaining_quantity)));
    const best = sorted[0];
    sorted.slice(1).forEach((o) => cancels.push({ type: "cancel", offerId: o.offer_id, slot, reason: "excess" }));
    const { q: want } = sizeFor(leg, big(best.reserved_shares), big(best.reserved_collateral), freeCollateral);
    const rem = big(best.remaining_quantity);
    let stale = "";
    if (!best.fillable) stale = "expired";
    else if (best.price !== leg.price.toString()) stale = "price_changed";
    else if (best.expires_at_ns !== null && big(best.expires_at_ns) <= nowNs + refreshNs) stale = "expiring_soon";
    else if (best.expires_at_ns === null) stale = "no_expiry";
    else if (want < T.minOrder || rem > want) stale = "over_limit";
    else if (rem * 100n < BigInt(S.requoteThresholdPct) * want) stale = "undersized";
    if (stale) cancels.push({ type: "cancel", offerId: best.offer_id, slot, reason: stale }); else keep.set(slot, best);
  }
  // Active-offer cap (possibly just reduced): keep the offers with the largest remaining size (ties: slot order, then lowest id) and cancel the rest.
  if (keep.size > maxOffers) {
    const rank = (a: OfferView, b: OfferView) => (big(b.remaining_quantity) > big(a.remaining_quantity) ? 1 : big(b.remaining_quantity) < big(a.remaining_quantity) ? -1 : 0) || SLOTS.indexOf(slotOfOffer(a)) - SLOTS.indexOf(slotOfOffer(b)) || Number(big(a.offer_id) - big(b.offer_id));
    for (const o of [...keep.values()].sort(rank).slice(maxOffers)) { cancels.push({ type: "cancel", offerId: o.offer_id, slot: slotOfOffer(o), reason: "active_offer_limit" }); keep.delete(slotOfOffer(o)); }
  }
  if (cancels.length) return out("acted", capByRate(cancels, facts, L.maxTransactionsPerMinute, reasons), { legs: outLegs, referenceNo: referenceNo.toString() });

  // creates only when nothing is being cancelled (released assets are re-read first)
  const creates: Action[] = [];
  let active = mine.length;
  const expiresAtNs = (() => { const e = nowNs + BigInt(S.quoteLifetimeSeconds) * 1_000_000_000n; const lim = snap.market.cutoffNs - bufferNs; return e < lim ? e : lim; })();
  for (const slot of SLOTS) {
    const leg = legBySlot.get(slot);
    if (!leg || keep.has(slot)) continue;
    if (expiresAtNs <= nowNs + 30_000_000_000n) { reasons.push({ code: "cutoff_buffer", message: "no room for a quote lifetime before the cutoff buffer", slot }); continue; }
    if (active >= maxOffers) { reasons.push({ code: "active_offer_limit", message: `already ${active} active offers (limit ${maxOffers})`, slot }); continue; }
    const { q, limit } = sizeFor(leg, 0n, 0n, freeCollateral);
    if (q < T.minOrder || q <= 0n) { reasons.push({ code: limit || "below_min_order", message: `${slot}: permitted size ${q} is below the minimum order ${T.minOrder}`, slot }); continue; }
    if (leg.side === "Buy") freeCollateral -= cost(q, leg.price, T.scale); else freeShares[leg.outcome] -= q;
    active++;
    creates.push({ type: "create", slot, outcome: leg.outcome, side: leg.side, price: leg.price, quantity: q, expiresAtNs });
    if (q < baseQty) reasons.push({ code: "reduced_size", message: `${slot}: size reduced to ${q} by ${limit}`, slot });
  }
  // A sell-side shortage is only a funding problem when the configuration is meant to split collateral into inventory.
  const needsFunding = reasons.some((r) => r.code === "insufficient_collateral" || (r.code === "insufficient_inventory" && big(cfg.funding.splitCollateral) > 0n));
  if (!creates.length) return out(reasons.length ? "skipped" : "noop", [], { legs: outLegs, referenceNo: referenceNo.toString(), needsFunding });
  return out("acted", capByRate(creates, facts, L.maxTransactionsPerMinute, reasons), { legs: outLegs, referenceNo: referenceNo.toString(), needsFunding });
}

function capByRate(actions: Action[], facts: Facts, perMinute: number, reasons: Reason[]): Action[] {
  const room = Math.max(0, perMinute - facts.txLastMinute);
  if (actions.length <= room) return actions;
  reasons.push({ code: "rate_limited", message: `transaction frequency limit: ${room} of ${actions.length} actions allowed now` });
  return actions.slice(0, room);
}

export { ceilTick, slotParts };
