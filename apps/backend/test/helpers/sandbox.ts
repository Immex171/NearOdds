import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Rpc } from "../../src/near/rpc.js";

export const REPO = resolve(import.meta.dirname, "../../../..");
export const MARKET_WASM = join(REPO, "target/wasm/market.wasm");
export const TOKEN_WASM = join(REPO, "target/wasm/test_collateral.wasm");

export function findSandboxBin(): string | null {
  if (process.env.SANDBOX_BIN && existsSync(process.env.SANDBOX_BIN)) return process.env.SANDBOX_BIN;
  const base = join(REPO, "target/debug/build");
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base).filter((x) => x.startsWith("near-sandbox-"))) {
    const dir = join(base, d, "out/.near");
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir)) { const p = join(dir, v, "near-sandbox"); if (existsSync(p)) return p; }
  }
  return null;
}
export const sandboxAvailable = () => !!findSandboxBin() && existsSync(MARKET_WASM) && existsSync(TOKEN_WASM);

export interface Sandbox { rpcUrl: string; rpc: Rpc; rootId: string; rootSecret: string; stop: () => Promise<void>; home: string }

let portCounter = 0;
export async function startSandbox(): Promise<Sandbox> {
  const bin = findSandboxBin()!;
  const home = mkdtempSync(join(tmpdir(), "nearodds-sbx-"));
  execFileSync(bin, ["--home", home, "init", "--chain-id", "localnet"], { stdio: "ignore" });
  const rpcPort = 33030 + ((process.pid + portCounter++ * 7) % 2000) * 2;
  const netPort = rpcPort + 1;
  const cfgPath = join(home, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.rpc.addr = `127.0.0.1:${rpcPort}`; cfg.network.addr = `127.0.0.1:${netPort}`;
  cfg.consensus.min_block_production_delay = { secs: 0, nanos: 300_000_000 };
  cfg.consensus.max_block_production_delay = { secs: 0, nanos: 800_000_000 };
  cfg.consensus.min_num_peers = 0;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const key = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8"));
  const child: ChildProcess = spawn(bin, ["--home", home, "run"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const rpc = new Rpc({ url: rpcUrl, retries: 0, timeoutMs: 5000 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const b = await rpc.finalBlock(); if (b.height > 3) break; } catch { /* starting */ }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("sandbox did not start"); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    rpcUrl, rpc, rootId: key.account_id, rootSecret: key.secret_key, home,
    stop: async () => { child.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 200)); try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
