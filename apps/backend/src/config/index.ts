import { readFileSync, existsSync } from "node:fs";

const env = process.env;
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : v === "true" || v === "1");
const big = (v: string | undefined, d: string) => BigInt(v && v !== "" ? v : d);

export interface ApprovedArtifact { id: string; version: string; path: string; sha256: string; sourceVersion: string }

export interface Config {
  databaseUrl: string;
  network: string;
  rpcUrl: string;
  neardataUrl: string;
  neardataApiKey: string | null;
  apiPort: number;
  apiHost: string;
  corsOrigins: string[];
  adminAccounts: string[];
  authRecipient: string;
  sessionTtlSeconds: number;
  keystoreDir: string;
  deployer: { accountId: string; credentialsFile: string | null };
  resolver: { accountId: string; credentialsFile: string | null };
  tokenOwner: { accountId: string; credentialsFile: string | null };
  artifactsFile: string;
  marketFundingYocto: bigint;
  faucet: { enabled: boolean; tokenId: string | null; cooldownSeconds: number; amount: bigint; perAccountLimit: bigint; globalDailyLimit: bigint; nearBudgetYocto: bigint };
  txPollTimeoutMs: number;
  rpcReadRetries: number;
}

export function loadConfig(e: NodeJS.ProcessEnv = env): Config {
  const deployer = e.DEPLOYER_ACCOUNT ?? "nearodds-deploy.testnet";
  return {
    databaseUrl: e.DATABASE_URL ?? "postgres://nearodds:nearodds@localhost:5440/nearodds",
    network: e.NEAR_NETWORK ?? "testnet",
    rpcUrl: e.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    neardataUrl: (e.NEARDATA_URL ?? "https://testnet.neardata.xyz").replace(/\/$/, ""),
    neardataApiKey: e.NEARDATA_API_KEY || null,
    apiPort: Number(e.API_PORT ?? 4000),
    apiHost: e.API_HOST ?? "127.0.0.1",
    corsOrigins: list(e.CORS_ORIGINS ?? "http://localhost:3000"),
    adminAccounts: list(e.ADMIN_ACCOUNTS),
    authRecipient: e.AUTH_RECIPIENT ?? "nearodds.app",
    sessionTtlSeconds: Number(e.SESSION_TTL_SECONDS ?? 86400),
    keystoreDir: e.KEYSTORE_DIR ?? "./.keystore",
    deployer: { accountId: deployer, credentialsFile: e.DEPLOYER_CREDENTIALS_FILE || null },
    resolver: { accountId: e.RESOLVER_ACCOUNT ?? deployer, credentialsFile: e.RESOLVER_CREDENTIALS_FILE || null },
    tokenOwner: { accountId: e.TOKEN_OWNER_ACCOUNT ?? deployer, credentialsFile: e.TOKEN_OWNER_CREDENTIALS_FILE || null },
    artifactsFile: e.APPROVED_ARTIFACTS_FILE ?? "./artifacts.json",
    marketFundingYocto: big(e.MARKET_FUNDING_YOCTO, "6000000000000000000000000"),
    faucet: {
      enabled: bool(e.FAUCET_ENABLED, true),
      tokenId: e.FAUCET_TOKEN_ID || null,
      cooldownSeconds: Number(e.FAUCET_COOLDOWN_SECONDS ?? 60),
      amount: big(e.FAUCET_AMOUNT, "100000000"),
      perAccountLimit: big(e.FAUCET_PER_ACCOUNT_LIMIT, "300000000"),
      globalDailyLimit: big(e.FAUCET_GLOBAL_DAILY_LIMIT, "10000000000"),
      nearBudgetYocto: big(e.FAUCET_NEAR_BUDGET_YOCTO, "500000000000000000000000"),
    },
    txPollTimeoutMs: Number(e.TX_POLL_TIMEOUT_MS ?? 90000),
    rpcReadRetries: Number(e.RPC_READ_RETRIES ?? 4),
  };
}

export function loadArtifacts(path: string): ApprovedArtifact[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as ApprovedArtifact[];
}
