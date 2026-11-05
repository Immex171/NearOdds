import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "near-api-js";

const TAG = 2147484061; // 2^31 + 413

function borshString(s: string): Buffer { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); }

/** NEP-413 signed payload hash: sha256(borsh({tag, message, nonce, recipient, callback_url})). */
export function nep413Hash(message: string, nonce: Buffer, recipient: string, callbackUrl?: string | null): Buffer {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const tag = Buffer.alloc(4); tag.writeUInt32LE(TAG);
  const cb = callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]) : Buffer.from([0]);
  return createHash("sha256").update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), cb])).digest();
}

export function verifyNep413Signature(publicKey: string, signature: Buffer, message: string, nonce: Buffer, recipient: string): boolean {
  try { return PublicKey.from(publicKey).verify(nep413Hash(message, nonce, recipient), signature); } catch { return false; }
}

export const newNonce = () => randomBytes(32);
export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
