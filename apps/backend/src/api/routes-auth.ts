import type { FastifyInstance } from "fastify";
import { bearer, requireSession, type Ctx } from "./app.js";
import { HttpError } from "./http.js";

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, auth } = ctx;
  app.post("/v1/auth/challenge", async (req) => auth.challenge(String((req.body as any)?.accountId ?? "")));
  app.post("/v1/auth/verify", async (req) => {
    const b = (req.body ?? {}) as Record<string, string>;
    for (const k of ["accountId", "publicKey", "signature", "nonce"]) if (typeof b[k] !== "string") throw new HttpError(400, "bad_request", `${k} is required`);
    return auth.verify({ accountId: b.accountId, publicKey: b.publicKey, signature: b.signature, nonce: b.nonce });
  });
  app.get("/v1/auth/session", async (req) => { const s = await requireSession(ctx, req); return { accountId: s.accountId, expiresAt: s.expiresAt, isAdmin: s.isAdmin }; });
  app.post("/v1/auth/logout", async (req) => { await requireSession(ctx, req); await auth.logout(bearer(req)!); return { ok: true }; });

  // ---- watchlist (authenticated)
  app.get("/v1/watchlist", async (req) => {
    const s = await requireSession(ctx, req);
    const r = await db.query("SELECT w.market_ref, w.created_at, m.question FROM watchlist w JOIN markets m USING (market_ref) WHERE w.account_id=$1 ORDER BY w.created_at DESC", [s.accountId]);
    return { items: r.rows.map((x: any) => ({ marketRef: x.market_ref, question: x.question, addedAt: new Date(x.created_at).toISOString() })) };
  });
  app.put("/v1/watchlist/:marketRef", async (req) => {
    const s = await requireSession(ctx, req);
    const ref = (req.params as any).marketRef;
    if (!(await db.query("SELECT 1 FROM markets WHERE market_ref=$1", [ref])).rowCount) throw new HttpError(404, "not_found", "market not found");
    await db.query("INSERT INTO watchlist(account_id, market_ref) VALUES ($1,$2) ON CONFLICT DO NOTHING", [s.accountId, ref]);
    return { marketRef: ref, watching: true };
  });
  app.delete("/v1/watchlist/:marketRef", async (req) => {
    const s = await requireSession(ctx, req);
    await db.query("DELETE FROM watchlist WHERE account_id=$1 AND market_ref=$2", [s.accountId, (req.params as any).marketRef]);
    return { marketRef: (req.params as any).marketRef, watching: false };
  });
}
