// Local NEAR Sandbox harness for the web app's integration tests. It starts a throwaway chain, deploys the REAL contract
// artifacts (target/wasm), and signs with keys generated here. It touches no testnet account and reads no credential files.
// Requirements (same as the backend's Sandbox tests): the cargo-built near-sandbox binary and target/wasm/*.wasm.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../../../..");
export const MARKET_WASM = join(REPO, "target/wasm/market.wasm");
export const TOKEN_WASM = join(REPO, "target/wasm/test_collateral.wasm");
// near-api-js is a dependency of apps/backend (not of the web app); load it from there.
const nearApi = createRequire(join(REPO, "apps/backend/package.json"))("near-api-js");
export const { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } = nearApi;

export function findSandboxBin() {
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
export const sandboxAvailable = () => Boolean(findSandboxBin()) && existsSync(MARKET_WASM) && existsSync(TOKEN_WASM);

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

export async function startSandbox() {
  const bin = findSandboxBin();
  const home = mkdtempSync(join(tmpdir(), "nearodds-web-sbx-"));
  execFileSync(bin, ["--home", home, "init", "--chain-id", "localnet"], { stdio: "ignore" });
  const rpcPort = 34030 + ((process.pid + n++ * 7) % 2000) * 2;
  const cfgPath = join(home, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.rpc.addr = `127.0.0.1:${rpcPort}`; cfg.network.addr = `127.0.0.1:${rpcPort + 1}`;
  cfg.consensus.min_block_production_delay = { secs: 0, nanos: 300_000_000 };
  cfg.consensus.max_block_production_delay = { secs: 0, nanos: 800_000_000 };
  cfg.consensus.min_num_peers = 0;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const key = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8"));
  const child = spawn(bin, ["--home", home, "run"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${rpcPort}`;
  const provider = new JsonRpcProvider({ url });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const b = await provider.viewBlock({ finality: "final" }); if (b.header.height > 3) break; } catch { /* starting */ }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("sandbox did not start"); }
    await sleep(300);
  }
  const sbx = { url, provider, home, rootId: key.account_id, hashes: [], stop: async () => { child.kill("SIGKILL"); await sleep(200); try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } } };
  sbx.root = { accountId: key.account_id, keyPair: KeyPair.fromString(key.secret_key) };
  return sbx;
}

const accountOf = (sbx, k) => new Account(k.accountId, sbx.provider, new KeyPairSigner(k.keyPair));

/** Sends one function call as `k`; records the hash with a label so a run can report real (sandbox) transaction hashes. */
export async function call(sbx, k, receiver, method, args, deposit = 1n, gas = 100n * TGAS, label = method) {
  const out = await accountOf(sbx, k).signAndSendTransaction({ receiverId: receiver, actions: [actions.functionCall(method, args, gas, deposit)] });
  sbx.hashes.push({ label, hash: out.transaction.hash, receiver, method });
  // Views read the FINAL block: wait until this transaction is final so the next read sees it.
  const inc = out.transaction_outcome?.block_hash ?? out.transactionOutcome?.blockHash;
  const at = (await sbx.provider.viewBlock({ blockId: inc })).header.height;
  for (let i = 0; i < 200; i++) { // receipts execute 1-2 blocks later; final lags again
    if ((await sbx.provider.viewBlock({ finality: "final" })).header.height >= at + 4) break;
    await sleep(150);
  }
  // A wallet's "success" is not proof: surface any failed receipt for the harness's own calls.
  const rcpts = out.receipts_outcome ?? out.receiptsOutcome ?? [];
  const bad = [out.status, ...rcpts.map((r) => r.outcome?.status)].find((s) => s && typeof s === "object" && "Failure" in s);
  if (bad) throw new Error(`${method} failed: ${JSON.stringify(bad).slice(0, 400)}`);
  return out;
}

export async function createAccount(sbx, name, near = 100n) {
  const accountId = `${name}.${sbx.rootId}`;
  const keyPair = KeyPair.fromRandom("ed25519");
  await accountOf(sbx, sbx.root).signAndSendTransaction({ receiverId: accountId, actions: [actions.createAccount(), actions.transfer(near * NEAR), actions.addFullAccessKey(keyPair.getPublicKey())] });
  return { accountId, keyPair };
}

export async function deployToken(sbx, owner, name = "tnoc") {
  const accountId = `${name}.${sbx.rootId}`;
  const keyPair = KeyPair.fromRandom("ed25519");
  await accountOf(sbx, sbx.root).signAndSendTransaction({ receiverId: accountId, actions: [actions.createAccount(), actions.transfer(30n * NEAR), actions.addFullAccessKey(keyPair.getPublicKey()), actions.deployContract(readFileSync(TOKEN_WASM)), actions.functionCall("new", { owner_id: owner.accountId }, 50n * TGAS, 0n)] });
  return accountId;
}

/** Deploys the real market contract with market_id "mkt-1" (several markets share it on purpose). */
export async function deployMarket(sbx, { name, tokenId, resolver, cutoffMs, question, rules = "Observation period: the test day. Trading closes first.", marketId = "mkt-1" }) {
  const accountId = `${name}.${sbx.rootId}`;
  const keyPair = KeyPair.fromRandom("ed25519");
  const cutoffNs = (BigInt(Date.now() + cutoffMs) * 1_000_000n).toString();
  const init = { collateral_token: tokenId, market_id: marketId, question, rules, resolution_source: "Test source", split_cutoff_ns: cutoffNs, resolver_id: resolver.accountId };
  await accountOf(sbx, sbx.root).signAndSendTransaction({ receiverId: accountId, actions: [actions.createAccount(), actions.transfer(20n * NEAR), actions.addFullAccessKey(keyPair.getPublicKey()), actions.deployContract(readFileSync(MARKET_WASM)), actions.functionCall("new", init, 100n * TGAS, 0n)] });
  await call(sbx, resolver, tokenId, "storage_deposit", { account_id: accountId, registration_only: true }, 1_250_000_000_000_000_000_000n, 30n * TGAS, "register market with token");
  return { contractId: accountId, marketId, tokenId, cutoffNs, cutoffMs: Number(BigInt(cutoffNs) / 1_000_000n) };
}

export async function view(sbx, contractId, method, args = {}) {
  const r = await sbx.provider.callFunction({ contractId, method, args, finality: "final" });
  return r;
}
