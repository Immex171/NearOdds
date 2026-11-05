import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import { withTx } from "../db/index.js";
import { HttpError } from "../api/http.js";
import { roleStatus } from "../keeper/signers.js";
import { enqueue } from "../keeper/jobs.js";
import { TOKEN_REGISTRATION_YOCTO } from "./mint.js";

const TESTNET_LIKE = new Set(["testnet", "sandbox", "localnet"]);
/** Reserved native NEAR per claim: registration deposit + a generous allowance for two transactions' gas. */
export const PER_CLAIM_NATIVE_RESERVE = TOKEN_REGISTRATION_YOCTO + 20_000_000_000_000_000_000_000n; // + 0.02 NEAR

export async function faucetToken(db: Db, cfg: Config): Promise<string | null> {
  if (cfg.faucet.tokenId) return cfg.faucet.tokenId;
  const r = await db.query("SELECT DISTINCT token_id FROM markets");
  return r.rowCount === 1 ? r.rows[0].token_id : null;
}

export async function faucetState(db: Db, cfg: Config) {
  const roles = roleStatus(cfg);
  const token = await faucetToken(db, cfg);
  let reason: string | null = null;
  if (!cfg.faucet.enabled) reason = "faucet is disabled by configuration";
  else if (!TESTNET_LIKE.has(cfg.network)) reason = `faucet only runs on test networks (network is ${cfg.network})`;
  else if (!roles.roles.tokenOwner.available) reason = "token-owner signer is not available (TOKEN_OWNER_CREDENTIALS_FILE)";
  else if (!token) reason = "no faucet token configured (FAUCET_TOKEN_ID)";
  const day = (await db.query("SELECT COALESCE(SUM(amount),0) s FROM faucet_claims WHERE state<>'failed' AND created_at > now() - interval '24 hours'")).rows[0].s;
  const spent = (await db.query("SELECT COALESCE(SUM(yocto),0) s FROM native_spend")).rows[0].s;
  const reserved = (await db.query("SELECT COUNT(*)::int n FROM faucet_claims WHERE state='queued'")).rows[0].n;
  return {
    enabled: reason === null, disabledReason: reason, tokenId: token, amountPerClaim: cfg.faucet.amount.toString(),
    limits: { perAccount: cfg.faucet.perAccountLimit.toString(), globalPer24h: cfg.faucet.globalDailyLimit.toString(), cooldownSeconds: cfg.faucet.cooldownSeconds },
    globalClaimedLast24h: day, nativeBudgetYocto: cfg.faucet.nearBudgetYocto.toString(), nativeSpentYocto: spent, queuedClaims: reserved,
    notice: "Test token with no value (tNOC). Distributed from the project's token-owner account; no NEAR is given to users.",
    keyIsolation: roles.note,
  };
}

export async function claimFaucet(db: Db, cfg: Config, accountId: string, idempotencyKey: string | undefined) {
  const st = await faucetState(db, cfg);
  if (!st.enabled) throw new HttpError(503, "faucet_disabled", st.disabledReason ?? "faucet disabled");
  const key = `${accountId}:${(idempotencyKey ?? "").slice(0, 80)}`;
  return withTx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(727002)"); // serialise quota decisions
    const dup = await c.query("SELECT * FROM faucet_claims WHERE request_key=$1", [key]);
    if (dup.rowCount) return { claim: dup.rows[0], replayed: true };
    if (!idempotencyKey) {
      const recent = await c.query("SELECT 1 FROM faucet_claims WHERE account_id=$1 AND state<>'failed' AND created_at > now() - make_interval(secs => $2)", [accountId, cfg.faucet.cooldownSeconds]);
      if (recent.rowCount) throw new HttpError(429, "cooldown", `wait ${cfg.faucet.cooldownSeconds}s between claims, or retry the same request with its Idempotency-Key`);
    }
    const amt = cfg.faucet.amount;
    const per = BigInt((await c.query("SELECT COALESCE(SUM(amount),0) s FROM faucet_claims WHERE account_id=$1 AND state<>'failed'", [accountId])).rows[0].s);
    if (per + amt > cfg.faucet.perAccountLimit) throw new HttpError(429, "account_quota", `per-account limit reached (${per} of ${cfg.faucet.perAccountLimit} base units claimed)`);
    const glob = BigInt((await c.query("SELECT COALESCE(SUM(amount),0) s FROM faucet_claims WHERE state<>'failed' AND created_at > now() - interval '24 hours'")).rows[0].s);
    if (glob + amt > cfg.faucet.globalDailyLimit) throw new HttpError(429, "global_quota", "global 24h faucet limit reached");
    const spent = BigInt((await c.query("SELECT COALESCE(SUM(yocto),0) s FROM native_spend")).rows[0].s);
    const queued = BigInt((await c.query("SELECT COUNT(*) n FROM faucet_claims WHERE state='queued'")).rows[0].n);
    if (spent + (queued + 1n) * PER_CLAIM_NATIVE_RESERVE > cfg.faucet.nearBudgetYocto) throw new HttpError(503, "native_budget", "faucet's native NEAR fee budget is exhausted");
    const ins = await c.query("INSERT INTO faucet_claims(account_id, amount, request_key) VALUES ($1,$2,$3) RETURNING *", [accountId, amt.toString(), key]);
    const claim = ins.rows[0];
    const job = await c.query("INSERT INTO jobs(kind, dedupe_key, state, payload) VALUES ('mint_tnoc', $1, 'queued', $2) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id", [`mint:${claim.id}`, JSON.stringify({ claimId: claim.id, tokenId: st.tokenId })]);
    if (job.rowCount) await c.query("UPDATE faucet_claims SET job_id=$2 WHERE id=$1", [claim.id, job.rows[0].id]);
    return { claim, replayed: false };
  });
}
export { enqueue };
