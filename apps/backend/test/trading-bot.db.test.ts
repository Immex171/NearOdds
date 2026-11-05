import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prereq } from "./helpers/prereq.js";
import { freshDb } from "./helpers/db.js";
import { buildApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/index.js";
import { Rpc } from "../src/near/rpc.js";
import { sha256hex } from "../src/auth/nep413.js";
import { enqueue, runOne } from "../src/keeper/jobs.js";
import { handlersFor } from "../src/keeper/loop.js";
import { BOT_JOB_KIND, botHandlers, scheduleBotCycles } from "../src/trading-bot/worker.js";
import { loadBot, proposeOps, ProposalConflict } from "../src/trading-bot/ops.js";
import { U, botConfig, snap } from "./helpers/bot-fixtures.js";

const ok = await prereq();
const FRONTEND = "http://localhost:3000";
const mkMarket = (db: any, ref: string, contract: string, token = "tok.testnet") => db.query(`INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, token_meta, config, source, verified_at)
  VALUES ($1,'testnet',$2,'mkt-1',$3,'Q?','r','s','4000000000000000000','res','{"symbol":"t","decimals":6,"name":"t"}','{}','keeper',now())`, [ref, contract, token]);
const session = (db: any, token: string, account: string) => db.query("INSERT INTO sessions(token_hash, account_id, public_key, expires_at) VALUES ($1,$2,'k', now() + interval '1 hour')", [sha256hex(token), account]);

describe.skipIf(!ok)("trading bot: admin API, state, job isolation, capacity reservation", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>;
  const H = (t = "tok-admin") => ({ authorization: `Bearer ${t}` });
  const cfgFor = (m: string) => botConfig({}, m);
  beforeAll(async () => {
    fdb = await freshDb();
    await mkMarket(fdb.db, "m_a", "mkt-a.testnet"); await mkMarket(fdb.db, "m_b", "mkt-b.testnet");
    await session(fdb.db, "tok-admin", "admin.testnet"); await session(fdb.db, "tok-user", "user.testnet");
    const cfg = loadConfig({ DATABASE_URL: "x", NEAR_NETWORK: "testnet", ADMIN_ACCOUNTS: "admin.testnet", CORS_ORIGINS: FRONTEND, DEPLOYER_ACCOUNT: "deployer.testnet", RESOLVER_ACCOUNT: "deployer.testnet", TOKEN_OWNER_ACCOUNT: "deployer.testnet" } as any);
    app = buildApp({ db: fdb.db, rpc: new Rpc({ url: "http://127.0.0.1:1", retries: 0, timeoutMs: 300 }), cfg });
  });
  afterAll(async () => { await app?.close(); await fdb?.drop(); });

  it("admin endpoints require the administrator allowlist", async () => {
    expect((await app.inject("/v1/admin/trading-bots")).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/admin/trading-bots", headers: H("tok-user") })).statusCode).toBe(403);
    expect((await app.inject({ url: "/v1/admin/trading-bots", headers: H() })).statusCode).toBe(200);
  });

  let id = "";
  it("validates and versions configuration; the bot account must be distinct; markets must be registered on the bot's network", async () => {
    const post = (b: object) => app.inject({ method: "POST", url: "/v1/admin/trading-bots", headers: H(), payload: b });
    const good = { slug: "mm-one", accountId: "mm-bot.testnet", network: "testnet", config: cfgFor("m_a") };
    expect((await post({ ...good, accountId: "deployer.testnet" })).json().error.code).toBe("account_not_distinct");
    expect((await post({ ...good, config: cfgFor("m_missing") })).json().error.code).toBe("unknown_market");
    expect((await post({ ...good, network: "mainnet" })).json().error.code).toBe("network_mismatch");
    expect((await post({ ...good, config: { ...cfgFor("m_a"), strategy: { spread: "x" } } })).json().error.code).toBe("invalid_config");
    const r = await post(good);
    expect(r.statusCode).toBe(201);
    const bot = r.json(); id = bot.id;
    expect([bot.mode, bot.desiredState, bot.state, bot.configVersion]).toEqual(["paper", "disabled", "disabled", 1]);
    expect(bot.account.credentialsConfigured).toBe(false);
    expect(JSON.stringify(bot)).not.toMatch(/private|secret|ed25519:/i);              // only non-secret status
    expect((await post(good)).json().error.code).toBe("slug_exists");
    const put = await app.inject({ method: "PUT", url: `/v1/admin/trading-bots/${id}/config`, headers: H(), payload: { config: cfgFor("m_a") } });
    expect(put.json().configVersion).toBe(2);
    expect((await fdb.db.query("SELECT version FROM trading_bot_configs WHERE bot_id=$1 ORDER BY version", [id])).rows.map((r: any) => r.version)).toEqual([1, 2]);
  });

  it("defaults to paper; execution cannot be started while the environment flag is off; start/pause/stop persist the requested state", async () => {
    const start = (mode: string) => app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/start`, headers: H(), payload: { mode } });
    const ex = await start("execute"); expect(ex.statusCode).toBe(409); expect(ex.json().error.code).toBe("execution_disabled");
    expect((await start("bogus")).statusCode).toBe(400);
    const p = (await start("paper")).json(); expect([p.mode, p.desiredState, p.state]).toEqual(["paper", "running", "paper"]);
    // "restart": the requested state lives in the database; nothing re-enables a paused/stopped bot
    await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/pause`, headers: H() });
    const row = (await fdb.db.query("SELECT desired_state FROM trading_bots WHERE id=$1", [id])).rows[0];
    expect(row.desired_state).toBe("paused");
    const bot = await loadBot(fdb.db, id);
    expect(bot!.desired_state).toBe("paused");
  });

  it("pause prevents new intentions immediately: unsigned operations are cancelled, proposals are refused, state is 'pausing' until quotes are gone", async () => {
    await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/start`, headers: H(), payload: { mode: "paper" } });
    const bot = (await loadBot(fdb.db, id))!;
    await fdb.db.query("INSERT INTO bot_operations(bot_id, market_ref, config_version, kind, slot, op_key, params, state) VALUES ($1,'m_a',$2,'create_offer','YES_BUY','k-unsigned','{}','proposed')", [id, bot.config_version]);
    await fdb.db.query("INSERT INTO bot_quotes(bot_id, market_ref, offer_id, slot, price, quantity, remaining, origin, state) VALUES ($1,'m_a',1,'YES_BUY',450000,10000000,10000000,'created','active')", [id]);
    const r = (await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/pause`, headers: H() })).json();
    expect(r.desiredState).toBe("paused"); expect(r.state).toBe("pausing");           // an open quote can still be filled
    expect((await fdb.db.query("SELECT state FROM bot_operations WHERE op_key='k-unsigned'")).rows[0].state).toBe("cancelled");
    const fresh = (await loadBot(fdb.db, id))!;
    await expect(proposeOps(fdb.db, fresh, { market_ref: "m_a", contract_id: "mkt-a.testnet", internal_market_id: "mkt-1", token_id: "tok.testnet" }, fresh.config_version, [{ type: "split", amount: 1n }], snap())).rejects.toMatchObject({ code: "bot_not_running" });
    await fdb.db.query("UPDATE bot_quotes SET state='cancelled' WHERE bot_id=$1", [id]);
    expect((await app.inject({ url: `/v1/admin/trading-bots/${id}`, headers: H() })).json().state).toBe("paused");
    const stop = (await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/stop`, headers: H() })).json();
    expect([stop.desiredState, stop.state]).toEqual(["stopped", "stopped"]);
  });

  it("a configuration change refuses proposals made under the old version (running operations keep their recorded version)", async () => {
    await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/start`, headers: H(), payload: { mode: "paper" } });
    const old = (await loadBot(fdb.db, id))!;
    await app.inject({ method: "PUT", url: `/v1/admin/trading-bots/${id}/config`, headers: H(), payload: { config: cfgFor("m_a") } });
    await expect(proposeOps(fdb.db, old, { market_ref: "m_a", contract_id: "mkt-a.testnet", internal_market_id: "mkt-1", token_id: "tok.testnet" }, old.config_version, [{ type: "split", amount: 1n }], snap())).rejects.toMatchObject({ code: "config_changed" });
  });

  it("preview reads the chain and trades nothing; an unreachable chain is reported, not guessed", async () => {
    const opsBefore = (await fdb.db.query("SELECT COUNT(*)::int n FROM bot_operations")).rows[0].n;
    const r = await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/preview`, headers: H() });
    expect(r.statusCode).toBe(200);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM bot_operations")).rows[0].n).toBe(opsBefore);
    const j = r.json(); expect(j.tradedNothing).toBe(true); expect(j.markets[0].reasons[0].code).toBe("chain_unavailable");
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal")).rows[0].n).toBe(0);
  });

  it("answers CORS preflight for the admin trading-bot endpoints from the frontend origin only", async () => {
    const pre = (origin: string, method: string, url: string) => app.inject({ method: "OPTIONS", url, headers: { origin, "access-control-request-method": method, "access-control-request-headers": "authorization,content-type" } });
    for (const [m, u] of [["PUT", `/v1/admin/trading-bots/${id}/config`], ["POST", `/v1/admin/trading-bots/${id}/pause`], ["POST", "/v1/admin/trading-bots"]] as const) {
      const r = await pre(FRONTEND, m, u);
      expect(r.statusCode).toBe(204); expect(r.headers["access-control-allow-origin"]).toBe(FRONTEND);
      expect(String(r.headers["access-control-allow-methods"])).toContain(m);
    }
    expect((await pre("https://evil.example", "PUT", `/v1/admin/trading-bots/${id}/config`)).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("contract-local offer ids are scoped by market: the same id on two contracts never collides", async () => {
    const cfg2 = botConfig({ markets: [{ marketRef: "m_a", enabled: true, reference: null }, { marketRef: "m_b", enabled: true, reference: null }] });
    const bot = (await fdb.db.query("INSERT INTO trading_bots(slug, account_id, network, config, created_by) VALUES ('mm-scope','mm3.testnet','testnet',$1,'t') RETURNING *", [JSON.stringify(cfg2)])).rows[0];
    for (const ref of ["m_a", "m_b"]) await fdb.db.query("INSERT INTO bot_quotes(bot_id, market_ref, offer_id, slot, price, quantity, remaining, origin, state) VALUES ($1,$2,1,'YES_BUY',450000,10000000,10000000,'created','active')", [bot.id, ref]);
    await expect(fdb.db.query("INSERT INTO bot_quotes(bot_id, market_ref, offer_id, slot, price, quantity, remaining, origin, state) VALUES ($1,'m_a',1,'YES_BUY',1,1,1,'created','active')", [bot.id])).rejects.toThrow(/duplicate key/);   // unique per (bot, market, offer)
    const orders = (await app.inject({ url: `/v1/admin/trading-bots/${bot.id}/orders`, headers: H() })).json().items;
    expect(orders.map((o: any) => o.offerRef).sort()).toEqual(["m_a:1", "m_b:1"]);
    const st = (await app.inject({ url: `/v1/admin/trading-bots/${bot.id}`, headers: H() })).json();
    expect(st.markets.map((m: any) => [m.marketRef, m.openQuotes.length])).toEqual([["m_a", 1], ["m_b", 1]]);
    await fdb.db.query("DELETE FROM bot_quotes WHERE bot_id=$1", [bot.id]);
  });

  it("execute -> paper is refused while quotes or unresolved operations are live; allowed once settled; paper bots never get proposals", async () => {
    const cfgx = { ...loadConfig({ DATABASE_URL: "x", NEAR_NETWORK: "testnet", ADMIN_ACCOUNTS: "admin.testnet", BOT_EXECUTION_ENABLED: "true", CORS_ORIGINS: FRONTEND, DEPLOYER_ACCOUNT: "deployer.testnet", RESOLVER_ACCOUNT: "deployer.testnet", TOKEN_OWNER_ACCOUNT: "deployer.testnet" } as any) };
    const app2 = buildApp({ db: fdb.db, rpc: new Rpc({ url: "http://127.0.0.1:1", retries: 0, timeoutMs: 300 }), cfg: cfgx });
    const f = await fdb.db.query("INSERT INTO trading_bots(slug, account_id, network, config, created_by, desired_state, mode, credentials_env) VALUES ('mm-mode','mm4.testnet','testnet',$1,'t','running','execute','BOT_MODE_CREDS') RETURNING id", [JSON.stringify(botConfig({}, "m_a"))]);
    const bid = f.rows[0].id;
    await fdb.db.query("INSERT INTO bot_quotes(bot_id, market_ref, offer_id, slot, price, quantity, remaining, origin, state) VALUES ($1,'m_a',5,'YES_BUY',450000,1,1,'created','active')", [bid]);
    const startPaper = () => app2.inject({ method: "POST", url: `/v1/admin/trading-bots/${bid}/start`, headers: H(), payload: { mode: "paper" } });
    let r = await startPaper();
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe("outstanding_work"); expect(r.json().error.details.quotes).toBe(1);
    expect((await fdb.db.query("SELECT mode FROM trading_bots WHERE id=$1", [bid])).rows[0].mode).toBe("execute");          // unchanged
    await fdb.db.query("UPDATE bot_quotes SET state='cancelled' WHERE bot_id=$1", [bid]);
    await fdb.db.query("INSERT INTO bot_operations(bot_id, market_ref, config_version, kind, op_key, params, state) VALUES ($1,'m_a',1,'create_offer','k-live','{}','submitted')", [bid]);
    r = await startPaper(); expect(r.statusCode).toBe(409); expect(r.json().error.details.ops).toBe(1);
    await fdb.db.query("UPDATE bot_operations SET state='confirmed' WHERE bot_id=$1", [bid]);
    r = await startPaper(); expect(r.statusCode).toBe(200); expect(r.json().mode).toBe("paper");
    const bot = (await loadBot(fdb.db, bid))!;
    await expect(proposeOps(fdb.db, bot, { market_ref: "m_a", contract_id: "mkt-a.testnet", internal_market_id: "mkt-1", token_id: "tok.testnet" }, bot.config_version, [{ type: "cancel", offerId: "1", slot: "YES_BUY", reason: "x" }], snap())).rejects.toMatchObject({ code: "not_execute_mode" });
    await app2.close();
  });

  it("markets removed from the configuration keep being scheduled and stay visible until their live work is gone", async () => {
    const cfg2 = botConfig({}, "m_a");                                     // m_b is NOT configured
    const ins = await fdb.db.query("INSERT INTO trading_bots(slug, account_id, network, config, created_by, desired_state, mode) VALUES ('mm-removed','mm5.testnet','testnet',$1,'t','running','execute') RETURNING id", [JSON.stringify(cfg2)]);
    const bid = ins.rows[0].id;
    await fdb.db.query("DELETE FROM jobs WHERE kind=$1", [BOT_JOB_KIND]);
    const queuedRefs = async () => (await fdb.db.query("SELECT payload->>'marketRef' m FROM jobs WHERE kind=$1 AND payload->>'botId'=$2 AND state='queued' ORDER BY 1", [BOT_JOB_KIND, String(bid)])).rows.map((r: any) => r.m);
    await scheduleBotCycles(fdb.db, 15, Date.now() + 5 * 60_000);
    expect(await queuedRefs()).toEqual(["m_a"]);
    // live quote on the removed market
    await fdb.db.query("INSERT INTO bot_quotes(bot_id, market_ref, offer_id, slot, price, quantity, remaining, origin, state) VALUES ($1,'m_b',9,'NO_BUY',450000,1,1,'created','active')", [bid]);
    await fdb.db.query("UPDATE jobs SET state='succeeded' WHERE kind=$1", [BOT_JOB_KIND]);
    await scheduleBotCycles(fdb.db, 15, Date.now() + 10 * 60_000);
    expect(await queuedRefs()).toEqual(["m_a", "m_b"]);
    // ... and an unresolved operation alone is enough
    await fdb.db.query("UPDATE bot_quotes SET state='cancelled' WHERE bot_id=$1", [bid]);
    await fdb.db.query("INSERT INTO bot_operations(bot_id, market_ref, config_version, kind, op_key, params, state) VALUES ($1,'m_b',1,'cancel_offer','k-removed','{}','uncertain')", [bid]);
    await fdb.db.query("UPDATE jobs SET state='succeeded' WHERE kind=$1", [BOT_JOB_KIND]);
    await scheduleBotCycles(fdb.db, 15, Date.now() + 15 * 60_000);
    expect(await queuedRefs()).toEqual(["m_a", "m_b"]);
    const st = (await app.inject({ url: `/v1/admin/trading-bots/${bid}`, headers: H() })).json();
    expect(st.markets.map((m: any) => [m.marketRef, m.removedFromConfig])).toEqual([["m_a", false], ["m_b", true]]);
    expect(st.pendingOperations.length).toBe(1); expect(st.state).toBe("uncertain");
    // once everything is settled the removed market disappears from status and from the schedule
    await fdb.db.query("UPDATE bot_operations SET state='confirmed' WHERE bot_id=$1", [bid]);
    await fdb.db.query("UPDATE jobs SET state='succeeded' WHERE kind=$1", [BOT_JOB_KIND]);
    await scheduleBotCycles(fdb.db, 15, Date.now() + 20 * 60_000);
    expect(await queuedRefs()).toEqual(["m_a"]);
    expect((await app.inject({ url: `/v1/admin/trading-bots/${bid}`, headers: H() })).json().markets.map((m: any) => m.marketRef)).toEqual(["m_a"]);
  });

  it("history endpoints respond (orders, fills, decisions, operations)", async () => {
    for (const p of ["orders", "fills", "decisions", "operations"]) {
      const r = await app.inject({ url: `/v1/admin/trading-bots/${id}/${p}`, headers: H() });
      expect(r.statusCode, p).toBe(200); expect(Array.isArray(r.json().items)).toBe(true);
    }
  });

  it("keeper and trading-bot workers claim ONLY their own job kinds", async () => {
    await fdb.db.query("DELETE FROM jobs");
    const keeperKinds = Object.keys(handlersFor({} as any));
    expect(keeperKinds).not.toContain(BOT_JOB_KIND);
    const ran: string[] = [];
    const keeperStubs = Object.fromEntries(keeperKinds.map((k) => [k, async () => { ran.push("keeper:" + k); }]));
    const botStubs = { [BOT_JOB_KIND]: async () => { ran.push("bot"); } };
    expect(Object.keys(botHandlers({} as any))).toEqual([BOT_JOB_KIND]);
    await enqueue(fdb.db, BOT_JOB_KIND, "iso-bot-1", {}); await enqueue(fdb.db, "create_market", "iso-keeper-1", {}); await enqueue(fdb.db, "something_else", "iso-other-1", {});
    while (await runOne(fdb.db, "keeper-w", keeperStubs)) { /* drain */ }
    expect(ran).toEqual(["keeper:create_market"]);
    expect((await fdb.db.query("SELECT state FROM jobs WHERE dedupe_key='iso-bot-1'")).rows[0].state).toBe("queued");   // untouched by the keeper
    while (await runOne(fdb.db, "bot-w", botStubs)) { /* drain */ }
    expect(ran).toEqual(["keeper:create_market", "bot"]);
    expect((await fdb.db.query("SELECT state FROM jobs WHERE dedupe_key='iso-other-1'")).rows[0].state).toBe("queued");   // nobody claims unknown kinds
  });

  it("scheduler enqueues one cycle job per bot/market and not while one is active; settled stopped bots are skipped", async () => {
    await fdb.db.query("DELETE FROM jobs");
    await fdb.db.query("UPDATE trading_bots SET desired_state='disabled' WHERE id <> $1", [id]);          // only this bot takes part
    await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/start`, headers: H(), payload: { mode: "paper" } });
    expect(await scheduleBotCycles(fdb.db, 15)).toBe(1);
    expect(await scheduleBotCycles(fdb.db, 15, Date.now() + 60_000)).toBe(0);      // previous still queued
    await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/stop`, headers: H() });
    await fdb.db.query("UPDATE jobs SET state='succeeded' WHERE kind=$1", [BOT_JOB_KIND]);
    expect(await scheduleBotCycles(fdb.db, 15, Date.now() + 120_000)).toBe(0);
  });

  it("concurrent proposals cannot both spend the same token balance (atomic bot-wide reservation)", async () => {
    const slugCfg = botConfig({ markets: [{ marketRef: "m_a", enabled: true, reference: null }, { marketRef: "m_b", enabled: true, reference: null }] });
    const ins = await fdb.db.query("INSERT INTO trading_bots(slug, account_id, network, config, created_by, desired_state, mode) VALUES ('mm-two','mm2.testnet','testnet',$1,'t','running','execute') RETURNING *", [JSON.stringify(slugCfg)]);
    const bot = ins.rows[0];
    const s = snap({ tokenBalance: 20_000_000n });
    const a = proposeOps(fdb.db, bot, { market_ref: "m_a", contract_id: "mkt-a.testnet", internal_market_id: "mkt-1", token_id: "tok.testnet" }, 1, [{ type: "deposit", amount: 20_000_000n }], s);
    const b = proposeOps(fdb.db, bot, { market_ref: "m_b", contract_id: "mkt-b.testnet", internal_market_id: "mkt-1", token_id: "tok.testnet" }, 1, [{ type: "deposit", amount: 20_000_000n }], s);
    const res = await Promise.allSettled([a, b]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(ProposalConflict); expect(rej.reason.code).toBe("insufficient_token_balance");
    // same market: a second batch while the first is pending is refused (one in-flight set per bot/market)
    await expect(proposeOps(fdb.db, bot, { market_ref: "m_a", contract_id: "mkt-a.testnet", internal_market_id: "mkt-1", token_id: "tok.testnet" }, 1, [{ type: "split", amount: 1n }], s).catch((e) => { throw e; })).rejects.toBeInstanceOf(ProposalConflict);
  });

  it("stable operation ids: re-proposing returns the pending operation; a failed one is retried under a new attempt number", async () => {
    const bot = (await fdb.db.query("SELECT * FROM trading_bots WHERE slug='mm-two'")).rows[0];
    const m = { market_ref: "m_b", contract_id: "mkt-b.testnet", internal_market_id: "mkt-1", token_id: "tok.testnet" };
    await fdb.db.query("UPDATE bot_operations SET state='confirmed' WHERE bot_id=$1", [bot.id]);
    const s = snap({ tokenBalance: 20_000_000n });
    const [o1] = await proposeOps(fdb.db, bot, m, 1, [{ type: "split" as const, amount: 1_000_000n }], s);
    const [again] = await proposeOps(fdb.db, bot, { ...m, market_ref: "m_a", contract_id: "mkt-a.testnet" }, 1, [{ type: "cancel", offerId: "7", slot: "YES_BUY", reason: "x" }], s);
    expect(o1.op_key).toMatch(/split:t1$/); expect(again.op_key).toMatch(/cancel:7$/);
    await fdb.db.query("UPDATE bot_operations SET state='failed' WHERE id=$1", [again.id]);
    const [retry] = await proposeOps(fdb.db, bot, { ...m, market_ref: "m_a", contract_id: "mkt-a.testnet" }, 1, [{ type: "cancel", offerId: "7", slot: "YES_BUY", reason: "x" }], s).catch(async () => { await fdb.db.query("UPDATE bot_operations SET state='confirmed' WHERE id=$1", [o1.id]); return proposeOps(fdb.db, bot, { ...m, market_ref: "m_a", contract_id: "mkt-a.testnet" }, 1, [{ type: "cancel", offerId: "7", slot: "YES_BUY", reason: "x" }], s); });
    expect(retry.op_key).toMatch(/cancel:7:a2$/);
  });
});
