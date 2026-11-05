#!/usr/bin/env node
// Derives apps/web/.env from deployments/testnet-demo.json and validates it.
//   node scripts/sync-deployment.mjs            write .env (offline validation)
//   node scripts/sync-deployment.mjs --online   also compare with the chain (get_config, ft_metadata, code hashes)
//   node scripts/sync-deployment.mjs --check    validate only, write nothing
// An explicit NEXT_PUBLIC_* value in the environment that disagrees with the manifest fails the run
// (a build pointed at the wrong contract is worse than no build).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RPC_URL, deriveEnv, envConflicts, toDotenv } from "./deployment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(process.env.NEARODDS_DEPLOYMENT ?? resolve(here, "../../../deployments/testnet-demo.json"));
const args = new Set(process.argv.slice(2));
const fail = (lines) => { console.error(`deployment: FAILED\n${lines.map((l) => "  - " + l).join("\n")}`); process.exit(1); };

let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (e) { fail([`cannot read ${manifestPath}: ${e.message}`]); }
const { env, problems } = deriveEnv(manifest);
const conflicts = envConflicts(env, process.env);
if (problems.length || conflicts.length) fail([...problems, ...conflicts]);

async function rpc(method, params) {
  const r = await fetch(process.env.NEXT_PUBLIC_RPC_URL || RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  if (j.result?.error) throw new Error(j.result.error);
  return j.result;
}
const view = async (id, method, a = {}) => JSON.parse(Buffer.from((await rpc("query", { request_type: "call_function", finality: "final", account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") })).result).toString());

if (args.has("--online")) {
  const bad = [];
  const m = manifest;
  try {
    const cfg = await view(env.NEXT_PUBLIC_MARKET_CONTRACT_ID, "get_config");
    const meta = await view(env.NEXT_PUBLIC_TOKEN_CONTRACT_ID, "ft_metadata");
    const mk = await view(env.NEXT_PUBLIC_MARKET_CONTRACT_ID, "get_market", { market_id: env.NEXT_PUBLIC_MARKET_ID });
    if (cfg.schema_version !== m.config.schema_version) bad.push(`on-chain schema_version ${cfg.schema_version} != manifest ${m.config.schema_version}`);
    if (cfg.collateral_token_id !== env.NEXT_PUBLIC_TOKEN_CONTRACT_ID) bad.push(`on-chain collateral_token_id ${cfg.collateral_token_id} != token account`);
    if (cfg.market_id !== env.NEXT_PUBLIC_MARKET_ID) bad.push(`on-chain market_id ${cfg.market_id} != ${env.NEXT_PUBLIC_MARKET_ID}`);
    if (cfg.decimals !== meta.decimals) bad.push(`config.decimals ${cfg.decimals} != ft_metadata.decimals ${meta.decimals}`);
    if (meta.symbol !== m.token_metadata.symbol) bad.push(`ft_metadata.symbol ${meta.symbol} != manifest ${m.token_metadata.symbol}`);
    if (mk.collateral_token_id !== env.NEXT_PUBLIC_TOKEN_CONTRACT_ID) bad.push("get_market collateral token differs");
    if (mk.split_cutoff_ns !== m.split_cutoff_ns) bad.push(`on-chain split_cutoff_ns ${mk.split_cutoff_ns} != manifest ${m.split_cutoff_ns}`);
    if (mk.question !== m.market_terms.question) bad.push("on-chain question differs from manifest");
    if (mk.rules !== m.market_terms.rules) bad.push("on-chain rules differ from manifest");
    if (JSON.stringify(cfg.trading) !== JSON.stringify(m.config.trading)) bad.push("on-chain trading parameters differ from manifest");
    for (const [label, id, want] of [["market", env.NEXT_PUBLIC_MARKET_CONTRACT_ID, m.artifacts.market_wasm.code_hash_base58], ["token", env.NEXT_PUBLIC_TOKEN_CONTRACT_ID, m.artifacts.token_wasm.code_hash_base58]]) {
      const acct = await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
      if (acct.code_hash !== want) bad.push(`${label} code hash ${acct.code_hash} != manifest ${want}`);
    }
    if (!bad.length) console.log(`deployment: on-chain check passed (${mk.status}, ${meta.symbol}, ${meta.decimals} decimals, schema ${cfg.schema_version})`);
  } catch (e) { bad.push(`RPC failure: ${e.message}`); }
  if (bad.length) fail(bad);
}

if (!args.has("--check")) {
  writeFileSync(resolve(here, "../.env"), toDotenv(env, "deployments/testnet-demo.json"));
  console.log(`deployment: wrote apps/web/.env (market ${env.NEXT_PUBLIC_MARKET_CONTRACT_ID}, token ${env.NEXT_PUBLIC_TOKEN_CONTRACT_ID}, ${env.NEXT_PUBLIC_MARKET_ID})`);
} else console.log("deployment: manifest is valid");
