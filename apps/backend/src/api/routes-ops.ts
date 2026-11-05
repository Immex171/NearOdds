import type { FastifyInstance } from "fastify";
import type { Ctx } from "./app.js";
import { freshness } from "./dto.js";

export async function opsSummary(ctx: Ctx) {
  const { db } = ctx;
  const f = await freshness(db);
  const workers = (await db.query("SELECT worker_id, role, info, beat_at, now() - beat_at AS age FROM worker_heartbeats ORDER BY role, worker_id")).rows;
  const jobs = (await db.query("SELECT state, COUNT(*) n FROM jobs GROUP BY state")).rows;
  const unc = (await db.query("SELECT op_key, tx_hash, signer_id, state, description, failure, updated_at FROM tx_journal WHERE state IN ('prepared','broadcast','uncertain') ORDER BY id")).rows;
  const cp = (await db.query("SELECT market_ref FROM markets WHERE history_start_height IS NOT NULL AND NOT history_complete")).rowCount;
  return {
    indexer: { checkpointHeight: f.blockHeight, tipHeight: f.tipHeight, lagBlocks: f.lagBlocks, checkpointUpdatedAt: f.checkpointUpdatedAt, marketsCatchingUp: cp },
    workers: workers.map((w: any) => ({ workerId: w.worker_id, role: w.role, lastBeatAt: new Date(w.beat_at).toISOString(), stale: Date.parse(new Date().toISOString()) - Date.parse(new Date(w.beat_at).toISOString()) > 60_000, info: w.info })),
    jobs: Object.fromEntries(jobs.map((j: any) => [j.state, Number(j.n)])),
    transactions: { unresolvedCount: unc.length, unresolved: unc.map((t: any) => ({ opKey: t.op_key, txHash: t.tx_hash, signer: t.signer_id, state: t.state, description: t.description, note: t.failure, updatedAt: new Date(t.updated_at).toISOString() })) },
    generatedAt: f.generatedAt,
  };
}

export function registerOpsRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/v1/health", async () => ({ status: "ok" }));
  app.get("/v1/ready", async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try { await ctx.db.query("SELECT 1"); checks.database = { ok: true }; } catch (e) { checks.database = { ok: false, detail: (e as Error).message }; }
    if (checks.database.ok) {
      const f = await freshness(ctx.db);
      checks.indexer = f.blockHeight === null ? { ok: false, detail: "indexer has not started" } : (f.lagBlocks ?? 0) > 600 ? { ok: false, detail: `lag ${f.lagBlocks} blocks` } : { ok: true, detail: `lag ${f.lagBlocks ?? "unknown"} blocks` };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ ready: ok, checks });
  });
  app.get("/v1/ops/status", async () => opsSummary(ctx));
}
