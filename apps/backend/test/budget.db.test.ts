import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { BudgetError, markSpent, recordRecovery, releaseIfUnsent, reserveBudget } from "../src/keeper/budget.js";
import { enqueue } from "../src/keeper/jobs.js";

const ok = await prereq();
const NEAR = 10n ** 24n;
describe.skipIf(!ok)("creation budget and capacity reservation", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>;
  const job = async (k: string) => (await enqueue(fdb.db, "create_market", k, {})).id;
  const committed = async (t: string) => BigInt((await fdb.db.query("SELECT COALESCE(SUM(GREATEST(CASE WHEN state='spent' THEN spent_yocto ELSE reserved_yocto END - recovered_yocto,0)),0) s FROM budget_reservations WHERE template_id=$1 AND state<>'released'", [t])).rows[0].s);
  beforeAll(async () => { fdb = await freshDb(); });
  afterAll(async () => { await fdb?.drop(); });

  it("two concurrent jobs, remaining budget fits only one: exactly one reserves", async () => {
    const limits = { creationBudgetYocto: (7n * NEAR).toString(), maxPerDay: 10 };
    const [a, b] = [await job("c1"), await job("c2")];
    const res = await Promise.allSettled([reserveBudget(fdb.db, "1", a, 5n * NEAR, limits), reserveBudget(fdb.db, "1", b, 5n * NEAR, limits)]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(BudgetError); expect(rej.reason.code).toBe("creation_budget");
    expect(await committed("1")).toBe(5n * NEAR);
  });
  it("daily capacity is enforced atomically too", async () => {
    const limits = { creationBudgetYocto: (1000n * NEAR).toString(), maxPerDay: 2 };
    const ids = await Promise.all(["d1", "d2", "d3", "d4"].map(job));
    const res = await Promise.allSettled(ids.map((id) => reserveBudget(fdb.db, "2", id, NEAR, limits)));
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(2);
    expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("creation_limit");
  });
  it("is idempotent per job (resume does not double reserve)", async () => {
    const limits = { creationBudgetYocto: (6n * NEAR).toString(), maxPerDay: 10 };
    const j = await job("i1");
    await reserveBudget(fdb.db, "3", j, 5n * NEAR, limits); await reserveBudget(fdb.db, "3", j, 5n * NEAR, limits);
    expect(await committed("3")).toBe(5n * NEAR);
  });
  it("a failed job keeps funding that may have been transferred; releases only when nothing can have been sent", async () => {
    const limits = { creationBudgetYocto: (100n * NEAR).toString(), maxPerDay: 10 };
    const unsent = await job("f1"), pending = await job("f2"), sent = await job("f3"), failedTx = await job("f4");
    for (const j of [unsent, pending, sent, failedTx]) await reserveBudget(fdb.db, "4", j, 5n * NEAR, limits);
    const jr = (j: string, state: string) => fdb.db.query("INSERT INTO tx_journal(job_id, op_key, signer_id, public_key, receiver_id, description, nonce, block_hash, tx_hash, signed_tx_b64, state) VALUES ($1,$2,'s','k','r','d',1,'b',$3,'x',$4)", [j, `create:${j}`, "h" + j, state]);
    await jr(pending, "uncertain");            // outcome unknown: funding may have moved
    await jr(sent, "succeeded"); await markSpent(fdb.db, sent, 5n * NEAR);
    await jr(failedTx, "failed");              // confirmed failed on chain: nothing moved
    expect(await releaseIfUnsent(fdb.db, unsent)).toBe(true);
    expect(await releaseIfUnsent(fdb.db, pending)).toBe(false);
    expect(await releaseIfUnsent(fdb.db, sent)).toBe(false);
    expect(await releaseIfUnsent(fdb.db, failedTx)).toBe(true);
    expect(await committed("4")).toBe(10n * NEAR); // pending + sent still counted
    // confirmed recovery frees budget separately from job status
    await recordRecovery(fdb.db, sent, 3n * NEAR);
    expect(await committed("4")).toBe(7n * NEAR);
    const row = (await fdb.db.query("SELECT state, spent_yocto, recovered_yocto FROM budget_reservations WHERE job_id=$1", [sent])).rows[0];
    expect([row.state, row.spent_yocto, row.recovered_yocto]).toEqual(["spent", (5n * NEAR).toString(), (3n * NEAR).toString()]);
  });
});
