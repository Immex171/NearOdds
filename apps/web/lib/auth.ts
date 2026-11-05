import type { Api } from "./api/client";
import type { ApiVerified } from "./api/types";

/** Application session issued by the backend after a NEP-413 signature. It is NOT a wallet connection. */
export interface AppSession { token: string; accountId: string; expiresAt: string; network: string; isAdmin: boolean }

const KEY = "nearodds:app-session:v1";
/** sessionStorage: a per-tab convenience that is gone when the tab closes; the wallet stays the source of identity. */
export const sessionStore = {
  load(): AppSession | null {
    try { const v = sessionStorage.getItem(KEY); return v ? (JSON.parse(v) as AppSession) : null; } catch { return null; }
  },
  save(s: AppSession) { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* unavailable */ } },
  clear() { try { sessionStorage.removeItem(KEY); } catch { /* unavailable */ } },
};

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  b.forEach((x) => { s += String.fromCharCode(x); });
  return btoa(s);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58ToBytes(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("invalid base58"); n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}

/** The backend wants a base64 signature. Wallets differ: plain base64, or "ed25519:<base58>". */
export function signatureToBase64(sig: string): string {
  return sig.startsWith("ed25519:") ? bytesToBase64(base58ToBytes(sig.slice("ed25519:".length))) : sig;
}

export interface MessageSigner { signMessage(message: string, recipient: string, nonce: Uint8Array): Promise<{ accountId: string; publicKey: string; signature: string }> }

/**
 * NEP-413 sign-in: challenge -> wallet signs (message, recipient, DECODED nonce) -> verify.
 * Throws if the wallet signed for a different account than the one that asked.
 */
export async function authenticate(api: Api, signer: MessageSigner, accountId: string, network: string): Promise<AppSession> {
  const ch = await api.challenge(accountId);
  const nonce = base64ToBytes(ch.nonce);
  if (nonce.length !== 32) throw new Error("The server sent a malformed sign-in challenge.");
  const signed = await signer.signMessage(ch.message, ch.recipient, nonce);
  if (signed.accountId !== accountId) throw new Error(`Your wallet signed as ${signed.accountId}, not ${accountId}. Switch accounts and try again.`);
  const v: ApiVerified = await api.verify({ accountId, publicKey: signed.publicKey, signature: signatureToBase64(signed.signature), nonce: ch.nonce });
  return { token: v.token, accountId: v.accountId, expiresAt: v.expiresAt, network, isAdmin: v.isAdmin };
}
