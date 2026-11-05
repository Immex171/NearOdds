import { actions } from "near-api-js";
import type { KeeperDeps } from "../keeper/create-market.js";
import { JobFailed, RetryLater, type JobCtx } from "../keeper/jobs.js";
import { TxFailedError } from "../near/tx.js";

const TGAS = 10n ** 12n;
export const TOKEN_REGISTRATION_YOCTO = 1_250_000_000_000_000_000_000n;

function burnt(outcome: any): bigint {
  let t = BigInt(outcome?.transaction_outcome?.outcome?.tokens_burnt ?? 0);
  for (const r of outcome?.receipts_outcome ?? []) t += BigInt(r.outcome?.tokens_burnt ?? 0);
  return t;
}

/**
 * Rebuild native-spend records from SUCCEEDED faucet transactions in the journal. A crash between a successful
 * registration/mint and its native_spend insert must still count against the budget. Idempotent.
 */
export async function recoverFaucetSpend(db: import("../db/index.js").Db): Promise<number> {
  const rows = (await db.query("SELECT op_key, outcome FROM tx_journal WHERE state='succeeded' AND (op_key LIKE 'faucet-reg:%' OR op_key LIKE 'faucet-mint:%')")).rows;
  let n = 0;
  for (const r of rows) {
    const [kind, id] = (r.op_key as string).split(":");
    const purpose = kind === "faucet-reg" ? "faucet_registration" : "faucet_mint_fee";
    const yocto = (kind === "faucet-reg" ? TOKEN_REGISTRATION_YOCTO : 0n) + burnt(r.outcome);
    const ins = await db.query("INSERT INTO native_spend(purpose, yocto, ref) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM native_spend WHERE purpose=$1 AND ref=$3)", [purpose, yocto.toString(), id]);
    n += ins.rowCount ?? 0;
  }
  return n;
}

/**
 * tNOC faucet job. Two journaled operations (register, mint), each signed at most once; both are resumable.
 * The claim row (unique request_key) + op keys keyed by claim id make duplicate minting impossible across retries and restarts.
 */
export async function mintJob(d: KeeperDeps, c: JobCtx): Promise<void> {
  const { db, rpc, tx, signers, cfg } = d;
  await recoverFaucetSpend(db);
  const claim = (await db.query("SELECT * FROM faucet_claims WHERE id=$1", [c.job.payload.claimId])).rows[0];
  if (!claim) throw new JobFailed("claim not found");
  if (claim.state === "minted") return;
  const token = c.job.payload.tokenId as string;
  const signer = await signers.reg.get(cfg.tokenOwner.accountId);
  const mintJournal = await tx.getJournal(`faucet-mint:${claim.id}`);
  if (!signer && !mintJournal) throw new RetryLater("token owner signer is not available", 5 * 60_000);
  try {
    if (!mintJournal) {
      const reg = await rpc.callView<unknown>(token, "storage_balance_of", { account_id: claim.account_id });
      if (reg === null) {
        await tx.execute(`faucet-reg:${claim.id}`, c.job.id, signer!, token, [actions.functionCall("storage_deposit", { account_id: claim.account_id, registration_only: true }, 30n * TGAS, TOKEN_REGISTRATION_YOCTO)], `faucet register ${claim.account_id}`);
        await recoverFaucetSpend(db);
      }
    }
    const signer2 = signer ?? (await signers.reg.get(mintJournal!.signer_id))!;
    await tx.execute(`faucet-mint:${claim.id}`, c.job.id, signer2, token, [actions.functionCall("mint", { account_id: claim.account_id, amount: claim.amount }, 30n * TGAS, 0n)], `faucet mint ${claim.amount} to ${claim.account_id}`);
    await recoverFaucetSpend(db);
    await db.query("UPDATE faucet_claims SET state='minted' WHERE id=$1", [claim.id]);
  } catch (e) {
    if (e instanceof TxFailedError) await db.query("UPDATE faucet_claims SET state='failed' WHERE id=$1 AND state='queued'", [claim.id]);
    throw e;
  }
}
