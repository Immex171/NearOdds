import type { FastifyInstance } from "fastify";
import { requireSession, type Ctx } from "./app.js";
import { HttpError } from "./http.js";
import { claimFaucet, faucetState } from "../faucet/service.js";

export function registerFaucetRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/v1/faucet", async () => faucetState(ctx.db, ctx.cfg));
  /** Idempotent: send an `Idempotency-Key` header and retry freely; the same key never mints twice. */
  app.post("/v1/faucet/claim", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const key = req.headers["idempotency-key"];
    const r = await claimFaucet(ctx.db, ctx.cfg, s.accountId, typeof key === "string" ? key : undefined);
    const job = r.claim.job_id ? (await ctx.db.query("SELECT state, last_error FROM jobs WHERE id=$1", [r.claim.job_id])).rows[0] : null;
    return reply.code(r.replayed ? 200 : 202).send({ claimId: r.claim.id, accountId: r.claim.account_id, amount: r.claim.amount, state: r.claim.state, jobState: job?.state ?? null, replayed: r.replayed });
  });
  app.get("/v1/faucet/claims/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const r = (await ctx.db.query("SELECT f.*, j.state AS job_state, j.last_error FROM faucet_claims f LEFT JOIN jobs j ON j.id=f.job_id WHERE f.id=$1 AND f.account_id=$2", [(req.params as any).id, s.accountId])).rows[0];
    if (!r) throw new HttpError(404, "not_found", "claim not found");
    return { claimId: r.id, amount: r.amount, state: r.state, jobState: r.job_state, note: r.last_error };
  });
}
