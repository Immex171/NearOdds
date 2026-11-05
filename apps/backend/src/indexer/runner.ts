import type { Db, Tx } from "../db/index.js";
import { withTx } from "../db/index.js";
import { Neardata, type NdBlock } from "./neardata.js";
import { parseEventLogs, receiptSucceeded } from "./events.js";
import { applyEvent } from "./project.js";

export interface Watched { ref: string; contractId: string; indexedThrough: number | null }

/** Ingest ONE block: successful receipts executed BY a watched market account, valid standard/version, deduped by (receipt, log). */
export async function ingestBlock(c: Tx, b: NdBlock, watched: Map<string, Watched>, only?: string): Promise<number> {
  const height = b.block.header.height;
  const tsNs = String(b.block.header.timestamp_nanosec);
  let applied = 0;
  for (const shard of b.shards) {
    for (const r of shard.receipt_execution_outcomes ?? []) {
      const o = r.execution_outcome.outcome;
      const w = watched.get(o.executor_id);
      if (!w || (only && w.contractId !== only) || r.receipt.receiver_id !== o.executor_id) continue;
      if (w.indexedThrough !== null && height <= w.indexedThrough && !only) continue; // catch-up owns this range
      if (!receiptSucceeded(o.status)) continue;
      const receiptId = r.execution_outcome.id;
      for (const ev of parseEventLogs(o.logs)) {
        const ins = await c.query(
          `INSERT INTO chain_events(market_ref, receipt_id, log_index, block_height, block_ts_ns, event, data, tx_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (receipt_id, log_index) DO NOTHING`,
          [w.ref, receiptId, ev.logIndex, height, tsNs, ev.event, JSON.stringify(ev.data), r.tx_hash ?? null]);
        if (!ins.rowCount) continue; // replay: already counted
        await applyEvent(c, { marketRef: w.ref, receiptId, logIndex: ev.logIndex, height, tsNs, txHash: r.tx_hash ?? null, event: ev.event, data: ev.data });
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

export interface IndexerStatus { checkpoint: number | null; tip: number | null; lag: number | null; error: string | null; catchingUp: string[] }

export class Indexer {
  lastError: string | null = null;
  constructor(private db: Db, private nd: Neardata, private opts: { batch?: number; concurrency?: number; startHeight?: number } = {}) {}

  async checkpoint(): Promise<number | null> {
    const r = await this.db.query("SELECT height FROM indexer_checkpoints WHERE name='main'");
    return r.rowCount ? Number(r.rows[0].height) : null;
  }

  private async fetchRange(from: number, to: number): Promise<(NdBlock | null)[]> {
    const conc = this.opts.concurrency ?? 2;
    const hs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const out: (NdBlock | null)[] = new Array(hs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(conc, hs.length) }, async () => {
      for (;;) { const i = next++; if (i >= hs.length) return; out[i] = await this.nd.block(hs[i]); }
    }));
    return out;
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
    const watched = await loadWatched(this.db);
    const blocks = await this.fetchRange(from, to);
    await withTx(this.db, async (c) => {
      for (const b of blocks) if (b) await ingestBlock(c, b, watched, m.contract_id);
      await c.query("UPDATE markets SET indexed_through=$2, history_complete = ($2::bigint >= $3::bigint) WHERE market_ref=$1", [m.market_ref, to, cp]);
    });
    return true;
  }

  /** One live step. Returns number of blocks consumed. */
  async step(): Promise<number> {
    try {
      const tip = await this.nd.finalHeight();
      let cp = await this.checkpoint();
      if (cp === null) {
        cp = (this.opts.startHeight ?? tip) - 1;
        await this.db.query("INSERT INTO indexer_checkpoints(name, height) VALUES ('main',$1) ON CONFLICT DO NOTHING", [cp]);
      }
      if (await this.catchUpPending()) { this.lastError = null; return 0; }
      if (cp >= tip) { await this.touch(tip); this.lastError = null; return 0; }
      const to = Math.min(tip, cp + (this.opts.batch ?? 50));
      const blocks = await this.fetchRange(cp + 1, to);
      const watched = await loadWatched(this.db);
      await withTx(this.db, async (c) => {
        for (const b of blocks) if (b) await ingestBlock(c, b, watched);
        const last = [...blocks].reverse().find(Boolean);
        await c.query("UPDATE indexer_checkpoints SET height=$1, block_hash=$2, block_ts_ns=COALESCE($3, block_ts_ns), updated_at=now() WHERE name='main'",
          [to, last?.block.header.hash ?? null, last ? String(last.block.header.timestamp_nanosec) : null]);
      });
      await this.db.query("UPDATE indexer_checkpoints SET updated_at=now() WHERE name='tip'"); // noop if absent
      await this.touch(tip);
      this.lastError = null;
      return to - cp;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  private async touch(tip: number) {
    await this.db.query("INSERT INTO indexer_checkpoints(name, height) VALUES ('tip',$1) ON CONFLICT (name) DO UPDATE SET height=$1, updated_at=now()", [tip]);
  }

  /** Test/ops helper: process exactly these blocks (e.g. replay) through the same path. */
  async processBlocks(blocks: NdBlock[]): Promise<number> {
    const watched = await loadWatched(this.db);
    return withTx(this.db, async (c) => { let n = 0; for (const b of blocks) n += await ingestBlock(c, b, watched); return n; });
  }

  async status(): Promise<IndexerStatus> {
    const cp = await this.checkpoint();
    const t = await this.db.query("SELECT height FROM indexer_checkpoints WHERE name='tip'");
    const tip = t.rowCount ? Number(t.rows[0].height) : null;
    const c = await this.db.query("SELECT market_ref FROM markets WHERE history_start_height IS NOT NULL AND NOT history_complete");
    return { checkpoint: cp, tip, lag: cp !== null && tip !== null ? Math.max(0, tip - cp) : null, error: this.lastError, catchingUp: c.rows.map((x: any) => x.market_ref) };
  }
}

/**
 * Historical backfill from KNOWN transactions through the RPC when the block provider cannot serve the range
 * (e.g. anonymous Neardata rate limits). Uses the exact same ingest path/dedupe keys as the live indexer.
 */
export async function backfillTransactions(db: Db, rpc: import("../near/rpc.js").Rpc, txs: { txHash: string; senders: string[] }[]): Promise<{ ingested: number; missing: string[] }> {
  const watched = await loadWatched(db);
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
      ingested += await withTx(db, (c) => ingestBlock(c, nd, watched, undefined));
    }
  }
  return { ingested, missing };
}
