import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import type { Rpc } from "../near/rpc.js";
import { AuthService } from "../auth/service.js";
import { HttpError } from "./http.js";
import { registerMarketRoutes } from "./routes-markets.js";
import { registerAccountRoutes } from "./routes-accounts.js";
import { registerOpsRoutes } from "./routes-ops.js";
import { registerStreamRoutes } from "./routes-stream.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerFaucetRoutes } from "./routes-faucet.js";
import { openapi } from "./openapi.js";

export interface Ctx { db: Db; rpc: Rpc; cfg: Config; auth: AuthService; streamPollMs?: number }

export type Session = { accountId: string; publicKey: string; expiresAt: string; isAdmin: boolean };

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}
export async function requireSession(ctx: Ctx, req: FastifyRequest): Promise<Session> {
  const s = await ctx.auth.session(bearer(req));
  if (!s) throw new HttpError(401, "unauthenticated", "a valid session token is required");
  return s;
}
/** Explicit administrator allowlist (ADMIN_ACCOUNTS). */
export async function requireAdmin(ctx: Ctx, req: FastifyRequest): Promise<Session> {
  const s = await requireSession(ctx, req);
  if (!ctx.cfg.adminAccounts.includes(s.accountId)) throw new HttpError(403, "forbidden", "account is not on the administrator allowlist");
  return s;
}

export function buildApp(ctx: Omit<Ctx, "auth"> & { auth?: AuthService }): FastifyInstance {
  const full: Ctx = { ...ctx, auth: ctx.auth ?? new AuthService(ctx.db, ctx.rpc, ctx.cfg.authRecipient, ctx.cfg.sessionTtlSeconds, ctx.cfg.adminAccounts) };
  const app = Fastify({ logger: false });
  app.register(cors, { origin: full.cfg.corsOrigins, credentials: false, allowedHeaders: ["authorization", "content-type", "last-event-id"] });
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details } });
    if (e?.validation || e?.statusCode === 400) return reply.code(400).send({ error: { code: "bad_request", message: e.message } });
    const unavailable = e?.name === "RpcUnavailableError";
    return reply.code(unavailable ? 503 : 500).send({ error: { code: unavailable ? "rpc_unavailable" : "internal", message: unavailable ? e.message : "internal error" } });
  });
  app.get("/v1/openapi.json", async () => openapi);
  registerOpsRoutes(app, full);
  registerMarketRoutes(app, full);
  registerAccountRoutes(app, full);
  registerStreamRoutes(app, full);
  registerAuthRoutes(app, full);
  registerAdminRoutes(app, full);
  registerFaucetRoutes(app, full);
  return app;
}
