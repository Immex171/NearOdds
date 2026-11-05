import { actions, KeyPair, KeyPairSigner } from "near-api-js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../../src/db/index.js";
import { TxExecutor } from "../../src/near/tx.js";
import { keyFromSecret, type SigningKey } from "../../src/near/keystore.js";
import type { Rpc } from "../../src/near/rpc.js";
import { MARKET_WASM, TOKEN_WASM, type Sandbox } from "./sandbox.js";

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
let seq = 0;

export class TestChain {
  tx: TxExecutor;
  root: SigningKey;
  constructor(public sbx: Sandbox, public db: Db) {
    this.tx = new TxExecutor(db, sbx.rpc, 60_000, 300);
    this.root = keyFromSecret(sbx.rootId, sbx.rootSecret);
  }
  /** Create `<name>.test.near` funded and keyed. Returns signing key. */
  async createAccount(name: string, nearAmount = 100n): Promise<SigningKey> {
    const id = `${name}.${this.root.accountId}`;
    const kp = KeyPair.fromRandom("ed25519");
    await this.tx.execute(`mk-acct:${id}`, null, this.root, id, [actions.createAccount(), actions.transfer(nearAmount * NEAR), actions.addFullAccessKey(kp.getPublicKey())], `create ${id}`);
    return { accountId: id, publicKey: kp.getPublicKey().toString(), signer: new KeyPairSigner(kp) };
  }
  async deployToken(owner: SigningKey, name = "tnoc"): Promise<string> {
    const id = `${name}.${this.root.accountId}`;
    const kp = KeyPair.fromRandom("ed25519");
    await this.tx.execute(`tok:${id}`, null, this.root, id, [actions.createAccount(), actions.transfer(30n * NEAR), actions.addFullAccessKey(kp.getPublicKey()), actions.deployContract(readFileSync(TOKEN_WASM)), actions.functionCall("new", { owner_id: owner.accountId }, 50n * TGAS, 0n)], `token ${id}`);
    return id;
  }
  call(key: SigningKey, receiver: string, method: string, args: object, deposit = 1n, gas = 100n * TGAS) {
    return this.tx.execute(`t${++seq}:${key.accountId}:${method}:${Date.now()}`, null, key, receiver, [actions.functionCall(method, args, gas, deposit)], `${method}`);
  }
}

export function writeCreds(key: SigningKey, secret: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "nearodds-creds-")), `${key.accountId}.json`);
  writeFileSync(f, JSON.stringify({ account_id: key.accountId, public_key: key.publicKey, private_key: secret }), { mode: 0o600 });
  return f;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type { Rpc };
