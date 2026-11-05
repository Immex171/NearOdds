import type { Db } from "../db/index.js";
import type { BotRow } from "./ops.js";

export type OperatingState = "disabled" | "paper" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "uncertain" | "needs_funding" | "setup_required";

export interface StateFacts { pendingOps: number; uncertainOps: number; activeQuotes: number; needsFunding: boolean; credentialsOk: boolean; executionAllowed: boolean }

/** Never reports paused/stopped while submissions or cancellations remain unresolved. */
export function deriveState(bot: Pick<BotRow, "desired_state" | "mode">, f: StateFacts): { state: OperatingState; reason: string | null } {
  const d = bot.desired_state;
  if (d === "disabled") return { state: "disabled", reason: "not started" };
  if (d === "paused" || d === "stopped") {
    const word = d === "paused" ? "pause" : "stop";
    if (f.uncertainOps > 0) return { state: "uncertain", reason: `${f.uncertainOps} transaction(s) have an unknown outcome; ${word} not complete` };
    if (f.pendingOps > 0 || f.activeQuotes > 0) return { state: d === "paused" ? "pausing" : "stopping", reason: `${f.pendingOps} operation(s) in flight, ${f.activeQuotes} open quote(s) still to cancel (open offers can be filled until cancelled or expired)` };
    return { state: d, reason: null };
  }
  if (bot.mode === "paper") return { state: "paper", reason: "paper mode: no transactions are signed or sent" };
  if (!f.executionAllowed) return { state: "setup_required", reason: "execution is not enabled for this environment" };
  if (!f.credentialsOk) return { state: "setup_required", reason: "bot credentials are missing or invalid" };
  if (f.uncertainOps > 0) return { state: "uncertain", reason: `${f.uncertainOps} transaction(s) have an unknown outcome` };
  if (f.needsFunding) return { state: "needs_funding", reason: "insufficient funds for the configured quotes" };
  return { state: "running", reason: null };
}

export async function gatherStateFacts(db: Db, botId: string, credentialsOk: boolean, executionAllowed: boolean): Promise<StateFacts> {
  const ops = (await db.query("SELECT COUNT(*) FILTER (WHERE state IN ('proposed','submitted','uncertain'))::int p, COUNT(*) FILTER (WHERE state='uncertain')::int u FROM bot_operations WHERE bot_id=$1", [botId])).rows[0];
  const q = (await db.query("SELECT COUNT(*)::int n FROM bot_quotes WHERE bot_id=$1 AND state='active'", [botId])).rows[0].n;
  const nf = (await db.query("SELECT COALESCE(bool_or(needs_funding),false) b FROM bot_market_status WHERE bot_id=$1", [botId])).rows[0].b;
  return { pendingOps: ops.p, uncertainOps: ops.u, activeQuotes: q, needsFunding: nf, credentialsOk, executionAllowed };
}

export async function refreshBotState(db: Db, bot: BotRow, credentialsOk: boolean, executionAllowed: boolean) {
  const cur = (await db.query("SELECT * FROM trading_bots WHERE id=$1", [bot.id])).rows[0];
  const facts = await gatherStateFacts(db, bot.id, credentialsOk, executionAllowed);
  const s = deriveState(cur, facts);
  await db.query("UPDATE trading_bots SET state=$2, state_reason=$3, updated_at=updated_at WHERE id=$1", [bot.id, s.state, s.reason]);
  return { ...s, facts };
}
