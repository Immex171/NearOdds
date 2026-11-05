import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { Neardata, NeardataUnavailableError, type NdBlock } from "../src/indexer/neardata.js";
import { block as blockH, ev, fakeNeardata, link, type R } from "./helpers/fake-chain.js";
import { Indexer } from "../src/indexer/runner.js";
import { buildApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/index.js";
import { Rpc } from "../src/near/rpc.js";

const M = "mkt-a.test.testnet", OTHER = "evil.testnet";
const ok = await prereq();
const block = (h: number, r: R[]) => blockH(h, r, M);


describe.skipIf(!ok)("indexer (fake Neardata): filtering, dedupe, atomicity, restart, projections", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>, ref: string;
  const chain = new Map<number, NdBlock>();
  let tip = 0;
  const acct = async (a: string) => (await fdb.db.query("SELECT * FROM account_state WHERE market_ref=$1 AND account_id=$2", [ref, a])).rows[0];
  beforeAll(async () => {
    fdb = await freshDb();
    ref = "m_test";
    await fdb.db.query(`INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, token_meta, config, source, verified_at, history_complete)
      VALUES ($1,'testnet',$2,'mkt-1','tok.testnet','Q?','r','s','1900000000000000000','res.testnet','{"symbol":"tNOC","decimals":6,"name":"t"}','{}','keeper', now(), false)`, [ref, M]);
    const U = (n: number) => String(n * 1_000_000);
    chain.set(101, block(101, [{ id: "r101", logs: [ev("storage_registered", { account_id: "alice.testnet", payer_id: "alice.testnet", storage_deposit_yocto: "1" }), ev("storage_registered", { account_id: "bob.testnet", payer_id: "bob.testnet", storage_deposit_yocto: "1" })] }]));
    chain.set(102, block(102, [
      { id: "r102a", logs: [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(100) })] },
      { id: "r102b", logs: [ev("deposit", { account_id: "bob.testnet", token_id: "t", amount: U(100) })] },
      { id: "r102x", executor: OTHER, logs: [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(999) })] },              // unregistered contract
      { id: "r102f", status: { Failure: { ActionError: {} } }, logs: [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(777) })] }, // failed receipt
      { id: "r102v", logs: [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(555) }, "9.9.9")] },                       // wrong version
      { id: "r102s", logs: [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(444) }, "1.0.0", "other_standard")] },     // wrong standard
    ]));
    // 103 skipped height (no block)
    chain.set(104, block(104, [{ id: "r104", logs: [ev("split", { account_id: "alice.testnet", market_id: "mkt-1", amount: U(50) })] }]));
    chain.set(105, block(105, [{ id: "r105", logs: [ev("offer_created", { offer_id: "1", owner_id: "alice.testnet", market_id: "mkt-1", outcome: "Yes", side: "Sell", price: "600000", quantity: U(20), expires_at_ns: null, reserved_collateral: "0", reserved_shares: U(20) })] }]));
    chain.set(106, block(106, [{ id: "r106", logs: [ev("offer_filled", { offer_id: "1", maker_id: "alice.testnet", taker_id: "bob.testnet", market_id: "mkt-1", outcome: "Yes", maker_side: "Sell", price: "600000", quantity: U(10), collateral_amount: U(6), remaining_quantity: U(10) })] }]));
    chain.set(107, block(107, [{ id: "r107", logs: [ev("withdrawal_requested", { account_id: "alice.testnet", withdrawal_id: "1", receiver_id: "alice.testnet", amount: U(10) })] }]));
    // the settlement callback FAILED later: its log must not complete the withdrawal
    chain.set(108, block(108, [{ id: "r108", status: { Failure: { ActionError: {} } }, logs: [ev("withdrawal_completed", { account_id: "alice.testnet", withdrawal_id: "1", amount: U(10) })] }]));
    tip = 108; link(chain);
  });
  afterAll(async () => { await fdb?.drop(); });

  it("applies only successful finalized receipts from registered contracts with the right standard/version; deterministic balances", async () => {
    const idx = new Indexer(fdb.db, fakeNeardata(chain, () => tip, { fail429: 3 }), { startHeight: 101, batch: 4, concurrency: 2 });
    for (let i = 0; i < 6; i++) await idx.step();
    expect(await idx.checkpoint()).toBe(108);
    const a = await acct("alice.testnet"), b = await acct("bob.testnet");
    // alice: 100 dep, -50 split => 50 avail coll; yes 50-20 reserved=30 avail/20 reserved(-10 filled)=10; no 50; withdrawal 10 pending (not completed: callback failed)
    expect([a.available_collateral, a.yes, a.reserved_yes, a.no, a.pending_withdrawal_amount]).toEqual([String(50e6 + 6e6 - 10e6), String(30e6), String(10e6), String(50e6), String(10e6)]);
    expect([b.available_collateral, b.yes]).toEqual([String(94e6), String(10e6)]);
    const wd = (await fdb.db.query("SELECT status FROM withdrawals")).rows;
    expect(wd).toEqual([{ status: "Pending" }]);
    const vol = (await fdb.db.query("SELECT COUNT(*)::int c, SUM(collateral_amount) v FROM fills")).rows[0];
    expect([vol.c, vol.v]).toEqual([1, String(6e6)]);
    expect((await fdb.db.query("SELECT remaining, state FROM offers")).rows).toEqual([{ remaining: String(10e6), state: "open" }]);
  });

  it("replaying the same blocks (and a restarted indexer) never double counts", async () => {
    const snap = async () => JSON.stringify([(await fdb.db.query("SELECT * FROM account_state ORDER BY account_id")).rows, (await fdb.db.query("SELECT * FROM fills")).rows, (await fdb.db.query("SELECT COUNT(*)::int FROM chain_events")).rows]);
    const before = await snap();
    const idx = new Indexer(fdb.db, fakeNeardata(chain, () => tip), { batch: 50 });
    expect(await idx.processBlocks([...chain.values()])).toBe(0);
    await idx.step(); // restart: resumes at checkpoint 108, nothing new
    expect(await snap()).toBe(before);
  });

  it("commits projections and checkpoint atomically: a poisoned batch rolls back entirely", async () => {
    chain.set(109, block(109, [{ id: "r109", logs: [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: "5" })] }]));
    chain.set(110, block(110, [{ id: "r110", logs: [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: "not-a-number" })] }]));
    tip = 110; link(chain);
    const idx = new Indexer(fdb.db, fakeNeardata(chain, () => tip), { batch: 10 });
    const before = (await acct("alice.testnet")).available_collateral;
    await expect(idx.step()).rejects.toThrow();
    expect(await idx.checkpoint()).toBe(108);                        // checkpoint did not move
    expect((await acct("alice.testnet")).available_collateral).toBe(before); // block 109's deposit was rolled back with it
    expect(idx.lastError).toBeTruthy();
    chain.delete(110); tip = 109; link(chain);                                   // operator fixes the source; indexer recovers
    await idx.step();
    expect(await idx.checkpoint()).toBe(109);
    expect(BigInt((await acct("alice.testnet")).available_collateral)).toBe(BigInt(before) + 5n);
  });

  it("redeem does not count released offer collateral twice", async () => {
    const U = (n: number) => String(n * 1_000_000);
    await fdb.db.query("INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, token_meta, config, source, verified_at) VALUES ('m_red','testnet','mkt-red.testnet','mkt-1','tok','Q','r','s','1','res','{\"symbol\":\"t\",\"decimals\":6,\"name\":\"t\"}','{}','keeper',now())");
    const R = "mkt-red.testnet";
    const E = (e: string, d: object) => ev(e, d);
    const rb = (h: number, id: string, logs: string[]) => block(h, [{ id, executor: R, logs }]);
    const seq = [
      rb(200, "q1", [E("storage_registered", { account_id: "carol.testnet", payer_id: "carol.testnet", storage_deposit_yocto: "1" }), E("deposit", { account_id: "carol.testnet", token_id: "t", amount: U(106) })]),
      rb(201, "q2", [E("split", { account_id: "carol.testnet", market_id: "mkt-1", amount: U(100) })]),
      rb(202, "q3", [E("offer_created", { offer_id: "7", owner_id: "carol.testnet", market_id: "mkt-1", outcome: "Yes", side: "Buy", price: "600000", quantity: U(10), expires_at_ns: null, reserved_collateral: U(6), reserved_shares: "0" })]),
      rb(203, "q4", [E("market_resolved", { market_id: "mkt-1", outcome: "Yes", resolver_id: "res", resolved_at_ns: "5", evidence: "e" })]),
      // redeem: the cancelled offer releases 6 collateral (own event), then redemption pays 100 winning shares
      rb(204, "q5", [E("offer_cancelled", { offer_id: "7", owner_id: "carol.testnet", market_id: "mkt-1", outcome: "Yes", side: "Buy", remaining_quantity: U(10), released_collateral: U(6), released_shares: "0" }),
        E("position_redeemed", { account_id: "carol.testnet", market_id: "mkt-1", outcome: "Yes", winning_shares: U(100), losing_shares: U(100), payout: U(100), released_offers: 1, released_collateral: U(6), released_shares: "0" })]),
    ];
    const idx = new Indexer(fdb.db, fakeNeardata(chain, () => tip), {});
    await idx.processBlocks(seq);
    const c = (await fdb.db.query("SELECT * FROM account_state WHERE market_ref='m_red' AND account_id='carol.testnet'")).rows[0];
    expect([c.available_collateral, c.reserved_collateral, c.yes, c.no, c.redeemed]).toEqual([U(106), "0", "0", "0", true]); // 6 (released once) + 100 payout
    expect((await fdb.db.query("SELECT state FROM offers WHERE market_ref='m_red'")).rows).toEqual([{ state: "released" }]);
    expect((await fdb.db.query("SELECT contract_status FROM markets WHERE market_ref='m_red'")).rows[0].contract_status).toBe("Resolved");
  });

  it("reports provider unavailability and authentication problems clearly", async () => {
    const down = new Indexer(fdb.db, fakeNeardata(chain, () => tip, { down: true }), {});
    await expect(down.step()).rejects.toBeInstanceOf(NeardataUnavailableError);
    expect((await down.status()).error).toMatch(/neardata unavailable/);
    const auth = new Neardata("http://nd.test", null, (async () => new Response("no", { status: 401 })) as any, 1);
    await expect(auth.finalHeight()).rejects.toThrow(/NEARDATA_API_KEY/);
  });

  it("SSE delivers a trade event with freshness, and clients can resync from snapshots", async () => {
    const cfg = loadConfig({ DATABASE_URL: "x" } as any);
    const app = buildApp({ db: fdb.db, rpc: new Rpc({ url: "http://127.0.0.1:1", retries: 0 }), cfg, streamPollMs: 100 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/stream?markets=${ref}`, { signal: ctl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    const until = async (needle: string) => { const t = Date.now(); while (!buf.includes(needle) && Date.now() - t < 5000) { const { value } = await reader.read(); buf += dec.decode(value); } return buf.includes(needle); };
    expect(await until("event: hello")).toBe(true);
    const U = (n: number) => String(n * 1_000_000);
    const idx = new Indexer(fdb.db, fakeNeardata(chain, () => tip), {});
    await idx.processBlocks([block(300, [{ id: "sse1", logs: [ev("offer_filled", { offer_id: "1", maker_id: "alice.testnet", taker_id: "bob.testnet", market_id: "mkt-1", outcome: "Yes", maker_side: "Sell", price: "600000", quantity: U(1), collateral_amount: "600000", remaining_quantity: U(9) })] }])]);
    expect(await until("event: trade")).toBe(true);
    const line = buf.split("\n").find((l) => l.startsWith("data:") && l.includes("collateral"))!;
    const payload = JSON.parse(line.slice(5));
    expect(payload.marketRef).toBe(ref); expect(payload.collateral).toBe("600000"); expect(payload.freshness).toHaveProperty("blockHeight");
    ctl.abort();
    const snap = (await app.inject(`/v1/markets/${ref}/trades`)).json();
    expect(snap.items[0].collateralAmount).toBe("600000"); expect(snap.freshness).toHaveProperty("lagBlocks");
    await app.close();
  });
});
