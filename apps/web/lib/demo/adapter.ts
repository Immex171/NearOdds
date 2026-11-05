import { mulPrice } from "../amounts";
import { MAX_OPEN_OFFERS, MAX_PRICE, MIN_ORDER_QUANTITY, MIN_PRICE, PRICE_TICK, QUANTITY_LOT } from "../trading";
import type {
  AccountState, ActivityItem, Capabilities, CreateOfferRequest, DataAdapter, HistoryPoint, Market, Offer, OpenOffer, Position,
  TxReporter,
} from "../types";
import {
  DEMO_ACCOUNT, DEMO_INITIAL, DEMO_NOW, demoActivity, demoHistory, demoInitialOffers, demoInitialPositions, demoMarkets, demoOffers,
} from "./data";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T[]): T[] => v.map((x) => ({ ...x }));

interface State {
  markets: Market[];
  book: Offer[];
  mine: OpenOffer[];
  positions: Position[];
  wallet: bigint;
  available: bigint;
  pending: bigint;
  log: ActivityItem[];
  extra: Map<string, ActivityItem[]>;
  seq: number;
  tick: number;
}

function initial(): State {
  return {
    markets: clone(demoMarkets), book: demoOffers(), mine: demoInitialOffers(), positions: demoInitialPositions(),
    wallet: DEMO_INITIAL.walletBalance, available: DEMO_INITIAL.available, pending: 0n,
    log: [{ id: "seed", t: DEMO_NOW - 2 * 3_600_000, kind: "event", text: "Demo account created with sample balances." }],
    extra: new Map(), seq: 1, tick: 0,
  };
}

const KEY = "nearodds:demo-state:v2"; // bump when the persisted shape changes
const OLD_KEYS = ["nearodds:demo-state:v1"];
const enc = (s: State) => JSON.stringify({ ...s, extra: [...s.extra] }, (_k, v) => (typeof v === "bigint" ? { $b: v.toString() } : v));
function load(): State | null {
  try {
    if (typeof localStorage !== "undefined") OLD_KEYS.forEach((k) => localStorage.removeItem(k));
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw, (_k, v) => (v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : v));
    // Discard saved state from an older shape instead of crashing on it.
    if (!Array.isArray(o.markets) || o.markets.some((m: Market) => !m?.resolution?.observation || !m.resolution.source?.name)) return null;
    return { ...o, extra: new Map(o.extra) } as State;
  } catch { return null; }
}

export const DEMO_CAPABILITIES: Capabilities = {
  trading: true, limitOffers: true, partialFills: true, cancelOffers: true, deposit: true, withdraw: true,
  completeSets: true, redeem: true, history: true,
};

export class DemoAdapter implements DataAdapter {
  id = "demo" as const;
  label = "Demo";
  symbol = "TEST";
  capabilities = DEMO_CAPABILITIES;
  private s = load() ?? initial();
  private subs = new Set<() => void>();
  /** Demo-only switch: the next transaction is rejected as if the user declined the wallet prompt. */
  rejectNext = false;

  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private emit() {
    this.s.tick++;
    try { localStorage.setItem(KEY, enc(this.s)); } catch { /* storage unavailable: state stays in memory */ }
    this.subs.forEach((f) => f());
  }
  /** Test hook: removes an offer as if someone else filled or cancelled it. */
  removeOffer(id: string) { this.s.book = this.s.book.filter((o) => o.id !== id); this.emit(); }
  setRejectNext(v: boolean) { this.rejectNext = v; this.emit(); }
  reset() {
    this.s = initial();
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    this.emit();
  }

  private market(id: string) {
    const m = this.s.markets.find((x) => x.id === id);
    if (!m) throw new Error("Market not found");
    return m;
  }
  private note(text: string, marketId?: string, kind: ActivityItem["kind"] = "trade") {
    const item = { id: `a${this.s.seq++}`, t: DEMO_NOW + this.s.seq * 60_000, text, kind };
    this.s.log.unshift(item);
    if (marketId) this.s.extra.set(marketId, [item, ...(this.s.extra.get(marketId) ?? [])]);
  }
  private pos(marketId: string, outcome: "YES" | "NO") {
    let p = this.s.positions.find((x) => x.marketId === marketId && x.outcome === outcome);
    if (!p) { p = { marketId, outcome, qty: 0n, avgPrice: null, reserved: 0n }; this.s.positions.push(p); }
    return p;
  }
  private withReserved(): Position[] {
    const out = this.s.positions.map((p) => ({ ...p }));
    for (const o of this.s.mine) {
      if (o.side !== "sell") continue;
      let p = out.find((x) => x.marketId === o.marketId && x.outcome === o.outcome);
      if (!p) { p = { marketId: o.marketId, outcome: o.outcome, qty: 0n, avgPrice: null, reserved: 0n }; out.push(p); }
      p.reserved += o.qty;
    }
    return out;
  }
  private prune() { this.s.positions = this.s.positions.filter((p) => p.qty > 0n); }

  private async run(r: TxReporter, work: () => void, label: string) {
    r({ phase: "awaiting-wallet", message: "Demo: simulating wallet approval…" });
    await sleep(250);
    if (this.rejectNext) {
      this.rejectNext = false;
      const msg = "Transaction rejected in the wallet. Nothing was changed.";
      r({ phase: "failed", message: msg });
      throw new Error(msg);
    }
    r({ phase: "submitted", message: "Demo: transaction submitted.", hash: `demo-${this.s.seq.toString(16).padStart(6, "0")}` });
    await sleep(250);
    r({ phase: "confirming", message: "Demo: waiting for confirmation…" });
    await sleep(350);
    try {
      work();
      this.emit();
      r({ phase: "confirmed", message: label });
    } catch (e) {
      r({ phase: "failed", message: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  async listMarkets() { return clone(this.s.markets); }
  async getMarket(id: string) { const m = this.s.markets.find((x) => x.id === id); return m ? { ...m } : null; }
  async getBook(id: string) { return clone(this.s.book.filter((o) => o.marketId === id)).concat(clone(this.s.mine.filter((o) => o.marketId === id))); }
  async getHistory(id: string): Promise<HistoryPoint[] | null> { const m = this.s.markets.find((x) => x.id === id); return m ? demoHistory(m) : null; }
  async getActivity(id: string) {
    const m = this.s.markets.find((x) => x.id === id);
    return m ? [...(this.s.extra.get(id) ?? []), ...demoActivity(m)] : [];
  }
  async getAccount(accountId: string): Promise<AccountState | null> {
    if (accountId !== DEMO_ACCOUNT) return null;
    const committed = this.s.mine.filter((o) => o.side === "buy").reduce((a, o) => a + mulPrice(o.price, o.qty), 0n);
    return {
      accountId, isDemo: true, walletBalance: this.s.wallet, available: this.s.available, committed, maxOpenOffers: MAX_OPEN_OFFERS,
      pendingWithdrawal: this.s.pending, positions: this.withReserved(), offers: clone(this.s.mine), activity: [...this.s.log],
    };
  }

  deposit(amount: bigint, r: TxReporter) {
    return this.run(r, () => {
      if (amount <= 0n) throw new Error("Enter an amount");
      if (amount > this.s.wallet) throw new Error("Insufficient wallet balance");
      this.s.wallet -= amount; this.s.available += amount;
      this.note("Deposited collateral (demo)", undefined, "event");
    }, "Demo deposit completed");
  }
  async withdraw(amount: bigint, r: TxReporter) {
    if (amount <= 0n || amount > this.s.available) { r({ phase: "failed", message: "Insufficient available collateral" }); throw new Error("Insufficient available collateral"); }
    this.s.available -= amount; this.s.pending += amount; this.emit();
    try {
      await this.run(r, () => {
        this.s.pending -= amount; this.s.wallet += amount;
        this.note("Withdrew collateral (demo)", undefined, "event");
      }, "Demo withdrawal completed");
    } catch (e) { this.s.pending -= amount; this.s.available += amount; this.emit(); throw e; }
  }
  split(marketId: string, amount: bigint, r: TxReporter) {
    return this.run(r, () => {
      const m = this.market(marketId);
      if (m.status !== "open") throw new Error("Market is not open");
      if (amount <= 0n) throw new Error("Enter an amount");
      if (amount > this.s.available) throw new Error("Insufficient available collateral");
      this.s.available -= amount; this.pos(marketId, "YES").qty += amount; this.pos(marketId, "NO").qty += amount;
      this.note(`Created ${amount / 1_000_000n} YES + NO shares`, marketId, "event");
    }, "Demo YES + NO shares created");
  }
  merge(marketId: string, amount: bigint, r: TxReporter) {
    return this.run(r, () => {
      this.market(marketId);
      const y = this.pos(marketId, "YES"), n = this.pos(marketId, "NO");
      if (amount <= 0n) throw new Error("Enter an amount");
      if (amount > y.qty || amount > n.qty) throw new Error("Insufficient shares: you need equal YES and NO shares");
      y.qty -= amount; n.qty -= amount; this.s.available += amount; this.prune();
      this.note(`Combined ${amount / 1_000_000n} YES + NO shares`, marketId, "event");
    }, "Demo YES + NO shares combined");
  }

  fillOffer(offerId: string, qty: bigint, r: TxReporter) {
    return this.run(r, () => {
      const o = this.s.book.find((x) => x.id === offerId);
      if (!o) throw new Error("Offer no longer available");
      const m = this.market(o.marketId);
      if (m.status !== "open") throw new Error("Market closed");
      if (qty <= 0n || qty % QUANTITY_LOT !== 0n) throw new Error("Quantity must be a positive multiple of the lot");
      if (qty > o.qty) throw new Error("Offer no longer has that many shares available");
      const cost = mulPrice(o.price, qty);
      const p = this.pos(o.marketId, o.outcome);
      if (o.side === "sell") {
        if (cost > this.s.available) throw new Error("Insufficient balance");
        const prior = (p.avgPrice ?? o.price) * p.qty;
        p.avgPrice = (prior + cost * 1_000_000n) / (p.qty + qty);
        p.qty += qty; this.s.available -= cost;
      } else {
        if (p.qty < qty) throw new Error("Insufficient shares");
        p.qty -= qty; this.s.available += cost; this.prune();
      }
      o.qty -= qty;
      this.s.book = this.s.book.filter((x) => x.qty > 0n);
      m.prevYes = m.prevYes ?? m.lastYes;
      m.lastYes = o.outcome === "YES" ? o.price : 1_000_000n - o.price; // display convention: last trade as YES-equivalent
      m.volume += cost; m.hasHistory = true;
      this.note(`${o.side === "sell" ? "Bought" : "Sold"} ${Number(qty) / 1e6} ${o.outcome} at ${Number(o.price) / 1e6} (demo)`, o.marketId);
    }, "Demo trade completed");
  }

  createOffer(req: CreateOfferRequest, r: TxReporter) {
    const { marketId, outcome, side, qty, price, expiresAt } = req;
    return this.run(r, () => {
      const m = this.market(marketId);
      if (m.status !== "open") throw new Error("Market closed");
      if (price < MIN_PRICE || price > MAX_PRICE || price % PRICE_TICK !== 0n) throw new Error("Invalid price: use a 0.01 step between 0.01 and 0.99");
      if (qty < MIN_ORDER_QUANTITY || qty % QUANTITY_LOT !== 0n) throw new Error("Invalid quantity");
      if (this.s.mine.length >= MAX_OPEN_OFFERS) throw new Error("Too many open offers (maximum 10)");
      if (side === "buy") {
        const cost = mulPrice(price, qty);
        if (cost > this.s.available) throw new Error("Insufficient balance");
        this.s.available -= cost;
      } else {
        const p = this.pos(marketId, outcome);
        if (p.qty < qty) throw new Error("Insufficient shares");
        p.qty -= qty; this.prune();
      }
      if (expiresAt != null && expiresAt <= DEMO_NOW) throw new Error("Expiry must be in the future");
      this.s.mine.push({ id: `mine-${this.s.seq++}`, marketId, outcome, side, price, qty, owner: DEMO_ACCOUNT, createdAt: DEMO_NOW + this.s.seq * 60_000, status: "open", expiresAt: expiresAt ?? null });
      this.note(`Placed limit ${side} ${Number(qty) / 1e6} ${outcome} at ${Number(price) / 1e6} (demo)`, marketId, "offer");
    }, "Demo limit offer placed");
  }

  cancelOffer(offerId: string, r: TxReporter) {
    return this.run(r, () => {
      const o = this.s.mine.find((x) => x.id === offerId);
      if (!o) throw new Error("Offer not found");
      if (o.side === "buy") this.s.available += mulPrice(o.price, o.qty);
      else this.pos(o.marketId, o.outcome).qty += o.qty;
      this.s.mine = this.s.mine.filter((x) => x.id !== offerId);
      this.note(`Cancelled offer on ${o.outcome} (demo)`, o.marketId, "offer");
    }, "Demo offer cancelled");
  }

  redeem(marketId: string, r: TxReporter) {
    return this.run(r, () => {
      const m = this.market(marketId);
      if (m.status !== "resolved" || !m.resolution.outcome) throw new Error("Market is not resolved");
      const win = this.s.positions.find((p) => p.marketId === marketId && p.outcome === m.resolution.outcome);
      this.s.available += win?.qty ?? 0n;
      this.s.positions = this.s.positions.filter((p) => p.marketId !== marketId);
      this.note("Redeemed winning shares (demo)", marketId, "event");
    }, "Demo redemption completed");
  }
}
