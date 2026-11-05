import { actions } from "near-api-js";
import type { MarketView } from "@nearodds/types";
import type { Db } from "../db/index.js";
import { enqueue, JobFailed, RetryLater, type JobCtx } from "./jobs.js";
import type { KeeperDeps } from "./create-market.js";

export interface ProviderMarket { marketRef: string; question: string; resolutionSource: string; observationStartNs: string | null; observationEndNs: string | null }
export interface ProviderResult { status: "ok" | "pending" | "ambiguous"; outcome?: "Yes" | "No"; evidenceRef?: string; observedAt?: Date; note?: string }
/** A source provider with a deterministic decision rule. Missing/late/ambiguous data MUST return pending/ambiguous, never "No". */
export interface SourceProvider { id: string; decisionRule: string; fetch(m: ProviderMarket, now: Date): Promise<ProviderResult> }

export class ProviderRegistry {
  private m = new Map<string, SourceProvider>();
  register(p: SourceProvider) { this.m.set(p.id, p); return this; }
  get(id: string) { return this.m.get(id) ?? null; }
  ids() { return [...this.m.keys()]; }
}
/**
 * Production default: NO automatic providers. NiMet publishes a report but no API endpoint is assumed here; the Lagos market
 * resolves through the reviewed-evidence workflow. Register a provider only after it is implemented AND tested.
 */
export const defaultProviders = () => new ProviderRegistry();

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);

export interface ProposalInput { marketRef: string; outcome: "Yes" | "No"; evidenceRef: string; evidenceNote?: string; retrievedAt: Date; proposedBy: string; provider?: string | null; decision?: "pending" | "approved" }

export class ResolutionError extends Error { constructor(readonly code: string, msg: string) { super(msg); } }

export async function proposeResolution(db: Db, i: ProposalInput, now = new Date()) {
  const m = (await db.query("SELECT * FROM markets WHERE market_ref=$1", [i.marketRef])).rows[0];
  if (!m) throw new ResolutionError("not_found", "market not found");
  if (m.contract_status === "Resolved") throw new ResolutionError("already_resolved", "market is already resolved on chain");
  if (i.outcome !== "Yes" && i.outcome !== "No") throw new ResolutionError("bad_outcome", "outcome must be Yes or No");
  const ev = i.evidenceRef.trim();
  if (!ev || bytes(ev) > 512) throw new ResolutionError("bad_evidence", "evidence reference must be 1 to 512 bytes");
  if (Number.isNaN(i.retrievedAt.getTime()) || i.retrievedAt.getTime() > now.getTime() + 5 * 60_000) throw new ResolutionError("bad_retrieved_at", "retrievedAt cannot be in the future");
  const obsEnd = m.observation_end_ns ? nsToMs(m.observation_end_ns) : nsToMs(m.cutoff_ns);
  if (i.retrievedAt.getTime() < obsEnd) throw new ResolutionError("evidence_too_early", `evidence was retrieved before the observation period ended (${new Date(obsEnd).toISOString()}); it cannot establish the outcome`);
  try {
    const r = await db.query(
      `INSERT INTO resolution_proposals(market_ref, outcome, evidence_ref, evidence_note, observation_start_ns, observation_end_ns, retrieved_at, proposed_by, provider, decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.marketRef, i.outcome, ev, i.evidenceNote ?? null, m.observation_start_ns, m.observation_end_ns, i.retrievedAt, i.proposedBy, i.provider ?? null, i.decision ?? "pending"]);
    await db.query("UPDATE resolution_watch SET evidence_state = $2, note=NULL WHERE market_ref=$1", [i.marketRef, i.decision === "approved" ? "approved" : "proposed"]);
    return r.rows[0];
  } catch (e: any) {
    if (e.code === "23505") throw new ResolutionError("proposal_exists", "a live (pending/approved/submitted) proposal already exists for this market; reject it first");
    throw e;
  }
}

export async function reviewProposal(db: Db, id: string, reviewer: string, decision: "approved" | "rejected", note: string | undefined, adminCount: number) {
  const p = (await db.query("SELECT * FROM resolution_proposals WHERE id=$1", [id])).rows[0];
  if (!p) throw new ResolutionError("not_found", "proposal not found");
  if (p.decision !== "pending") throw new ResolutionError("not_pending", `proposal is already ${p.decision}`);
  if (decision === "approved" && p.proposed_by === reviewer && adminCount > 1) throw new ResolutionError("self_approval", "a second administrator must approve this proposal");
  const r = await db.query("UPDATE resolution_proposals SET decision=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1 AND decision='pending' RETURNING *", [id, decision, reviewer, note ?? null]);
  await db.query("UPDATE resolution_watch SET evidence_state=$2 WHERE market_ref=$1", [p.market_ref, decision === "approved" ? "approved" : "missing"]);
  return r.rows[0];
}

/** Track the three conditions separately, call providers for automatic templates, and enqueue submission only when all hold. */
export async function resolutionTick(d: KeeperDeps & { providers: ProviderRegistry }, nowMs = (d.now ?? Date.now)()) {
  const { db } = d;
  await db.query("INSERT INTO resolution_watch(market_ref) SELECT market_ref FROM markets WHERE contract_status <> 'Resolved' ON CONFLICT DO NOTHING");
  const rows = (await db.query("SELECT m.*, w.policy, w.provider, w.evidence_state FROM markets m JOIN resolution_watch w USING (market_ref) WHERE m.contract_status <> 'Resolved'")).rows;
  const now = BigInt(nowMs) * 1_000_000n;
  const enq: string[] = [];
  for (const m of rows) {
    const cutoffPassed = now >= BigInt(m.cutoff_ns);
    const obsComplete = cutoffPassed && (m.observation_end_ns === null || now >= BigInt(m.observation_end_ns));
    await db.query("UPDATE resolution_watch SET cutoff_passed=$2, observation_complete=$3, last_checked_at=now() WHERE market_ref=$1", [m.market_ref, cutoffPassed, obsComplete]);
    if (!obsComplete) continue;
    let live = (await db.query("SELECT * FROM resolution_proposals WHERE market_ref=$1 AND decision IN ('pending','approved','submitted')", [m.market_ref])).rows[0];
    if (!live && m.policy === "automatic" && m.provider) {
      const prov = d.providers.get(m.provider);
      if (!prov) { await db.query("UPDATE resolution_watch SET evidence_state='provider_error', note=$2 WHERE market_ref=$1", [m.market_ref, `provider ${m.provider} is not registered`]); continue; }
      try {
        const r = await prov.fetch({ marketRef: m.market_ref, question: m.question, resolutionSource: m.resolution_source, observationStartNs: m.observation_start_ns, observationEndNs: m.observation_end_ns }, new Date(nowMs));
        if (r.status === "ok" && r.outcome && r.evidenceRef) {
          live = await proposeResolution(db, { marketRef: m.market_ref, outcome: r.outcome, evidenceRef: r.evidenceRef, retrievedAt: r.observedAt ?? new Date(nowMs), proposedBy: `provider:${prov.id}`, provider: prov.id, decision: "approved", evidenceNote: `rule: ${prov.decisionRule}` }, new Date(nowMs));
        } else await db.query("UPDATE resolution_watch SET evidence_state=$2, note=$3 WHERE market_ref=$1", [m.market_ref, r.status === "ambiguous" ? "ambiguous" : "missing", r.note ?? (r.status === "pending" ? "evidence not yet available" : "ambiguous evidence: needs review")]);
      } catch (e) { await db.query("UPDATE resolution_watch SET evidence_state='provider_error', note=$2 WHERE market_ref=$1", [m.market_ref, (e as Error).message.slice(0, 300)]); }
    }
    if (live && live.decision === "approved") {
      const j = await enqueue(db, "resolve_market", `resolve:${m.market_ref}`, { marketRef: m.market_ref, proposalId: live.id });
      if (j.created) { enq.push(m.market_ref); await db.query("UPDATE resolution_proposals SET job_id=$2 WHERE id=$1", [live.id, j.id]); }
    }
  }
  return { enqueued: enq };
}

export async function resolveMarketJob(d: KeeperDeps, c: JobCtx): Promise<void> {
  const { db, rpc, signers, tx } = d;
  const now = BigInt((d.now ?? Date.now)()) * 1_000_000n;
  const p = c.job.payload;
  const m = (await db.query("SELECT * FROM markets WHERE market_ref=$1", [p.marketRef])).rows[0];
  const prop = (await db.query("SELECT * FROM resolution_proposals WHERE id=$1", [p.proposalId])).rows[0];
  if (!m || !prop) throw new JobFailed("market or proposal missing");
  if (prop.decision !== "approved" && prop.decision !== "submitted") throw new JobFailed(`proposal is ${prop.decision}, not approved`);
  const journal = await tx.getJournal(`resolve:${m.market_ref}`);
  const chain = await rpc.callView<MarketView>(m.contract_id, "get_market", { market_id: m.internal_market_id });
  if (chain.resolved) {
    await db.query("UPDATE resolution_proposals SET decision='submitted' WHERE id=$1", [prop.id]);
    await db.query("UPDATE resolution_watch SET evidence_state='submitted' WHERE market_ref=$1", [m.market_ref]);
    if (chain.resolution && chain.resolution.outcome !== prop.outcome) throw new JobFailed(`market already resolved on chain as ${chain.resolution.outcome} (proposal said ${prop.outcome})`);
    return;
  }
  // Separate conditions, all required: contract-level cutoff, observation complete, evidence retrieved after observation, authorized signer.
  if (!journal) {
    if (!chain.awaiting_resolution) throw new RetryLater("trading cutoff has not passed on chain yet", 60_000);
    if (m.observation_end_ns && now < BigInt(m.observation_end_ns)) throw new RetryLater("observation period has not ended", 60_000);
    if (new Date(prop.retrieved_at).getTime() < Number(BigInt(m.observation_end_ns ?? m.cutoff_ns) / 1_000_000n)) throw new JobFailed("evidence predates the end of the observation period");
  }
  const signer = await signers.reg.get(m.resolver_id);
  if (!signer) throw new RetryLater(`resolver signer ${m.resolver_id} is not available; configure RESOLVER_CREDENTIALS_FILE`, 5 * 60_000);
  const out = await tx.execute(`resolve:${m.market_ref}`, c.job.id, signer, m.contract_id,
    [actions.functionCall("resolve_market", { market_id: m.internal_market_id, outcome: prop.outcome, evidence: prop.evidence_ref }, 100n * 10n ** 12n, 1n)], `resolve ${m.market_ref} ${prop.outcome}`);
  await db.query("UPDATE resolution_proposals SET decision='submitted' WHERE id=$1", [prop.id]);
  await db.query("UPDATE resolution_watch SET evidence_state='submitted' WHERE market_ref=$1", [m.market_ref]);
  await c.patch({ resolveTx: out.transaction.hash });
}
