import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { sandboxAvailable, startSandbox, type Sandbox } from "./helpers/sandbox.js";
import { TestChain, sleep } from "./helpers/chain.js";
import { keeperEnv } from "./helpers/keeper-env.js";
import { actor, setupMarket } from "./helpers/market.js";
import { buildApp } from "../src/api/app.js";
import { reconcileMarket } from "../src/indexer/reconcile.js";
import { backfillTransactions } from "../src/indexer/runner.js";
import { keeperPass } from "../src/keeper/loop.js";
import { proposeResolution, reviewProposal, ResolutionError } from "../src/keeper/resolution.js";

const ok = sandboxAvailable() && (await dbAvailable());
describe.skipIf(!ok)("Sandbox lifecycle: deposits, offers, partial fills, cancel, resolution, redeem, withdraw", () => {
  let sbx: Sandbox, fdb: Awaited<ReturnType<typeof freshDb>>, chain: TestChain, env: Awaited<ReturnType<typeof keeperEnv>>;
  beforeAll(async () => { sbx = await startSandbox(); fdb = await freshDb(); chain = new TestChain(sbx, fdb.db); });
  afterAll(async () => { await sbx?.stop(); await fdb?.drop(); });

  it("indexer projections match contract views through the whole lifecycle; replay changes nothing", { timeout: 480_000 }, async () => {
    const dep = await chain.createAccount("deployer", 300n);
    const alice = await chain.createAccount("alice", 50n), bob = await chain.createAccount("bob", 50n);
    const token = await chain.deployToken(dep);
    env = await keeperEnv(sbx, fdb.db, chain, dep, (dep.signer as any).key.toString(), token);
    const m = await setupMarket(chain, fdb.db, dep, token, "life", 215_000, 15_000);
    const A = actor(chain, fdb.db, m, token, [alice.accountId, bob.accountId, dep.accountId]);
    const U = (x: number) => (BigInt(x) * 1_000_000n).toString();

    await A.register(alice); await A.register(bob);
    await A.fund(dep, alice, U(200)); await A.fund(dep, bob, U(100));
    await A.m(alice, "split_position", { market_id: "mkt-1", amount: U(100) });
    const o1 = await A.m(alice, "create_offer", { market_id: "mkt-1", outcome: "Yes", side: "Sell", price: "600000", quantity: U(50) });
    const o2 = await A.m(alice, "create_offer", { market_id: "mkt-1", outcome: "No", side: "Buy", price: "300000", quantity: U(20) });
    const id1 = JSON.parse(Buffer.from(o1.status.SuccessValue, "base64").toString()).offer_id;
    const id2 = JSON.parse(Buffer.from(o2.status.SuccessValue, "base64").toString()).offer_id;
    await A.m(bob, "fill_offer", { offer_id: id1, quantity: U(10) });           // partial fill (bob buys 10 YES @0.60)
    await A.m(bob, "fill_offer", { offer_id: id1, quantity: U(5) });            // second partial
    await A.m(alice, "cancel_offer", { offer_id: id2 });                         // full cancel of the buy-NO offer
    const o3 = await A.m(bob, "create_offer", { market_id: "mkt-1", outcome: "Yes", side: "Buy", price: "500000", quantity: U(8) });
    const id3 = JSON.parse(Buffer.from(o3.status.SuccessValue, "base64").toString()).offer_id;
    await A.m(alice, "fill_offer", { offer_id: id3, quantity: U(3) });           // alice sells 3 YES into bob's bid
    await A.m(bob, "split_position", { market_id: "mkt-1", amount: U(10) });
    await A.m(bob, "merge_positions", { market_id: "mkt-1", amount: U(4) });

    // ---- mid-flight: projections equal views BEFORE any reconcile overwrite
    let h = (await sbx.rpc.finalBlock()).height;
    let rep = await reconcileMarket(fdb.db, sbx.rpc, m.ref, h);
    expect(rep.offerDrift, JSON.stringify(rep)).toEqual([]);
    expect(rep.accountDrift, JSON.stringify(rep)).toEqual([]);
    // volume = confirmed fills only: 10*0.6 + 5*0.6 + 3*0.5 = 6+3+1.5 = 10.5 tokens
    const app = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: env.cfg });
    const mk = (await app.inject(`/v1/markets/${m.ref}`)).json();
    expect(mk.volume).toBe("10500000"); expect(mk.tradeCount).toBe(3);
    const book = (await app.inject(`/v1/markets/${m.ref}/book`)).json();
    expect(book.yes.asks.map((o: any) => [o.offerId, o.remainingQuantity])).toEqual([[id1, U(35)]]);
    expect(book.yes.bids.map((o: any) => [o.offerId, o.remainingQuantity])).toEqual([[id3, U(5)]]);
    expect(book.no.empty).toBe(true); // cancelled NO bid is gone
    const trades = (await app.inject(`/v1/markets/${m.ref}/trades`)).json();
    expect(trades.items.length).toBe(3);
    const candles = (await app.inject(`/v1/markets/${m.ref}/candles?outcome=Yes&interval=1m`)).json();
    expect(candles.candles.reduce((s: bigint, c: any) => s + BigInt(c.volume), 0n)).toBe(10500000n);
    expect(mk.quotes.Yes.lastTrade).toBe("500000"); expect(mk.quotes.No.lastTrade).toBeNull(); // YES and NO kept distinct

    // ---- replay: re-ingesting every receipt changes nothing
    const snap = async () => JSON.stringify([(await fdb.db.query("SELECT * FROM account_state ORDER BY account_id")).rows, (await fdb.db.query("SELECT COUNT(*)::int c, SUM(collateral_amount) v FROM fills")).rows, (await fdb.db.query("SELECT COUNT(*)::int c FROM chain_events")).rows]);
    const before = await snap();
    const replayed = await backfillTransactions(fdb.db, sbx.rpc, A.hashes);
    expect(replayed.ingested).toBe(0);
    expect(await snap()).toBe(before);

    // ---- resolution: wait for cutoff; evidence missing => stays pending, no resolve tx, never NO
    await sleep(Math.max(0, Number(BigInt(m.cutoffNs) / 1_000_000n) - Date.now()) + 1500);
    let r = await keeperPass(env.deps, "w1");
    expect(r.resolutionEnqueued).toEqual([]);
    expect((await sbx.rpc.callView<any>(m.id, "get_market", { market_id: "mkt-1" })).status).toBe("AwaitingResolution");
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key LIKE 'resolve:%'")).rows[0].n).toBe(0);
    const w = (await fdb.db.query("SELECT * FROM resolution_watch WHERE market_ref=$1", [m.ref])).rows[0];
    expect(w.cutoff_passed).toBe(true); expect(w.evidence_state).toBe("missing");
    // evidence that predates the end of the observation period is rejected
    await expect(proposeResolution(fdb.db, { marketRef: m.ref, outcome: "Yes", evidenceRef: "https://example/report", retrievedAt: new Date(Number(BigInt(m.cutoffNs) / 1_000_000n) + 1000), proposedBy: dep.accountId })).rejects.toBeInstanceOf(ResolutionError);
    // wait until observation completes, propose, approve
    await sleep(Math.max(0, Number(BigInt(m.cutoffNs) / 1_000_000n) + 15_000 - Date.now()) + 1500);
    const prop = await proposeResolution(fdb.db, { marketRef: m.ref, outcome: "Yes", evidenceRef: "https://example.test/nimet/report", retrievedAt: new Date(), proposedBy: dep.accountId });
    expect(prop.decision).toBe("pending");
    r = await keeperPass(env.deps, "w1");
    expect(r.resolutionEnqueued).toEqual([]); // pending proposals do not resolve anything
    await reviewProposal(fdb.db, prop.id, dep.accountId, "approved", "checked", 1);
    r = await keeperPass(env.deps, "w1");
    expect(r.resolutionEnqueued).toEqual([m.ref]);
    const chainMkt = await sbx.rpc.callView<any>(m.id, "get_market", { market_id: "mkt-1" });
    expect(chainMkt.resolution.outcome).toBe("Yes"); expect(chainMkt.resolution.evidence).toBe("https://example.test/nimet/report");
    const rtx = (await fdb.db.query("SELECT tx_hash FROM tx_journal WHERE op_key=$1", [`resolve:${m.ref}`])).rows[0].tx_hash;
    await A.ingest(rtx);
    expect((await fdb.db.query("SELECT contract_status FROM markets WHERE market_ref=$1", [m.ref])).rows[0].contract_status).toBe("Resolved");

    // ---- redeem + withdraw
    await A.m(alice, "redeem", { market_id: "mkt-1" });
    await A.m(bob, "redeem", { market_id: "mkt-1" });
    const wd = await A.m(alice, "withdraw", { amount: U(10) });
    h = (await sbx.rpc.finalBlock()).height;
    rep = await reconcileMarket(fdb.db, sbx.rpc, m.ref, h);
    expect(rep.offerDrift, JSON.stringify(rep)).toEqual([]);
    expect(rep.accountDrift, JSON.stringify(rep)).toEqual([]); // redemption released collateral NOT double counted
    expect(rep.withdrawalFixes).toEqual([]);
    const wds = (await app.inject(`/v1/accounts/${alice.accountId}/withdrawals`)).json();
    expect(wds.items.map((x: any) => [x.status, x.amount, x.confirmed])).toEqual([["Completed", U(10), true]]);
    expect(wd.status.SuccessValue).toBeDefined();
    // volume unchanged by redemption/withdrawal
    expect((await app.inject(`/v1/markets/${m.ref}`)).json().volume).toBe("10500000");
    const pf = (await app.inject(`/v1/accounts/${bob.accountId}/portfolio`)).json();
    expect(pf.markets[0].redeemed).toBe(true); expect(pf.markets[0].positions.yes.total).toBe("0");
    await app.close();
  });
});
