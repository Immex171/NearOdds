import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import type { Rpc } from "../near/rpc.js";
import { RpcUnavailableError } from "../near/rpc.js";
import { HttpError } from "../api/http.js";
import { newNonce, sha256hex, verifyNep413Signature } from "./nep413.js";

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const validAccountId = (a: unknown): a is string => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT_RE.test(a);

export class AuthService {
  constructor(private db: Db, private rpc: Rpc, private recipient: string, private ttlSeconds: number, private admins: string[]) {}

  async challenge(accountId: string) {
    if (!validAccountId(accountId)) throw new HttpError(400, "bad_account", "invalid NEAR account id");
    const nonce = newNonce(); const hex = nonce.toString("hex");
    const expires = new Date(Date.now() + 5 * 60_000);
    const message = `Sign in to NearOdds as ${accountId}. Nonce ${hex.slice(0, 16)}. Expires ${expires.toISOString()}.`;
    await this.db.query("INSERT INTO auth_nonces(nonce, account_id, message, expires_at) VALUES ($1,$2,$3,$4)", [hex, accountId, message, expires]);
    return { accountId, message, recipient: this.recipient, nonce: nonce.toString("base64"), nonceHex: hex, expiresAt: expires.toISOString() };
  }

  async verify(i: { accountId: string; publicKey: string; signature: string; nonce: string }) {
    if (!validAccountId(i.accountId)) throw new HttpError(400, "bad_account", "invalid NEAR account id");
    const nonceBuf = Buffer.from(i.nonce, "base64");
    if (nonceBuf.length !== 32) throw new HttpError(400, "bad_nonce", "nonce must be 32 bytes (base64)");
    const hex = nonceBuf.toString("hex");
    // Single-use: consume atomically BEFORE any other check so a replay (even in parallel) can never succeed twice.
    const c = await this.db.query("UPDATE auth_nonces SET used_at=now() WHERE nonce=$1 AND account_id=$2 AND used_at IS NULL AND expires_at > now() RETURNING message", [hex, i.accountId]);
    if (!c.rowCount) throw new HttpError(401, "nonce_invalid", "challenge nonce is unknown, expired, already used, or for another account");
    const sig = Buffer.from(i.signature, "base64");
    if (!verifyNep413Signature(i.publicKey, sig, c.rows[0].message, nonceBuf, this.recipient)) throw new HttpError(401, "bad_signature", "signature does not verify for this message, recipient and nonce");
    let key;
    try { key = await this.rpc.accessKey(i.accountId, i.publicKey); } catch (e) { if (e instanceof RpcUnavailableError) throw new HttpError(503, "rpc_unavailable", "cannot confirm the signing key right now; try again"); throw e; }
    if (!key) throw new HttpError(401, "key_not_on_account", "public key is not a current access key of this account");
    if (key.permission !== "FullAccess") throw new HttpError(401, "key_not_full_access", "signing key must be a full-access key");
    const token = randomBytes(32).toString("base64url");
    const exp = new Date(Date.now() + this.ttlSeconds * 1000);
    await this.db.query("INSERT INTO sessions(token_hash, account_id, public_key, expires_at) VALUES ($1,$2,$3,$4)", [sha256hex(token), i.accountId, i.publicKey, exp]);
    return { token, accountId: i.accountId, expiresAt: exp.toISOString(), isAdmin: this.admins.includes(i.accountId) };
  }

  async session(token: string | undefined) {
    if (!token) return null;
    const r = await this.db.query("SELECT account_id, public_key, expires_at FROM sessions WHERE token_hash=$1 AND expires_at > now()", [sha256hex(token)]);
    if (!r.rowCount) return null;
    return { accountId: r.rows[0].account_id as string, publicKey: r.rows[0].public_key as string, expiresAt: new Date(r.rows[0].expires_at).toISOString(), isAdmin: this.admins.includes(r.rows[0].account_id) };
  }
  async logout(token: string) { await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256hex(token)]); }
}
