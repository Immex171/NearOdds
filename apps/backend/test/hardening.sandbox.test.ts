import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actions } from "near-api-js";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { sandboxAvailable, startSandbox, type Sandbox } from "./helpers/sandbox.js";
import { TestChain, sleep } from "./helpers/chain.js";
import { keeperEnv, lagosTemplate } from "./helpers/keeper-env.js";
import { createTemplate, updateTemplate } from "../src/keeper/templates.js";
import { handlersFor } from "../src/keeper/loop.js";
import { scheduleTick } from "../src/keeper/scheduler.js";
import { runOne } from "../src/keeper/jobs.js";
import { Rpc, RpcUnavailableError } from "../src/near/rpc.js";
import { verifyMarketOnChain } from "../src/registry/index.js";
import { setupMarket } from "./helpers/market.js";
import { TxExecutor, type JournalRow } from "../src/near/tx.js";

const ok = await prereq({ sandbox: true });
describe.skipIf(!ok)("hardening on Sandbox: frozen templates, verification outage, per-key ordering", () => {
  let sbx: Sandbox, fdb: Awaited<ReturnType<typeof freshDb>>, chain: TestChain, env: Awaited<ReturnType<typeof keeperEnv>>, dep: any, token: string, token2: string;
  const today = (over: Record<string, unknown>) => lagosTemplate(dep.accountId, token, { schedule: { frequency: "daily", timezone: "UTC", leadDays: 0, minLeadMinutes: 0 }, observation: null, cutoff: { offsetMinutesFromObservationStart: 24 * 60 - 1 }, ...over });
  const drain = async (deps = env.deps, w = "w") => { let n = 0; while (await runOne(fdb.db, w, handlersFor(deps))) n++; return n; };
  const release = () => fdb.db.query("UPDATE jobs SET run_after=now(), lease_until=NULL WHERE state IN ('queued','uncertain','running')");

  beforeAll(async () => {
    sbx = await startSandbox(); fdb = await freshDb(); chain = new TestChain(sbx, fdb.db);
    dep = await chain.createAccount("deployer", 400n);
    token = await chain.deployToken(dep, "tnoc"); token2 = await chain.deployToken(dep, "tnoc2");
    env = await keeperEnv(sbx, fdb.db, chain, dep, (dep.signer as any).key.toString(), token);
    env.deps.providers.register({ id: "fx", decisionRule: "fixture", fetch: async () => ({ status: "pending" }) });
  });
  afterAll(async () => { await sbx?.stop(); await fdb?.drop(); });

  it("a template updated AFTER its job was queued does not change that job's terms or dependencies", async () => {
    const t = await createTemplate(fdb.db, today({ slug: "frz", category: "CatV1", questionTemplate: "Frozen v1 {{date}}?" }), dep.accountId, env.cfg, env.deps.providers);
    await updateTemplate(fdb.db, t.id, { enabled: true }, env.cfg, env.deps.providers);
    expect((await scheduleTick(fdb.db)).enqueued.length).toBe(1);
    await updateTemplate(fdb.db, t.id, { spec: today({ slug: "frz", category: "CatV2", questionTemplate: "Changed v2 {{date}}?", collateralToken: token2, resolution: { policy: "automatic", provider: "fx", decisionRule: "r" } }) }, env.cfg, env.deps.providers);
    await drain();
    const job = (await fdb.db.query("SELECT state, last_error, payload->>'templateVersion' v FROM jobs WHERE dedupe_key LIKE 'tpl:frz:v1:%'")).rows[0];
    expect(job.state, job.last_error).toBe("succeeded"); expect(job.v).toBe("1");
    const m = (await fdb.db.query("SELECT * FROM markets WHERE template_id=$1", [t.id])).rows[0];
    expect(m.question).toMatch(/^Frozen v1 /); expect(m.category).toBe("CatV1"); expect(m.token_id).toBe(token);
    expect(await sbx.rpc.callView(token, "storage_balance_of", { account_id: m.contract_id })).not.toBeNull();   // registered with the ORIGINAL token
    expect(await sbx.rpc.callView(token2, "storage_balance_of", { account_id: m.contract_id })).toBeNull();
    expect((await fdb.db.query("SELECT policy, provider FROM resolution_watch WHERE market_ref=$1", [m.market_ref])).rows[0]).toEqual({ policy: "reviewed", provider: null });
    expect((await fdb.db.query("SELECT version FROM template_revisions WHERE template_id=$1 ORDER BY version", [t.id])).rows.map((r: any) => r.version)).toEqual([1, 2]);
    await fdb.db.query("UPDATE templates SET enabled=false"); // keep later tests isolated from this template
  });

  it("a template updated after the creation tx succeeded but before publication still publishes the original terms", async () => {
    const t = await createTemplate(fdb.db, today({ slug: "frz2", category: "Before", questionTemplate: "Crash window v1 {{date}}?" }), dep.accountId, env.cfg, env.deps.providers);
    await updateTemplate(fdb.db, t.id, { enabled: true }, env.cfg, env.deps.providers);
    await fdb.db.query("UPDATE templates SET enabled=false WHERE slug<>'frz2'");
    await scheduleTick(fdb.db);
    class CrashAfterCreate extends TxExecutor {
      crashed = false;
      override async execute(op: string, job: string | null, k: any, r: string, a: any, d: string) {
        const out = await super.execute(op, job, k, r, a, d);
        if (op.startsWith("create:") && !this.crashed) { this.crashed = true; throw new Error("simulated crash after on-chain creation"); }
        return out;
      }
    }
    await drain({ ...env.deps, tx: new CrashAfterCreate(fdb.db, env.rpc, 60_000, 300) });
    const j = (await fdb.db.query("SELECT * FROM jobs WHERE dedupe_key LIKE 'tpl:frz2:v1:%'")).rows[0];
    expect(j.state, j.last_error + " " + JSON.stringify(j.payload.createTx)).toBe("queued");
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM markets WHERE template_id=$1", [t.id])).rows[0].n).toBe(0); // not yet published
    await updateTemplate(fdb.db, t.id, { spec: today({ slug: "frz2", category: "After", questionTemplate: "Changed {{date}}?", collateralToken: token2, resolution: { policy: "automatic", provider: "fx", decisionRule: "r" } }) }, env.cfg, env.deps.providers);
    await release(); await drain();
    const m = (await fdb.db.query("SELECT * FROM markets WHERE template_id=$1", [t.id])).rows[0];
    expect(m.question).toMatch(/^Crash window v1 /); expect(m.category).toBe("Before"); expect(m.token_id).toBe(token);
    expect((await fdb.db.query("SELECT policy FROM resolution_watch WHERE market_ref=$1", [m.market_ref])).rows[0].policy).toBe("reviewed");
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key=$1", [`create:${j.id}`])).rows[0].n).toBe(1);
  });

  it("verification outage after funding: the job resumes verifying the existing deployment (no failure, no new tx); budget stays spent", async () => {
    const t = await createTemplate(fdb.db, today({ slug: "vout", questionTemplate: "Outage {{date}}?" }), dep.accountId, env.cfg, env.deps.providers);
    await updateTemplate(fdb.db, t.id, { enabled: true }, env.cfg, env.deps.providers);
    await fdb.db.query("UPDATE templates SET enabled=false WHERE slug<>'vout'");
    await scheduleTick(fdb.db);
    let down = true;
    const flaky = new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { const b = JSON.parse(i.body); if (down && b.method === "query" && b.params.request_type === "call_function") throw new Error("socket hang up"); return fetch(u, i); }) as any });
    await drain({ ...env.deps, rpc: flaky });
    const j = (await fdb.db.query("SELECT * FROM jobs WHERE dedupe_key LIKE 'tpl:vout:%'")).rows[0];
    expect(j.state, j.last_error).toBe("queued");                       // NOT failed
    expect(j.last_error).toMatch(/rpc unavailable/);
    expect(j.payload.createTx).toBeTruthy();                           // funding already happened
    expect((await fdb.db.query("SELECT state FROM budget_reservations WHERE job_id=$1", [j.id])).rows[0].state).toBe("spent");
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM markets WHERE template_id=$1", [t.id])).rows[0].n).toBe(0);
    down = false; await release(); await drain({ ...env.deps, rpc: flaky });
    expect((await fdb.db.query("SELECT state FROM jobs WHERE id=$1", [j.id])).rows[0].state).toBe("succeeded");
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key LIKE $1", [`create:${j.id}`])).rows[0].n).toBe(1);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM markets WHERE template_id=$1", [t.id])).rows[0].n).toBe(1);
  });

  it("verification distinguishes a confirmed mismatch (ok:false) from an unavailable RPC (throws, retryable)", async () => {
    const m = await setupMarket(chain, fdb.db, dep, token, "vmis", 3_600_000);
    const good = await verifyMarketOnChain(sbx.rpc, { contractId: m.id, tokenId: token, marketId: "mkt-1", resolverId: dep.accountId });
    expect(good.ok).toBe(true);
    const bad = await verifyMarketOnChain(sbx.rpc, { contractId: m.id, tokenId: token, marketId: "mkt-1", resolverId: "other.test.near", codeHashBase58: "11111111111111111111111111111111" });
    expect(bad.ok).toBe(false); expect(bad.problems.join()).toMatch(/resolver/);
    const flaky = new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { const b = JSON.parse(i.body); if (b.method === "query" && b.params.request_type === "call_function") throw new Error("timeout"); return fetch(u, i); }) as any });
    await expect(verifyMarketOnChain(flaky, { contractId: m.id, tokenId: token, marketId: "mkt-1" })).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it("per-key ordering: a higher-nonce transaction cannot overtake a delayed lower-nonce one from another worker", async () => {
    const target = await chain.createAccount("sink", 5n);
    let release_: () => void; const gate = new Promise<void>((r) => (release_ = r));
    class DelayedBroadcast extends TxExecutor { override async broadcast(row: JournalRow) { await gate; return super.broadcast(row); } }
    const exA = new DelayedBroadcast(fdb.db, sbx.rpc, 60_000, 200), exB = new TxExecutor(fdb.db, sbx.rpc, 60_000, 200);
    const A = exA.execute("ord-A", null, chain.root, target.accountId, [actions.transfer(1n)], "A");
    await sleep(800); // A is prepared (lower nonce) and stuck before broadcast
    const B = exB.execute("ord-B", null, chain.root, target.accountId, [actions.transfer(2n)], "B");
    await sleep(3500);
    const rows = (await fdb.db.query("SELECT op_key, nonce, state, tx_hash FROM tx_journal WHERE op_key IN ('ord-A','ord-B') ORDER BY nonce::numeric")).rows;
    expect(rows.map((r: any) => r.op_key)).toEqual(["ord-A", "ord-B"]);      // A really got the lower nonce
    expect(rows[1].state).toBe("prepared");                                   // B has NOT been broadcast while A is unresolved
    await expect(sbx.rpc.once("tx", { tx_hash: rows[1].tx_hash, sender_account_id: chain.root.accountId, wait_until: "NONE" })).rejects.toBeDefined(); // chain has never seen B
    release_!();
    const [oa, ob] = await Promise.all([A, B]);
    const final = (await fdb.db.query("SELECT op_key, state FROM tx_journal WHERE op_key IN ('ord-A','ord-B') ORDER BY nonce::numeric")).rows;
    expect(final.map((r: any) => r.state)).toEqual(["succeeded", "succeeded"]); // the lower nonce was NOT invalidated
    const ha = (await sbx.rpc.read("block", { block_id: oa.transaction_outcome.block_hash })).header.height, hb = (await sbx.rpc.read("block", { block_id: ob.transaction_outcome.block_hash })).header.height;
    expect(ha).toBeLessThanOrEqual(hb);
    const acct: any = await sbx.rpc.viewAccount(target.accountId);
    expect(BigInt(acct.amount)).toBe(5n * 10n ** 24n + 3n);
  });

  it("an unresolved transaction stays uncertain: there is no expiry-based 'safe to repeat' path", async () => {
    expect((TxExecutor.prototype as any).isExpiredUnincluded).toBeUndefined();
    const down = new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { const m = JSON.parse(i.body).method; if (m === "tx" || m === "EXPERIMENTAL_tx_status" || m === "send_tx") throw new Error("down"); return fetch(u, i); }) as any });
    const ex = new TxExecutor(fdb.db, down, 800, 100);
    const sink = await chain.createAccount("sink2", 2n);
    for (let i = 0; i < 3; i++) await expect(ex.execute("never-resolved", null, chain.root, sink.accountId, [actions.transfer(1n)], "u")).rejects.toMatchObject({ name: "TxUncertainError" });
    const rows = (await fdb.db.query("SELECT state, tx_hash FROM tx_journal WHERE op_key='never-resolved'")).rows;
    expect(rows.length).toBe(1); expect(rows[0].state).toBe("uncertain");
  });
});
