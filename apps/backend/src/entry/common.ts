import { loadConfig } from "../config/index.js";
import { createPool } from "../db/index.js";
import { Rpc } from "../near/rpc.js";
export function boot() {
  const cfg = loadConfig();
  const db = createPool(cfg.databaseUrl);
  const rpc = new Rpc({ url: cfg.rpcUrl, retries: cfg.rpcReadRetries });
  return { cfg, db, rpc };
}
