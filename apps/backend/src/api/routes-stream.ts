import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import type { Ctx } from "./app.js";
import { freshness } from "./dto.js";

interface Client { res: ServerResponse; markets: Set<string> | null; account: string | null }

/**
 * SSE: GET /v1/stream?markets=ref1,ref2&account=alice.testnet
 * Events: market_created, market_status, book, trade, account, heartbeat. Each carries `freshness`.
 * Resume: send Last-Event-ID; if events were missed (or the id is unknown), re-fetch the snapshot endpoints. The stream is a hint, the REST snapshot is the truth.
 */
export function registerStreamRoutes(app: FastifyInstance, ctx: Ctx) {
  const clients = new Set<Client>();
  let lastId = 0n; let timer: NodeJS.Timeout | null = null; let started = false;

  async function pump() {
    try {
      const rows = (await ctx.db.query("SELECT * FROM stream_events WHERE id > $1 ORDER BY id LIMIT 500", [lastId.toString()])).rows;
      if (rows.length) {
        const fr = await freshness(ctx.db);
        for (const e of rows) {
          lastId = BigInt(e.id);
          for (const c of clients) {
            const wantMarket = e.market_ref && (!c.markets || c.markets.has(e.market_ref));
            const wantAcct = e.account_id && c.account === e.account_id;
            const global = !e.market_ref && !e.account_id;
            const isAcctOnly = e.type === "account";
            if ((isAcctOnly ? wantAcct : (wantMarket || wantAcct || global)))
              c.res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ marketRef: e.market_ref, account: e.account_id, ...e.payload, freshness: fr })}\n\n`);
          }
        }
      } else if (clients.size) {
        const fr = await freshness(ctx.db);
        for (const c of clients) c.res.write(`event: heartbeat\ndata: ${JSON.stringify({ freshness: fr })}\n\n`);
      }
    } catch { /* keep pumping; clients see gaps via heartbeat freshness */ }
  }

  app.get("/v1/stream", async (req, reply) => {
    if (!started) {
      started = true;
      lastId = BigInt((await ctx.db.query("SELECT COALESCE(MAX(id),0) m FROM stream_events")).rows[0].m);
      timer = setInterval(pump, ctx.streamPollMs ?? 1000);
    }
    const q = req.query as Record<string, string | undefined>;
    const c: Client = { res: reply.raw, markets: q.markets ? new Set(q.markets.split(",")) : null, account: q.account ?? null };
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...(req.headers.origin && ctx.cfg.corsOrigins.includes(req.headers.origin) ? { "access-control-allow-origin": req.headers.origin, vary: "Origin" } : {}) });
    const fr = await freshness(ctx.db);
    reply.raw.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ freshness: fr, resync: req.headers["last-event-id"] !== undefined, hint: "Fetch snapshots after (re)connecting; the stream only carries changes." })}\n\n`);
    clients.add(c);
    req.raw.on("close", () => { clients.delete(c); });
    return reply; // keep the socket open
  });
  app.addHook("onClose", async () => { if (timer) clearInterval(timer); for (const c of clients) c.res.end(); });
}
