import { describe, expect, it } from "vitest";
import { computeLegs, ceilTick, floorLot, floorTick } from "../src/trading-bot/strategy.js";
import { decide } from "../src/trading-bot/decide.js";
import { BotConfig } from "../src/trading-bot/config.js";
import { deriveState } from "../src/trading-bot/state.js";
import { NOW, T, U, acct, botConfig, facts, offer, snap } from "./helpers/bot-fixtures.js";

const run = (o: { s?: any; f?: any; c?: any; now?: number } = {}) => decide({ nowMs: o.now ?? NOW, snap: snap(o.s), facts: facts(o.f), cfg: o.c ?? botConfig(), marketRef: "m_test" });
const types = (d: ReturnType<typeof decide>) => d.actions.map((a) => a.type);

describe("quote calculation", () => {
  it("fixture: reference 0.50, spread 0.05 => bids 0.45, asks 0.55 for YES and NO", () => {
    const r = computeLegs(T, 500_000n, 50_000n);
    expect(r.referenceNo).toBe(500_000n);
    expect(Object.fromEntries(r.legs.map((l) => [l.slot, l.price]))).toEqual({ YES_BUY: 450_000n, YES_SELL: 550_000n, NO_BUY: 450_000n, NO_SELL: 550_000n });
  });
  it("derives NO = scale - YES and keeps YES/NO combined constraints", () => {
    const r = computeLegs(T, 620_000n, 50_000n);
    const p = Object.fromEntries(r.legs.map((l) => [l.slot, l.price]));
    expect(r.referenceNo).toBe(380_000n);
    expect(p.YES_BUY! + p.NO_BUY!).toBeLessThanOrEqual(T.scale);
    expect(p.YES_SELL! + p.NO_SELL!).toBeGreaterThanOrEqual(T.scale);
  });
  it("rounds bids DOWN and asks UP to a valid tick", () => {
    const r = computeLegs(T, 503_000n, 47_000n); // yes bid 456000 -> 450000, ask 550000; no ref 497000: bid 450000, ask 544000 -> 550000
    const p = Object.fromEntries(r.legs.map((l) => [l.slot, l.price]));
    expect(p.YES_BUY).toBe(450_000n); expect(p.YES_SELL).toBe(550_000n); expect(p.NO_BUY).toBe(450_000n); expect(p.NO_SELL).toBe(550_000n);
    expect(floorTick(456_000n, 10_000n)).toBe(450_000n); expect(ceilTick(544_000n, 10_000n)).toBe(550_000n); expect(ceilTick(550_000n, 10_000n)).toBe(550_000n);
    expect(floorLot(1_234_567n, 100n)).toBe(1_234_500n);
  });
  it("skips legs outside the contract's price range and reports why", () => {
    const r = computeLegs(T, 970_000n, 50_000n); // YES ask 1.02 out of range; NO ref 0.03: bid -0.02 out of range
    const slots = r.legs.map((l) => l.slot);
    expect(slots).not.toContain("YES_SELL"); expect(slots).not.toContain("NO_BUY");
    expect(r.reasons.filter((x) => x.code === "price_out_of_range").length).toBe(2);
  });
  it("requires bid < ask (zero spread crosses)", () => {
    const r = computeLegs(T, 500_000n, 0n);
    expect(r.legs).toEqual([]); expect(r.reasons.every((x) => x.code === "crossed_quote")).toBe(true);
  });
  it("rejects a reference outside (0, scale)", () => { expect(computeLegs(T, 1_000_000n, 50_000n).reasons[0].code).toBe("reference_out_of_range"); expect(computeLegs(T, 0n, 50_000n).legs).toEqual([]); });
});

describe("decision: funded fixture, limits, inventory", () => {
  it("places four quotes: bids reserve 9 collateral in total, asks use the existing 10+10 shares", () => {
    const d = run();
    expect(types(d)).toEqual(["create", "create", "create", "create"]);
    const by = Object.fromEntries(d.actions.map((a: any) => [a.slot, a]));
    expect([by.YES_BUY.price, by.YES_BUY.quantity]).toEqual([450_000n, 10_000_000n]);
    expect([by.NO_BUY.price, by.NO_BUY.quantity]).toEqual([450_000n, 10_000_000n]);
    expect([by.YES_SELL.price, by.YES_SELL.quantity, by.NO_SELL.price, by.NO_SELL.quantity]).toEqual([550_000n, 10_000_000n, 550_000n, 10_000_000n]);
    const cst = (a: any) => (BigInt(a.quantity) * BigInt(a.price)) / 1_000_000n;
    const reserved = cst(by.YES_BUY) + cst(by.NO_BUY);
    expect(reserved).toBe(9_000_000n);
    expect(d.actions.every((a: any) => a.expiresAtNs > BigInt(NOW) * 1_000_000n)).toBe(true);
  });
  it("insufficient collateral reduces the buy size to what is affordable (never more than available)", () => {
    const d = run({ s: { account: acct({ available_collateral: U(2.25), yes: U(10), no: U(10) }) } });
    const yb = d.actions.find((a: any) => a.slot === "YES_BUY") as any; const nb = d.actions.find((a: any) => a.slot === "NO_BUY") as any;
    expect(yb.quantity).toBe(5_000_000n);                       // 2.25 / 0.45
    expect(nb).toBeUndefined();                                  // collateral already used by the YES bid
    expect(d.reasons.some((r) => r.code === "insufficient_collateral" && r.slot === "NO_BUY")).toBe(true);
    expect(d.needsFunding).toBe(true);
  });
  it("insufficient inventory: asks are limited to the shares the bot actually has", () => {
    const d = run({ s: { account: acct({ available_collateral: U(10), yes: U(3), no: "0" }) } });
    const ys = d.actions.find((a: any) => a.slot === "YES_SELL") as any;
    expect(ys.quantity).toBe(3_000_000n);
    expect(d.actions.find((a: any) => a.slot === "NO_SELL")).toBeUndefined();
    expect(d.reasons.some((r) => r.code === "insufficient_inventory" && r.slot === "NO_SELL")).toBe(true);
  });
  it("owned shares include reserved ones and open buys count toward the inventory limit", () => {
    // 15 owned (5 available + 10 reserved) + limit 20 => a YES bid may add at most 5
    const d = run({ s: { account: acct({ available_collateral: U(10), yes: U(5), reserved_yes: U(10), no: U(10) }), offers: [offer({ offer_id: "1", outcome: "Yes", side: "Sell", price: "550000", reserved_shares: U(10), remaining_quantity: U(10) })] } });
    const yb = d.actions.find((a: any) => a.slot === "YES_BUY") as any;
    expect(yb.quantity).toBe(5_000_000n);
    expect(d.reasons.some((r) => r.code === "reduced_size")).toBe(true);
  });
  it("an outstanding buy offer reduces the headroom of other legs (it may still acquire shares)", () => {
    const withBid = offer({ offer_id: "9", outcome: "Yes", side: "Buy", price: "450000", remaining_quantity: U(8), reserved_collateral: U(3.6) });
    const d = run({ s: { account: acct({ available_collateral: U(6.4), reserved_collateral: U(3.6), yes: U(10), no: U(10) }), offers: [withBid] }, c: botConfig({ limits: { ...botConfig().limits, maxYesInventory: U(14) } }) });
    // owned 10, existing bid may add 8 => headroom for the bid slot itself is 14-10=4 => bid (8) is OVER the limit and must be cancelled
    expect(d.actions[0]).toMatchObject({ type: "cancel", offerId: "9", reason: "over_limit" });
  });
  it("active offer limit counts existing offers (including unexpected ones)", () => {
    const stray = offer({ offer_id: "5", outcome: "No", side: "Sell", price: "560000", reserved_shares: U(1), remaining_quantity: U(1), quantity: U(1) });
    const c = botConfig({ limits: { ...botConfig().limits, maxActiveOffersPerMarket: 3 } });
    const d = run({ c, s: { account: acct({ available_collateral: U(10), yes: U(10), no: U(9), reserved_no: U(1) }), offers: [stray] } });
    // the stray No-sell sits in NO_SELL at the wrong price & size => replaced first
    expect(d.actions[0]).toMatchObject({ type: "cancel", offerId: "5" });
    const after = run({ c, s: { account: acct({ available_collateral: U(10), yes: U(10), no: U(10) }), offers: [] } });
    expect(types(after).filter((t) => t === "create").length).toBe(3);                    // capped at 3
    expect(after.reasons.some((r) => r.code === "active_offer_limit")).toBe(true);
  });
  it("respects quantity-per-order and transaction frequency limits", () => {
    const c = botConfig({ limits: { ...botConfig().limits, maxOrderQuantity: U(4) } });
    expect(run({ c }).actions.every((a: any) => a.quantity === 4_000_000n)).toBe(true);
    const d = run({ f: { txLastMinute: 58 } });
    expect(d.actions.length).toBe(2); expect(d.reasons.some((r) => r.code === "rate_limited")).toBe(true);
  });
  it("does not churn: unchanged quotes produce no actions", () => {
    const exp = (BigInt(NOW + 3_000_000) * 1_000_000n).toString();
    const q = (id: string, o: "Yes" | "No", s: "Buy" | "Sell", p: string) => offer({ offer_id: id, outcome: o, side: s, price: p, expires_at_ns: exp, reserved_collateral: s === "Buy" ? U(4.5) : "0", reserved_shares: s === "Sell" ? U(10) : "0" });
    const d = run({ s: { account: acct({ available_collateral: U(1), reserved_collateral: U(9), yes: "0", no: "0", reserved_yes: U(10), reserved_no: U(10) }), offers: [q("1", "Yes", "Buy", "450000"), q("2", "Yes", "Sell", "550000"), q("3", "No", "Buy", "450000"), q("4", "No", "Sell", "550000")] } });
    expect(d.actions).toEqual([]); expect(d.outcome).toBe("noop");
  });
  it("partial fill: keeps a still-adequate remainder; undersized/expiring/repriced quotes are cancelled BEFORE new ones are created", () => {
    const exp = (BigInt(NOW + 3_000_000) * 1_000_000n).toString();
    const ask = (rem: number, price = "550000", e = exp) => offer({ offer_id: "2", outcome: "Yes", side: "Sell", price, quantity: U(10), remaining_quantity: U(rem), reserved_shares: U(rem), expires_at_ns: e });
    const base = (rem: number, extra: any = {}) => run({ s: { account: acct({ available_collateral: U(10), yes: U(10 - rem), reserved_yes: U(rem), no: U(10) }), offers: [ask(rem, extra.price, extra.exp)] } });
    expect(base(6).actions.find((a: any) => a.type === "cancel")).toBeUndefined();                       // 6 of 10 >= 50%
    expect(base(3).actions[0]).toMatchObject({ type: "cancel", offerId: "2", reason: "undersized" });
    expect(base(3).actions.some((a: any) => a.type === "create")).toBe(false);                            // no create until the cancel is confirmed
    expect(base(8, { price: "540000" }).actions[0]).toMatchObject({ type: "cancel", reason: "price_changed" });
    expect(base(8, { exp: (BigInt(NOW + 10_000) * 1_000_000n).toString() }).actions[0]).toMatchObject({ type: "cancel", reason: "expiring_soon" });
  });
  it("after a partial fill the replacement is sized by what the bot still holds (not blindly the full size)", () => {
    // 7 of 10 YES sold; cancel confirmed: 3 YES left available
    const d = run({ s: { account: acct({ available_collateral: U(13), yes: U(3), no: U(10) }), offers: [] } });
    const ys = d.actions.find((a: any) => a.slot === "YES_SELL") as any;
    expect(ys.quantity).toBe(3_000_000n);
  });
  it("duplicate quotes in one slot: keeps one, cancels the excess", () => {
    const exp = (BigInt(NOW + 3_000_000) * 1_000_000n).toString();
    const a = offer({ offer_id: "1", outcome: "Yes", side: "Sell", price: "550000", reserved_shares: U(5), remaining_quantity: U(5), expires_at_ns: exp });
    const b = offer({ offer_id: "2", outcome: "Yes", side: "Sell", price: "550000", reserved_shares: U(5), remaining_quantity: U(5), expires_at_ns: exp });
    const d = run({ s: { account: acct({ yes: "0", reserved_yes: U(10), available_collateral: U(10), no: U(10) }), offers: [a, b] } });
    expect(d.actions.filter((x: any) => x.reason === "excess").length).toBe(1);
  });
});

describe("decision: reference, cutoff, market status, setup, stale data", () => {
  const exp = (ms: number) => new Date(ms).toISOString();
  it("an absent, expired or stale reference stops new quoting and cancels existing quotes", () => {
    const withOffer = { offers: [offer({ offer_id: "1", outcome: "Yes", side: "Sell", reserved_shares: U(5), remaining_quantity: U(5) })], account: acct({ yes: "0", reserved_yes: U(5), available_collateral: U(10), no: U(10) }) };
    for (const [name, ref, code] of [
      ["absent", null, "no_reference"],
      ["expired", { yesPrice: "500000", label: "x", source: "y", asOf: exp(NOW - 7_200_000), expiresAt: exp(NOW - 1000) }, "reference_expired"],
      ["stale", { yesPrice: "500000", label: "x", source: "y", asOf: exp(NOW - 3_600_000), expiresAt: exp(NOW + 3_600_000) }, "reference_stale"],
    ] as const) {
      const c = botConfig(); c.markets[0].reference = ref as any;
      const d = run({ c, s: withOffer });
      expect(d.reasons[0].code, name).toBe(code);
      expect(types(d), name).toEqual(["cancel"]);
      expect(run({ c }).actions, name).toEqual([]);                     // nothing to create
    }
  });
  it("stops new quotes inside the cutoff buffer and after the cutoff; cancels leftovers", () => {
    const cut = (ms: number) => ({ market: { status: "Open" as const, tradingOpen: true, cutoffNs: BigInt(NOW + ms) * 1_000_000n, resolved: false } });
    expect(run({ s: cut(200_000) }).reasons[0].code).toBe("cutoff_buffer");
    expect(run({ s: cut(200_000) }).actions).toEqual([]);
    const o = offer({ offer_id: "1", outcome: "Yes", side: "Sell", reserved_shares: U(5), remaining_quantity: U(5) });
    const closed = run({ s: { market: { status: "AwaitingResolution", tradingOpen: false, cutoffNs: BigInt(NOW - 1000) * 1_000_000n, resolved: false }, offers: [o], account: acct({ yes: "0", reserved_yes: U(5) }) } });
    expect(closed.reasons[0].code).toBe("market_closed"); expect(types(closed)).toEqual(["cancel"]);
  });
  it("a resolved market: no quotes, leftovers cancelled, reason reported", () => {
    const d = run({ s: { market: { status: "Resolved", tradingOpen: false, cutoffNs: BigInt(NOW - 1000) * 1_000_000n, resolved: true } } });
    expect(d.reasons[0].code).toBe("market_resolved"); expect(d.actions).toEqual([]);
  });
  it("quote expiry is bounded by the quote lifetime and the cutoff buffer", () => {
    const cutoff = BigInt(NOW + 1_000_000) * 1_000_000n;      // ~16.7 min away, buffer 5 min => latest expiry cutoff-300s
    const d = run({ s: { market: { status: "Open", tradingOpen: true, cutoffNs: cutoff, resolved: false } } });
    for (const a of d.actions as any[]) expect(a.expiresAtNs).toBe(cutoff - 300n * 1_000_000_000n);
  });
  it("setup is stepwise: token registration, market registration, deposit, split, then quotes", () => {
    expect(types(run({ s: { tokenRegistered: false } }))).toEqual(["register_token"]);
    expect(types(run({ s: { account: null } }))).toEqual(["register_market"]);
    const f = { trancheDone: { deposit: false, split: false } };
    expect(types(run({ f, s: { tokenBalance: 20_000_000n } }))).toEqual(["deposit"]);
    expect(types(run({ f: { trancheDone: { deposit: true, split: false } } }))).toEqual(["split"]);
  });
  it("deposits are bounded and need the money: per-market limit, total limit, token balance, native reserve", () => {
    const f = { trancheDone: { deposit: false, split: false } };
    expect(run({ f, s: { tokenBalance: 5_000_000n } }).reasons.some((r) => r.code === "needs_collateral")).toBe(true);
    expect(run({ f: { ...f, allocatedCollateral: 5_000_000n }, s: { tokenBalance: 99_000_000n } }).reasons[0].code).toBe("market_collateral_limit");
    expect(run({ f: { ...f, allocatedTotal: 30_000_000n }, s: { tokenBalance: 99_000_000n } }).reasons[0].code).toBe("total_collateral_limit");
    expect(run({ s: { tokenRegistered: false, nativeBalance: 50_000_000_000_000_000_000_000n } }).reasons[0].code).toBe("needs_native");
    expect(run({ f: { nativeSpent: 999_000_000_000_000_000_000_000n }, s: { tokenRegistered: false } }).reasons[0].code).toBe("native_spend_limit");
  });
  it("stale chain data, operations in flight, not-running and repeated failures all prevent new actions", () => {
    expect(run({ now: NOW + 600_000 }).reasons[0].code).toBe("stale_chain_data");
    expect(run({ f: { hasPendingOps: true } }).reasons.map((r) => r.code)).toContain("operations_in_flight");
    expect(run({ f: { desired: "paused" } }).reasons[0].code).toBe("not_running");
    expect(run({ f: { recentFailures: 3 } }).reasons.map((r) => r.code)).toContain("recent_failures");
    expect(run({ f: { hasPendingOps: true } }).actions).toEqual([]);
  });
});

describe("operating state and config", () => {
  const base = { pendingOps: 0, uncertainOps: 0, activeQuotes: 0, needsFunding: false, credentialsOk: true, executionAllowed: true };
  it("never reports paused/stopped while work is unresolved", () => {
    expect(deriveState({ desired_state: "paused", mode: "execute" }, { ...base, activeQuotes: 2 }).state).toBe("pausing");
    expect(deriveState({ desired_state: "stopped", mode: "execute" }, { ...base, pendingOps: 1 }).state).toBe("stopping");
    expect(deriveState({ desired_state: "stopped", mode: "execute" }, { ...base, uncertainOps: 1 }).state).toBe("uncertain");
    expect(deriveState({ desired_state: "paused", mode: "execute" }, base).state).toBe("paused");
    expect(deriveState({ desired_state: "stopped", mode: "execute" }, base).state).toBe("stopped");
  });
  it("disabled / paper / running / needs_funding / setup_required / uncertain", () => {
    expect(deriveState({ desired_state: "disabled", mode: "paper" }, base).state).toBe("disabled");
    expect(deriveState({ desired_state: "running", mode: "paper" }, base).state).toBe("paper");
    expect(deriveState({ desired_state: "running", mode: "execute" }, base).state).toBe("running");
    expect(deriveState({ desired_state: "running", mode: "execute" }, { ...base, needsFunding: true }).state).toBe("needs_funding");
    expect(deriveState({ desired_state: "running", mode: "execute" }, { ...base, credentialsOk: false }).state).toBe("setup_required");
    expect(deriveState({ desired_state: "running", mode: "execute" }, { ...base, uncertainOps: 1 }).state).toBe("uncertain");
  });
  it("validates configuration (deposit within limits, no duplicate markets)", () => {
    expect(() => botConfig({ funding: { trancheId: 1, depositCollateral: U(99), splitCollateral: "0" } })).toThrow();
    expect(() => botConfig({ funding: { trancheId: 1, depositCollateral: U(5), splitCollateral: U(9) } })).toThrow();
    const bad = botConfig(); bad.markets.push(bad.markets[0]);
    expect(BotConfig.safeParse(bad).success).toBe(false);
  });
});

describe("lifecycle limits: splits vs inventory limits, shrinking the active-offer cap, removed markets", () => {
  const funded = { trancheDone: { deposit: true, split: false } };
  const lim = (o: Record<string, any>) => botConfig({ limits: { ...botConfig().limits, ...o } });
  const splitOf = (d: ReturnType<typeof decide>) => d.actions.find((a: any) => a.type === "split") as any;

  it("deposit 20 + split 10 with max YES/NO inventory 5: the split is cut to 5 (never 10 YES + 10 NO)", () => {
    const d = run({ f: funded, c: lim({ maxYesInventory: U(5), maxNoInventory: U(5) }), s: { account: acct({ available_collateral: U(20) }) } });
    expect(splitOf(d).amount).toBe(5_000_000n);
    expect(d.reasons.some((r) => r.code === "split_reduced")).toBe(true);
  });
  it("counts shares the account already holds (available + reserved) and open buys that may still acquire shares", () => {
    const base = { f: funded, c: lim({ maxYesInventory: U(5), maxNoInventory: U(5) }) };
    // holds 3 YES (2 available + 1 reserved) and 3 NO => headroom 2
    const holds = run({ ...base, s: { account: acct({ available_collateral: U(20), yes: U(2), reserved_yes: U(1), no: U(3) }), offers: [offer({ offer_id: "1", outcome: "Yes", side: "Sell", price: "550000", remaining_quantity: U(1), reserved_shares: U(1) })] } });
    expect(splitOf(holds).amount).toBe(2_000_000n);
    // holds nothing, but an open YES bid for 3 may acquire 3 more YES => headroom 2
    const buy = offer({ offer_id: "2", outcome: "Yes", side: "Buy", price: "450000", remaining_quantity: U(3), reserved_collateral: U(1.35) });
    const bid = run({ ...base, s: { account: acct({ available_collateral: U(20), reserved_collateral: U(1.35) }), offers: [buy] } });
    expect(splitOf(bid).amount).toBe(2_000_000n);
  });
  it("already at/over the limit: no split at all, the bot keeps quoting with what it holds, reason recorded", () => {
    const d = run({ f: funded, c: lim({ maxYesInventory: U(5), maxNoInventory: U(5) }), s: { account: acct({ available_collateral: U(20), yes: U(6), no: U(6) }) } });
    expect(splitOf(d)).toBeUndefined();
    expect(d.reasons.some((r) => r.code === "split_blocked_by_inventory_limit")).toBe(true);
    expect(d.actions.some((a: any) => a.type === "create" && a.side === "Sell")).toBe(true);        // sells quoted from the 6 held shares
  });
  it("later funding tranches obey the same limits (tranche 2 with existing inventory)", () => {
    const c = botConfig({ funding: { trancheId: 2, depositCollateral: U(20), splitCollateral: U(10) }, limits: { ...botConfig().limits, maxYesInventory: U(12), maxNoInventory: U(12) } });
    const d = run({ f: funded, c, s: { account: acct({ available_collateral: U(20), yes: U(8), no: U(8) }) } });
    expect(splitOf(d).amount).toBe(4_000_000n);                                                      // 12 - 8
  });
  it("a split within the limits is unchanged", () => { expect(splitOf(run({ f: funded, s: { account: acct({ available_collateral: U(20) }) } })).amount).toBe(10_000_000n); });

  it("reducing maxActiveOffersPerMarket cancels the excess deterministically (largest remaining kept, then slot order, then lowest id)", () => {
    const exp = (BigInt(NOW + 3_000_000) * 1_000_000n).toString();
    const q = (id: string, o: "Yes" | "No", sd: "Buy" | "Sell", p: string, rem: number) => offer({ offer_id: id, outcome: o, side: sd, price: p, quantity: U(10), remaining_quantity: U(rem), expires_at_ns: exp, reserved_collateral: sd === "Buy" ? U(rem * 0.45) : "0", reserved_shares: sd === "Sell" ? U(rem) : "0" });
    const offers = [q("1", "Yes", "Buy", "450000", 6), q("2", "Yes", "Sell", "550000", 10), q("3", "No", "Buy", "450000", 10), q("4", "No", "Sell", "550000", 10)];
    const st = { account: acct({ available_collateral: U(1), reserved_collateral: U(9), reserved_yes: U(10), reserved_no: U(10) }), offers };
    const four = run({ s: st }); expect(four.actions).toEqual([]);                                   // 4 valid quotes under the default cap of 4
    const d = run({ c: lim({ maxActiveOffersPerMarket: 2 }), s: st });
    const cancelled = d.actions.map((a: any) => a.offerId).sort();
    expect(d.actions.every((a: any) => a.type === "cancel" && a.reason === "active_offer_limit")).toBe(true);
    expect(cancelled).toEqual(["1", "4"]);                                                            // kept: #2 (YES_SELL) and #3 (NO_BUY): both 10, earlier slot wins over NO_SELL; #1 is smaller (6)
    // same input => same answer
    expect(run({ c: lim({ maxActiveOffersPerMarket: 2 }), s: st }).actions).toEqual(d.actions);
    // after the cancellations are confirmed and the chain re-read: nothing more to cancel, and no new quote is created above the cap
    const after = run({ c: lim({ maxActiveOffersPerMarket: 2 }), s: { account: acct({ available_collateral: U(5.6), reserved_collateral: U(4.5), reserved_yes: U(10), yes: "0", no: U(10) }), offers: [offers[1], offers[2]] } });
    expect(after.actions).toEqual([]);
    expect(after.reasons.some((r) => r.code === "active_offer_limit")).toBe(true);
  });

  it("a market removed from the configuration is cancellation-only (not a silent early return)", () => {
    const other = botConfig({}, "m_other");
    const o = offer({ offer_id: "1", outcome: "Yes", side: "Sell", price: "550000", reserved_shares: U(5), remaining_quantity: U(5) });
    const withLive = decide({ nowMs: NOW, snap: snap({ account: acct({ yes: "0", reserved_yes: U(5) }), offers: [o] }), facts: facts(), cfg: other, marketRef: "m_test" });
    expect(withLive.reasons[0].code).toBe("market_removed"); expect(withLive.outcome).toBe("wind_down");
    expect(withLive.actions).toEqual([expect.objectContaining({ type: "cancel", offerId: "1", reason: "market_removed" })]);
    const clean = decide({ nowMs: NOW, snap: snap(), facts: facts(), cfg: other, marketRef: "m_test" });
    expect(clean.actions).toEqual([]);                                                                  // nothing left: nothing to do
    const pending = decide({ nowMs: NOW, snap: snap(), facts: facts({ hasPendingOps: true }), cfg: other, marketRef: "m_test" });
    expect(pending.reasons.map((r) => r.code)).toContain("operations_in_flight");                      // in-flight work is reconciled first
  });
});
