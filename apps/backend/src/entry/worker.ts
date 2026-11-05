import { randomUUID } from "node:crypto";
import { migrate } from "../db/index.js";
import { Neardata } from "../indexer/neardata.js";
import { Indexer } from "../indexer/runner.js";
import { reconcileMarket } from "../indexer/reconcile.js";
import { boot } from "./common.js";
import { startKeeper } from "../keeper/loop.js";

const { cfg, db, rpc } = boot();
await migrate(db);
const workerId = `worker-${randomUUID().slice(0, 8)}`;
const nd = new Neardata(cfg.neardataUrl, cfg.neardataApiKey);
// With an API key Neardata allows far more parallel requests; anonymous access is rate limited (429), so stay gentle.
const concurrency = Number(process.env.NEARDATA_CONCURRENCY ?? (cfg.neardataApiKey ? 8 : 2));
console.log(`[indexer] neardata ${cfg.neardataUrl}, api key ${cfg.neardataApiKey ? "set" : "NOT set"}, concurrency ${concurrency}`);
const indexer = new Indexer(db, nd, { concurrency });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stop = false;
process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });

async function beat(role: string, info: object) {
  await db.query("INSERT INTO worker_heartbeats(worker_id, role, info, beat_at) VALUES ($1,$2,$3,now()) ON CONFLICT (worker_id) DO UPDATE SET info=$3, beat_at=now(), role=$2", [workerId + ":" + role, role, JSON.stringify(info)]);
}

async function indexLoop() {
  let lastReconcile = 0;
  while (!stop) {
    let n = 0;
    try { n = await indexer.step(); } catch (e) { console.error("[indexer]", (e as Error).message); await sleep(5000); }
    const st = await indexer.status().catch(() => null);
    if (indexer.lockBusy) { console.log("[indexer] another worker process holds the indexing lock; this one is waiting. Stop the other worker(s): pgrep -fa entry/worker.ts"); await sleep(10000); }
    else if (n > 0 || (st && st.catchingUp.length)) {
      const p = (await db.query("SELECT history_start_height h, indexed_through t FROM markets WHERE history_start_height IS NOT NULL ORDER BY created_at LIMIT 1")).rows[0];
      console.log(`[indexer] checkpoint ${st?.checkpoint} tip ${st?.tip} lag ${st?.lag}${p ? ` | history scan ${p.t ?? "starting"} of ${st?.checkpoint}` : ""}${st?.openGaps ? ` | open gaps ${st.openGaps}` : ""}`);
    }
    await beat("indexer", { ...st }).catch(() => {});
    // newly discovered participants are hydrated from contract views at the checkpoint block right away
    if (st?.checkpoint && !st.catchingUp.length) {
      const need = (await db.query("SELECT DISTINCT market_ref FROM market_participants WHERE hydrated_at IS NULL")).rows;
      for (const r of need) { try { await reconcileMarket(db, rpc, r.market_ref, st.checkpoint); } catch (e) { console.error("[hydrate]", (e as Error).message); } }
    }
    if (st?.checkpoint && !st.catchingUp.length && Date.now() - lastReconcile > 30_000) {
      lastReconcile = Date.now();
      const refs = (await db.query("SELECT market_ref FROM markets")).rows;
      for (const r of refs) { try { await reconcileMarket(db, rpc, r.market_ref, st.checkpoint); } catch (e) { console.error("[reconcile]", (e as Error).message); } }
    }
    if (n === 0) await sleep(1000);
  }
}

console.log(`worker ${workerId} starting`);
const keeper = startKeeper({ cfg, db, rpc, workerId, beat: (i) => beat("keeper", i), shouldStop: () => stop });
await Promise.all([indexLoop(), keeper]);
await db.end();
