import { createHash } from "node:crypto";
import { Transaction, SignedTransaction, createTransaction, baseDecode, baseEncode, type Action } from "near-api-js";
import { withTx, type Db } from "../db/index.js";
import { Rpc, RpcError, RpcUnavailableError } from "./rpc.js";
import type { SigningKey } from "./keystore.js";

export type TxState = "prepared" | "broadcast" | "uncertain" | "succeeded" | "failed";
export interface JournalRow { id: string; op_key: string; tx_hash: string; state: TxState; outcome: any; failure: string | null; signer_id: string; receiver_id: string; nonce: string; description: string }

export class TxUncertainError extends Error {
  constructor(readonly opKey: string, readonly txHash: string, msg: string) { super(msg); this.name = "TxUncertainError"; }
}
/** A lower-nonce transaction from the same signing key is still unresolved: this one must wait its turn (not an error in the job). */
export class TxBlockedError extends Error {
  constructor(readonly opKey: string, readonly waitingFor: string[]) { super(`tx ${opKey} waits for earlier transactions of the same key: ${waitingFor.join(", ")}`); this.name = "TxBlockedError"; }
}
/** The signing guard said no (e.g. the owner stopped the bot): nothing was signed. */
export class SigningRefusedError extends Error {
  constructor(readonly opKey: string) { super(`signing of ${opKey} was refused by its guard`); this.name = "SigningRefusedError"; }
}
/** Runs INSIDE the database transaction that persists the signed bytes; return false to refuse signing. */
export type SigningGuard = (c: import("../db/index.js").Tx) => Promise<boolean>;

export class TxFailedError extends Error {
  constructor(readonly opKey: string, readonly txHash: string, readonly failure: string) { super(`tx ${txHash} failed: ${failure}`); this.name = "TxFailedError"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Failure found anywhere in the receipt tree of a final outcome, or null. */
export function findFailure(outcome: any): string | null {
  const st = outcome?.status;
  if (st && typeof st === "object" && st.Failure) return JSON.stringify(st.Failure);
  for (const r of outcome?.receipts_outcome ?? []) {
    const s = r.outcome?.status;
    if (s && typeof s === "object" && s.Failure) return JSON.stringify(s.Failure);
  }
  return null;
}

/**
 * Journaled transaction executor.
 *  - A logical operation (opKey) is signed AT MOST ONCE. The signed bytes and hash are persisted before broadcast.
 *  - On timeout/unavailable RPC the same bytes may be re-broadcast, never re-signed.
 *  - Nonces for a signer are allocated under a row lock so concurrent workers never collide.
 */
export class TxExecutor {
  constructor(private db: Db, private rpc: Rpc, private pollTimeoutMs = 90000, private pollIntervalMs = 1500) {}

  async getJournal(opKey: string): Promise<JournalRow | null> {
    const r = await this.db.query("SELECT * FROM tx_journal WHERE op_key=$1", [opKey]);
    return r.rows[0] ?? null;
  }

  /** Sign + persist (no network write). Idempotent per opKey. */
  async prepare(opKey: string, jobId: string | null, key: SigningKey, receiverId: string, actions: Action[], description: string, guard?: SigningGuard): Promise<JournalRow> {
    const existing = await this.getJournal(opKey);
    if (existing) return existing;
    // reads first (may throw RpcUnavailable: nothing signed yet, safe to retry the whole prepare)
    const [ak, block] = await Promise.all([this.rpc.accessKey(key.accountId, key.publicKey), this.rpc.finalBlock()]);
    if (!ak) throw new Error(`signer key ${key.publicKey} is not an access key of ${key.accountId}`);
    return withTx(this.db, async (c) => {
      const again = await c.query("SELECT * FROM tx_journal WHERE op_key=$1", [opKey]);
      if (again.rowCount) return again.rows[0];
      // Guarded transition into durable signing: evaluated under locks, in the same transaction that stores the signature.
      if (guard && !(await guard(c))) throw new SigningRefusedError(opKey);
      await c.query("INSERT INTO signer_nonces(signer_id, public_key) VALUES ($1,$2) ON CONFLICT DO NOTHING", [key.accountId, key.publicKey]);
      const n = await c.query("SELECT last_nonce FROM signer_nonces WHERE signer_id=$1 AND public_key=$2 FOR UPDATE", [key.accountId, key.publicKey]);
      const last = BigInt(n.rows[0].last_nonce);
      const nonce = (ak.nonce > last ? ak.nonce : last) + 1n;
      const tx = createTransaction(key.accountId, (await key.signer.getPublicKey()), receiverId, nonce, actions, baseDecode(block.hash));
      const { txHash, signedTransaction } = await key.signer.signTransaction(tx);
      const hash = baseEncode(txHash);
      const b64 = Buffer.from(signedTransaction.encode()).toString("base64");
      await c.query("UPDATE signer_nonces SET last_nonce=$3 WHERE signer_id=$1 AND public_key=$2", [key.accountId, key.publicKey, nonce.toString()]);
      const ins = await c.query(
        `INSERT INTO tx_journal(job_id, op_key, signer_id, public_key, receiver_id, description, nonce, block_hash, tx_hash, signed_tx_b64, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared') RETURNING *`,
        [jobId, opKey, key.accountId, key.publicKey, receiverId, description, nonce.toString(), block.hash, hash, b64]);
      return ins.rows[0];
    });
  }

  private async setState(opKey: string, state: TxState, extra: { outcome?: unknown; failure?: string } = {}) {
    await this.db.query("UPDATE tx_journal SET state=$2, outcome=COALESCE($3::jsonb, outcome), failure=COALESCE($4, failure), updated_at=now() WHERE op_key=$1 AND state NOT IN ('succeeded','failed')",
      [opKey, state, extra.outcome === undefined ? null : JSON.stringify(extra.outcome), extra.failure ?? null]);
  }

  /**
   * Durable per-key ordering. A transaction may be broadcast only when every lower-nonce transaction of the same key is
   * terminal (succeeded/failed on chain). If a higher nonce landed first the lower one would be invalid forever.
   */
  async waitTurn(row: JournalRow, timeoutMs = this.pollTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.db.query(
        `SELECT t.op_key FROM tx_journal t JOIN tx_journal me ON me.op_key=$1
         WHERE t.signer_id = me.signer_id AND t.public_key = me.public_key AND t.nonce < me.nonce AND t.state NOT IN ('succeeded','failed') ORDER BY t.nonce`, [row.op_key]);
      if (!r.rowCount) return;
      if (Date.now() >= deadline) throw new TxBlockedError(row.op_key, r.rows.map((x: any) => x.op_key));
      await sleep(this.pollIntervalMs);
    }
  }

  /** Broadcast the SAME persisted bytes. Safe to call repeatedly. */
  async broadcast(row: JournalRow & { signed_tx_b64?: string }): Promise<void> {
    const full = row.signed_tx_b64 ? row : (await this.db.query("SELECT * FROM tx_journal WHERE op_key=$1", [row.op_key])).rows[0];
    try {
      await this.rpc.once("send_tx", { signed_tx_base64: full.signed_tx_b64, wait_until: "NONE" });
      await this.setState(row.op_key, "broadcast");
    } catch (e) {
      if (e instanceof RpcUnavailableError) { await this.setState(row.op_key, "uncertain", { failure: `broadcast unconfirmed: ${e.message}` }); return; }
      // Protocol rejection of an already-seen tx is fine; real rejections surface when we poll.
      if (e instanceof RpcError) { await this.setState(row.op_key, "uncertain", { failure: `broadcast: ${e.message}` }); return; }
      throw e;
    }
  }

  /** Poll tx status. Returns final outcome, null if still unknown. */
  async poll(row: JournalRow, timeoutMs = this.pollTimeoutMs): Promise<any | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const o = await this.rpc.once("tx", { tx_hash: row.tx_hash, sender_account_id: row.signer_id, wait_until: "FINAL" });
        if (o?.status && o.status !== "NotStarted" && o.status !== "Started") return o;
      } catch (e) {
        if (!(e instanceof RpcUnavailableError) && !(e instanceof RpcError)) throw e;
        // unknown-transaction / unavailable: keep waiting, never sign anew
      }
      if (Date.now() >= deadline) return null;
      await sleep(this.pollIntervalMs);
    }
  }

  /**
   * Drive an operation to a verdict. Throws TxUncertainError when the outcome cannot be established
   * (state `uncertain`; call again later to resume with the same signed tx) and TxFailedError on a chain failure.
   */
  async execute(opKey: string, jobId: string | null, key: SigningKey, receiverId: string, actions: Action[], description: string, guard?: SigningGuard): Promise<any> {
    let row = await this.prepare(opKey, jobId, key, receiverId, actions, description, guard);
    if (row.state === "succeeded") return row.outcome;
    if (row.state === "failed") throw new TxFailedError(opKey, row.tx_hash, row.failure ?? "failed");
    // prepared / broadcast / uncertain: first see if the chain already knows it (do not rebroadcast blindly)
    let outcome = await this.poll(row, 2000);
    if (!outcome) {
      await this.waitTurn(row);
      await this.broadcast(row);
      outcome = await this.poll(row);
    }
    if (!outcome) {
      await this.setState(opKey, "uncertain", { failure: "no final status before patience ran out" });
      throw new TxUncertainError(opKey, row.tx_hash, `transaction ${row.tx_hash} outcome unknown; resume later (same signed bytes)`);
    }
    const failure = findFailure(outcome);
    if (failure) {
      await this.setState(opKey, "failed", { outcome, failure });
      throw new TxFailedError(opKey, row.tx_hash, failure);
    }
    await this.setState(opKey, "succeeded", { outcome });
    return outcome;
  }
}

export function txHashOf(signedB64: string): string {
  const st = SignedTransaction.decode(Buffer.from(signedB64, "base64"));
  return baseEncode(createHash("sha256").update(st.transaction.encode()).digest());
}
export type { Transaction };
