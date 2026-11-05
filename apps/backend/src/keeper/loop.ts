import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import { Rpc } from "../near/rpc.js";
import { TxExecutor } from "../near/tx.js";
import { createMarketJob, type KeeperDeps } from "./create-market.js";
import { runOne, type Handler } from "./jobs.js";
import { ProviderRegistry, defaultProviders, resolutionTick, resolveMarketJob } from "./resolution.js";
import { scheduleTick } from "./scheduler.js";
import { buildSigners } from "./signers.js";
import { mintJob } from "../faucet/mint.js";

export function makeDeps(cfg: Config, db: Db, rpc: Rpc): KeeperDeps & { providers: ProviderRegistry } {
  const signers = buildSigners(cfg, db);
  return { cfg, db, rpc, signers, tx: new TxExecutor(db, rpc, cfg.txPollTimeoutMs), providers: defaultProviders() };
}
export const handlersFor = (d: KeeperDeps): Record<string, Handler> => ({
  create_market: (c) => createMarketJob(d, c),
  resolve_market: (c) => resolveMarketJob(d, c),
  mint_tnoc: (c) => mintJob(d, c),
});

/** One scheduling + resolution pass, then drain runnable jobs. Used by the worker loop and by tests. */
export async function keeperPass(d: KeeperDeps & { providers: ProviderRegistry }, workerId: string, maxJobs = 20) {
  const s = await scheduleTick(d.db, (d.now ?? Date.now)());
  const r = await resolutionTick(d);
  const h = handlersFor(d);
  let ran = 0;
  while (ran < maxJobs && (await runOne(d.db, workerId, h))) ran++;
  return { scheduled: s.enqueued, resolutionEnqueued: r.enqueued, jobsRun: ran };
}

export async function startKeeper(o: { cfg: Config; db: Db; rpc: Rpc; workerId: string; beat: (i: object) => Promise<void>; shouldStop: () => boolean }) {
  const d = makeDeps(o.cfg, o.db, o.rpc);
  console.log("[keeper] signer roles:", JSON.stringify(d.signers.roles), d.signers.keyIsolation ? "" : `(NO key isolation: ${d.signers.sharedKeyRoles.join(",")} share one account)`);
  let lastPass = 0;
  while (!o.shouldStop()) {
    try {
      if (Date.now() - lastPass > 30_000) { lastPass = Date.now(); const r = await keeperPass(d, o.workerId); await o.beat({ ...r, roles: d.signers.roles, keyIsolation: d.signers.keyIsolation }); }
      else if (!(await runOne(o.db, o.workerId, handlersFor(d)))) await new Promise((r) => setTimeout(r, 2000));
    } catch (e) { console.error("[keeper]", (e as Error).message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
