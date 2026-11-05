import { createHash } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import type { Rpc } from "../near/rpc.js";
import { RpcUnavailableError } from "../near/rpc.js";
import type { TxExecutor } from "../near/tx.js";
import type { SigningKey } from "../near/keystore.js";
import { IdentityError, readSnapshot, summarize, type FullSnapshot, type MarketRow } from "./chain.js";
import { slotOf, type BotConfig } from "./config.js";
import { decide, type Action, type Decision } from "./decide.js";
import { loadBot, loadFacts, pendingOps, proposeOps, ProposalConflict, reconcileQuotes, recoverBotSpend, runOperation, type BotRow, type OpRow } from "./ops.js";
import { executionNetworkAllowed } from "./signer.js";
import { refreshBotState } from "./state.js";
import type { Reason } from "./strategy.js";

export interface BotDeps {
  cfg: Config; db: Db; rpc: Rpc; tx: TxExecutor;
  signer: (bot: Pick<BotRow, "account_id" | "credentials_env">) => Promise<SigningKey | null>;
  now?: () => number;
}
export interface CycleResult { status: "done" | "locked" | "disabled" | "error"; iterations: number; outcome?: string; opIds: string[]; reasons: Reason[] }

const serial = (a: Action) => JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** Execution needs: execute mode, the environment flag, an allowed network matching the worker's, and a verified signer. */
export async function executionAllowed(d: BotDeps, bot: BotRow): Promise<{ ok: boolean; why: string | null }> {
  if (bot.mode !== "execute") return { ok: false, why: "paper mode" };
  if (!d.cfg.bot.executionEnabled) return { ok: false, why: "BOT_EXECUTION_ENABLED is not set" };
  if (!executionNetworkAllowed(bot.network) || bot.network !== d.cfg.network) return { ok: false, why: `execution is allowed only on Sandbox or testnet matching the worker network (bot ${bot.network}, worker ${d.cfg.network})` };
  if (!(await d.signer(bot))) return { ok: false, why: "bot signer is missing or not verified" };
  return { ok: true, why: null };
}

async function recordDecision(db: Db, bot: BotRow, marketRef: string, outcome: string, dec: { actions: Action[]; reasons: Reason[] }, opIds: string[], block: number | null, mode: string) {
  // do not flood history with identical "nothing to do" cycles
  const sig = createHash("sha1").update(JSON.stringify([outcome, dec.reasons.map((r) => r.code), dec.actions.map(serial), opIds])).digest("hex");
  const last = (await db.query("SELECT id, outcome, reasons, actions, op_ids FROM bot_decisions WHERE bot_id=$1 AND market_ref=$2 ORDER BY id DESC LIMIT 1", [bot.id, marketRef])).rows[0];
  if (last && opIds.length === 0 && createHash("sha1").update(JSON.stringify([last.outcome, last.reasons.map((r: Reason) => r.code), last.actions.map((a: any) => JSON.stringify(a)), last.op_ids])).digest("hex") === sig) return last.id as string;
  const r = await db.query("INSERT INTO bot_decisions(bot_id, market_ref, config_version, mode, outcome, actions, reasons, op_ids, block_height) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [bot.id, marketRef, bot.config_version, mode, outcome, JSON.stringify(dec.actions, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), JSON.stringify(dec.reasons), JSON.stringify(opIds), block]);
  return r.rows[0].id as string;
}

async function upsertStatus(db: Db, bot: BotRow, marketRef: string, snap: FullSnapshot | null, needsFunding: boolean, decisionId: string | null) {
  await db.query(
    `INSERT INTO bot_market_status(bot_id, market_ref, last_cycle_at, last_chain_read_at, block_height, snapshot, needs_funding, last_decision_id)
     VALUES ($1,$2,now(),$3,$4,$5,$6,$7)
     ON CONFLICT (bot_id, market_ref) DO UPDATE SET last_cycle_at=now(), last_chain_read_at=COALESCE($3, bot_market_status.last_chain_read_at), block_height=COALESCE($4, bot_market_status.block_height),
       snapshot=COALESCE($5, bot_market_status.snapshot), needs_funding=$6, last_decision_id=COALESCE($7, bot_market_status.last_decision_id)`,
    [bot.id, marketRef, snap ? new Date(snap.readAt) : null, snap?.blockHeight ?? null, snap ? JSON.stringify(summarize(snap)) : null, needsFunding, decisionId]);
}

/**
 * One decision cycle for (bot, market). Exactly one owner at a time (session advisory lock + the job lease).
 * Loop: resume in-flight ops -> coherent chain snapshot -> reconcile -> decide -> propose (atomic reservation) -> execute -> refresh.
 */
export async function runCycle(d: BotDeps, botIdOrSlug: string, marketRef: string): Promise<CycleResult> {
  const { db } = d;
  let bot = await loadBot(db, botIdOrSlug);
  if (!bot || bot.desired_state === "disabled") return { status: "disabled", iterations: 0, opIds: [], reasons: [] };
  const lock = await db.connect();
  const lockKey = `botmkt:${bot.id}:${marketRef}`;
  if (!(await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) ok", [lockKey])).rows[0].ok) { lock.release(); return { status: "locked", iterations: 0, opIds: [], reasons: [] }; }
  const result: CycleResult = { status: "done", iterations: 0, opIds: [], reasons: [] };
  try {
    const market = (await db.query("SELECT market_ref, network, contract_id, internal_market_id, token_id, cutoff_ns FROM markets WHERE market_ref=$1", [marketRef])).rows[0] as MarketRow | undefined;
    if (!market || market.network !== bot.network) { result.status = "error"; result.reasons.push({ code: "market_unavailable", message: "market not in the registry for this network" }); return result; }
    for (let iter = 0; iter < 6; iter++) {
      result.iterations = iter + 1;
      bot = (await loadBot(db, bot.id))!;
      const cfg: BotConfig = bot.config;
      const exec = await executionAllowed(d, bot);
      let lastSnap: FullSnapshot | null = null;

      // 1. resume anything in flight (same op key => same signed bytes)
      if (exec.ok) {
        for (const op of await pendingOps(db, bot.id, marketRef)) {
          const r = await runOperation({ db, tx: d.tx, signer: d.signer }, bot, market, op);
          if (r === "uncertain" || r === "blocked") {
            const reasons = [{ code: r === "uncertain" ? "uncertain_operation" : "operation_blocked", message: r === "uncertain" ? `operation ${op.op_key} has an unknown outcome; it will be reconciled, never repeated` : `operation ${op.op_key} is waiting (earlier transactions of this key, or RPC)` }];
            const id = await recordDecision(db, bot, marketRef, "noop", { actions: [], reasons }, [], null, bot.mode);
            await upsertStatus(db, bot, marketRef, null, false, id); result.reasons = reasons; result.outcome = "noop";
            return result;
          }
        }
      }

      // 2. coherent snapshot
      let snap: FullSnapshot;
      try { snap = await readSnapshot(d.rpc, market, bot.account_id); }
      catch (e) {
        const reasons: Reason[] = [{ code: e instanceof IdentityError ? "identity_mismatch" : "chain_unavailable", message: (e as Error).message }];
        if (!(e instanceof RpcUnavailableError) && !(e instanceof IdentityError)) throw e;
        const id = await recordDecision(db, bot, marketRef, "skipped", { actions: [], reasons }, [], null, bot.mode);
        await upsertStatus(db, bot, marketRef, null, false, id); result.reasons = reasons; result.outcome = "skipped";
        return result;
      }
      lastSnap = snap;
      await reconcileQuotes(db, bot, marketRef, snap.offers, (o) => slotOf(o.outcome, o.side));
      await recoverBotSpend(db, bot.id);

      // 3. decide
      const facts = await loadFacts(db, bot, marketRef);
      if (!exec.ok && bot.mode === "execute") facts.hasPendingOps = facts.hasPendingOps; // unchanged; execution gating reported below
      const dec: Decision = decide({ nowMs: (d.now ?? Date.now)(), snap, facts, cfg, marketRef });
      if (!exec.ok && bot.mode === "execute") dec.reasons.push({ code: "execution_unavailable", message: exec.why ?? "execution unavailable" });

      // paper (or execution unavailable): record only
      if (!exec.ok) {
        const id = await recordDecision(db, bot, marketRef, dec.actions.length ? "paper" : dec.outcome, dec, [], snap.blockHeight, bot.mode);
        await upsertStatus(db, bot, marketRef, snap, dec.needsFunding, id);
        result.outcome = dec.actions.length ? "paper" : dec.outcome; result.reasons = dec.reasons;
        break;
      }

      if (!dec.actions.length) {
        const id = await recordDecision(db, bot, marketRef, dec.outcome, dec, [], snap.blockHeight, bot.mode);
        await upsertStatus(db, bot, marketRef, snap, dec.needsFunding, id);
        result.outcome = dec.outcome; result.reasons = dec.reasons;
        break;
      }

      // 4. atomic reservation, then execute sequentially
      let ops: OpRow[];
      try { ops = await proposeOps(db, bot, market, bot.config_version, dec.actions, snap); }
      catch (e) {
        if (!(e instanceof ProposalConflict)) throw e;
        const reasons = [...dec.reasons, { code: e.code, message: e.message }];
        const id = await recordDecision(db, bot, marketRef, "skipped", { actions: dec.actions, reasons }, [], snap.blockHeight, bot.mode);
        await upsertStatus(db, bot, marketRef, snap, dec.needsFunding, id); result.outcome = "skipped"; result.reasons = reasons;
        break;
      }
      const decisionId = await recordDecision(db, bot, marketRef, "acted", dec, ops.map((o) => o.id), snap.blockHeight, bot.mode);
      await upsertStatus(db, bot, marketRef, snap, dec.needsFunding, decisionId);
      result.opIds.push(...ops.map((o) => o.id)); result.outcome = "acted";
      let allConfirmed = true;
      for (const op of ops) {
        const r = await runOperation({ db, tx: d.tx, signer: d.signer }, bot, market, op);
        if (r !== "confirmed") { allConfirmed = false; result.reasons.push({ code: `op_${r}`, message: `${op.op_key}: ${r}` }); break; }
      }
      if (!allConfirmed) break;
      void lastSnap;
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
    lock.release();
    const cur = await loadBot(db, bot.id);
    if (cur) { const ex = await executionAllowed(d, cur).catch(() => ({ ok: false })); await refreshBotState(db, cur, cur.mode === "execute" ? !!(await d.signer(cur).catch(() => null)) : false, ex.ok).catch(() => {}); }
  }
  return result;
}
