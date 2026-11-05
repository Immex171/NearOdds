import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actions } from "near-api-js";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { sandboxAvailable, startSandbox, type Sandbox } from "./helpers/sandbox.js";
import { TestChain } from "./helpers/chain.js";
import { Rpc, RpcUnavailableError } from "../src/near/rpc.js";
import { TxExecutor, TxUncertainError } from "../src/near/tx.js";

const ok = await prereq({ sandbox: true });
describe.skipIf(!ok)("tx executor on Sandbox", () => {
  let sbx: Sandbox, fdb: Awaited<ReturnType<typeof freshDb>>, chain: TestChain;
  beforeAll(async () => { sbx = await startSandbox(); fdb = await freshDb(); chain = new TestChain(sbx, fdb.db); });
  afterAll(async () => { await sbx?.stop(); await fdb?.drop(); });

  it("signs once per op key and returns the cached outcome on re-execution", async () => {
    const a = await chain.createAccount("alice");
    const before = (await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal")).rows[0].n;
    const o1 = await chain.tx.execute("op-1", null, chain.root, a.accountId, [actions.transfer(1n)], "t1");
    const o2 = await chain.tx.execute("op-1", null, chain.root, a.accountId, [actions.transfer(1n)], "t1");
    expect(o2.transaction.hash).toBe(o1.transaction.hash);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal")).rows[0].n).toBe(before + 1);
  });

  it("allocates distinct nonces for concurrent operations of one signer", async () => {
    const a = await chain.createAccount("bob");
    await Promise.all(Array.from({ length: 6 }, (_, i) => chain.tx.execute(`conc-${i}`, null, chain.root, a.accountId, [actions.transfer(1n)], "c")));
    const n = (await fdb.db.query("SELECT COUNT(DISTINCT nonce)::int d, COUNT(*)::int t FROM tx_journal WHERE op_key LIKE 'conc-%'")).rows[0];
    expect(n.d).toBe(6); expect(n.t).toBe(6);
  });

  it("RPC timeout after execution: status reads fail, op becomes uncertain, NO new signed tx; later resume finds the original", async () => {
    const a = await chain.createAccount("carol");
    // flaky rpc: reads of tx status fail while 'down'
    let down = false;
    const flaky = new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { const body = JSON.parse(i.body); if (down && (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status")) throw new Error("timeout"); return fetch(u, i); }) as any });
    const ex = new TxExecutor(fdb.db, flaky, 1500, 200);
    down = true;
    await expect(ex.execute("flaky-op", null, chain.root, a.accountId, [actions.transfer(5n)], "flaky")).rejects.toBeInstanceOf(TxUncertainError);
    const row = (await fdb.db.query("SELECT * FROM tx_journal WHERE op_key='flaky-op'")).rows[0];
    expect(row.state).toBe("uncertain");
    await new Promise((r) => setTimeout(r, 1500)); // the broadcast tx executes on chain regardless
    down = false;
    const out = await ex.execute("flaky-op", null, chain.root, a.accountId, [actions.transfer(5n)], "flaky");
    expect(out.transaction.hash).toBe(row.tx_hash);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key='flaky-op'")).rows[0].n).toBe(1);
    // exactly one transfer of 5 landed
    const acct = await sbx.rpc.viewAccount(a.accountId);
    expect(acct.exists && BigInt(acct.amount)).toBe(100n * 10n ** 24n + 5n);
  });

  it("distinguishes UNKNOWN_ACCOUNT from an unavailable RPC", async () => {
    expect(await sbx.rpc.viewAccount("nobody.test.near")).toEqual({ exists: false });
    const dead = new Rpc({ url: "http://127.0.0.1:1", retries: 1, backoffMs: 5, timeoutMs: 500 });
    await expect(dead.viewAccount("nobody.test.near")).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});
