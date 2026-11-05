import type { Q } from "../db/index.js";

export const TRUST_MODEL = {
  model: "manual-trusted-resolver",
  summary: "One configured resolver account sets a final YES or NO once, after the trading cutoff. The contract records the evidence but cannot verify it. There is no VOID, dispute or challenge path.",
  voidSupported: false, disputesSupported: false,
} as const;

export type UiStatus = "open" | "awaiting" | "resolved";
export type ContractStatus = "Open" | "AwaitingResolution" | "Resolved";

export function nowNs(): bigint { return BigInt(Date.now()) * 1_000_000n; }

/** Status derived from cutoff + resolution so it flips at the cutoff even before the next reconcile. */
export function effectiveStatus(row: { contract_status: string; cutoff_ns: string }, now = nowNs()): ContractStatus {
  if (row.contract_status === "Resolved") return "Resolved";
  return now >= BigInt(row.cutoff_ns) ? "AwaitingResolution" : "Open";
}
const ui = (s: ContractStatus): UiStatus => (s === "Open" ? "open" : s === "Resolved" ? "resolved" : "awaiting");
const iso = (ns: string | null) => (ns === null ? null : new Date(Number(BigInt(ns) / 1_000_000n)).toISOString());

export interface Freshness { blockHeight: number | null; tipHeight: number | null; lagBlocks: number | null; checkpointUpdatedAt: string | null; generatedAt: string }

export async function freshness(db: Q): Promise<Freshness> {
  const r = await db.query("SELECT name, height, updated_at FROM indexer_checkpoints WHERE name IN ('main','tip')");
  const m = r.rows.find((x: any) => x.name === "main"), t = r.rows.find((x: any) => x.name === "tip");
  const h = m ? Number(m.height) : null, tip = t ? Number(t.height) : null;
  return { blockHeight: h, tipHeight: tip, lagBlocks: h !== null && tip !== null ? Math.max(0, tip - h) : null, checkpointUpdatedAt: m ? new Date(m.updated_at).toISOString() : null, generatedAt: new Date().toISOString() };
}

/** Displayed-price methodology (documented in docs/backend.md): midpoint of best executable bid/ask when both exist and spread <= 0.10, else last confirmed trade for THAT outcome, else null. YES and NO are computed independently. */
export function displayedPrice(bid: string | null, ask: string | null, last: string | null): { price: string | null; basis: "midpoint" | "last_trade" | "none" } {
  if (bid && ask && BigInt(ask) - BigInt(bid) <= 100000n) return { price: ((BigInt(bid) + BigInt(ask)) / 2n).toString(), basis: "midpoint" };
  if (last) return { price: last, basis: "last_trade" };
  return { price: null, basis: "none" };
}

export interface OutcomeQuote { bestBid: string | null; bestAsk: string | null; lastTrade: string | null; displayed: string | null; basis: string }

export async function marketStats(db: Q, refs: string[], now = nowNs()) {
  if (!refs.length) return new Map<string, { volume: string; trades: number; quotes: { Yes: OutcomeQuote; No: OutcomeQuote }; openOffers: number }>();
  const vol = await db.query("SELECT market_ref, COALESCE(SUM(collateral_amount),0) AS v, COUNT(*) AS n FROM fills WHERE market_ref = ANY($1) GROUP BY market_ref", [refs]);
  const last = await db.query("SELECT DISTINCT ON (market_ref, outcome) market_ref, outcome, price FROM fills WHERE market_ref = ANY($1) ORDER BY market_ref, outcome, ts_ns DESC, id DESC", [refs]);
  const best = await db.query(
    `SELECT o.market_ref, o.outcome, o.side, CASE WHEN o.side='Buy' THEN MAX(o.price) ELSE MIN(o.price) END AS p, COUNT(*) AS n
     FROM offers o JOIN markets m USING (market_ref)
     WHERE o.market_ref = ANY($1) AND o.state='open' AND m.contract_status <> 'Resolved' AND m.cutoff_ns > $2::numeric
       AND (o.expires_at_ns IS NULL OR o.expires_at_ns > $2::numeric)
     GROUP BY o.market_ref, o.outcome, o.side`, [refs, now.toString()]);
  const res = new Map<string, any>();
  for (const ref of refs) res.set(ref, { volume: "0", trades: 0, openOffers: 0, quotes: { Yes: { bestBid: null, bestAsk: null, lastTrade: null }, No: { bestBid: null, bestAsk: null, lastTrade: null } } });
  for (const r of vol.rows) { const e = res.get(r.market_ref); e.volume = r.v; e.trades = Number(r.n); }
  for (const r of last.rows) res.get(r.market_ref).quotes[r.outcome].lastTrade = r.price;
  for (const r of best.rows) { const e = res.get(r.market_ref); e.quotes[r.outcome][r.side === "Buy" ? "bestBid" : "bestAsk"] = r.p; e.openOffers += Number(r.n); }
  for (const e of res.values()) for (const o of ["Yes", "No"] as const) {
    const q = e.quotes[o]; const d = displayedPrice(q.bestBid, q.bestAsk, q.lastTrade); q.displayed = d.price; q.basis = d.basis;
  }
  return res as Map<string, { volume: string; trades: number; quotes: { Yes: OutcomeQuote; No: OutcomeQuote }; openOffers: number }>;
}

export function marketDto(row: any, stats: any, now = nowNs()) {
  const status = effectiveStatus(row, now);
  const meta = row.token_meta;
  return {
    marketRef: row.market_ref,
    network: row.network,
    /** Wallet calls go to contractId with marketId as the `market_id` argument. */
    contract: { contractId: row.contract_id, marketId: row.internal_market_id, tokenId: row.token_id },
    question: row.question, rules: row.rules, resolutionSource: row.resolution_source,
    category: row.category, tag: row.tag,
    token: { symbol: meta.symbol, name: meta.name, decimals: meta.decimals, isTestToken: true },
    status, uiStatus: ui(status), tradingOpen: status === "Open",
    tradingCutoff: { ns: row.cutoff_ns, iso: iso(row.cutoff_ns) },
    observation: { startNs: row.observation_start_ns, endNs: row.observation_end_ns, startIso: iso(row.observation_start_ns), endIso: iso(row.observation_end_ns) },
    resolver: row.resolver_id,
    resolution: row.resolution,
    trustModel: TRUST_MODEL,
    trading: row.config?.trading,
    volume: stats?.volume ?? "0", tradeCount: stats?.trades ?? 0, openOfferCount: stats?.openOffers ?? 0,
    quotes: stats?.quotes ?? null,
    supply: { outstandingYes: row.outstanding_yes, outstandingNo: row.outstanding_no, marketBacking: row.market_backing },
    source: row.source, templateId: row.template_id, occurrenceKey: row.occurrence_key,
    createdAt: new Date(row.created_at).toISOString(), verifiedAt: new Date(row.verified_at).toISOString(),
    coverage: {
      historyComplete: row.history_complete, historyStartHeight: row.history_start_height === null ? null : Number(row.history_start_height),
      indexedThrough: row.indexed_through === null ? null : Number(row.indexed_through),
      note: row.history_complete ? "Event history is complete from historyStartHeight." : "Trade history may be incomplete: events before the indexer's start are not reconstructible from contract views.",
    },
    reconcile: row.reconcile ? { ok: row.reconcile.ok, blockHeight: row.reconcile.blockHeight, at: row.reconcile.at, driftCount: (row.reconcile.offerDrift?.length ?? 0) + (row.reconcile.accountDrift?.length ?? 0) } : null,
  };
}
