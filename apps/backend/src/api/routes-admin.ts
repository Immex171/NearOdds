import type { FastifyInstance } from "fastify";
import { requireAdmin, type Ctx } from "./app.js";
import { HttpError, intParam } from "./http.js";
import { TemplateError, createTemplate, updateTemplate } from "../keeper/templates.js";
import { ProviderRegistry, ResolutionError, defaultProviders, proposeResolution, reviewProposal } from "../keeper/resolution.js";
import { roleStatus } from "../keeper/signers.js";
import { TemplateSpec, dueOccurrences } from "../keeper/template.js";

function wrap<T>(f: () => Promise<T>): Promise<T> {
  return f().catch((e) => {
    if (e instanceof TemplateError) throw new HttpError(e.code === "not_found" ? 404 : 400, e.code, e.message, e.details);
    if (e instanceof ResolutionError) throw new HttpError(e.code === "not_found" ? 404 : e.code === "proposal_exists" || e.code === "not_pending" ? 409 : 400, e.code, e.message);
    throw e;
  });
}
const tplDto = (t: any) => ({ id: t.id, slug: t.slug, version: t.version, enabled: t.enabled, category: t.category, tag: t.tag, spec: t.spec, createdBy: t.created_by, lastScheduledFor: t.last_scheduled_for, updatedAt: t.updated_at });

export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx & { providers?: ProviderRegistry }) {
  const { db, cfg } = ctx;
  const providers = ctx.providers ?? defaultProviders();

  app.get("/v1/admin/templates", async (req) => { await requireAdmin(ctx, req); return { items: (await db.query("SELECT * FROM templates ORDER BY id")).rows.map(tplDto) }; });
  app.post("/v1/admin/templates", async (req, reply) => {
    const s = await requireAdmin(ctx, req);
    const t = await wrap(() => createTemplate(db, req.body, s.accountId, cfg, providers));
    return reply.code(201).send(tplDto(t));
  });
  app.patch("/v1/admin/templates/:id", async (req) => {
    await requireAdmin(ctx, req);
    const b = (req.body ?? {}) as { enabled?: boolean; spec?: unknown };
    return tplDto(await wrap(() => updateTemplate(db, (req.params as any).id, b, cfg, providers)));
  });
  /** What the scheduler would create right now (no side effects). */
  app.get("/v1/admin/templates/:id/preview", async (req) => {
    await requireAdmin(ctx, req);
    const t = (await db.query("SELECT * FROM templates WHERE id=$1", [(req.params as any).id])).rows[0];
    if (!t) throw new HttpError(404, "not_found", "template not found");
    const spec = TemplateSpec.parse(t.spec);
    return { due: dueOccurrences(spec, t.version, Date.now()).map((o) => ({ occurrence: o.dedupe, cutoff: new Date(o.cutoffMs).toISOString(), observationEnd: o.obsEndMs ? new Date(o.obsEndMs).toISOString() : null })) };
  });

  app.get("/v1/admin/jobs", async (req) => {
    await requireAdmin(ctx, req);
    const q = req.query as Record<string, string | undefined>;
    const limit = intParam(q.limit, 50, 1, 200);
    const p: unknown[] = []; let w = "";
    if (q.state) { p.push(q.state); w = "WHERE state = $1"; }
    const jobs = (await db.query(`SELECT id, kind, dedupe_key, state, step, attempts, run_after, last_error, owner, lease_until, created_at, updated_at, payload - 'intent' AS payload, (payload->'intent'->>'accountName') AS account FROM jobs ${w} ORDER BY id DESC LIMIT ${limit}`, p)).rows;
    const txs = (await db.query("SELECT id, job_id, op_key, signer_id, receiver_id, description, nonce, tx_hash, state, failure, updated_at FROM tx_journal ORDER BY id DESC LIMIT 100")).rows;
    return { jobs, transactions: txs, signers: roleStatus(cfg) };
  });

  app.get("/v1/admin/resolutions", async (req) => {
    await requireAdmin(ctx, req);
    const proposals = (await db.query("SELECT * FROM resolution_proposals ORDER BY id DESC LIMIT 100")).rows;
    const watch = (await db.query("SELECT w.*, m.question, m.cutoff_ns, m.observation_end_ns FROM resolution_watch w JOIN markets m USING (market_ref) ORDER BY m.cutoff_ns")).rows;
    return {
      trustModel: "Final YES/NO is set once by the configured resolver account; no VOID/dispute path exists in the contract.",
      conditions: watch.map((w: any) => ({ marketRef: w.market_ref, question: w.question, policy: w.policy, provider: w.provider, cutoffPassed: w.cutoff_passed, observationComplete: w.observation_complete, evidence: w.evidence_state, note: w.note, lastCheckedAt: w.last_checked_at })),
      proposals,
    };
  });
  app.post("/v1/admin/resolutions", async (req, reply) => {
    const s = await requireAdmin(ctx, req);
    const b = (req.body ?? {}) as Record<string, any>;
    if (typeof b.marketRef !== "string" || typeof b.evidenceRef !== "string" || typeof b.retrievedAt !== "string") throw new HttpError(400, "bad_request", "marketRef, outcome, evidenceRef and retrievedAt are required");
    const p = await wrap(() => proposeResolution(db, { marketRef: b.marketRef, outcome: b.outcome, evidenceRef: b.evidenceRef, evidenceNote: b.evidenceNote, retrievedAt: new Date(b.retrievedAt), proposedBy: s.accountId }));
    return reply.code(201).send(p);
  });
  app.post("/v1/admin/resolutions/:id/review", async (req) => {
    const s = await requireAdmin(ctx, req);
    const b = (req.body ?? {}) as { decision?: string; note?: string };
    if (b.decision !== "approved" && b.decision !== "rejected") throw new HttpError(400, "bad_request", "decision must be approved|rejected");
    return wrap(() => reviewProposal(db, (req.params as any).id, s.accountId, b.decision as "approved" | "rejected", b.note, cfg.adminAccounts.length));
  });
}
