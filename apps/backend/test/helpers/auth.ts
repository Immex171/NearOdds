import type { FastifyInstance } from "fastify";
import type { SigningKey } from "../../src/near/keystore.js";

/** Wallet-side NEP-413 signing, done with near-api-js's own signer (independent of our verifier). */
export async function signChallenge(key: SigningKey, ch: { message: string; recipient: string; nonce: string }, recipientOverride?: string) {
  const s = await key.signer.signNep413Message(key.accountId, { message: ch.message, recipient: recipientOverride ?? ch.recipient, nonce: new Uint8Array(Buffer.from(ch.nonce, "base64")) });
  return { accountId: key.accountId, publicKey: key.publicKey, signature: Buffer.from(s.signature).toString("base64"), nonce: ch.nonce };
}
export async function login(app: FastifyInstance, key: SigningKey): Promise<string> {
  const ch = (await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { accountId: key.accountId } })).json();
  const res = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: await signChallenge(key, ch) });
  if (res.statusCode !== 200) throw new Error("login failed: " + res.body);
  return res.json().token;
}
