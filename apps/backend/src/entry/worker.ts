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
const indexer = new Indexer(db, nd);
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
    await beat("indexer", { ...st }).catch(() => {});
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
