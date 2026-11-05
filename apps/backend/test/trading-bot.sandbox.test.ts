import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prereq } from "./helpers/prereq.js";
import { freshDb } from "./helpers/db.js";
import { startSandbox, type Sandbox } from "./helpers/sandbox.js";
import { TGAS, TestChain, sleep } from "./helpers/chain.js";
import { keeperEnv } from "./helpers/keeper-env.js";
import { setupMarket } from "./helpers/market.js";
import { login } from "./helpers/auth.js";
import { CrashAfter, GateBeforePrepare, GatedBroadcast, botDeps, cfgFor, insertBot, prepAccount, views } from "./helpers/bot-rig.js";
import { U } from "./helpers/bot-fixtures.js";
import { runCycle } from "../src/trading-bot/cycle.js";
import { loadBot, loadFacts, proposeOps, ProposalConflict, recoverBotSpend, runOperation } from "../src/trading-bot/ops.js";
import { readSnapshot } from "../src/trading-bot/chain.js";
import { decide } from "../src/trading-bot/decide.js";
import { BOT_JOB_KIND, botHandlers, scheduleBotCycles } from "../src/trading-bot/worker.js";
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
    // the API process reports/permits execute mode only when the credentials file named by the env var exists
    const f = join(mkdtempSync(join(tmpdir(), "botenv-")), "bot.json"); writeFileSync(f, JSON.stringify({ account_id: "x", private_key: "x" })); process.env.BOT_CREDENTIALS_FILE = f;
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

  const spyRpcFor = () => { const calls: string[] = []; return { calls, rpc: new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { calls.push(JSON.parse(i.body).method); return fetch(u, i); }) as any }) }; };
  const waitReached = async (g: { reached: boolean }) => { for (let i = 0; i < 160 && !g.reached; i++) await sleep(250); expect(g.reached).toBe(true); };
  const api = (method: "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: adminAuth, payload });

  it("stop (or a config change) requested BEFORE signing: the cancelled operation is never signed or broadcast", { timeout: 300_000 }, async () => {
    const bot = await newBot("prestop", [A], cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }), { mint: 10_000_000n });
    const tokenBal = async () => BigInt(await sbx.rpc.callView<string>(token, "ft_balance_of", { account_id: bot.key.accountId }));
    const journalFor = () => q("SELECT op_key FROM tx_journal WHERE op_key LIKE $1", [`bot:${bot.id}:%`]);
    // --- 1. the worker is paused before signing (op proposed + marked submitted, nothing signed) ...
    let spy = spyRpcFor(); const gate = new GateBeforePrepare(fdb.db, spy.rpc, 60_000, 200);
    const cyc = runCycle({ ...botDeps({ cfg: env.cfg, rpc: spy.rpc, tx: gate }, fdb.db, [bot.key]) }, bot.id, A.ref);
    await waitReached(gate);
    expect((await ops(bot.id)).map((o: any) => o.state)).toEqual(["submitted"]);
    expect(await journalFor()).toEqual([]);
    // ... the administrator stops the bot ...
    const stop = (await api("POST", `/v1/admin/trading-bots/${bot.id}/stop`)).json();
    expect((await ops(bot.id)).map((o: any) => o.state)).toEqual(["cancelled"]);                  // cancelled before any signature existed
    expect(stop.desiredState).toBe("stopped");
    // ... and the worker resumes: it must NOT sign
    gate.release(); await cyc;
    expect(await journalFor()).toEqual([]);                                                       // no signed bytes
    expect(spy.calls).not.toContain("send_tx"); expect(spy.calls).not.toContain("broadcast_tx_async"); // no broadcast
    expect(await tokenBal()).toBe(10_000_000n);                                                   // nothing was deposited
    expect((await ops(bot.id)).map((o: any) => o.state)).toEqual(["cancelled"]);
    expect((await q("SELECT state FROM trading_bots WHERE id=$1", [bot.id]))[0].state).toBe("stopped");

    // --- 2. same race with a configuration change instead of a stop
    await api("POST", `/v1/admin/trading-bots/${bot.id}/start`, { mode: "execute" });
    spy = spyRpcFor(); const gate2 = new GateBeforePrepare(fdb.db, spy.rpc, 60_000, 200);
    const cyc2 = runCycle(botDeps({ cfg: env.cfg, rpc: spy.rpc, tx: gate2 }, fdb.db, [bot.key]), bot.id, A.ref);
    await waitReached(gate2);
    const firstOp = (await ops(bot.id)).find((o: any) => o.state === "submitted");
    await api("PUT", `/v1/admin/trading-bots/${bot.id}/config`, { config: cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }) });
    gate2.release(); await cyc2;
    expect((await q("SELECT state FROM bot_operations WHERE op_key=$1", [firstOp.op_key]))[0].state).toBe("cancelled");   // the v1 operation was refused at the signing step
    expect((await q("SELECT 1 FROM tx_journal WHERE op_key=$1", [firstOp.op_key])).length).toBe(0);
  });

  it("execute -> paper is refused while quotes are live; after stop + settle it is allowed and a paper bot then signs and broadcasts nothing", { timeout: 300_000 }, async () => {
    const bot = await newBot("modebot", [A], cfgFor([A.ref], { funding: { depositCollateral: U(10), splitCollateral: "0" } }), { mint: 10_000_000n });
    await runCycle(bot.deps, bot.id, A.ref);
    expect((await views(sbx.rpc, A.id, bot.key.accountId))[1].length).toBe(2);                     // two live bids
    const refused = await api("POST", `/v1/admin/trading-bots/${bot.id}/start`, { mode: "paper" });
    expect(refused.statusCode).toBe(409); expect(refused.json().error.code).toBe("outstanding_work");
    expect((await q("SELECT mode FROM trading_bots WHERE id=$1", [bot.id]))[0].mode).toBe("execute");
    await api("POST", `/v1/admin/trading-bots/${bot.id}/stop`);
    expect((await q("SELECT state FROM trading_bots WHERE id=$1", [bot.id]))[0].state).toBe("stopping");   // still has offers
    await runCycle(bot.deps, bot.id, A.ref);                                                       // wind-down cancels them
    expect((await views(sbx.rpc, A.id, bot.key.accountId))[1].length).toBe(0);
    const ok = await api("POST", `/v1/admin/trading-bots/${bot.id}/start`, { mode: "paper" });
    expect(ok.statusCode).toBe(200); expect(ok.json().state).toBe("paper");
    const spy = spyRpcFor(); const journalBefore = (await q("SELECT COUNT(*)::int n FROM tx_journal"))[0].n;
    class Forbidden extends TxExecutor { override async prepare(): Promise<never> { throw new Error("settled paper mode must not sign"); } }
    const r = await runCycle(botDeps({ cfg: env.cfg, rpc: spy.rpc, tx: new Forbidden(fdb.db, spy.rpc) }, fdb.db, [bot.key]), bot.id, A.ref);
    expect(["paper", "noop", "skipped"]).toContain(r.outcome);
    expect((await q("SELECT COUNT(*)::int n FROM tx_journal"))[0].n).toBe(journalBefore);
    expect(spy.calls).not.toContain("send_tx");
  });

  it("a market removed from the configuration while it has live quotes AND a transaction in flight is still reconciled and cancelled", { timeout: 360_000 }, async () => {
    const bot = await newBot("rmbot", [A, B], cfgFor([A.ref, B.ref], { funding: { depositCollateral: U(5), splitCollateral: "0" } }), { mint: 10_000_000n });
    await runCycle(bot.deps, bot.id, B.ref);
    const quotesB = async () => (await views(sbx.rpc, B.id, bot.key.accountId))[1];
    expect((await quotesB()).length).toBe(2);
    // new reference on B => both bids are stale; the worker starts cancelling them and its first cancel is in flight (signed, unsent)
    const repriced = cfgFor([A.ref, B.ref], { funding: { depositCollateral: U(5), splitCollateral: "0" }, reference: { yesPrice: "600000" } });
    expect((await api("PUT", `/v1/admin/trading-bots/${bot.id}/config`, { config: repriced })).statusCode).toBe(200);
    const gated = new GatedBroadcast(fdb.db, env.rpc, 60_000, 200);
    const cyc = runCycle(botDeps(env.deps as any, fdb.db, [bot.key], gated), bot.id, B.ref);
    await waitReached(gated);
    // ... and now B is REMOVED from the configuration
    const removed = cfgFor([A.ref], { funding: { depositCollateral: U(5), splitCollateral: "0" } });
    expect((await api("PUT", `/v1/admin/trading-bots/${bot.id}/config`, { config: removed })).statusCode).toBe(200);
    const st = (await app.inject({ url: `/v1/admin/trading-bots/${bot.id}`, headers: adminAuth })).json();
    const entry = st.markets.find((m: any) => m.marketRef === B.ref);
    expect(entry.removedFromConfig).toBe(true); expect(entry.openQuotes.length).toBe(2); expect(st.pendingOperations.length).toBeGreaterThan(0);   // visible, with its live work
    await fdb.db.query("DELETE FROM jobs WHERE kind=$1", [BOT_JOB_KIND]);
    await scheduleBotCycles(fdb.db, 15, Date.now() + 3_600_000);
    expect((await q("SELECT payload->>'marketRef' m FROM jobs WHERE kind=$1 AND payload->>'botId'=$2 ORDER BY 1", [BOT_JOB_KIND, bot.id])).map((r: any) => r.m).sort()).toEqual([A.ref, B.ref].sort());   // still scheduled
    gated.release(); await cyc;
    await runCycle(bot.deps, bot.id, B.ref);                                                         // reconcile + finish winding down
    expect((await quotesB()).length).toBe(0);                                                        // nothing left live on the removed market
    expect((await ops(bot.id, "cancel_offer")).every((o: any) => o.state === "confirmed")).toBe(true);
    expect((await q("SELECT COUNT(*)::int n FROM bot_operations WHERE bot_id=$1 AND state IN ('proposed','submitted','uncertain')", [bot.id]))[0].n).toBe(0);
    const after = (await app.inject({ url: `/v1/admin/trading-bots/${bot.id}`, headers: adminAuth })).json();
    expect(after.markets.map((m: any) => m.marketRef)).toEqual([A.ref]);                             // gone from status once settled
    await fdb.db.query("DELETE FROM jobs WHERE kind=$1", [BOT_JOB_KIND]);
    await scheduleBotCycles(fdb.db, 15, Date.now() + 7_200_000);
    expect((await q("SELECT payload->>'marketRef' m FROM jobs WHERE kind=$1 AND payload->>'botId'=$2", [BOT_JOB_KIND, bot.id])).map((r: any) => r.m)).toEqual([A.ref]);
  });

  it("failed on-chain transactions burn gas: the fee is recorded exactly once (also after a crash) and counts against the native limit; refunded deposits are not spending", { timeout: 300_000 }, async () => {
    const bot = await newBot("failbot", [A], cfgFor([A.ref]), { prereg: false });
    await chain.call(bot.key, token, "storage_deposit", { account_id: bot.key.accountId, registration_only: true }, 1_250_000_000_000_000_000_000n, 30n * TGAS);
    const mrow = (await q("SELECT market_ref, network, contract_id, internal_market_id, token_id, cutoff_ns FROM markets WHERE market_ref=$1", [A.ref]))[0];
    const m = { market_ref: A.ref, contract_id: A.id, internal_market_id: "mkt-1", token_id: token };
    const exec = { db: fdb.db, tx: env.deps.tx, signer: async () => bot.key };
    const botRow = (await loadBot(fdb.db, bot.id))!;
    const snapNow = await readSnapshot(env.rpc, mrow, bot.key.accountId);
    // (1) an under-funded market registration fails on chain: gas is burnt, the attached deposit is refunded
    const [reg] = await proposeOps(fdb.db, botRow, m, botRow.config_version, [{ type: "register_market", deposit: 1000n }], snapNow);
    expect(await runOperation(exec as any, botRow, m, reg)).toBe("failed");
    // (2) a cancel of a nonexistent offer fails on chain too (needs a registered account)
    await chain.call(bot.key, A.id, "storage_deposit", { account_id: null, registration_only: true }, 40_960_000_000_000_000_000_000n, 30n * TGAS);
    const [can] = await proposeOps(fdb.db, botRow, m, botRow.config_version, [{ type: "cancel", offerId: "999999", slot: "YES_BUY", reason: "test" }], snapNow);
    expect(await runOperation(exec as any, botRow, m, can)).toBe("failed");
    const rows = async () => q("SELECT op_id, burnt_yocto, deposit_yocto, refunded_yocto, yocto, op_outcome FROM bot_native_spend WHERE bot_id=$1 ORDER BY op_id::numeric", [bot.id]);
    let r = await rows();
    expect(r.length).toBe(2);
    expect(r.every((x: any) => x.op_outcome === "failed" && BigInt(x.burnt_yocto) > 0n && x.deposit_yocto === "0")).toBe(true);   // real burnt gas, no deposit kept
    expect(r[0].refunded_yocto).toBe("1000"); expect(r[1].refunded_yocto).toBe("0");                                            // refund tracked apart from spending
    expect(BigInt(r[0].yocto)).toBe(BigInt(r[0].burnt_yocto));
    const total = r.reduce((a: bigint, x: any) => a + BigInt(x.yocto), 0n);
    // restart / crash recovery: records can be rebuilt from the journal and are never duplicated
    expect(await recoverBotSpend(fdb.db, bot.id)).toBe(0);
    await fdb.db.query("DELETE FROM bot_native_spend WHERE bot_id=$1", [bot.id]);                                              // "crash before the expense was recorded"
    expect(await recoverBotSpend(fdb.db, bot.id)).toBe(2);
    expect(await recoverBotSpend(fdb.db, bot.id)).toBe(0);
    r = await rows(); expect(r.length).toBe(2);
    expect(r.reduce((a: bigint, x: any) => a + BigInt(x.yocto), 0n)).toBe(total);
    // the recorded fees affect later budget decisions
    expect((await loadFacts(fdb.db, botRow, A.ref)).nativeSpent).toBe(total);
    const tight = { ...botRow.config, limits: { ...botRow.config.limits, maxNativeSpendYocto: (total + 1000n).toString() } };
    const facts = await loadFacts(fdb.db, botRow, A.ref);
    const d = decide({ nowMs: Date.now(), snap: { ...snapNow, tokenRegistered: false }, facts: { ...facts, desired: "running" }, cfg: tight, marketRef: A.ref });
    expect(d.reasons[0].code).toBe("native_spend_limit"); expect(d.actions).toEqual([]);
    await fdb.db.query("UPDATE trading_bots SET config=$2 WHERE id=$1", [bot.id, JSON.stringify(tight)]);
    const bot2 = (await loadBot(fdb.db, bot.id))!;
    await expect(proposeOps(fdb.db, bot2, m, bot2.config_version, [{ type: "register_token", deposit: 1_250_000_000_000_000_000_000n }], snapNow)).rejects.toMatchObject({ code: "native_spend_limit" });
    void ProposalConflict;
  });
});
