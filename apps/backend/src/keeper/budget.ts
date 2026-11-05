import type { Db } from "../db/index.js";
import { withTx } from "../db/index.js";

export class BudgetError extends Error { constructor(readonly code: "creation_limit" | "creation_budget", msg: string) { super(msg); } }

/**
 * Atomic reservation of creation capacity and funding for one job.
 * Serialised per template (advisory lock), idempotent per job. committed(job) = spent if funding may have left the deployer,
 * else reserved; minus funds an operator confirmed recovered. A failed job releases ONLY if nothing could have been sent.
 */
export async function reserveBudget(db: Db, templateId: string, jobId: string, funding: bigint, limits: { creationBudgetYocto: string; maxPerDay: number }): Promise<void> {
  await withTx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`budget:${templateId}`]);
    const mine = (await c.query("SELECT state FROM budget_reservations WHERE job_id=$1", [jobId])).rows[0];
    if (mine && mine.state !== "released") return; // already reserved/spent for this job
    const day = (await c.query("SELECT COUNT(*)::int n FROM budget_reservations WHERE template_id=$1 AND state<>'released' AND job_id<>$2 AND created_at > now() - interval '24 hours'", [templateId, jobId])).rows[0].n;
    if (day >= limits.maxPerDay) throw new BudgetError("creation_limit", `template creation limit reached (${limits.maxPerDay} per 24h)`);
    const committed = BigInt((await c.query(
      `SELECT COALESCE(SUM(GREATEST(CASE WHEN state='spent' THEN spent_yocto ELSE reserved_yocto END - recovered_yocto, 0)),0) s
       FROM budget_reservations WHERE template_id=$1 AND state<>'released' AND job_id<>$2`, [templateId, jobId])).rows[0].s);
    if (committed + funding > BigInt(limits.creationBudgetYocto)) throw new BudgetError("creation_budget", `template creation budget exhausted (${committed} committed + ${funding} > ${limits.creationBudgetYocto} yocto)`);
    if (mine) await c.query("UPDATE budget_reservations SET state='reserved', reserved_yocto=$2, updated_at=now() WHERE job_id=$1", [jobId, funding.toString()]);
    else await c.query("INSERT INTO budget_reservations(job_id, template_id, reserved_yocto, state) VALUES ($1,$2,$3,'reserved')", [jobId, templateId, funding.toString()]);
  });
}

/** The creation transaction succeeded: the funding has left the deployer. Never released automatically after this. */
export async function markSpent(db: Db, jobId: string, amount: bigint) {
  await db.query("UPDATE budget_reservations SET state='spent', spent_yocto=$2, updated_at=now() WHERE job_id=$1 AND state<>'released'", [jobId, amount.toString()]);
}

/** Release only when no creation transaction can have moved funds (never signed, or confirmed failed). */
export async function releaseIfUnsent(db: Db, jobId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE budget_reservations b SET state='released', updated_at=now()
     WHERE b.job_id=$1 AND b.state='reserved'
       AND NOT EXISTS (SELECT 1 FROM tx_journal t WHERE t.op_key = 'create:' || b.job_id AND t.state <> 'failed')`, [jobId]);
  return (r.rowCount ?? 0) > 0;
}

/** An operator confirmed `yocto` was recovered from the market account (e.g. via a transfer back). Frees that much budget. */
export async function recordRecovery(db: Db, jobId: string, yocto: bigint) {
  const r = await db.query("UPDATE budget_reservations SET recovered_yocto = LEAST(recovered_yocto + $2::numeric, GREATEST(spent_yocto, reserved_yocto)), updated_at=now() WHERE job_id=$1 RETURNING recovered_yocto", [jobId, yocto.toString()]);
  if (!r.rowCount) throw new Error("no reservation for job " + jobId);
  return r.rows[0].recovered_yocto as string;
}
