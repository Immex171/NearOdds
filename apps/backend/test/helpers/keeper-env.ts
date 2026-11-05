import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { makeDeps } from "../../src/keeper/loop.js";
import { Rpc } from "../../src/near/rpc.js";
import { TxExecutor } from "../../src/near/tx.js";
import type { Db } from "../../src/db/index.js";
import { TestChain, writeCreds } from "./chain.js";
import type { Sandbox } from "./sandbox.js";
import type { SigningKey } from "../../src/near/keystore.js";
import { REPO } from "./sandbox.js";

export function lagosTemplate(deployer: string, token: string, over: Record<string, unknown> = {}) {
  return {
    slug: "lagos-rain", category: "Weather", tag: "Lagos",
    questionTemplate: "Will it rain in Lagos on {{date}}?",
    rulesTemplate: "Observation: the Lagos calendar day {{date}} ({{timezone}}). Resolves YES if the NiMet daily weather report for {{date}} records measurable rain, otherwise NO. Trading closes {{cutoffUtc}}.",
    resolutionSource: "NiMet daily weather report, Lagos, {{date}}",
    schedule: { frequency: "daily", timezone: "Africa/Lagos", leadDays: 2, minLeadMinutes: 0 },
    cutoff: { offsetMinutesFromObservationStart: 0 },
    observation: { startOffsetMinutes: 0, durationMinutes: 1440 },
    evidence: { required: true, description: "Link or quote of the NiMet daily report for the observation date" },
    resolverAccount: deployer, collateralToken: token,
    artifact: { id: "market-wasm", version: "1.0.0" },
    limits: { fundingYocto: (5n * 10n ** 24n).toString(), creationBudgetYocto: (60n * 10n ** 24n).toString(), minDeployerBalanceYocto: (10n * 10n ** 24n).toString(), maxPerDay: 10 },
    resolution: { policy: "reviewed" },
    ...over,
  };
}

export async function keeperEnv(sbx: Sandbox, db: Db, chain: TestChain, deployer: SigningKey, secret: string, token: string) {
  const ks = mkdtempSync(join(tmpdir(), "nearodds-ks-"));
  const creds = writeCreds(deployer, secret);
  const cfg = loadConfig({
    DATABASE_URL: "x", NEAR_NETWORK: "sandbox", NEAR_RPC_URL: sbx.rpcUrl, KEYSTORE_DIR: ks,
    DEPLOYER_ACCOUNT: deployer.accountId, DEPLOYER_CREDENTIALS_FILE: creds, RESOLVER_ACCOUNT: deployer.accountId, RESOLVER_CREDENTIALS_FILE: creds,
    TOKEN_OWNER_ACCOUNT: deployer.accountId, TOKEN_OWNER_CREDENTIALS_FILE: creds,
    APPROVED_ARTIFACTS_FILE: resolve(REPO, "apps/backend/artifacts.json"), ADMIN_ACCOUNTS: deployer.accountId, TX_POLL_TIMEOUT_MS: "60000",
  } as NodeJS.ProcessEnv);
  const rpc = new Rpc({ url: sbx.rpcUrl, retries: 2, backoffMs: 50 });
  const deps = makeDeps(cfg, db, rpc);
  deps.tx = new TxExecutor(db, rpc, 60_000, 300);
  return { cfg, deps, ks, token, chain, rpc };
}
