import { migrate } from "../db/index.js";
import { buildApp } from "../api/app.js";
import { boot } from "./common.js";
const { cfg, db, rpc } = boot();
await migrate(db);
const app = buildApp({ db, rpc, cfg });
await app.listen({ port: cfg.apiPort, host: cfg.apiHost });
console.log(`api listening on ${cfg.apiHost}:${cfg.apiPort}`);
