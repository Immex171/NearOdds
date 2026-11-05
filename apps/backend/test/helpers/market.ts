import { actions, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync } from "node:fs";
import type { Db } from "../../src/db/index.js";
import { backfillTransactions } from "../../src/indexer/runner.js";
import type { SigningKey } from "../../src/near/keystore.js";
import { publishMarket, verifyMarketOnChain } from "../../src/registry/index.js";
import { NEAR, TGAS, type TestChain } from "./chain.js";
import { MARKET_WASM } from "./sandbox.js";

/** Deploys a market directly (not through the keeper), publishes it, and returns helpers that ingest each tx. */
export async function setupMarket(chain: TestChain, db: Db, deployer: SigningKey, token: string, name: string, cutoffInMs: number, obsEndAfterCutoffMs = 0) {
  const id = `${name}.${chain.root.accountId}`;
  const kp = KeyPair.fromRandom("ed25519");
  const cutoffNs = ((BigInt(Date.now() + cutoffInMs)) * 1_000_000n).toString();
  const init = { collateral_token: token, market_id: "mkt-1", question: `Question ${name}?`, rules: "rules", resolution_source: "source", split_cutoff_ns: cutoffNs, resolver_id: deployer.accountId };
  const out = await chain.tx.execute(`mkt:${id}`, null, chain.root, id, [actions.createAccount(), actions.transfer(20n * NEAR), actions.addFullAccessKey(kp.getPublicKey()), actions.deployContract(readFileSync(MARKET_WASM)), actions.functionCall("new", init, 100n * TGAS, 0n)], "deploy market");
  await chain.call(deployer, token, "storage_deposit", { account_id: id, registration_only: true }, 1_250_000_000_000_000_000_000n, 30n * TGAS);
  const v = await verifyMarketOnChain(chain.sbx.rpc, { contractId: id, tokenId: token, marketId: "mkt-1", resolverId: deployer.accountId });
  if (!v.ok) throw new Error(v.problems.join(";"));
  const b = await chain.sbx.rpc.read("block", { block_id: out.transaction_outcome.block_hash });
  const obsEnd = obsEndAfterCutoffMs ? (BigInt(cutoffNs) + BigInt(obsEndAfterCutoffMs) * 1_000_000n).toString() : null;
  const ref = await publishMarket(db, { network: "sandbox", contractId: id, internalMarketId: "mkt-1", tokenId: token, verification: v, source: "keeper", category: "Test", observationEndNs: obsEnd, historyStartHeight: b.header.height });
  return { id, ref, cutoffNs };
}

export function actor(chain: TestChain, db: Db, market: { id: string }, token: string, everyone: string[]) {
  const hashes: { txHash: string; senders: string[] }[] = [];
  const ingest = async (hash: string) => { hashes.push({ txHash: hash, senders: everyone }); return backfillTransactions(db, chain.sbx.rpc, [{ txHash: hash, senders: everyone }]); };
  return {
    hashes,
    ingest,
    /** call a market method and ingest its receipts */
    async m(key: SigningKey, method: string, args: object, deposit = 1n, gas = 100n * TGAS) { const o = await chain.call(key, market.id, method, args, deposit, gas); await ingest(o.transaction.hash); return o; },
    async register(key: SigningKey) {
      await chain.call(key, token, "storage_deposit", { account_id: key.accountId, registration_only: true }, 1_250_000_000_000_000_000_000n, 30n * TGAS);
      const o = await chain.call(key, market.id, "storage_deposit", { account_id: null, registration_only: true }, 40_960_000_000_000_000_000_000n, 30n * TGAS);
      await ingest(o.transaction.hash);
    },
    async fund(owner: SigningKey, key: SigningKey, amount: string) {
      await chain.call(owner, token, "mint", { account_id: key.accountId, amount }, 0n, 30n * TGAS);
      const o = await chain.call(key, token, "ft_transfer_call", { receiver_id: market.id, amount, msg: "deposit" }, 1n, 300n * TGAS);
      await ingest(o.transaction.hash);
    },
  };
}
export { KeyPairSigner };
