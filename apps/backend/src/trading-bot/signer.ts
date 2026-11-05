import { existsSync } from "node:fs";
import type { Config } from "../config/index.js";
import { keyFromCredentialsFile, type SigningKey } from "../near/keystore.js";
import type { Rpc } from "../near/rpc.js";
import type { BotRow } from "./ops.js";

const EXECUTION_NETWORKS = new Set(["sandbox", "testnet", "localnet"]);
export const executionNetworkAllowed = (network: string) => EXECUTION_NETWORKS.has(network);

export interface BotSignerStatus { configured: boolean; keyVerified: boolean; problem: string | null }

/**
 * Loads the bot's credentials from the file named by the env var `bot.credentials_env` (never from the database),
 * checks the account is distinct from the deployer / resolver / token-owner roles, and verifies the key is a current
 * FULL-ACCESS key of the bot account (the contract calls attach 1 yocto or a deposit, which function-call keys cannot do).
 */
export function makeBotSigner(cfg: Config, rpc: Rpc, env: NodeJS.ProcessEnv = process.env) {
  const cache = new Map<string, { at: number; key: SigningKey | null; status: BotSignerStatus }>();
  const status = async (bot: Pick<BotRow, "account_id" | "credentials_env">): Promise<{ key: SigningKey | null; status: BotSignerStatus }> => {
    const hit = cache.get(bot.account_id + bot.credentials_env);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
    let res: { key: SigningKey | null; status: BotSignerStatus };
    const file = env[bot.credentials_env];
    const others = [cfg.deployer.accountId, cfg.resolver.accountId, cfg.tokenOwner.accountId];
    if (others.includes(bot.account_id)) res = { key: null, status: { configured: false, keyVerified: false, problem: "bot account must be distinct from the deployer, resolver and token-owner accounts" } };
    else if (!file) res = { key: null, status: { configured: false, keyVerified: false, problem: `credentials not configured (env ${bot.credentials_env})` } };
    else if (!existsSync(file)) res = { key: null, status: { configured: false, keyVerified: false, problem: "credentials file not found" } };
    else {
      try {
        const key = keyFromCredentialsFile(bot.account_id, file);
        const ak = await rpc.accessKey(bot.account_id, key.publicKey);
        if (!ak) res = { key: null, status: { configured: true, keyVerified: false, problem: "the configured key is not an access key of the bot account" } };
        else if (ak.permission !== "FullAccess") res = { key: null, status: { configured: true, keyVerified: false, problem: "the configured key is not full-access (required for payable contract calls)" } };
        else res = { key, status: { configured: true, keyVerified: true, problem: null } };
      } catch (e) { return { key: null, status: { configured: true, keyVerified: false, problem: `could not verify key: ${(e as Error).message}` } }; } // not cached: retry next time
    }
    cache.set(bot.account_id + bot.credentials_env, { at: Date.now(), ...res });
    return res;
  };
  return { status, signer: async (bot: Pick<BotRow, "account_id" | "credentials_env">) => (await status(bot)).key };
}

/** API-process view: reports only non-secret facts (never loads keys). */
export function credentialsConfigured(bot: Pick<BotRow, "credentials_env">, env: NodeJS.ProcessEnv = process.env): boolean {
  const f = env[bot.credentials_env]; return !!f && existsSync(f);
}
