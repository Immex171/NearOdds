import type { Db } from "../db/index.js";
import { RpcUnavailableError } from "../near/rpc.js";
import { TxBlockedError, TxFailedError, TxUncertainError } from "../near/tx.js";
import { releaseIfUnsent } from "./budget.js";

export type JobState = "queued" | "running" | "uncertain" | "succeeded" | "failed" | "cancelled";
export interface Job { id: string; kind: string; dedupe_key: string; state: JobState; payload: any; step: string | null; attempts: number; owner: string | null }

/** Throw to try again later without failing the job. */
export class RetryLater extends Error { constructor(msg: string, readonly delayMs = 30_000) { super(msg); } }
/** Throw to fail the job permanently (nothing irreversible is half-done, or it needs a human). */
export class JobFailed extends Error { constructor(msg: string) { super(msg); } }

export async function enqueue(db: Db, kind: string, dedupeKey: string, payload: object): Promise<{ id: string; created: boolean }> {
  const r = await db.query("INSERT INTO jobs(kind, dedupe_key, state, payload) VALUES ($1,$2,'queued',$3) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id", [kind, dedupeKey, JSON.stringify(payload)]);
  if (r.rowCount) return { id: r.rows[0].id, created: true };
  return { id: (await db.query("SELECT id FROM jobs WHERE dedupe_key=$1", [dedupeKey])).rows[0].id, created: false };
}

/** Exclusive ownership: SKIP LOCKED + lease. A crashed worker's lease expires and the job is resumed (not restarted blindly). */
export async function claim(db: Db, workerId: string, leaseSeconds = 60, kinds?: string[]): Promise<Job | null> {
  const r = await db.query(
    `UPDATE jobs SET state = CASE WHEN state='uncertain' THEN 'uncertain' ELSE 'running' END, owner=$1, lease_until=now() + make_interval(secs => $2), attempts=attempts+1, updated_at=now()
     WHERE id = (SELECT id FROM jobs WHERE state IN ('queued','uncertain','running') AND run_after <= now() AND (lease_until IS NULL OR lease_until < now())
                 AND ($3::text[] IS NULL OR kind = ANY($3)) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [workerId, leaseSeconds, kinds ?? null]);
  return r.rows[0] ?? null;
}

export async function patchPayload(db: Db, job: Job, patch: object, step?: string) {
  const r = await db.query("UPDATE jobs SET payload = payload || $3::jsonb, step=COALESCE($4, step), updated_at=now() WHERE id=$1 AND owner=$2 RETURNING payload", [job.id, job.owner, JSON.stringify(patch), step ?? null]);
  if (!r.rowCount) throw new Error(`job ${job.id}: lease lost`);
  job.payload = r.rows[0].payload; if (step) job.step = step;
}

async function settle(db: Db, job: Job, state: JobState, err: string | null, delayMs = 0) {
  if (state === "failed") await releaseIfUnsent(db, job.id).catch(() => {}); // frees budget only if no funds can have moved
  await db.query("UPDATE jobs SET state=$3, last_error=$4, run_after=now() + make_interval(secs => $5), lease_until=NULL, owner=NULL, updated_at=now() WHERE id=$1 AND owner=$2", [job.id, job.owner, state, err, delayMs / 1000]);
}

export interface JobCtx { job: Job; db: Db; patch: (p: object, step?: string) => Promise<void> }
export type Handler = (c: JobCtx) => Promise<void>;
const MAX_ATTEMPTS = 60;

/** Claim and run one job. Returns false when idle. */
export async function runOne(db: Db, workerId: string, handlers: Record<string, Handler>, kinds?: string[]): Promise<boolean> {
  const job = await claim(db, workerId, 60, kinds);
  if (!job) return false;
  const h = handlers[job.kind];
  const timer = setInterval(() => { db.query("UPDATE jobs SET lease_until=now() + interval '60 seconds' WHERE id=$1 AND owner=$2", [job.id, job.owner]).catch(() => {}); }, 15_000);
  try {
    if (!h) throw new JobFailed(`no handler for ${job.kind}`);
    await h({ job, db, patch: (p, s) => patchPayload(db, job, p, s) });
    await settle(db, job, "succeeded", null);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (e instanceof JobFailed || e instanceof TxFailedError) await settle(db, job, "failed", msg);
    else if (e instanceof TxUncertainError) await settle(db, job, "uncertain", msg, 60_000);
    else if (e instanceof TxBlockedError) await settle(db, job, job.state === "uncertain" ? "uncertain" : "queued", msg, 10_000);
    else if (e instanceof RetryLater) await settle(db, job, "queued", msg, e.delayMs);
    else if (e instanceof RpcUnavailableError) await settle(db, job, job.attempts > MAX_ATTEMPTS ? "failed" : (job.state === "uncertain" ? "uncertain" : "queued"), `rpc unavailable: ${msg}`, 30_000);
    else await settle(db, job, job.attempts > 8 ? "failed" : "queued", `unexpected: ${msg}`, 15_000 * job.attempts);
  } finally { clearInterval(timer); }
  return true;
}
