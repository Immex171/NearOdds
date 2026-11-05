import { randomBytes } from "node:crypto";
import { KeyPair, actions } from "near-api-js";
import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import { withTx } from "../db/index.js";
import type { Rpc } from "../near/rpc.js";
import { RpcUnavailableError } from "../near/rpc.js";
import { TxExecutor } from "../near/tx.js";
import { publishMarket, verifyMarketOnChain } from "../registry/index.js";
import { JobFailed, RetryLater, type JobCtx } from "./jobs.js";
import { loadApprovedArtifact } from "./artifacts.js";
import type { Signers } from "./signers.js";
import { occurrenceFor, renderAndValidate } from "./template.js";
import { loadRevision } from "./templates.js";
import { BudgetError, markSpent, reserveBudget } from "./budget.js";

export interface KeeperDeps { cfg: Config; db: Db; rpc: Rpc; signers: Signers; tx: TxExecutor; now?: () => number }

const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
export const TOKEN_REGISTRATION_YOCTO = 1_250_000_000_000_000_000_000n;

export function marketAccountName(slug: string, date: string, parent: string, rand = randomBytes(4).toString("hex")): string {
  let s = slug.replace(/[^a-z0-9]/g, "").slice(0, 10);
  const mk = (x: string) => `mkt-${x}-${date.replace(/-/g, "")}-${rand}.${parent}`;
  while (mk(s).length > 64 && s.length > 1) s = s.slice(0, -1);
  return mk(s);
}

export async function createMarketJob(d: KeeperDeps, c: JobCtx): Promise<void> {
  const { db, rpc, signers, tx, cfg } = d;
  const now = d.now ?? Date.now;
  const job = c.job;
  const p = job.payload;

  const tpl = (await db.query("SELECT * FROM templates WHERE id=$1", [p.templateId])).rows[0];
  if (!tpl) throw new JobFailed(`template ${p.templateId} no longer exists`);
  const spec = await loadRevision(db, p.templateId, p.templateVersion); // frozen at scheduling time
  const [y, m, dd] = (p.occurrenceDate as string).split("-").map(Number);
  const occ = occurrenceFor(spec, p.templateVersion, y, m, dd);

  // ---- 1-4: validate, then persist intent (account name + recoverable key reference) BEFORE any funding.
  if (!p.intent) {
    const v = renderAndValidate(spec, occ, now());
    if (v.problems.length) throw new JobFailed("validation failed: " + v.problems.join("; "));
    let artifact;
    try { artifact = loadApprovedArtifact(cfg.artifactsFile, spec.artifact.id, spec.artifact.version); } catch (e) { throw new JobFailed((e as Error).message); }
    if (!tpl.enabled) throw new JobFailed("template was disabled before creation started");
    const funding = BigInt(spec.limits.fundingYocto);

    try { await reserveBudget(db, String(p.templateId), job.id, funding, spec.limits); }
    catch (e) { if (e instanceof BudgetError) throw new JobFailed(e.message); throw e; }

    const dep = await rpc.viewAccount(cfg.deployer.accountId); // unavailable => retry; never guess
    if (!dep.exists) throw new JobFailed(`deployer account ${cfg.deployer.accountId} does not exist`);
    const gasBuffer = 1n * NEAR;
    if (BigInt(dep.amount) < funding + BigInt(spec.limits.minDeployerBalanceYocto) + gasBuffer)
      throw new RetryLater(`insufficient_deployment_funding: deployer holds ${dep.amount} yocto; need ${funding + BigInt(spec.limits.minDeployerBalanceYocto) + gasBuffer}`, 10 * 60_000);

    const accountName = marketAccountName(spec.slug, occ.date, cfg.deployer.accountId);
    const kp = KeyPair.fromRandom("ed25519");
    const pub = kp.getPublicKey().toString();
    const secretRef = signers.ks.writeNew(accountName, kp); // O_EXCL: refuses to overwrite
    const initArgs = {
      collateral_token: spec.collateralToken, market_id: v.market!.marketId, question: v.market!.question, rules: v.market!.rules,
      resolution_source: v.market!.resolutionSource, split_cutoff_ns: v.market!.splitCutoffNs, resolver_id: spec.resolverAccount,
    };
    const intent = { accountName, publicKey: pub, secretRef, initArgs, fundingYocto: funding.toString(), artifactSha256: artifact.sha256, obsStartNs: v.market!.obsStartNs, obsEndNs: v.market!.obsEndNs, templateSlug: spec.slug };
    await withTx(db, async (cl) => {
      await cl.query("INSERT INTO key_refs(account_id, public_key, secret_ref, purpose, job_id) VALUES ($1,$2,$3,'market-account',$4)", [accountName, pub, secretRef, job.id]);
      await cl.query(
        `INSERT INTO deployment_records(job_id, contract_id, deployer_id, init_args, artifact_id, artifact_version, artifact_sha256, code_hash_base58, source_version, accounts, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'intent')`,
        [job.id, accountName, cfg.deployer.accountId, JSON.stringify(initArgs), artifact.id, artifact.version, artifact.sha256, artifact.codeHashBase58, artifact.sourceVersion,
          JSON.stringify({ market: accountName, token: spec.collateralToken, deployer: cfg.deployer.accountId, resolver: spec.resolverAccount, keyPublic: pub })]);
      const r = await cl.query("UPDATE jobs SET payload = payload || $3::jsonb, step='intent_persisted', updated_at=now() WHERE id=$1 AND owner=$2", [job.id, job.owner, JSON.stringify({ intent })]);
      if (!r.rowCount) throw new Error("lease lost");
    });
    job.payload = { ...job.payload, intent };
  }
  const intent = job.payload.intent;
  const artifact = (() => { try { return loadApprovedArtifact(cfg.artifactsFile, spec.artifact.id, spec.artifact.version); } catch (e) { throw new JobFailed((e as Error).message); } })();
  if (artifact.sha256 !== intent.artifactSha256) throw new JobFailed("approved artifact changed since intent was recorded");

  // ---- 5-6: ONE batch transaction: create + fund + add key + deploy + new(). Atomic: never a funded-but-uninitialised market.
  const deployer = await signers.reg.get(cfg.deployer.accountId);
  const existingJ = await tx.getJournal(`create:${job.id}`);
  if (!existingJ) {
    // Not yet signed: safe to look at the account. An explicit UNKNOWN_ACCOUNT lets us proceed; an unavailable RPC throws and we retry.
    const look = await rpc.viewAccount(intent.accountName);
    if (look.exists) throw new JobFailed(`account ${intent.accountName} already exists but this job never signed a creation: refusing to touch a foreign account`);
    if (!deployer) throw new RetryLater("deployer signer is not available (set DEPLOYER_CREDENTIALS_FILE)", 5 * 60_000);
  }
  if (!p.createTx) {
    const signer = deployer ?? (existingJ ? await signers.reg.get(existingJ.signer_id) : null);
    if (!signer) throw new RetryLater("deployer signer is not available", 5 * 60_000);
    const pub = KeyPair.fromString(signers.ks.read(intent.secretRef).secret as any).getPublicKey();
    const acts = [
      actions.createAccount(), actions.transfer(BigInt(intent.fundingYocto)), actions.addFullAccessKey(pub),
      actions.deployContract(artifact.bytes),
      actions.functionCall("new", intent.initArgs, 100n * TGAS, 0n),
    ];
    const out = await tx.execute(`create:${job.id}`, job.id, signer, intent.accountName, acts, `create+fund+deploy+init ${intent.accountName}`);
    await markSpent(db, job.id, BigInt(intent.fundingYocto));
    await c.patch({ createTx: out.transaction.hash, createBlockHash: out.transaction_outcome.block_hash }, "created");
  }
  let startHeight: number | null = job.payload.deployHeight ?? null;
  if (startHeight === null) {
    const b = await rpc.read("block", { block_id: job.payload.createBlockHash });
    startHeight = b.header.height; await c.patch({ deployHeight: startHeight });
  }

  // ---- 7: register with the collateral token (skip if already registered).
  const reg = await rpc.callView<unknown>(spec.collateralToken, "storage_balance_of", { account_id: intent.accountName });
  if (reg === null && !p.registerTx) {
    const signer = deployer ?? (await tx.getJournal(`register:${job.id}`).then((j) => (j ? signers.reg.get(j.signer_id) : null)));
    if (!signer) throw new RetryLater("deployer signer is not available", 5 * 60_000);
    const out = await tx.execute(`register:${job.id}`, job.id, signer, spec.collateralToken,
      [actions.functionCall("storage_deposit", { account_id: intent.accountName, registration_only: true }, 30n * TGAS, TOKEN_REGISTRATION_YOCTO)], `register ${intent.accountName} with ${spec.collateralToken}`);
    await c.patch({ registerTx: out.transaction.hash }, "registered");
  }

  // ---- 8: verify
  const v = await verifyMarketOnChain(rpc, {
    contractId: intent.accountName, tokenId: spec.collateralToken, marketId: intent.initArgs.market_id, resolverId: spec.resolverAccount,
    question: intent.initArgs.question, rules: intent.initArgs.rules, resolutionSource: intent.initArgs.resolution_source, cutoffNs: intent.initArgs.split_cutoff_ns,
    codeHashBase58: artifact.codeHashBase58,
  });
  if (!v.ok) {
    await db.query("UPDATE deployment_records SET status='verification_failed', verification=$2 WHERE job_id=$1", [job.id, JSON.stringify({ ok: false, problems: v.problems })]);
    throw new JobFailed("post-deploy verification failed: " + v.problems.join("; "));
  }

  // ---- 9: publish (registry + frontend API). Idempotent.
  await withTx(db, async (cl) => {
    const ref = await publishMarket(cl, {
      network: cfg.network, contractId: intent.accountName, internalMarketId: intent.initArgs.market_id, tokenId: spec.collateralToken, verification: v, source: "keeper",
      category: spec.category, tag: spec.tag ?? null, templateId: String(p.templateId), occurrenceKey: occ.dedupe,
      observationStartNs: intent.obsStartNs, observationEndNs: intent.obsEndNs, historyStartHeight: startHeight,
    });
    await cl.query("UPDATE deployment_records SET market_ref=$2, status='published', code_hash_base58=$3, tx_hashes=$4, verification=$5 WHERE job_id=$1",
      [job.id, ref, v.codeHash, JSON.stringify({ create_fund_deploy_init: job.payload.createTx, token_registration: job.payload.registerTx ?? null }), JSON.stringify({ ok: true, codeHash: v.codeHash, tokenRegistered: v.tokenRegistered, token: v.token, at: new Date().toISOString() })]);
    await cl.query("INSERT INTO resolution_watch(market_ref, policy, provider) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [ref, spec.resolution.policy, spec.resolution.policy === "automatic" ? spec.resolution.provider : null]);
    await cl.query("UPDATE jobs SET payload = payload || $2::jsonb WHERE id=$1", [job.id, JSON.stringify({ marketRef: ref })]);
  });
}

export function isRpcDown(e: unknown) { return e instanceof RpcUnavailableError; }
