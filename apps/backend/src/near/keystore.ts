import { openSync, writeSync, closeSync, readFileSync, mkdirSync, existsSync, constants } from "node:fs";
import { join } from "node:path";
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { Q } from "../db/index.js";

/**
 * File keystore. New keys are created with O_EXCL|mode 0600 so an existing key file is NEVER overwritten.
 * The DB (key_refs) only stores a reference; secrets never enter the database, logs or git.
 */
export class Keystore {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }

  fileFor(accountId: string, publicKey: string) { return `${accountId}.${publicKey.replace(/[^A-Za-z0-9]/g, "_")}.json`; }

  /** Writes the secret first (exclusive), then returns. Caller records key_refs in the DB afterwards (idempotent). */
  writeNew(accountId: string, kp: KeyPair): string {
    const pub = kp.getPublicKey().toString();
    const name = this.fileFor(accountId, pub);
    const fd = openSync(join(this.dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeSync(fd, JSON.stringify({ account_id: accountId, public_key: pub, private_key: kp.toString() })); } finally { closeSync(fd); }
    return name;
  }

  read(ref: string): { accountId: string; publicKey: string; secret: string } {
    const j = JSON.parse(readFileSync(join(this.dir, ref), "utf8"));
    return { accountId: j.account_id, publicKey: j.public_key, secret: j.private_key };
  }
  has(ref: string) { return existsSync(join(this.dir, ref)); }
}

export interface SigningKey { accountId: string; publicKey: string; signer: KeyPairSigner }

export function keyFromSecret(accountId: string, secret: string): SigningKey {
  const kp = KeyPair.fromString(secret as KeyPairString);
  return { accountId, publicKey: kp.getPublicKey().toString(), signer: new KeyPairSigner(kp) };
}

/** near-cli credentials JSON: {account_id, public_key, private_key}. */
export function keyFromCredentialsFile(accountId: string, file: string): SigningKey {
  const j = JSON.parse(readFileSync(file, "utf8"));
  return keyFromSecret(accountId, j.private_key ?? j.secret_key);
}

/** Resolves signing keys: configured signers first, else per-account key_refs in the keystore. */
export class SignerRegistry {
  private fixed = new Map<string, SigningKey>();
  constructor(private ks: Keystore, private db: Q) {}
  register(k: SigningKey) { this.fixed.set(k.accountId, k); }
  hasFixed(accountId: string) { return this.fixed.has(accountId); }
  async get(accountId: string, publicKey?: string): Promise<SigningKey | null> {
    const f = this.fixed.get(accountId);
    if (f && (!publicKey || f.publicKey === publicKey)) return f;
    const r = await this.db.query("SELECT public_key, secret_ref FROM key_refs WHERE account_id=$1 AND ($2::text IS NULL OR public_key=$2) ORDER BY created_at LIMIT 1", [accountId, publicKey ?? null]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    if (!this.ks.has(row.secret_ref)) return null;
    return keyFromSecret(accountId, this.ks.read(row.secret_ref).secret);
  }
}
