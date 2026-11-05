/**
 * READ-ONLY dry run for one live market creation. Writes nothing (no DB, no chain, no keys).
 *   pnpm plan-creation --template templates/lagos-rain.testnet.json --date 2026-11-13
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import { loadApprovedArtifact } from "../keeper/artifacts.js";
import { TemplateSpec, occurrenceFor, renderAndValidate } from "../keeper/template.js";
import { marketAccountName } from "../keeper/create-market.js";
import { Rpc } from "../near/rpc.js";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const NEAR = 10n ** 24n;
const near = (y: bigint) => `${(Number(y / 10n ** 20n) / 10000).toFixed(4)} NEAR`;

export async function buildPlan(templatePath: string, date: string) {
  const cfg = loadConfig();
  const spec = TemplateSpec.parse(JSON.parse(readFileSync(templatePath, "utf8")));
  const [y, m, d] = date.split("-").map(Number);
  const occ = occurrenceFor(spec, 1, y, m, d);
  const v = renderAndValidate(spec, occ, Date.now());
  const rpc = new Rpc({ url: cfg.rpcUrl });
  const blockers: string[] = [];
  let artifactInfo: { sha256: string; codeHash: string; bytes: number } | null = null;
  try { const a = loadApprovedArtifact(cfg.artifactsFile, spec.artifact.id, spec.artifact.version); artifactInfo = { sha256: a.sha256, codeHash: a.codeHashBase58, bytes: a.bytes.length }; } catch (e) { blockers.push((e as Error).message); }
  if (v.problems.length) blockers.push(...v.problems.map((p) => "terms: " + p));
  const funding = BigInt(spec.limits.fundingYocto), minBal = BigInt(spec.limits.minDeployerBalanceYocto), gasBuffer = 1n * NEAR, tokenReg = 1_250_000_000_000_000_000_000n;
  const need = funding + minBal + gasBuffer + tokenReg;
  const dep: any = await rpc.viewAccount(cfg.deployer.accountId);
  const bal = dep.exists ? BigInt(dep.amount) : 0n;
  if (!dep.exists) blockers.push(`deployer ${cfg.deployer.accountId} not found`);
  else if (bal < need) blockers.push(`deployer balance ${near(bal)} is below the ${near(need)} required (short by ${near(need - bal)})`);
  if (!cfg.deployer.credentialsFile || !existsSync(cfg.deployer.credentialsFile)) blockers.push("DEPLOYER_CREDENTIALS_FILE is not configured or not found (presence checked only; the file is never read by this tool)");
  const res: any = await rpc.viewAccount(spec.resolverAccount);
  if (!res.exists) blockers.push(`resolver ${spec.resolverAccount} not found`);
  let token: any = null;
  try { token = await rpc.callView(spec.collateralToken, "ft_metadata"); } catch (e) { blockers.push(`collateral token views failed: ${(e as Error).message}`); }
  const warnings: string[] = [];
  if (date === "2026-11-12") warnings.push("2026-11-12 is the persistent demo market's date: creating it would duplicate the demo.");
  if (!cfg.tokenOwner.credentialsFile) warnings.push("resolver/token-owner credentials not configured: the keeper could create the market but could not resolve it.");
  if ([cfg.deployer.accountId, cfg.resolver.accountId, cfg.tokenOwner.accountId].every((a) => a === cfg.deployer.accountId)) warnings.push("deployer, resolver and token owner are the SAME account: no key isolation.");
  const accountPattern = marketAccountName(spec.slug, occ.date, cfg.deployer.accountId, "<8 random hex>");
  const plan = {
    template: { slug: spec.slug, schedule: spec.schedule, enabledOnInsert: false, limits: spec.limits, resolution: spec.resolution },
    occurrence: { date: occ.date, dedupeKey: occ.dedupe },
    terms: v.market ? {
      initializer: { collateral_token: spec.collateralToken, market_id: v.market.marketId, question: v.market.question, rules: v.market.rules, resolution_source: v.market.resolutionSource, split_cutoff_ns: v.market.splitCutoffNs, resolver_id: spec.resolverAccount },
      tradingCutoff: { utc: new Date(occ.cutoffMs).toISOString(), ns: v.market.splitCutoffNs },
      observation: { startUtc: occ.obsStartMs ? new Date(occ.obsStartMs).toISOString() : null, endUtc: occ.obsEndMs ? new Date(occ.obsEndMs).toISOString() : null },
    } : null,
    artifact: artifactInfo,
    token: token ? { symbol: token.symbol, decimals: token.decimals } : null,
    account: { pattern: accountPattern, signer: cfg.deployer.accountId, keyHandling: "fresh ed25519 key written to KEYSTORE_DIR (0600, O_EXCL) and referenced in key_refs BEFORE funding" },
    funding: { toMarketAccount: near(funding), minDeployerBalanceKept: near(minBal), gasBuffer: near(gasBuffer), tokenRegistrationDeposit: near(tokenReg), totalDeployerBalanceRequired: near(need), deployerBalanceNow: near(bal), shortfall: bal >= need ? "none" : near(need - bal) },
    expectedTransactions: [
      { n: 1, signer: cfg.deployer.accountId, receiver: "<new market account>", batch: ["CreateAccount", `Transfer ${near(funding)}`, "AddKey full-access (fresh key)", `DeployContract ${artifactInfo?.bytes ?? "?"} bytes (sha256 ${artifactInfo?.sha256.slice(0, 12) ?? "?"}…)`, "FunctionCall new(initializer above), 100 Tgas"], note: "atomic: either the funded, initialised market exists or nothing does" },
      { n: 2, signer: cfg.deployer.accountId, receiver: spec.collateralToken, call: `storage_deposit {account_id:<market>, registration_only:true}`, deposit: near(tokenReg) },
    ],
    verification: ["code hash == artifact hash", "get_config/get_market equal the initializer values", "ft_metadata decimals == market decimals", "market registered on the token"],
    notExecuted: ["no recurring schedule is enabled by this plan", "no resolution transaction (Lagos resolves later via the reviewed-evidence workflow)"],
    warnings, blockers,
  };
  return { plan, hash: createHash("sha256").update(JSON.stringify({ t: spec, d: date, f: spec.limits })).digest("hex").slice(0, 16) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { plan, hash } = await buildPlan(arg("template", "templates/lagos-rain.testnet.json")!, arg("date", "2026-11-13")!);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\nplan hash: ${hash}\n${plan.blockers.length ? "BLOCKED: " + plan.blockers.length + " blocker(s) above. Nothing was written." : "No blockers. Nothing was written; run create-once with --confirm " + hash + " to execute."}`);
}
