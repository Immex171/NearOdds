import type { FastifyReply } from "fastify";
export class HttpError extends Error { constructor(readonly status: number, readonly code: string, msg: string, readonly details?: unknown) { super(msg); } }
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, "bad_request", msg, details);
export function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details } });
  throw e;
}
const NUM = /^\d+$/;
export function decimal(v: unknown, name: string): string { if (typeof v !== "string" || !NUM.test(v)) throw badRequest(`${name} must be a decimal string`); return v; }
export function intParam(v: unknown, d: number, min: number, max: number): number { const n = v === undefined ? d : Number(v); if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`integer between ${min} and ${max} expected`); return n; }
