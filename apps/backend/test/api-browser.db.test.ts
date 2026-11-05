import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { buildApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/index.js";
import { Rpc } from "../src/near/rpc.js";

const ok = await prereq();
const FRONTEND = "http://localhost:3000";
describe.skipIf(!ok)("browser integration: CORS preflight and market status filters", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>;
  const FUTURE = (BigInt(Date.now() + 86_400_000) * 1_000_000n).toString(), PAST = (BigInt(Date.now() - 86_400_000) * 1_000_000n).toString();
  beforeAll(async () => {
    fdb = await freshDb();
    app = buildApp({ db: fdb.db, rpc: new Rpc({ url: "http://127.0.0.1:1", retries: 0 }), cfg: loadConfig({ DATABASE_URL: "x", CORS_ORIGINS: FRONTEND } as any) });
    const add = (ref: string, q: string, cat: string, cutoff: string, status: string) => fdb.db.query(`INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, category, token_meta, config, contract_status, source, verified_at)
      VALUES ($1,'testnet',$2,'mkt-1','t',$3,'r','s',$4,'res',$5,'{"symbol":"t","decimals":6,"name":"t"}','{}',$6,'keeper',now())`, [ref, `${ref}.testnet`, q, cutoff, cat, status]);
    await add("m_open_w", "Will it rain in Lagos?", "Weather", FUTURE, "Open");
    await add("m_open_c", "Will BTC close above 100k?", "Crypto", FUTURE, "Open");
    await add("m_await_w", "Will it rain in Abuja?", "Weather", PAST, "Open");
    await add("m_res_w", "Was it sunny in Lagos?", "Weather", PAST, "Resolved");
    await add("m_res_c", "Did ETH flip?", "Crypto", PAST, "Resolved");
  });
  afterAll(async () => { await app?.close(); await fdb?.drop(); });

  const pre = (method: string, headers: string, origin = FRONTEND, url = "/v1/watchlist/m_open_w") =>
    app.inject({ method: "OPTIONS", url, headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers } });

  it("answers preflight for PUT/PATCH/DELETE/POST with the Idempotency-Key and Authorization headers for the allowed origin", async () => {
    for (const m of ["PUT", "PATCH", "DELETE", "POST"]) {
      const r = await pre(m, "authorization,content-type,idempotency-key");
      expect(r.statusCode, m).toBe(204);
      expect(r.headers["access-control-allow-origin"]).toBe(FRONTEND);
      expect(String(r.headers["access-control-allow-methods"]).split(/,\s*/)).toContain(m);
      expect(String(r.headers["access-control-allow-headers"]).toLowerCase()).toContain("idempotency-key");
      expect(String(r.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
    }
  });
  it("keeps the origin allowlist: other origins get no CORS grant", async () => {
    const r = await pre("PUT", "authorization", "https://evil.example");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const g = await app.inject({ url: "/v1/markets", headers: { origin: "https://evil.example" } });
    expect(g.headers["access-control-allow-origin"]).toBeUndefined();
    const ok_ = await app.inject({ url: "/v1/markets", headers: { origin: FRONTEND } });
    expect(ok_.headers["access-control-allow-origin"]).toBe(FRONTEND);
  });
  it("SSE honours the same allowlist", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    for (const [origin, expected] of [[FRONTEND, FRONTEND], ["https://evil.example", null]] as const) {
      const ctl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/stream`, { headers: { origin }, signal: ctl.signal });
      expect(res.headers.get("access-control-allow-origin")).toBe(expected);
      ctl.abort();
    }
  });

  const refs = async (qs: string) => { const r = await app.inject(`/v1/markets?${qs}&sort=closing`); expect(r.statusCode, r.body).toBe(200); return r.json().items.map((x: any) => x.marketRef).sort(); };
  it("status filters work alone (open, awaiting, resolved) ...", async () => {
    expect(await refs("status=open")).toEqual(["m_open_c", "m_open_w"]);
    expect(await refs("status=awaiting")).toEqual(["m_await_w"]);
    expect(await refs("status=resolved")).toEqual(["m_res_c", "m_res_w"]);
  });
  it("... and combined with search and category filters", async () => {
    expect(await refs("status=resolved&q=lagos")).toEqual(["m_res_w"]);
    expect(await refs("status=resolved&category=Crypto")).toEqual(["m_res_c"]);
    expect(await refs("status=open&category=Weather&q=rain")).toEqual(["m_open_w"]);
    expect(await refs("status=awaiting&q=abuja&category=Weather")).toEqual(["m_await_w"]);
    expect(await refs("status=open&q=nothing")).toEqual([]);
    expect((await app.inject("/v1/markets?status=bogus")).statusCode).toBe(400);
    const page = (await app.inject("/v1/markets?status=resolved&limit=1&offset=1")).json();
    expect(page.page.total).toBe(2); expect(page.items.length).toBe(1);
  });
});
