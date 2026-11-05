import { actions } from "near-api-js";
import type { Db } from "../../src/db/index.js";
import type { SigningKey } from "../../src/near/keystore.js";
import { TxExecutor, type JournalRow } from "../../src/near/tx.js";
import type { BotDeps } from "../../src/trading-bot/cycle.js";
import { BotConfig } from "../../src/trading-bot/config.js";
import { TGAS, type TestChain } from "./chain.js";
import { U } from "./bot-fixtures.js";

export const cfgFor = (refs: string[], over: { funding?: any; limits?: any; strategy?: any; reference?: any } = {}) => BotConfig.parse({
  markets: refs.map((marketRef) => ({ marketRef, enabled: true, reference: { yesPrice: "500000", label: "sandbox fixture 0.50 (test value, not a recommendation)", source: "bot sandbox test", asOf: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...(over.reference ?? {}) } })),
  strategy: { spread: "50000", quantityPerQuote: U(10), quoteLifetimeSeconds: 3600, requoteThresholdPct: 50, refreshBeforeExpirySeconds: 30, ...(over.strategy ?? {}) },
  funding: { trancheId: 1, depositCollateral: U(20), splitCollateral: U(10), ...(over.funding ?? {}) },
  limits: { maxOrderQuantity: U(10), maxYesInventory: U(20), maxNoInventory: U(20), maxCollateralPerMarket: U(20), maxCollateralTotal: U(100), maxActiveOffersPerMarket: 4, maxNativeSpendYocto: "5000000000000000000000000", minNativeReserveYocto: "100000000000000000000000", maxTransactionsPerMinute: 600, referenceMaxAgeSeconds: 3600, maxChainDataAgeSeconds: 120, cutoffBufferSeconds: 300, ...(over.limits ?? {}) },
});

export async function insertBot(db: Db, slug: string, account: string, config: BotConfig, o: { mode?: string; desired?: string } = {}) {
  const r = await db.query("INSERT INTO trading_bots(slug, account_id, network, config, created_by, desired_state, mode) VALUES ($1,$2,'sandbox',$3,'test',$4,$5) RETURNING id", [slug, account, JSON.stringify(config), o.desired ?? "running", o.mode ?? "execute"]);
  await db.query("INSERT INTO trading_bot_configs(bot_id, version, config, created_by) VALUES ($1,1,$2,'test')", [r.rows[0].id, JSON.stringify(config)]);
  return r.rows[0].id as string;
}

export function botDeps(base: { cfg: any; rpc: any; tx: TxExecutor }, db: Db, keys: SigningKey[], tx?: TxExecutor): BotDeps {
  return { cfg: base.cfg, db, rpc: base.rpc, tx: tx ?? base.tx, signer: async (b) => keys.find((k) => k.accountId === b.account_id) ?? null };
}

/** Holds the FIRST broadcast until released: lets a test make an earlier-nonce transaction slow while another worker proceeds. */
export class GatedBroadcast extends TxExecutor {
  private gate!: () => void; private opened = new Promise<void>((r) => (this.gate = r)); armed = true; reached = false;
  release() { this.gate(); }
  override async broadcast(row: JournalRow) { if (this.armed) { this.armed = false; this.reached = true; await this.opened; } return super.broadcast(row); }
}
export class CrashAfter extends TxExecutor {
  crashed = false;
  constructor(db: Db, rpc: any, private match: RegExp) { super(db, rpc, 60_000, 300); }
  override async execute(op: string, job: string | null, k: any, r: string, a: any, d: string, g?: any) {
    const out = await super.execute(op, job, k, r, a, d, g);
    if (this.match.test(op) && !this.crashed) { this.crashed = true; throw new Error("simulated crash after on-chain success"); }
    return out;
  }
}

/** Create + pre-register a bot account (token and markets) and mint it test collateral, so scenarios can start at "deposit". */
export async function prepAccount(chain: TestChain, owner: SigningKey, key: SigningKey, token: string, markets: string[], mint: bigint) {
  await chain.call(key, token, "storage_deposit", { account_id: key.accountId, registration_only: true }, 1_250_000_000_000_000_000_000n, 30n * TGAS);
  for (const m of markets) await chain.call(key, m, "storage_deposit", { account_id: null, registration_only: true }, 40_960_000_000_000_000_000_000n, 30n * TGAS);
  if (mint > 0n) await chain.call(owner, token, "mint", { account_id: key.accountId, amount: mint.toString() }, 0n, 30n * TGAS);
}
export const views = (rpc: any, contract: string, account: string) => Promise.all([rpc.callView(contract, "get_account", { account_id: account }), rpc.callView(contract, "get_account_offers", { account_id: account })]) as Promise<[any, any[]]>;
export { actions };

/** Pauses a worker right BEFORE the signing step (before the guarded transition) until released. */
export class GateBeforePrepare extends TxExecutor {
  private open!: () => void; private opened = new Promise<void>((r) => (this.open = r)); armed = true; reached = false;
  release() { this.open(); }
  override async prepare(opKey: string, jobId: string | null, key: any, receiverId: string, acts: any[], description: string, guard?: any) {
    if (this.armed && !(await this.getJournal(opKey))) { this.armed = false; this.reached = true; await this.opened; }
    return super.prepare(opKey, jobId, key, receiverId, acts, description, guard);
  }
}
