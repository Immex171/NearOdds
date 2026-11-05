import type { Db } from "../db/index.js";
import { enqueue, RetryLater, type Handler } from "../keeper/jobs.js";
import { runCycle, type BotDeps } from "./cycle.js";

/** The ONLY job kind the trading-bot worker claims. The keeper claims only its own kinds (see runOne). */
export const BOT_JOB_KIND = "bot_market_cycle";

/** Enqueue one cycle job per (bot, market) unless one is already active. Settled paused/stopped bots are skipped. */
export async function scheduleBotCycles(db: Db, cycleSeconds: number, nowMs = Date.now()): Promise<number> {
  const bots = (await db.query("SELECT id, desired_state, state, config FROM trading_bots WHERE desired_state <> 'disabled'")).rows;
  let n = 0;
  for (const b of bots) {
    if ((b.state === "paused" || b.state === "stopped") && b.desired_state !== "running") continue; // nothing left to wind down
    // configured markets, PLUS markets removed from the configuration that still have live quotes or unresolved operations
    const leftovers = (await db.query(
      `SELECT market_ref FROM bot_quotes WHERE bot_id=$1 AND state='active'
       UNION SELECT market_ref FROM bot_operations WHERE bot_id=$1 AND state IN ('proposed','submitted','uncertain')`, [b.id])).rows.map((r: any) => r.market_ref as string);
    const refs = [...new Set<string>([...(b.config.markets as { marketRef: string }[]).map((m) => m.marketRef), ...leftovers])];
    for (const m of refs.map((marketRef) => ({ marketRef }))) {
      const active = await db.query("SELECT 1 FROM jobs WHERE kind=$1 AND state IN ('queued','running','uncertain') AND payload->>'botId'=$2 AND payload->>'marketRef'=$3 LIMIT 1", [BOT_JOB_KIND, String(b.id), m.marketRef]);
      if (active.rowCount) continue;
      const slot = Math.floor(nowMs / (cycleSeconds * 1000));
      const r = await enqueue(db, BOT_JOB_KIND, `botcycle:${b.id}:${m.marketRef}:${slot}`, { botId: String(b.id), marketRef: m.marketRef });
      if (r.created) n++;
    }
  }
  await db.query("DELETE FROM jobs WHERE kind=$1 AND state IN ('succeeded','failed') AND updated_at < now() - interval '1 day'", [BOT_JOB_KIND]);
  return n;
}

export const botHandlers = (d: BotDeps): Record<string, Handler> => ({
  [BOT_JOB_KIND]: async (c) => {
    const r = await runCycle(d, c.job.payload.botId, c.job.payload.marketRef);
    if (r.status === "locked") throw new RetryLater("another worker owns this bot/market right now", 5_000);
  },
});
