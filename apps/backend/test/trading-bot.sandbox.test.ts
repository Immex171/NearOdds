import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prereq } from "./helpers/prereq.js";
import { freshDb } from "./helpers/db.js";
import { startSandbox, type Sandbox } from "./helpers/sandbox.js";
import { TGAS, TestChain, sleep } from "./helpers/chain.js";
import { keeperEnv } from "./helpers/keeper-env.js";
import { setupMarket } from "./helpers/market.js";
import { login } from "./helpers/auth.js";
import { CrashAfter, GatedBroadcast, botDeps, cfgFor, insertBot, prepAccount, views } from "./helpers/bot-rig.js";
import { U } from "./helpers/bot-fixtures.js";
import { runCycle } from "../src/trading-bot/cycle.js";
import { BOT_JOB_KIND, botHandlers } from "../src/trading-bot/worker.js";
import { makeBotSigner } from "../src/trading-bot/signer.js";
import { buildApp } from "../src/api/app.js";
import { enqueue, runOne } from "../src/keeper/jobs.js";
import { Rpc } from "../src/near/rpc.js";
import { TxExecutor } from "../src/near/tx.js";
import { actions, KeyPair, KeyPairSigner } from "near-api-js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ok = await prereq({ sandbox: true });
describe.skipIf(!ok)("trading bot on Sandbox (real contracts)", () => {
  let sbx: Sandbox, fdb: Awaited<ReturnType<typeof freshDb>>, chain: TestChain, env: Awaited<ReturnType<typeof keeperEnv>>;
  let dep: any, token: string, A: { id: string; ref: string }, B: { id: string; ref: string }, taker: any, app: ReturnType<typeof buildApp>, adminAuth: any;
  const q = async (sql: string, p: unknown[] = []) => (await fdb.db.query(sql, p)).rows;
  const newBot = async (name: string, markets: { id: string; ref: string }[], cfg: ReturnType<typeof cfgFor>, o: { mint?: bigint; prereg?: boolean; mode?: string } = {}) => {
    const key = await chain.createAccount(name, 40n);
    if (o.prereg !== false) await prepAccount(chain, dep, key, token, markets.map((m) => m.id), o.mint ?? 0n);
    const id = await insertBot(fdb.db, name, key.accountId, cfg, { mode: o.mode });
    return { key, id, deps: botDeps(env.deps as any, fdb.db, [key]) };
  };
  const ops = (id: string, kind?: string) => q("SELECT kind, slot, generation, state, op_key FROM bot_operations WHERE bot_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY id", [id, kind ?? null]);

  beforeAll(async () => {
    sbx = await startSandbox(); fdb = await freshDb(); chain = new TestChain(sbx, fdb.db);
    dep = await chain.createAccount("deployer", 400n);
    token = await chain.deployToken(dep);
    env = await keeperEnv(sbx, fdb.db, chain, dep, (dep.signer as any).key.toString(), token);
    A = await setupMarket(chain, fdb.db, dep, token, "bota", 3_600_000);
    B = await setupMarket(chain, fdb.db, dep, token, "botb", 3_600_000);     // second contract, ALSO internal market id mkt-1
    taker = await chain.createAccount("taker", 60n);
    await prepAccount(chain, dep, taker, token, [A.id, B.id], 100_000_000n);
    for (const m of [A, B]) { await chain.call(taker, token, "ft_transfer_call", { receiver_id: m.id, amount: U(30), msg: "deposit" }, 1n, 300n * TGAS); await chain.call(taker, m.id, "split_position", { market_id: "mkt-1", amount: U(20) }); }
    app = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: env.cfg });
    adminAuth = { authorization: `Bearer ${await login(app, dep)}` };
  });
  afterAll(async () => { await app?.close(); await sbx?.stop(); await fdb?.drop(); });

  it("fixture: register, deposit 20, split 10, four quotes (bids reserve 9; asks use the 10+10 shares); a counterparty partly fills; the bot reconciles and requotes only within its limits", { timeout: 420_000 }, async () => {
    const bot = await newBot("mmbot", [A], cfgFor([A.ref]), { prereg: false });
    // 1. no funds yet: the bot registers itself, then reports that it needs collateral
    let r = await runCycle(bot.deps, bot.id, A.ref);
    expect(r.reasons.map((x) => x.code)).toContain("needs_collateral");
    expect(await sbx.rpc.callView(token, "storage_balance_of", { account_id: bot.key.accountId })).not.toBeNull();
    expect((await ops(bot.id)).map((o: any) => o.kind)).toEqual(["register_token", "register_market"]);
    expect((await q("SELECT needs_funding FROM bot_market_status WHERE bot_id=$1", [bot.id]))[0].needs_funding).toBe(true);
    // 2. project funding: 40 test tokens; deposit 20 and split 10 happen exactly once
    await chain.call(dep, token, "mint", { account_id: bot.key.accountId, amount: U(40) }, 0n, 30n * TGAS);
    r = await runCycle(bot.deps, bot.id, A.ref);
    const kinds = (await ops(bot.id)).map((o: any) => o.kind);
    expect(kinds.slice(2)).toEqual(["deposit", "split", "create_offer", "create_offer", "create_offer", "create_offer"]);
    const [acct, offers] = await views(sbx.rpc, A.id, bot.key.accountId);
    expect(acct).toMatchObject({ available_collateral: U(1), reserved_collateral: U(9), yes: "0", reserved_yes: U(10), no: "0", reserved_no: U(10) });
    expect(BigInt(await sbx.rpc.callView<string>(token, "ft_balance_of", { account_id: bot.key.accountId }))).toBe(20_000_000n);   // 40 - 20 deposited
    const by = (o: string, s: string) => offers.find((x: any) => x.outcome === o && x.side === s);
    expect([by("Yes", "Buy").price, by("Yes", "Buy").quantity, by("No", "Buy").price, by("No", "Buy").quantity]).toEqual(["450000", U(10), "450000", U(10)]);
    expect([by("Yes", "Sell").price, by("Yes", "Sell").remaining_quantity, by("No", "Sell").price, by("No", "Sell").remaining_quantity]).toEqual(["550000", U(10), "550000", U(10)]);
    expect(offers.every((o: any) => o.expires_at_ns !== null)).toBe(true);                       // bounded lifetime
    const quotes = await q("SELECT slot, offer_id, state FROM bot_quotes WHERE bot_id=$1 ORDER BY slot", [bot.id]);
    expect(quotes.map((x: any) => x.slot)).toEqual(["NO_BUY", "NO_SELL", "YES_BUY", "YES_SELL"]); expect(quotes.every((x: any) => x.state === "active")).toBe(true);
    expect(BigInt((await q("SELECT COALESCE(SUM(yocto),0) s FROM bot_native_spend WHERE bot_id=$1", [bot.id]))[0].s)).toBeGreaterThan(41_000_000_000_000_000_000_000n);   // registrations + gas recorded
    const opsAfterSetup = (await ops(bot.id)).length;
    // 3. nothing changed => nothing to do (no cancel/recreate churn)
    await runCycle(bot.deps, bot.id, A.ref);
    expect((await ops(bot.id)).length).toBe(opsAfterSetup);

    // 4. counterparty sells 4 YES into the bot's 0.45 bid
    const yesBid = by("Yes", "Buy").offer_id, yesAsk = by("Yes", "Sell").offer_id;
    await chain.call(taker, A.id, "fill_offer", { offer_id: yesBid, quantity: U(4) });
    const [a2, o2] = await views(sbx.rpc, A.id, bot.key.accountId);
    expect(a2).toMatchObject({ available_collateral: U(1), reserved_collateral: U(7.2), yes: U(4), reserved_yes: U(10) });
    expect(o2.find((x: any) => x.offer_id === yesBid).remaining_quantity).toBe(U(6));
    await runCycle(bot.deps, bot.id, A.ref);
    expect((await ops(bot.id)).length).toBe(opsAfterSetup);                                                       // 6 remaining == what the limits allow: keep
    expect((await q("SELECT remaining FROM bot_quotes WHERE bot_id=$1 AND offer_id=$2", [bot.id, yesBid]))[0].remaining).toBe(U(6));

    // 5. counterparty buys 7 of the bot's YES ask: 3 left (< 50% of what it may offer) => cancel, then re-create SMALLER (7 = shares it holds)
    await chain.call(taker, A.id, "fill_offer", { offer_id: yesAsk, quantity: U(7) });
    const [a3] = await views(sbx.rpc, A.id, bot.key.accountId);
    expect(a3).toMatchObject({ reserved_yes: U(3), yes: U(4) });
    await runCycle(bot.deps, bot.id, A.ref);
    const newOps = (await ops(bot.id)).slice(opsAfterSetup);
    expect(newOps.map((o: any) => `${o.kind}:${o.slot}:${o.state}`)).toEqual(["cancel_offer:YES_SELL:confirmed", "create_offer:YES_SELL:confirmed"]);
    const [a4, o4] = await views(sbx.rpc, A.id, bot.key.accountId);
    const newAsk = o4.find((x: any) => x.outcome === "Yes" && x.side === "Sell");
    expect(newAsk.offer_id).not.toBe(yesAsk); expect([newAsk.price, newAsk.quantity]).toEqual(["550000", U(7)]);   // sized by holdings, not blindly 10
    expect(a4).toMatchObject({ reserved_yes: U(7), yes: "0" });
    expect(o4.find((x: any) => x.offer_id === yesBid).remaining_quantity).toBe(U(6));                             // untouched
    expect(o4.length).toBe(4);
    // chain and the bot's own records agree; the fills are visible
    expect((await q("SELECT COUNT(*)::int n FROM bot_quotes WHERE bot_id=$1 AND state='active'", [bot.id]))[0].n).toBe(4);
    expect((await q("SELECT state FROM bot_quotes WHERE bot_id=$1 AND offer_id=$2", [bot.id, yesAsk]))[0].state).toBe("cancelled");
    // status API (admin): balances, quotes, spending, reasons, no secrets (the API process sees the credentials file via the same env var as the worker)
    const credFile = join(mkdtempSync(join(tmpdir(), "mmcreds-")), "bot.json"); writeFileSync(credFile, JSON.stringify({ account_id: bot.key.accountId, private_key: (bot.key.signer as any).key.toString() }), { mode: 0o600 }); process.env.BOT_CREDENTIALS_FILE = credFile;
    const st = (await app.inject({ url: `/v1/admin/trading-bots/${bot.id}`, headers: adminAuth })).json();
    expect(st.state).toBe("running"); expect(st.markets[0].openQuotes.length).toBe(4); expect(st.markets[0].lastChainRead.blockHeight).toBeGreaterThan(0);
    expect(st.markets[0].balances.collateral.available).toBe(U(4.85));   // 1 left over + 3.85 proceeds of the YES ask fill expect(JSON.stringify(st)).not.toMatch(/ed25519:[A-Za-z0-9]{40}/);
    expect(BigInt(st.spending.nativeSpentYocto)).toBeGreaterThan(0n);
  });

  it("crash after a successful create_offer, before its result was recorded: the existing offer is recovered, not duplicated", { timeout: 240_000 }, async () => {
    const bot = await newBot("crashbot", [A], cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }), { mint: 10_000_000n });
    const crashing = botDeps(env.deps as any, fdb.db, [bot.key], new CrashAfter(fdb.db, env.rpc, /:create:YES_BUY/));
    await expect(runCycle(crashing, bot.id, A.ref)).rejects.toThrow(/simulated crash/);
    const [, onChain] = await views(sbx.rpc, A.id, bot.key.accountId);
    expect(onChain.length).toBe(1);                                                                    // the offer exists on chain
    expect((await q("SELECT COUNT(*)::int n FROM bot_quotes WHERE bot_id=$1", [bot.id]))[0].n).toBe(0); // ...but the result was never recorded
    expect((await ops(bot.id, "create_offer")).map((o: any) => o.state)).toEqual(["submitted", "proposed"]);   // the signed one + the reserved-but-unsent sibling
    await runCycle(bot.deps, bot.id, A.ref);                                                           // restart
    const [, after] = await views(sbx.rpc, A.id, bot.key.accountId);
    expect(after.filter((o: any) => o.outcome === "Yes" && o.side === "Buy").length).toBe(1);          // still ONE YES bid
    expect(after.length).toBe(2);                                                                      // YES bid (recovered) + NO bid
    expect((await q("SELECT offer_id FROM bot_quotes WHERE bot_id=$1 AND slot='YES_BUY'", [bot.id]))[0].offer_id).toBe(onChain[0].offer_id);
    const creates = await ops(bot.id, "create_offer");
    expect(creates.every((o: any) => o.state === "confirmed")).toBe(true); expect(creates.length).toBe(2);
    expect((await q("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key LIKE $1", [`bot:${bot.id}:%create%`]))[0].n).toBe(2);
  });

  it("status reads fail after successful execution: the operation stays uncertain and is never re-submitted; later it resumes with the same transaction", { timeout: 240_000 }, async () => {
    const bot = await newBot("outbot", [A], cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }), { mint: 10_000_000n });
    let down = true;
    const flaky = new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { const m = JSON.parse(i.body).method; if (down && (m === "tx" || m === "EXPERIMENTAL_tx_status")) throw new Error("socket hang up"); return fetch(u, i); }) as any });
    const d = botDeps(env.deps as any, fdb.db, [bot.key], new TxExecutor(fdb.db, flaky, 1500, 200));
    let r = await runCycle(d, bot.id, A.ref);
    expect(r.reasons.some((x) => x.code === "op_uncertain")).toBe(true);
    const j1 = await q("SELECT op_key, tx_hash, state FROM tx_journal WHERE op_key LIKE $1", [`bot:${bot.id}:%`]);
    expect(j1.length).toBe(1);
    expect((await q("SELECT state FROM trading_bots WHERE id=$1", [bot.id]))[0].state).toBe("uncertain");
    r = await runCycle(d, bot.id, A.ref);                                           // still down: reconciles the SAME tx, creates nothing new
    expect(r.reasons.some((x) => x.code === "uncertain_operation")).toBe(true);
    expect((await q("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key LIKE $1", [`bot:${bot.id}:%`]))[0].n).toBe(1);
    expect((await ops(bot.id)).length).toBe(1);
    down = false;
    await runCycle(d, bot.id, A.ref);
    const j2 = await q("SELECT tx_hash FROM tx_journal WHERE op_key=$1", [j1[0].op_key]);
    expect(j2).toEqual([{ tx_hash: j1[0].tx_hash }]);                                // the original transaction, never a new one
    expect((await ops(bot.id, "deposit")).map((o: any) => o.state)).toEqual(["confirmed"]);
    const [acct, offers] = await views(sbx.rpc, A.id, bot.key.accountId);
    expect(acct.reserved_collateral).toBe(U(9)); expect(offers.length).toBe(2);       // deposited ONCE (10), two bids reserve 9
    expect((await q("SELECT state FROM trading_bots WHERE id=$1", [bot.id]))[0].state).toBe("running");
  });

  it("two workers on the same bot/market: one owns the cycle, the other defers; no duplicate offers", { timeout: 240_000 }, async () => {
    const bot = await newBot("duobot", [A], cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }), { mint: 10_000_000n });
    const gated = new GatedBroadcast(fdb.db, env.rpc, 60_000, 200);
    const d1 = botDeps(env.deps as any, fdb.db, [bot.key], gated), d2 = botDeps(env.deps as any, fdb.db, [bot.key]);
    await enqueue(fdb.db, BOT_JOB_KIND, `dup-1-${bot.id}`, { botId: bot.id, marketRef: A.ref }); await enqueue(fdb.db, BOT_JOB_KIND, `dup-2-${bot.id}`, { botId: bot.id, marketRef: A.ref });
    const w1 = runOne(fdb.db, "bot-w1", botHandlers(d1));
    for (let i = 0; i < 160 && !gated.reached; i++) await sleep(250);
    expect(gated.reached).toBe(true);                                                  // worker 1 is mid-cycle (first tx signed, not yet broadcast)
    await runOne(fdb.db, "bot-w2", botHandlers(d2));
    const deferred = (await q("SELECT state, last_error FROM jobs WHERE dedupe_key LIKE $1 AND state='queued'", [`dup-%-${bot.id}`]));
    expect(deferred.length).toBe(1); expect(deferred[0].last_error).toMatch(/another worker owns/);
    gated.release(); await w1;
    await fdb.db.query("UPDATE jobs SET run_after=now() WHERE state='queued' AND kind=$1", [BOT_JOB_KIND]);
    await runOne(fdb.db, "bot-w2", botHandlers(d2));                                  // the deferred cycle now sees finished work
    const [, offers] = await views(sbx.rpc, A.id, bot.key.accountId);
    expect(offers.length).toBe(2);
    const creates = await ops(bot.id, "create_offer"); expect(new Set(creates.map((o: any) => o.slot)).size).toBe(creates.length);
    expect(creates.every((o: any) => o.generation === 1)).toBe(true);
  });

  it("one bot, two markets with the SAME internal id: ordering by key, per-contract offer ids and balances", { timeout: 300_000 }, async () => {
    const bot = await newBot("twomkt", [A, B], cfgFor([A.ref, B.ref], { funding: { depositCollateral: U(8), splitCollateral: "0" } }), { mint: 20_000_000n });
    const gated = new GatedBroadcast(fdb.db, env.rpc, 60_000, 200);
    const dA = botDeps(env.deps as any, fdb.db, [bot.key], gated), dB = botDeps(env.deps as any, fdb.db, [bot.key]);
    const cycA = runCycle(dA, bot.id, A.ref);
    for (let i = 0; i < 160 && !gated.reached; i++) await sleep(250);
    const cycB = runCycle(dB, bot.id, B.ref);                                         // another worker, same signing key, other market
    await sleep(4000);
    const rows = await q("SELECT op_key, nonce, state, tx_hash FROM tx_journal WHERE signer_id=$1 AND op_key LIKE 'bot:%' ORDER BY nonce::numeric", [bot.key.accountId]);
    expect(rows.length).toBe(2);
    expect(rows[0].op_key).toContain(A.ref); expect(rows[1].op_key).toContain(B.ref);   // A holds the lower nonce
    expect(rows[1].state).toBe("prepared");                                            // B must not overtake A
    await expect(sbx.rpc.once("tx", { tx_hash: rows[1].tx_hash, sender_account_id: bot.key.accountId, wait_until: "NONE" })).rejects.toBeDefined();
    gated.release();
    await Promise.all([cycA, cycB]);
    expect((await q("SELECT state FROM tx_journal WHERE signer_id=$1 AND op_key LIKE 'bot:%'", [bot.key.accountId])).every((x: any) => x.state === "succeeded")).toBe(true);   // nothing invalidated
    // both markets fully quoted; every offer is attributed to ITS contract (ids are contract-local)
    const qa = await q("SELECT market_ref, offer_id FROM bot_quotes WHERE bot_id=$1 AND state='active'", [bot.id]);
    const ids = (ref: string) => qa.filter((x: any) => x.market_ref === ref).map((x: any) => x.offer_id).sort();
    expect(ids(A.ref).length).toBe(2); expect(ids(B.ref).length).toBe(2);
    for (const m of [A, B]) {
      const [acct, offers] = await views(sbx.rpc, m.id, bot.key.accountId);
      expect(offers.map((o: any) => o.offer_id).sort()).toEqual(ids(m.ref));
      expect(BigInt(acct.reserved_collateral)).toBeGreaterThan(7_900_000n); expect(BigInt(acct.reserved_collateral)).toBeLessThanOrEqual(8_000_000n);   // 8 deposited; the NO bid is sized down to the remaining cash
    }
  });

  it("stop during an in-flight transaction: no new intentions; the signed one is reconciled; then open quotes are cancelled before 'stopped'", { timeout: 300_000 }, async () => {
    const bot = await newBot("stopbot", [A], cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }), { mint: 10_000_000n });
    const gated = new GatedBroadcast(fdb.db, env.rpc, 60_000, 200);
    const d = botDeps(env.deps as any, fdb.db, [bot.key], gated);
    const cyc = runCycle(d, bot.id, A.ref);
    for (let i = 0; i < 160 && !gated.reached; i++) await sleep(250);
    const stop = (await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${bot.id}/stop`, headers: adminAuth })).json();
    expect(stop.desiredState).toBe("stopped"); expect(stop.state).toBe("stopping");   // the deposit is signed but unresolved
    gated.release(); await cyc;
    expect((await ops(bot.id, "create_offer")).length).toBe(0);                        // nothing new was started after the stop
    expect((await ops(bot.id, "deposit")).map((o: any) => o.state)).toEqual(["confirmed"]);
    expect((await q("SELECT state FROM trading_bots WHERE id=$1", [bot.id]))[0].state).toBe("stopped");

    // second bot: quotes are open when stop arrives
    const b2 = await newBot("stopbot2", [A], cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }), { mint: 10_000_000n });
    await runCycle(b2.deps, b2.id, A.ref);
    expect((await views(sbx.rpc, A.id, b2.key.accountId))[1].length).toBe(2);
    const st = (await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${b2.id}/pause`, headers: adminAuth })).json();
    expect(st.state).toBe("pausing");                                                  // offers stay fillable until cancelled
    expect(st.markets[0].openQuotes.length).toBe(2);
    await runCycle(b2.deps, b2.id, A.ref);
    const [acct, offers] = await views(sbx.rpc, A.id, b2.key.accountId);
    expect(offers.length).toBe(0); expect(acct.reserved_collateral).toBe("0"); expect(BigInt(acct.available_collateral)).toBe(10_000_000n);
    expect((await app.inject({ url: `/v1/admin/trading-bots/${b2.id}`, headers: adminAuth })).json().state).toBe("paused");
    expect((await ops(b2.id, "cancel_offer")).map((o: any) => o.state)).toEqual(["confirmed", "confirmed"]);
  });

  it("paper mode proposes actions but never signs or broadcasts", { timeout: 120_000 }, async () => {
    const key = await chain.createAccount("paperbot", 5n);                               // not even registered anywhere
    const id = await insertBot(fdb.db, "paperbot", key.accountId, cfgFor([A.ref]), { mode: "paper" });
    let rpcCalls: string[] = [];
    const spyRpc = new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { rpcCalls.push(JSON.parse(i.body).method); return fetch(u, i); }) as any });
    class ForbiddenTx extends TxExecutor { override async prepare(): Promise<never> { throw new Error("paper mode must not sign"); } override async execute(): Promise<never> { throw new Error("paper mode must not execute"); } }
    let signerAsked = false;
    const d = { cfg: env.cfg, db: fdb.db, rpc: spyRpc, tx: new ForbiddenTx(fdb.db, spyRpc), signer: async () => { signerAsked = true; return null; } };
    const journalBefore = (await q("SELECT COUNT(*)::int n FROM tx_journal"))[0].n;
    const r = await runCycle(d as any, id, A.ref);
    expect(r.outcome).toBe("paper");
    const dec = (await q("SELECT outcome, actions, reasons FROM bot_decisions WHERE bot_id=$1", [id]))[0];
    expect(dec.outcome).toBe("paper"); expect(dec.actions[0].type).toBe("register_token");   // what it WOULD do
    expect((await ops(id)).length).toBe(0); expect(signerAsked).toBe(false);
    expect((await q("SELECT COUNT(*)::int n FROM tx_journal"))[0].n).toBe(journalBefore);
    expect(rpcCalls).not.toContain("send_tx"); expect(rpcCalls).not.toContain("broadcast_tx_async"); expect(rpcCalls).not.toContain("broadcast_tx_commit");
    // preview (admin API): proposed quotes, nothing traded
    const prev = (await app.inject({ method: "POST", url: `/v1/admin/trading-bots/${id}/preview`, headers: adminAuth })).json();
    expect(prev.tradedNothing).toBe(true); expect(prev.markets[0].blockHeight).toBeGreaterThan(0);
    expect((await ops(id)).length).toBe(0);
  });

  it("an 'execute' bot is held back (paper-like, reported) when execution is not allowed", { timeout: 120_000 }, async () => {
    const key = await chain.createAccount("blockedbot", 5n);
    const id = await insertBot(fdb.db, "blockedbot", key.accountId, cfgFor([A.ref]), { mode: "execute" });
    const d = botDeps({ ...(env.deps as any), cfg: { ...env.cfg, bot: { ...env.cfg.bot, executionEnabled: false } } }, fdb.db, [key]);
    const r = await runCycle(d, id, A.ref);
    expect(r.reasons.some((x) => x.code === "execution_unavailable")).toBe(true);
    expect((await ops(id)).length).toBe(0);
  });

  it("signer verification: distinct account, credentials present, key belongs to the account and is full-access", { timeout: 180_000 }, async () => {
    const full = await chain.createAccount("keybot", 5n);
    const dir = mkdtempSync(join(tmpdir(), "botcreds-"));
    const file = (name: string, k: { accountId: string; secret: string }) => { const f = join(dir, name); writeFileSync(f, JSON.stringify({ account_id: k.accountId, private_key: k.secret }), { mode: 0o600 }); return f; };
    const secret = (k: any) => k.signer.key.toString();
    const mk = (envv: Record<string, string>) => makeBotSigner(env.cfg, sbx.rpc, envv);
    const bot = (acc: string, e = "BOT_CREDENTIALS_FILE") => ({ account_id: acc, credentials_env: e });
    expect((await mk({}).status(bot(full.accountId))).status.problem).toMatch(/not configured/);
    expect((await mk({ BOT_CREDENTIALS_FILE: file("ok.json", { accountId: full.accountId, secret: secret(full) }) }).status(bot(full.accountId))).status).toMatchObject({ configured: true, keyVerified: true, problem: null });
    expect((await mk({ BOT_CREDENTIALS_FILE: file("deployer.json", { accountId: dep.accountId, secret: secret(dep) }) }).status(bot(dep.accountId))).status.problem).toMatch(/distinct/);
    const stranger = KeyPair.fromRandom("ed25519");
    expect((await mk({ BOT_CREDENTIALS_FILE: file("stranger.json", { accountId: full.accountId, secret: stranger.toString() }) }).status(bot(full.accountId))).status.problem).toMatch(/not an access key/);
    const fc = KeyPair.fromRandom("ed25519");
    await chain.tx.execute(`fc-${full.accountId}`, null, full, full.accountId, [actions.addFunctionCallAccessKey(fc.getPublicKey(), token, ["mint"])], "add fc key");
    expect((await mk({ BOT_CREDENTIALS_FILE: file("fc.json", { accountId: full.accountId, secret: fc.toString() }) }).status(bot(full.accountId))).status.problem).toMatch(/not full-access/);
    void KeyPairSigner;
  });
});
