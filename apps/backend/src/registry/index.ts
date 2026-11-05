import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConfigView, MarketView } from "@nearodds/types";
import type { Q } from "../db/index.js";
import { Rpc, RpcError, RpcUnavailableError } from "../near/rpc.js";

export const EXPECTED_SCHEMA_VERSION = 3;

/** Globally unique, stable public id for (network, contract account, internal market id). */
export function marketRefFor(network: string, contractId: string, internalMarketId: string): string {
  return "m_" + createHash("sha256").update(`${network}|${contractId}|${internalMarketId}`).digest("hex").slice(0, 20);
}
/** Scope contract-local identifiers (offers, withdrawals) globally. */
export const scopedId = (marketRef: string, localId: string) => `${marketRef}:${localId}`;

export interface TokenMetadata { spec: string; name: string; symbol: string; decimals: number; icon: string | null; reference: string | null; reference_hash: string | null }

export interface ChainVerification {
  ok: boolean;
  problems: string[];
  config?: ConfigView;
  market?: MarketView;
  token?: TokenMetadata;
  codeHash?: string;
  tokenRegistered?: boolean;
  blockHeight?: number;
}

export interface Expectation {
  contractId: string;
  tokenId: string;
  marketId: string;
  resolverId?: string;
  question?: string;
  rules?: string;
  resolutionSource?: string;
  cutoffNs?: string;
  codeHashBase58?: string;
}

/** Validates a deployed market against get_config / get_market / ft_metadata / token registration / code hash. */
export async function verifyMarketOnChain(rpc: Rpc, e: Expectation): Promise<ChainVerification> {
  const problems: string[] = [];
  const acct = await rpc.viewAccount(e.contractId);
  if (!acct.exists) return { ok: false, problems: [`market account ${e.contractId} does not exist`] };
  const out: ChainVerification = { ok: false, problems, codeHash: acct.codeHash };
  if (e.codeHashBase58 && acct.codeHash !== e.codeHashBase58) problems.push(`code hash ${acct.codeHash} != expected ${e.codeHashBase58}`);
  if (acct.codeHash === "11111111111111111111111111111111") problems.push("no contract code deployed");
  let cfg: ConfigView, mkt: MarketView, meta: TokenMetadata;
  try {
    cfg = await rpc.callView<ConfigView>(e.contractId, "get_config");
    mkt = await rpc.callView<MarketView>(e.contractId, "get_market", { market_id: e.marketId });
  } catch (err) { if (err instanceof RpcUnavailableError) throw err; problems.push(`market views failed: ${(err as Error).message}`); return out; }
  out.config = cfg; out.market = mkt;
  if (cfg.schema_version !== EXPECTED_SCHEMA_VERSION) problems.push(`schema_version ${cfg.schema_version} != ${EXPECTED_SCHEMA_VERSION}`);
  if (cfg.market_id !== e.marketId) problems.push(`config.market_id ${cfg.market_id} != ${e.marketId}`);
  if (cfg.collateral_token_id !== e.tokenId) problems.push(`collateral token ${cfg.collateral_token_id} != ${e.tokenId}`);
  if (e.resolverId && cfg.resolver_id !== e.resolverId) problems.push(`resolver ${cfg.resolver_id} != ${e.resolverId}`);
  if (e.question !== undefined && mkt.question !== e.question) problems.push("question mismatch");
  if (e.rules !== undefined && mkt.rules !== e.rules) problems.push("rules mismatch");
  if (e.resolutionSource !== undefined && mkt.resolution_source !== e.resolutionSource) problems.push("resolution_source mismatch");
  if (e.cutoffNs !== undefined && mkt.split_cutoff_ns !== e.cutoffNs) problems.push(`cutoff ${mkt.split_cutoff_ns} != ${e.cutoffNs}`);
  try {
    meta = await rpc.callView<TokenMetadata>(e.tokenId, "ft_metadata");
    out.token = meta;
    if (meta.decimals !== cfg.decimals) problems.push(`token decimals ${meta.decimals} != market decimals ${cfg.decimals}`);
    const bal = await rpc.callView<unknown>(e.tokenId, "storage_balance_of", { account_id: e.contractId });
    out.tokenRegistered = bal !== null;
    if (bal === null) problems.push("market account is not registered with the collateral token");
  } catch (err) { if (err instanceof RpcUnavailableError) throw err; problems.push(`token views failed: ${(err as Error).message}`); }
  out.ok = problems.length === 0;
  return out;
}

export interface PublishInput {
  network: string; contractId: string; internalMarketId: string; tokenId: string;
  verification: ChainVerification; source: "imported-demo" | "keeper";
  category?: string | null; tag?: string | null; templateId?: string | null; occurrenceKey?: string | null;
  observationStartNs?: string | null; observationEndNs?: string | null;
  historyStartHeight?: number | null;
}

/** Publish a VERIFIED market into the registry. Refuses unverified input. */
export async function publishMarket(db: Q, p: PublishInput): Promise<string> {
  if (!p.verification.ok || !p.verification.config || !p.verification.market || !p.verification.token) throw new Error("refusing to publish an unverified market: " + p.verification.problems.join("; "));
  const m = p.verification.market;
  const ref = marketRefFor(p.network, p.contractId, p.internalMarketId);
  await db.query(
    `INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id,
       category, tag, template_id, occurrence_key, observation_start_ns, observation_end_ns, token_meta, config, contract_status, resolution,
       outstanding_yes, outstanding_no, market_backing, source, history_start_height, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now())
     ON CONFLICT (market_ref) DO UPDATE SET verified_at=now(), token_meta=EXCLUDED.token_meta, config=EXCLUDED.config`,
    [ref, p.network, p.contractId, p.internalMarketId, p.tokenId, m.question, m.rules, m.resolution_source, m.split_cutoff_ns, m.resolver_id,
      p.category ?? null, p.tag ?? null, p.templateId ?? null, p.occurrenceKey ?? null, p.observationStartNs ?? null, p.observationEndNs ?? null,
      JSON.stringify(p.verification.token), JSON.stringify(p.verification.config), m.status, m.resolution ? JSON.stringify(m.resolution) : null,
      m.outstanding_yes, m.outstanding_no, m.market_backing, p.source, p.historyStartHeight ?? null]);
  await db.query("INSERT INTO stream_events(market_ref, type, payload) VALUES ($1,'market_created',$2)", [ref, JSON.stringify({ marketRef: ref, contractId: p.contractId, marketId: p.internalMarketId })]);
  return ref;
}

export interface DemoManifest {
  network: string;
  accounts: { market: string; token: string; resolver_and_token_owner: string; liquidity_provider?: string; probe_trader?: string };
  market_id: string; split_cutoff_ns: string;
  artifacts: { market_wasm: { sha256_hex: string; code_hash_base58: string; bytes: number } };
  git_commit: string;
  steps: { step: string; tx_hash: string; succeeded: boolean }[];
  market_terms: { question: string; rules: string; resolution_source: string; observation_date?: string; split_cutoff_ns: string };
  config: { resolver_id: string; collateral_token_id: string };
}

export function readDemoManifest(path: string): DemoManifest { return JSON.parse(readFileSync(path, "utf8")); }

/** Imports the persistent demo, validating the manifest against the chain first. The manifest file is never modified. */
export async function importDemo(db: Q, rpc: Rpc, networkName: string, manifest: DemoManifest) {
  const a = manifest.accounts;
  const v = await verifyMarketOnChain(rpc, {
    contractId: a.market, tokenId: a.token, marketId: manifest.market_id, resolverId: manifest.config.resolver_id,
    question: manifest.market_terms.question, rules: manifest.market_terms.rules, resolutionSource: manifest.market_terms.resolution_source,
    cutoffNs: manifest.split_cutoff_ns, codeHashBase58: manifest.artifacts.market_wasm.code_hash_base58,
  });
  if (!v.ok) throw new Error("demo manifest does not match the chain: " + v.problems.join("; "));
  let historyStart: number | null = null;
  const deployTx = manifest.steps.find((s) => s.step.includes("market: deploy"))?.tx_hash;
  if (deployTx) historyStart = await blockHeightOfTx(rpc, deployTx, a.resolver_and_token_owner).catch(() => null);
  const ref = await publishMarket(db, {
    network: networkName, contractId: a.market, internalMarketId: manifest.market_id, tokenId: a.token, verification: v, source: "imported-demo",
    historyStartHeight: historyStart,
    category: "Weather", tag: "Lagos",
    observationStartNs: "1794438000000000000", observationEndNs: "1794524400000000000",
  });
  const txHashes: Record<string, string> = {};
  for (const s of manifest.steps) if (s.step.includes("market: deploy")) txHashes.deploy_and_init = s.tx_hash;
  await db.query(
    `INSERT INTO deployment_records(market_ref, contract_id, deployer_id, init_args, artifact_id, artifact_version, artifact_sha256, code_hash_base58, source_version, accounts, tx_hashes, verification)
     VALUES ($1,$2,$3,$4,'market-wasm','imported',$5,$6,$7,$8,$9,$10) ON CONFLICT (market_ref) DO NOTHING`,
    [ref, a.market, a.resolver_and_token_owner,
      JSON.stringify({ collateral_token: a.token, market_id: manifest.market_id, question: manifest.market_terms.question, rules: manifest.market_terms.rules, resolution_source: manifest.market_terms.resolution_source, split_cutoff_ns: manifest.split_cutoff_ns, resolver_id: manifest.config.resolver_id }),
      manifest.artifacts.market_wasm.sha256_hex, manifest.artifacts.market_wasm.code_hash_base58, manifest.git_commit,
      JSON.stringify(a), JSON.stringify(txHashes), JSON.stringify({ ok: true, source: "import-time chain verification", codeHash: v.codeHash, problems: [] })]);
  return { ref, verification: v };
}

/** Height of the block that included a transaction (null if the RPC no longer retains it). */
export async function blockHeightOfTx(rpc: Rpc, txHash: string, signerId: string): Promise<number | null> {
  const o = await rpc.read("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
  const bh = o?.transaction_outcome?.block_hash;
  if (!bh) return null;
  const b = await rpc.read("block", { block_id: bh });
  return b.header.height as number;
}
