import type { FastifyInstance } from "fastify";
import type { Ctx } from "./app.js";
import { effectiveStatus, freshness, marketDto, marketStats, nowNs } from "./dto.js";
import { badRequest, intParam, notFound } from "./http.js";

const INTERVALS: Record<string, bigint> = { "1m": 60n, "5m": 300n, "15m": 900n, "1h": 3600n, "4h": 14400n, "1d": 86400n };
const SECOND_NS = 1_000_000_000n;

export async function getMarketRow(ctx: Ctx, ref: string) {
  const r = await ctx.db.query("SELECT * FROM markets WHERE market_ref=$1", [ref]);
  if (!r.rowCount) throw notFound("market");
  return r.rows[0];
}

export function registerMarketRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get("/v1/markets", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = intParam(q.limit, 20, 1, 100), offset = intParam(q.offset, 0, 0, 1_000_000);
    const where: string[] = []; const p: unknown[] = []; const now = nowNs();
    if (q.q) { p.push(`%${q.q.replace(/[%_]/g, "")}%`); where.push(`(question ILIKE $${p.length} OR rules ILIKE $${p.length} OR contract_id ILIKE $${p.length})`); }
    if (q.category) { p.push(q.category); where.push(`category = $${p.length}`); }
    if (q.status) {
      if (!["open", "awaiting", "resolved"].includes(q.status)) throw badRequest("status must be open|awaiting|resolved");
      p.push(now.toString());
      where.push(q.status === "resolved" ? `contract_status='Resolved'` : q.status === "open" ? `contract_status<>'Resolved' AND cutoff_ns > $${p.length}::numeric` : `contract_status<>'Resolved' AND cutoff_ns <= $${p.length}::numeric`);
    }
    const sort = ({ newest: "created_at DESC", closing: "cutoff_ns ASC", volume: "(SELECT COALESCE(SUM(collateral_amount),0) FROM fills f WHERE f.market_ref=markets.market_ref) DESC" } as Record<string, string>)[q.sort ?? "newest"];
    if (!sort) throw badRequest("sort must be newest|closing|volume");
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (await db.query(`SELECT COUNT(*) FROM markets ${w}`, p)).rows[0].count;
    const rows = (await db.query(`SELECT * FROM markets ${w} ORDER BY ${sort}, market_ref LIMIT ${limit} OFFSET ${offset}`, p)).rows;
    const stats = await marketStats(db, rows.map((r: any) => r.market_ref), now);
    return { items: rows.map((r: any) => marketDto(r, stats.get(r.market_ref), now)), page: { limit, offset, total: Number(total) }, freshness: await freshness(db) };
  });

  app.get("/v1/categories", async () => {
    const r = await db.query("SELECT category, COUNT(*) n FROM markets WHERE category IS NOT NULL GROUP BY category ORDER BY category");
    return { items: r.rows.map((x: any) => ({ category: x.category, count: Number(x.n) })) };
  });

  app.get("/v1/markets/:marketRef", async (req) => {
    const row = await getMarketRow(ctx, (req.params as any).marketRef);
    const stats = await marketStats(db, [row.market_ref]);
    const dep = await db.query("SELECT artifact_id, artifact_version, artifact_sha256, code_hash_base58, source_version, tx_hashes, verification FROM deployment_records WHERE market_ref=$1", [row.market_ref]);
    const rw = (await db.query("SELECT policy, provider, cutoff_passed, observation_complete, evidence_state, note, last_checked_at FROM resolution_watch WHERE market_ref=$1", [row.market_ref])).rows[0];
    return { ...marketDto(row, stats.get(row.market_ref)), resolutionStatus: rw ? { policy: rw.policy, provider: rw.provider, cutoffPassed: rw.cutoff_passed, observationComplete: rw.observation_complete, evidence: rw.evidence_state, note: rw.note, lastCheckedAt: rw.last_checked_at, rule: "Separate conditions: the contract-enforced trading cutoff, completion of the observation period, and available reviewed evidence. Missing or ambiguous evidence never becomes NO." } : null, deployment: dep.rows[0] ? { artifactId: dep.rows[0].artifact_id, artifactVersion: dep.rows[0].artifact_version, artifactSha256: dep.rows[0].artifact_sha256, codeHashBase58: dep.rows[0].code_hash_base58, sourceVersion: dep.rows[0].source_version, txHashes: dep.rows[0].tx_hashes, verification: dep.rows[0].verification } : null, freshness: await freshness(db) };
  });

  /** Separate YES and NO books: bids (Buy, best = highest) and asks (Sell, best = lowest). Only executable offers appear in bids/asks. */
  app.get("/v1/markets/:marketRef/book", async (req) => {
    const row = await getMarketRow(ctx, (req.params as any).marketRef);
    const now = nowNs();
    const open = (await db.query("SELECT * FROM offers WHERE market_ref=$1 AND state='open'", [row.market_ref])).rows;
    const closed = effectiveStatus(row, now) !== "Open";
    const fillable = (o: any) => !closed && (o.expires_at_ns === null || BigInt(o.expires_at_ns) > now);
    const dto = (o: any) => ({ offerId: o.offer_id, offerRef: `${row.market_ref}:${o.offer_id}`, owner: o.owner_id, price: o.price, remainingQuantity: o.remaining, originalQuantity: o.quantity, expiresAtNs: o.expires_at_ns, createdAtNs: o.created_ns });
    const side = (outcome: string) => {
      const xs = open.filter((o: any) => o.outcome === outcome && fillable(o));
      const cmp = (a: any, b: any, dir: 1 | -1) => { const d = BigInt(a.price) - BigInt(b.price); return d === 0n ? Number(BigInt(a.offer_id) - BigInt(b.offer_id)) : d > 0n ? dir : -dir; };
      const bids = xs.filter((o: any) => o.side === "Buy").sort((a: any, b: any) => cmp(a, b, -1)).map(dto);
      const asks = xs.filter((o: any) => o.side === "Sell").sort((a: any, b: any) => cmp(a, b, 1)).map(dto);
      const levels = (arr: any[]) => { const m = new Map<string, bigint>(); for (const o of arr) m.set(o.price, (m.get(o.price) ?? 0n) + BigInt(o.remainingQuantity)); return [...m].map(([price, q]) => ({ price, quantity: q.toString() })); };
      return { bids, asks, bidLevels: levels(bids), askLevels: levels(asks), empty: bids.length === 0 && asks.length === 0 };
    };
    const unfillable = open.filter((o: any) => !fillable(o)).map((o: any) => ({ ...dto(o), outcome: o.outcome, side: o.side, reason: closed ? "market_closed" : "expired", cancellable: true }));
    return { marketRef: row.market_ref, contract: { contractId: row.contract_id, marketId: row.internal_market_id }, status: effectiveStatus(row, now), yes: side("Yes"), no: side("No"), unfillable, note: "Order books are an indexed view of onchain offers; users sign fill/cancel in their own wallet. YES and NO books are independent.", freshness: await freshness(db) };
  });

  app.get("/v1/markets/:marketRef/trades", async (req) => {
    const row = await getMarketRow(ctx, (req.params as any).marketRef);
    const q = req.query as Record<string, string | undefined>;
    const limit = intParam(q.limit, 50, 1, 200);
    const p: unknown[] = [row.market_ref]; let cur = "";
    if (q.before) { if (!/^\d+$/.test(q.before)) throw badRequest("before must be a trade id"); p.push(q.before); cur = `AND id < $2`; }
    const rows = (await db.query(`SELECT * FROM fills WHERE market_ref=$1 ${cur} ORDER BY id DESC LIMIT ${limit}`, p)).rows;
    return { items: rows.map((f: any) => ({ tradeId: f.id, offerId: f.offer_id, outcome: f.outcome, price: f.price, quantity: f.quantity, collateralAmount: f.collateral_amount, maker: f.maker_id, taker: f.taker_id, makerSide: f.maker_side, takerSide: f.maker_side === "Sell" ? "Buy" : "Sell", blockHeight: Number(f.block_height), timestampNs: f.ts_ns, receiptId: f.receipt_id })), nextBefore: rows.length === limit ? rows[rows.length - 1].id : null, freshness: await freshness(db) };
  });

  /** OHLC from confirmed fills only, per outcome. Price = the offer's fixed price; volume = sum of collateral_amount. Empty buckets are omitted (no interpolation). */
  app.get("/v1/markets/:marketRef/candles", async (req) => {
    const row = await getMarketRow(ctx, (req.params as any).marketRef);
    const q = req.query as Record<string, string | undefined>;
    const outcome = q.outcome ?? "Yes"; if (outcome !== "Yes" && outcome !== "No") throw badRequest("outcome must be Yes|No");
    const iv = q.interval ?? "1h"; const secs = INTERVALS[iv]; if (!secs) throw badRequest("interval must be one of " + Object.keys(INTERVALS).join(","));
    const limit = intParam(q.limit, 200, 1, 1000);
    const size = (secs * SECOND_NS).toString();
    const r = await db.query(
      `SELECT (floor(ts_ns / $3::numeric) * $3::numeric) AS bucket,
              (array_agg(price ORDER BY ts_ns, id))[1] AS o, MAX(price) AS h, MIN(price) AS l, (array_agg(price ORDER BY ts_ns DESC, id DESC))[1] AS c,
              SUM(collateral_amount) AS volume, SUM(quantity) AS shares, COUNT(*) AS trades
       FROM fills WHERE market_ref=$1 AND outcome=$2 GROUP BY 1 ORDER BY 1 DESC LIMIT ${limit}`, [row.market_ref, outcome, size]);
    return { marketRef: row.market_ref, outcome, interval: iv, methodology: "Candles are built from confirmed offer_filled events for this outcome only; open/high/low/close are fill prices; empty intervals are omitted.", candles: r.rows.reverse().map((c: any) => ({ startNs: c.bucket, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.volume, shares: c.shares, trades: Number(c.trades) })), freshness: await freshness(db) };
  });

  app.get("/v1/markets/:marketRef/activity", async (req) => {
    const row = await getMarketRow(ctx, (req.params as any).marketRef);
    const limit = intParam((req.query as any).limit, 50, 1, 200);
    const rows = (await db.query("SELECT * FROM activity WHERE market_ref=$1 AND kind IN ('offer_created','offer_cancelled','fill_taker','redeem') ORDER BY id DESC LIMIT " + limit, [row.market_ref])).rows;
    return { items: rows.map(activityDto), freshness: await freshness(db) };
  });
}

export const activityDto = (a: any) => ({ id: a.id, marketRef: a.market_ref, account: a.account_id, kind: a.kind, amount: a.amount, detail: a.detail, timestampNs: a.ts_ns, receiptId: a.receipt_id });
