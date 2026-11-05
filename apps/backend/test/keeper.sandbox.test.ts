import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { actions } from "near-api-js";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { sandboxAvailable, startSandbox, type Sandbox } from "./helpers/sandbox.js";
import { TestChain } from "./helpers/chain.js";
import { keeperEnv, lagosTemplate } from "./helpers/keeper-env.js";
import { createTemplate, updateTemplate } from "../src/keeper/templates.js";
import { keeperPass } from "../src/keeper/loop.js";
import { claim, enqueue } from "../src/keeper/jobs.js";
import { Rpc } from "../src/near/rpc.js";
import { TxExecutor } from "../src/near/tx.js";
import { buildApp } from "../src/api/app.js";
import { loadApprovedArtifact } from "../src/keeper/artifacts.js";

const ok = sandboxAvailable() && (await dbAvailable());
describe.skipIf(!ok)("keeper: automatic market creation on Sandbox", () => {
  let sbx: Sandbox, fdb: Awaited<ReturnType<typeof freshDb>>, chain: TestChain, env: Awaited<ReturnType<typeof keeperEnv>>, deployerId: string, tokenId: string, tplId: string;
  const release = () => fdb.db.query("UPDATE jobs SET run_after=now(), lease_until=NULL WHERE state IN ('queued','uncertain','running')");

  beforeAll(async () => {
    sbx = await startSandbox(); fdb = await freshDb(); chain = new TestChain(sbx, fdb.db);
    const dep = await chain.createAccount("deployer", 300n);
    const secret = (dep.signer as any).key.toString();
    tokenId = await chain.deployToken(dep);
    deployerId = dep.accountId;
    env = await keeperEnv(sbx, fdb.db, chain, dep, secret, tokenId);
    const t = await createTemplate(fdb.db, lagosTemplate(deployerId, tokenId), deployerId, env.cfg, env.deps.providers);
    tplId = t.id;
  });
  afterAll(async () => { await sbx?.stop(); await fdb?.drop(); });

  it("a disabled template creates nothing; enabling it creates every due occurrence once (two independent markets)", async () => {
    let r = await keeperPass(env.deps, "w1");
    expect(r.scheduled).toEqual([]);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM markets")).rows[0].n).toBe(0);
    await updateTemplate(fdb.db, tplId, { enabled: true }, env.cfg, env.deps.providers);
    r = await keeperPass(env.deps, "w1");
    expect(r.scheduled.length).toBe(2);
    const jobs = (await fdb.db.query("SELECT state, last_error FROM jobs ORDER BY id")).rows;
    expect(jobs.map((j: any) => j.state), JSON.stringify(jobs)).toEqual(["succeeded", "succeeded"]);
    const again = await keeperPass(env.deps, "w1"); // idempotent scheduling
    expect(again.scheduled).toEqual([]);

    const ms = (await fdb.db.query("SELECT * FROM markets ORDER BY cutoff_ns")).rows;
    expect(ms.length).toBe(2);
    expect(new Set(ms.map((m: any) => m.contract_id)).size).toBe(2);
    expect(ms.every((m: any) => m.internal_market_id === "mkt-1")).toBe(true); // same internal id, different contracts
    expect(new Set(ms.map((m: any) => m.market_ref)).size).toBe(2);
    const art = loadApprovedArtifact(env.cfg.artifactsFile, "market-wasm", "1.0.0");
    for (const m of ms) {
      const acct = await sbx.rpc.viewAccount(m.contract_id);
      expect(acct.exists && acct.codeHash).toBe(art.codeHashBase58);
      const mv: any = await sbx.rpc.callView(m.contract_id, "get_market", { market_id: "mkt-1" });
      expect(mv.question).toBe(m.question); expect(mv.resolver_id).toBe(deployerId); expect(mv.split_cutoff_ns).toBe(m.cutoff_ns);
      expect(await sbx.rpc.callView(tokenId, "storage_balance_of", { account_id: m.contract_id })).not.toBeNull();
      const dr = (await fdb.db.query("SELECT * FROM deployment_records WHERE market_ref=$1", [m.market_ref])).rows[0];
      expect(dr.status).toBe("published"); expect(dr.artifact_sha256).toBe(art.sha256); expect(dr.tx_hashes.create_fund_deploy_init).toBeTruthy(); expect(dr.verification.ok).toBe(true);
      expect(dr.init_args.collateral_token).toBe(tokenId);
      // secret persisted server-side only, mode 0600
      const kr = (await fdb.db.query("SELECT secret_ref FROM key_refs WHERE account_id=$1", [m.contract_id])).rows[0];
      expect(statSync(join(env.ks, kr.secret_ref)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(dr)).not.toContain("ed25519:" + "secret");
    }
    // frontend API: honest empty books
    const app = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: env.cfg });
    const list = (await app.inject("/v1/markets")).json();
    expect(list.page.total).toBe(2);
    const book = (await app.inject(`/v1/markets/${ms[0].market_ref}/book`)).json();
    expect(book.yes.empty && book.no.empty).toBe(true); expect(book.contract.contractId).toBe(ms[0].contract_id);
    await app.close();
  });

  it("template budget caps further creation", async () => {
    await updateTemplate(fdb.db, tplId, { spec: lagosTemplate(deployerId, tokenId, { limits: { fundingYocto: (5n * 10n ** 24n).toString(), creationBudgetYocto: (10n * 10n ** 24n).toString(), minDeployerBalanceYocto: "0", maxPerDay: 10 }, schedule: { frequency: "daily", timezone: "Africa/Lagos", leadDays: 3, minLeadMinutes: 0 } }) }, env.cfg, env.deps.providers);
    // version 2 => fresh occurrence keys; budget (10 NEAR) already fully used by the 2 v1 jobs
    const r = await keeperPass(env.deps, "w1");
    expect(r.scheduled.length).toBeGreaterThan(0);
    const failed = (await fdb.db.query("SELECT state, last_error FROM jobs WHERE dedupe_key LIKE '%:v2:%'")).rows;
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((j: any) => j.state === "failed" && /budget/.test(j.last_error))).toBe(true);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM markets")).rows[0].n).toBe(2);
  });

  it("job claim is exclusive across workers", async () => {
    await enqueue(fdb.db, "noop", "excl-1", {});
    const [a, b] = await Promise.all([claim(fdb.db, "wa", 60, ["noop"]), claim(fdb.db, "wb", 60, ["noop"])]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });

  it("crash after the tx executed but before the job recorded it: resume reconciles, no duplicate account/funding/deploy", async () => {
    await fdb.db.query("UPDATE templates SET enabled=false WHERE id=$1", [tplId]);
    // new template (distinct slug) with one occurrence, crashing the worker right after the creation tx lands
    const t = await createTemplate(fdb.db, lagosTemplate(deployerId, tokenId, { slug: "crash-test", schedule: { frequency: "daily", timezone: "UTC", leadDays: 0, minLeadMinutes: 0 }, observation: null, cutoff: { offsetMinutesFromObservationStart: 24 * 60 - 1 }, resolution: { policy: "reviewed" } }), deployerId, env.cfg, env.deps.providers);
    await updateTemplate(fdb.db, t.id, { enabled: true }, env.cfg, env.deps.providers);
    class CrashingTx extends TxExecutor {
      crashed = false;
      override async execute(op: string, job: string | null, k: any, r: string, a: any, d: string) {
        const out = await super.execute(op, job, k, r, a, d);
        if (op.startsWith("create:") && !this.crashed) { this.crashed = true; throw new Error("simulated process crash after on-chain success"); }
        return out;
      }
    }
    const before = (await fdb.db.query("SELECT COUNT(*)::int n FROM markets")).rows[0].n;
    const crashing = { ...env.deps, tx: new CrashingTx(fdb.db, env.rpc, 60_000, 300) };
    await keeperPass(crashing, "w1");
    const job = (await fdb.db.query("SELECT * FROM jobs WHERE dedupe_key LIKE 'tpl:crash-test:%'")).rows[0];
    expect(job.state).toBe("queued"); expect(job.payload.createTx).toBeUndefined();
    const intent = job.payload.intent;
    const acctBefore = await sbx.rpc.viewAccount(intent.accountName);
    expect(acctBefore.exists).toBe(true); // funded + deployed already
    // "restart": new worker, new executor instance
    await release();
    await keeperPass(env.deps, "w2");
    const done = (await fdb.db.query("SELECT * FROM jobs WHERE id=$1", [job.id])).rows[0];
    expect(done.state, done.last_error).toBe("succeeded");
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key=$1", [`create:${job.id}`])).rows[0].n).toBe(1);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM key_refs WHERE account_id=$1", [intent.accountName])).rows[0].n).toBe(1);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM markets")).rows[0].n).toBe(before + 1);
    const acct: any = await sbx.rpc.viewAccount(intent.accountName);
    expect(BigInt(acct.amount)).toBeLessThanOrEqual(5n * 10n ** 24n); // funded exactly once
    expect(BigInt(acct.amount)).toBeGreaterThan(4n * 10n ** 24n);
  });

  it("successful execution followed by unavailable status reads: job goes uncertain, no new signed tx; resumes to success", async () => {
    await fdb.db.query("UPDATE templates SET enabled=false WHERE slug='crash-test'");
    const t = await createTemplate(fdb.db, lagosTemplate(deployerId, tokenId, { slug: "flaky-test", schedule: { frequency: "daily", timezone: "UTC", leadDays: 0, minLeadMinutes: 0 }, observation: null, cutoff: { offsetMinutesFromObservationStart: 24 * 60 - 1 } }), deployerId, env.cfg, env.deps.providers);
    await updateTemplate(fdb.db, t.id, { enabled: true }, env.cfg, env.deps.providers);
    let down = true;
    const flaky = new Rpc({ url: sbx.rpcUrl, retries: 0, fetchImpl: (async (u: any, i: any) => { const m = JSON.parse(i.body).method; if (down && (m === "tx" || m === "EXPERIMENTAL_tx_status")) throw new Error("socket hang up"); return fetch(u, i); }) as any });
    const d2 = { ...env.deps, tx: new TxExecutor(fdb.db, flaky, 1500, 200) };
    await keeperPass(d2, "w1");
    const job = (await fdb.db.query("SELECT * FROM jobs WHERE dedupe_key LIKE 'tpl:flaky-test:%'")).rows[0];
    expect(job.state).toBe("uncertain");
    const j1 = (await fdb.db.query("SELECT tx_hash, state FROM tx_journal WHERE op_key=$1", [`create:${job.id}`])).rows;
    expect(j1.length).toBe(1);
    // ops surface shows the uncertainty
    const app = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: env.cfg });
    const ops = (await app.inject("/v1/ops/status")).json();
    expect(ops.transactions.unresolvedCount).toBeGreaterThanOrEqual(1);
    await app.close();
    down = false; await release();
    await keeperPass(d2, "w1");
    const after = (await fdb.db.query("SELECT state FROM jobs WHERE id=$1", [job.id])).rows[0];
    expect(after.state).toBe("succeeded");
    const j2 = (await fdb.db.query("SELECT tx_hash FROM tx_journal WHERE op_key=$1", [`create:${job.id}`])).rows;
    expect(j2).toEqual([{ tx_hash: j1[0].tx_hash }]); // same single signed transaction throughout
  });
});
