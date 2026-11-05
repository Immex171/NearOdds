import type { Db, Tx } from "../db/index.js";
import { withTx } from "../db/index.js";
import { Neardata, type NdBlock } from "./neardata.js";
import { parseEventLogs, receiptSucceeded } from "./events.js";
import { applyEvent } from "./project.js";

export interface Watched { ref: string; contractId: string; indexedThrough: number | null }
const INDEX_LOCK = 727003;

/** Ingest ONE block: successful receipts executed BY a watched market account, valid standard/version, deduped by (receipt, log). */
export async function ingestBlock(c: Tx, b: NdBlock, watched: Map<string, Watched>, only?: string, snapCache?: Map<string, number | null>, force = false): Promise<number> {
  const height = b.block.header.height;
  const tsNs = String(b.block.header.timestamp_nanosec);
  const cache = snapCache ?? new Map<string, number | null>();
  let applied = 0;
  for (const shard of b.shards) {
    for (const r of shard.receipt_execution_outcomes ?? []) {
      const o = r.execution_outcome.outcome;
      const w = watched.get(o.executor_id);
      if (!w || (only && w.contractId !== only) || r.receipt.receiver_id !== o.executor_id) continue;
      if (w.indexedThrough !== null && height <= w.indexedThrough && !only && !force) continue; // catch-up owns this range
      if (!receiptSucceeded(o.status)) continue;
      const receiptId = r.execution_outcome.id;
      const events = parseEventLogs(o.logs);
      if (!events.length) continue;
      // Serialise with reconcile for this market and read its snapshot anchor (held until the transaction ends).
      if (!cache.has(w.ref)) {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [w.ref]);
        const s = await c.query("SELECT snapshot_height FROM markets WHERE market_ref=$1", [w.ref]);
        cache.set(w.ref, s.rows[0]?.snapshot_height == null ? null : Number(s.rows[0].snapshot_height));
      }
      const anchor = cache.get(w.ref)!;
      const snap = anchor === null || height > anchor;
      for (const ev of events) {
        const ins = await c.query(
          `INSERT INTO chain_events(market_ref, receipt_id, log_index, block_height, block_ts_ns, event, data, tx_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (receipt_id, log_index) DO NOTHING`,
          [w.ref, receiptId, ev.logIndex, height, tsNs, ev.event, JSON.stringify(ev.data), r.tx_hash ?? null]);
        if (!ins.rowCount) continue; // replay: already counted
        await applyEvent(c, { marketRef: w.ref, receiptId, logIndex: ev.logIndex, height, tsNs, txHash: r.tx_hash ?? null, event: ev.event, data: ev.data, snap });
        if (snap) await c.query("UPDATE markets SET applied_height = GREATEST(COALESCE(applied_height,0), $2) WHERE market_ref=$1", [w.ref, height]);
        applied++;
      }
    }
  }
  return applied;
}

async function loadWatched(db: Db | Tx): Promise<Map<string, Watched>> {
  const r = await db.query("SELECT market_ref, contract_id, indexed_through FROM markets");
  return new Map(r.rows.map((x: any) => [x.contract_id, { ref: x.market_ref, contractId: x.contract_id, indexedThrough: x.indexed_through === null ? null : Number(x.indexed_through) }]));
}

export interface Gap { from: number; to: number; reason: string }
export interface RangeResult { blocks: NdBlock[]; skipped: number[]; gaps: Gap[]; /** last height fully accounted for (block ingested, skip proven, or gap recorded) */ through: number }

/**
 * Fetch [from,to] and classify every height:
 *  - block present            -> ingest
 *  - provider returned none   -> PROVEN skipped only if the nearest existing block above it has prev_height < height
 *                                (the chain's own linkage); otherwise it is an unresolved gap (provider data unavailable).
 * Trailing misses are checked against a forward anchor block just beyond `to`.
 */
export async function resolveRange(nd: Neardata, from: number, to: number, concurrency = 2): Promise<RangeResult> {
  const hs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const got: (NdBlock | null)[] = new Array(hs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, hs.length) }, async () => {
    for (;;) { const i = next++; if (i >= hs.length) return; got[i] = await nd.block(hs[i]); }
  }));
  let above: NdBlock | null = null;
  if (got[got.length - 1] === null) { // need an anchor beyond the range
    for (let h = to + 1; h <= to + 30 && !above; h++) above = await nd.block(h);
  }
  const skipped: number[] = []; const gaps: Gap[] = [];
  let nearest: NdBlock | null = above;
  for (let i = hs.length - 1; i >= 0; i--) {
    const b = got[i];
    if (b) { nearest = b; continue; }
    const h = hs[i];
    const prev = nearest?.block.header.prev_height;
    if (nearest && typeof prev === "number" && prev < h) skipped.push(h);
    else {
      const reason = nearest ? `provider has no block ${h}, but block ${nearest.block.header.height} links to prev_height ${prev ?? "unknown"}: not proven skipped` : `provider has no block ${h} and no anchor block above it`;
      const last = gaps[gaps.length - 1];
      if (last && last.from === h + 1) { last.from = h; last.reason = reason; } else gaps.push({ from: h, to: h, reason });
    }
  }
  return { blocks: got.filter((b): b is NdBlock => !!b), skipped: skipped.reverse(), gaps: gaps.reverse(), through: to };
}

export interface IndexerStatus { checkpoint: number | null; tip: number | null; lag: number | null; error: string | null; catchingUp: string[]; openGaps: number }

/** One indexing writer at a time across workers (session advisory lock on a dedicated connection). */
async function withIndexLock<T>(db: Db, wait: boolean, fn: () => Promise<T>): Promise<T | null> {
  const c = await db.connect();
  try {
    if (wait) await c.query("SELECT pg_advisory_lock($1)", [INDEX_LOCK]);
    else if (!(await c.query("SELECT pg_try_advisory_lock($1) ok", [INDEX_LOCK])).rows[0].ok) return null;
    try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock($1)", [INDEX_LOCK]); }
  } finally { c.release(); }
}

export class Indexer {
  lastError: string | null = null;
  constructor(private db: Db, private nd: Neardata, private opts: { batch?: number; concurrency?: number; startHeight?: number } = {}) {}

  async checkpoint(): Promise<number | null> {
    const r = await this.db.query("SELECT height FROM indexer_checkpoints WHERE name='main'");
    return r.rowCount ? Number(r.rows[0].height) : null;
  }

  private async recordGaps(c: Tx, scope: string, gaps: Gap[]) {
    for (const g of gaps) await c.query(
      "INSERT INTO index_gaps(scope, from_height, to_height, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (scope, from_height, to_height) DO UPDATE SET reason=$4, resolved_at=NULL", [scope, g.from, g.to, g.reason]);
  }

  /** history_complete only when the market's scan reached the checkpoint AND no unresolved gap overlaps its history. */
  async refreshCoverage() {
    await this.db.query(
      `UPDATE markets m SET history_complete = (
         m.history_start_height IS NOT NULL AND m.indexed_through IS NOT NULL
         AND m.indexed_through >= COALESCE((SELECT height FROM indexer_checkpoints WHERE name='main'), 0)
         AND NOT EXISTS (SELECT 1 FROM index_gaps g WHERE g.resolved_at IS NULL AND (g.scope = m.market_ref OR (g.scope='main' AND g.to_height >= m.history_start_height))))`);
  }

  /** Markets that need an older range scanned before the live loop may advance. */
  async catchUpPending(limitBlocks = 2000): Promise<boolean> {
    const cp = await this.checkpoint();
    if (cp === null) return false;
    const r = await this.db.query("SELECT market_ref, contract_id, history_start_height, indexed_through FROM markets WHERE history_start_height IS NOT NULL AND (indexed_through IS NULL OR indexed_through < $1) ORDER BY created_at LIMIT 1", [cp]);
    if (!r.rowCount) return false;
    const m = r.rows[0];
    const from = (m.indexed_through === null ? Number(m.history_start_height) - 1 : Number(m.indexed_through)) + 1;
    const to = Math.min(cp, from + limitBlocks - 1);
    const rr = await resolveRange(this.nd, from, to, this.opts.concurrency);
    const watched = await loadWatched(this.db);
    await withTx(this.db, async (c) => {
      const cache = new Map<string, number | null>();
      for (const b of rr.blocks) await ingestBlock(c, b, watched, m.contract_id, cache);
      await this.recordGaps(c, m.market_ref, rr.gaps);
      await c.query("UPDATE markets SET indexed_through=$2 WHERE market_ref=$1", [m.market_ref, to]);
    });
    return true;
  }

  /** Re-attempt unresolved gaps (backoff by attempts). Found blocks are ingested as history; proven skips close the gap. */
  async retryGaps(max = 3): Promise<number> {
    const gaps = (await this.db.query(
      `SELECT g.*, m.contract_id FROM index_gaps g LEFT JOIN markets m ON m.market_ref = g.scope
       WHERE g.resolved_at IS NULL AND (g.last_attempt_at IS NULL OR g.last_attempt_at < now() - make_interval(secs => LEAST(3600, 30 * (g.attempts + 1))))
       ORDER BY g.id LIMIT $1`, [max])).rows;
    let closed = 0;
    for (const g of gaps) {
      const from = Number(g.from_height), to = Number(g.to_height);
      const rr = await resolveRange(this.nd, from, Math.min(to, from + 999), this.opts.concurrency);
      const watched = await loadWatched(this.db);
      await withTx(this.db, async (c) => {
        const cache = new Map<string, number | null>();
        for (const b of rr.blocks) await ingestBlock(c, b, watched, g.contract_id ?? undefined, cache, true);
        await c.query("UPDATE index_gaps SET resolved_at=now(), last_attempt_at=now(), attempts=attempts+1 WHERE id=$1", [g.id]);
        await this.recordGaps(c, g.scope, rr.gaps);
        if (Math.min(to, from + 999) < to) await this.recordGaps(c, g.scope, [{ from: from + 1000, to, reason: "remaining part of a large gap" }]);
      });
      if (!rr.gaps.length) closed++;
    }
    return closed;
  }

  /** One live step. Returns number of blocks consumed. */
  async step(): Promise<number> {
    const r = await withIndexLock(this.db, false, async () => {
      try {
        const tip = await this.nd.finalHeight();
        let cp = await this.checkpoint();
        if (cp === null) {
          cp = (this.opts.startHeight ?? tip) - 1;
          await this.db.query("INSERT INTO indexer_checkpoints(name, height) VALUES ('main',$1) ON CONFLICT DO NOTHING", [cp]);
        }
        await this.retryGaps();
        if (await this.catchUpPending()) { await this.refreshCoverage(); this.lastError = null; return 0; }
        let consumed = 0;
        if (cp < tip) {
          const to = Math.min(tip, cp + (this.opts.batch ?? 50));
          const rr = await resolveRange(this.nd, cp + 1, to, this.opts.concurrency);
          const watched = await loadWatched(this.db);
          await withTx(this.db, async (c) => {
            const cache = new Map<string, number | null>();
            for (const b of rr.blocks) await ingestBlock(c, b, watched, undefined, cache);
            await this.recordGaps(c, "main", rr.gaps);
            const last = rr.blocks[rr.blocks.length - 1];
            await c.query("UPDATE indexer_checkpoints SET height=$1, block_hash=COALESCE($2, block_hash), block_ts_ns=COALESCE($3, block_ts_ns), updated_at=now() WHERE name='main' AND height=$4",
              [to, last?.block.header.hash ?? null, last ? String(last.block.header.timestamp_nanosec) : null, cp]);
            // Markets whose scan is continuous with the live stream move along with it (catch-up only covers the older range).
            await c.query("UPDATE markets SET indexed_through=$1 WHERE indexed_through IS NOT NULL AND indexed_through >= $2", [to, cp]);
          });
          consumed = to - cp;
        }
        await this.db.query("INSERT INTO indexer_checkpoints(name, height) VALUES ('tip',$1) ON CONFLICT (name) DO UPDATE SET height=$1, updated_at=now()", [tip]);
        await this.refreshCoverage();
        this.lastError = null;
        return consumed;
      } catch (e) { this.lastError = (e as Error).message; throw e; }
    });
    return r ?? 0;
  }

  /** Test/ops helper: process exactly these blocks (e.g. replay) through the same path. */
  async processBlocks(blocks: NdBlock[]): Promise<number> {
    const watched = await loadWatched(this.db);
    return (await withIndexLock(this.db, true, () => withTx(this.db, async (c) => { const cache = new Map<string, number | null>(); let n = 0; for (const b of blocks) n += await ingestBlock(c, b, watched, undefined, cache); return n; }))) ?? 0;
  }

  async status(): Promise<IndexerStatus> {
    const cp = await this.checkpoint();
    const t = await this.db.query("SELECT height FROM indexer_checkpoints WHERE name='tip'");
    const tip = t.rowCount ? Number(t.rows[0].height) : null;
    const c = await this.db.query("SELECT market_ref FROM markets WHERE history_start_height IS NOT NULL AND NOT history_complete");
    const g = await this.db.query("SELECT COUNT(*)::int n FROM index_gaps WHERE resolved_at IS NULL");
    return { checkpoint: cp, tip, lag: cp !== null && tip !== null ? Math.max(0, tip - cp) : null, error: this.lastError, catchingUp: c.rows.map((x: any) => x.market_ref), openGaps: g.rows[0].n };
  }
}

/**
 * Historical backfill from KNOWN transactions through the RPC when the block provider cannot serve the range.
 * Same ingest path/dedupe keys as the live indexer; events older than the market's snapshot anchor stay history-only.
 */
export async function backfillTransactions(db: Db, rpc: import("../near/rpc.js").Rpc, txs: { txHash: string; senders: string[] }[]): Promise<{ ingested: number; missing: string[] }> {
  const missing: string[] = [];
  let ingested = 0;
  const blocks = new Map<string, { height: number; ts: string }>();
  for (const t of txs) {
    let st: any = null;
    for (const s of t.senders) { try { st = await rpc.read("EXPERIMENTAL_tx_status", { tx_hash: t.txHash, sender_account_id: s, wait_until: "FINAL" }); break; } catch (e: any) { if (e?.name === "RpcUnavailableError") throw e; } }
    if (!st) { missing.push(t.txHash); continue; }
    const byBlock = new Map<string, any[]>();
    for (const ro of st.receipts_outcome ?? []) { const a = byBlock.get(ro.block_hash) ?? []; a.push(ro); byBlock.set(ro.block_hash, a); }
    for (const [bh, ros] of byBlock) {
      if (!blocks.has(bh)) { const b = await rpc.read("block", { block_id: bh }); blocks.set(bh, { height: b.header.height, ts: String(b.header.timestamp_nanosec) }); }
      const bi = blocks.get(bh)!;
      const nd: NdBlock = {
        block: { header: { height: bi.height, hash: bh, timestamp_nanosec: bi.ts } },
        shards: [{ shard_id: 0, receipt_execution_outcomes: ros.map((ro: any) => ({
          execution_outcome: { id: ro.id, block_hash: bh, outcome: ro.outcome }, receipt: { predecessor_id: "", receiver_id: ro.outcome.executor_id, receipt_id: ro.id }, tx_hash: t.txHash })) }],
      };
      const watched = await loadWatched(db);
      ingested += (await withIndexLock(db, true, () => withTx(db, (c) => ingestBlock(c, nd, watched)))) ?? 0;
    }
  }
  return { ingested, missing };
}
