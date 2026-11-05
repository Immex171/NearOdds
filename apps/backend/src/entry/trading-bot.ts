import { randomUUID } from "node:crypto";
import { migrate } from "../db/index.js";
import { runOne } from "../keeper/jobs.js";
import { TxExecutor } from "../near/tx.js";
import { Keystore, SignerRegistry } from "../near/keystore.js";
import { botHandlers, scheduleBotCycles } from "../trading-bot/worker.js";
import { makeBotSigner } from "../trading-bot/signer.js";
import { boot } from "./common.js";

const { cfg, db, rpc } = boot();
await migrate(db);
const workerId = `bot-${randomUUID().slice(0, 8)}`;
void new SignerRegistry(new Keystore(cfg.keystoreDir), db); // keystore dir exists; bot keys come from the credentials file only
const signer = makeBotSigner(cfg, rpc);
const deps = { cfg, db, rpc, tx: new TxExecutor(db, rpc, cfg.txPollTimeoutMs), signer: signer.signer };
const handlers = botHandlers(deps);
let stop = false;
process.on("SIGINT", () => { stop = true; }); process.on("SIGTERM", () => { stop = true; });
console.log(`[trading-bot] ${workerId} starting. Execution ${cfg.bot.executionEnabled ? "ENABLED" : "disabled (paper only)"} on ${cfg.network}`);
let lastSchedule = 0;
while (!stop) {
  try {
    if (Date.now() - lastSchedule >= cfg.bot.cycleSeconds * 1000) {
      lastSchedule = Date.now();
      const n = await scheduleBotCycles(db, cfg.bot.cycleSeconds);
      await db.query("INSERT INTO worker_heartbeats(worker_id, role, info, beat_at) VALUES ($1,'trading-bot',$2,now()) ON CONFLICT (worker_id) DO UPDATE SET info=$2, beat_at=now()", [workerId, JSON.stringify({ scheduled: n, executionEnabled: cfg.bot.executionEnabled, network: cfg.network })]);
    }
    if (!(await runOne(db, workerId, handlers))) await new Promise((r) => setTimeout(r, 1500));
  } catch (e) { console.error("[trading-bot]", (e as Error).message); await new Promise((r) => setTimeout(r, 5000)); }
}
await db.end();
