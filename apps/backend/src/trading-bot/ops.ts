import { actions as na } from "near-api-js";
import type { OfferView } from "@nearodds/types";
import type { Db } from "../db/index.js";
import { withTx } from "../db/index.js";
import type { SigningKey } from "../near/keystore.js";
import { RpcUnavailableError } from "../near/rpc.js";
import { SigningRefusedError, TxBlockedError, TxFailedError, TxUncertainError, type SigningGuard, type TxExecutor } from "../near/tx.js";
import type { BotConfig, Slot } from "./config.js";
import type { Action, Facts, Snapshot } from "./decide.js";
import { cost } from "./strategy.js";

const TGAS = 10n ** 12n;
export interface BotRow { id: string; slug: string; account_id: string; network: string; credentials_env: string; mode: "paper" | "execute"; desired_state: "disabled" | "running" | "paused" | "stopped"; state: string; config_version: number; config: BotConfig }
export interface OpRow { id: string; bot_id: string; market_ref: string; config_version: number; kind: string; slot: Slot | null; generation: number | null; op_key: string; params: any; state: string; offer_id: string | null; tx_hash: string | null; reason: string | null }
export interface MarketCtx { market_ref: string; contract_id: string; internal_market_id: string; token_id: string }
const PENDING = ["proposed", "submitted", "uncertain"];

export async function loadBot(db: Db, idOrSlug: string): Promise<BotRow | null> {
  const r = await db.query(/^\d+$/.test(idOrSlug) ? "SELECT * FROM trading_bots WHERE id=$1" : "SELECT * FROM trading_bots WHERE slug=$1", [idOrSlug]);
  return r.rows[0] ?? null;
}

/** DB-side facts: commitments, allocations, history. These never authorise spending of chain balances. */
export async function loadFacts(db: Db, bot: BotRow, marketRef: string): Promise<Facts & { pendingCount: number }> {
  const cfg = bot.config;
  const pending = (await db.query("SELECT COUNT(*)::int n FROM bot_operations WHERE bot_id=$1 AND market_ref=$2 AND state = ANY($3)", [bot.id, marketRef, PENDING])).rows[0].n;
  const alloc = (await db.query("SELECT market_ref, COALESCE(SUM((params->>'amount')::numeric),0) s FROM bot_operations WHERE bot_id=$1 AND kind='deposit' AND state='confirmed' GROUP BY market_ref", [bot.id])).rows;
  const spent = (await db.query("SELECT COALESCE(SUM(yocto),0) s FROM bot_native_spend WHERE bot_id=$1", [bot.id])).rows[0].s;
  const rate = (await db.query("SELECT COUNT(*)::int n FROM bot_operations WHERE bot_id=$1 AND created_at > now() - interval '60 seconds' AND state <> 'cancelled'", [bot.id])).rows[0].n;
  const fails = (await db.query("SELECT COUNT(*)::int n FROM bot_operations WHERE bot_id=$1 AND market_ref=$2 AND state='failed' AND updated_at > now() - interval '5 minutes'", [bot.id, marketRef])).rows[0].n;
  const tranche = cfg.funding.trancheId;
  const done = (await db.query("SELECT kind FROM bot_operations WHERE bot_id=$1 AND market_ref=$2 AND state='confirmed' AND kind IN ('deposit','split') AND (params->>'tranche')::int=$3", [bot.id, marketRef, tranche])).rows.map((r: any) => r.kind);
  return {
    desired: bot.desired_state, mode: bot.mode, hasPendingOps: pending > 0, pendingCount: pending,
    allocatedCollateral: BigInt(alloc.find((a: any) => a.market_ref === marketRef)?.s ?? 0), allocatedTotal: alloc.reduce((a: bigint, r: any) => a + BigInt(r.s), 0n),
    nativeSpent: BigInt(spent), txLastMinute: rate, recentFailures: fails, trancheDone: { deposit: done.includes("deposit"), split: done.includes("split") },
  };
}

export class ProposalConflict extends Error { constructor(readonly code: string, msg: string) { super(msg); } }

/**
 * Atomically reserve capacity and persist stable operation ids for a batch of actions.
 * Serialised per bot. Rejects if the bot stopped / its configuration changed, if the market already has operations in flight,
 * or if bot-wide commitments (token balance, native balance, spend limits, tx frequency) would be exceeded by pending + proposed work.
 */
export async function proposeOps(db: Db, bot: BotRow, m: MarketCtx, expectedVersion: number, acts: Action[], snap: Snapshot): Promise<OpRow[]> {
  return withTx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`botcap:${bot.id}`]);
    const cur = (await c.query("SELECT desired_state, mode, config_version, config FROM trading_bots WHERE id=$1 FOR SHARE", [bot.id])).rows[0];
    const cfg: BotConfig = cur.config; const L = cfg.limits;
    const growing = acts.some((a) => a.type !== "cancel");
    if (growing && cur.desired_state !== "running") throw new ProposalConflict("bot_not_running", `bot is ${cur.desired_state}`);
    if (growing && cur.config_version !== expectedVersion) throw new ProposalConflict("config_changed", `configuration changed (v${expectedVersion} -> v${cur.config_version})`);
    if (cur.mode !== "execute") throw new ProposalConflict("not_execute_mode", "bot is in paper mode: nothing may be proposed");
    const pend = (await c.query("SELECT market_ref, kind, params, commit_native FROM bot_operations WHERE bot_id=$1 AND state = ANY($2)", [bot.id, PENDING])).rows;
    if (pend.some((p: any) => p.market_ref === m.market_ref)) throw new ProposalConflict("operations_in_flight", "this market already has operations in flight");
    const pendDeposits = pend.filter((p: any) => p.kind === "deposit").reduce((a: bigint, p: any) => a + BigInt(p.params.amount), 0n);
    const pendNative = pend.reduce((a: bigint, p: any) => a + BigInt(p.commit_native), 0n);
    const spent = BigInt((await c.query("SELECT COALESCE(SUM(yocto),0) s FROM bot_native_spend WHERE bot_id=$1", [bot.id])).rows[0].s);
    const allocTotal = BigInt((await c.query("SELECT COALESCE(SUM((params->>'amount')::numeric),0) s FROM bot_operations WHERE bot_id=$1 AND kind='deposit' AND state='confirmed'", [bot.id])).rows[0].s);
    const rate = (await c.query("SELECT COUNT(*)::int n FROM bot_operations WHERE bot_id=$1 AND created_at > now() - interval '60 seconds' AND state <> 'cancelled'", [bot.id])).rows[0].n;
    if (rate + acts.length > L.maxTransactionsPerMinute) throw new ProposalConflict("rate_limited", "transaction frequency limit");
    const fee = BigInt(L.estimatedTxFeeYocto), reserve = BigInt(L.minNativeReserveYocto);
    const out: OpRow[] = [];
    let nativeAcc = pendNative, depAcc = pendDeposits;
    for (const a of acts) {
      let kind = "", slot: Slot | null = null, gen: number | null = null, base = "", params: any = {};
      let cCol = 0n, cYes = 0n, cNo = 0n, cNative = fee;
      switch (a.type) {
        case "register_token": kind = "register_token"; base = `bot:${bot.id}:token-reg:${m.token_id}`; params = { token: m.token_id, deposit: a.deposit.toString() }; cNative += a.deposit; break;
        case "register_market": kind = "register_market"; base = `bot:${bot.id}:${m.market_ref}:market-reg`; params = { deposit: a.deposit.toString() }; cNative += a.deposit; break;
        case "deposit": {
          kind = "deposit"; base = `bot:${bot.id}:${m.market_ref}:deposit:t${cfg.funding.trancheId}`; params = { amount: a.amount.toString(), tranche: cfg.funding.trancheId };
          if (depAcc + a.amount > snap.tokenBalance) throw new ProposalConflict("insufficient_token_balance", "pending deposits plus this one exceed the bot's token balance");
          if (allocTotal + depAcc + a.amount > BigInt(L.maxCollateralTotal)) throw new ProposalConflict("total_collateral_limit", "deposits would exceed the total collateral limit");
          depAcc += a.amount; break;
        }
        case "split": kind = "split"; base = `bot:${bot.id}:${m.market_ref}:split:t${cfg.funding.trancheId}`; params = { amount: a.amount.toString(), tranche: cfg.funding.trancheId }; cCol = a.amount; break;
        case "create": {
          kind = "create_offer"; slot = a.slot; params = { slot: a.slot, outcome: a.outcome, side: a.side, price: a.price.toString(), quantity: a.quantity.toString(), expiresAtNs: a.expiresAtNs.toString() };
          gen = (await c.query("SELECT COALESCE(MAX(generation),0)+1 g FROM bot_operations WHERE bot_id=$1 AND market_ref=$2 AND slot=$3 AND kind='create_offer'", [bot.id, m.market_ref, a.slot])).rows[0].g;
          base = `bot:${bot.id}:${m.market_ref}:create:${a.slot}:g${gen}`;
          if (a.side === "Sell") { if (a.outcome === "Yes") cYes = a.quantity; else cNo = a.quantity; } else cCol = cost(a.quantity, a.price, snap.trading.scale);
          break;
        }
        case "cancel": kind = "cancel_offer"; slot = a.slot; base = `bot:${bot.id}:${m.market_ref}:cancel:${a.offerId}`; params = { offerId: a.offerId, reason: a.reason }; break;
      }
      if (a.type !== "cancel") {
        if (nativeAcc + cNative + reserve > snap.nativeBalance) throw new ProposalConflict("needs_native", "native balance would fall below the reserve");
        if (spent + nativeAcc + cNative > BigInt(L.maxNativeSpendYocto)) throw new ProposalConflict("native_spend_limit", "native spending limit");
      }
      nativeAcc += cNative;
      // a previous FAILED attempt used the base key: retry under the next attempt number (a pending/confirmed one is returned as is)
      const prior = (await c.query("SELECT * FROM bot_operations WHERE op_key = $1 OR op_key LIKE $2 ORDER BY id DESC", [base, base + ":a%"])).rows;
      const live = prior.find((p: any) => p.state !== "failed" && p.state !== "cancelled");
      if (live) { out.push(live); continue; }
      const key = prior.length ? `${base}:a${prior.length + 1}` : base;
      const ins = await c.query(
        `INSERT INTO bot_operations(bot_id, market_ref, config_version, kind, slot, generation, op_key, params, state, commit_collateral, commit_yes, commit_no, commit_native, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9,$10,$11,$12,$13) RETURNING *`,
        [bot.id, m.market_ref, expectedVersion, kind, slot, gen, key, JSON.stringify(params), cCol.toString(), cYes.toString(), cNo.toString(), cNative.toString(), a.type === "cancel" ? a.reason : null]);
      out.push(ins.rows[0]);
    }
    return out;
  });
}

export interface ExecDeps { db: Db; tx: TxExecutor; signer: (bot: BotRow) => Promise<SigningKey | null> }
export type OpResult = "confirmed" | "failed" | "cancelled" | "uncertain" | "blocked";

function buildCall(op: OpRow, m: MarketCtx, bot: BotRow): { receiver: string; actions: any[]; desc: string } {
  const p = op.params;
  switch (op.kind) {
    case "register_token": return { receiver: m.token_id, actions: [na.functionCall("storage_deposit", { account_id: bot.account_id, registration_only: true }, 30n * TGAS, BigInt(p.deposit))], desc: `bot register ${bot.account_id} with token` };
    case "register_market": return { receiver: m.contract_id, actions: [na.functionCall("storage_deposit", { account_id: null, registration_only: true }, 30n * TGAS, BigInt(p.deposit))], desc: `bot register with market ${m.market_ref}` };
    case "deposit": return { receiver: m.token_id, actions: [na.functionCall("ft_transfer_call", { receiver_id: m.contract_id, amount: p.amount, msg: "deposit" }, 300n * TGAS, 1n)], desc: `bot deposit ${p.amount}` };
    case "split": return { receiver: m.contract_id, actions: [na.functionCall("split_position", { market_id: m.internal_market_id, amount: p.amount }, 100n * TGAS, 1n)], desc: `bot split ${p.amount}` };
    case "create_offer": return { receiver: m.contract_id, actions: [na.functionCall("create_offer", { market_id: m.internal_market_id, outcome: p.outcome, side: p.side, price: p.price, quantity: p.quantity, expires_at_ns: p.expiresAtNs }, 100n * TGAS, 1n)], desc: `bot ${p.slot} ${p.quantity}@${p.price}` };
    case "cancel_offer": return { receiver: m.contract_id, actions: [na.functionCall("cancel_offer", { offer_id: p.offerId }, 100n * TGAS, 1n)], desc: `bot cancel ${p.offerId}` };
  }
  throw new Error("unknown op kind " + op.kind);
}

const burnt = (o: any) => { let t = BigInt(o?.transaction_outcome?.outcome?.tokens_burnt ?? 0); for (const r of o?.receipts_outcome ?? []) t += BigInt(r.outcome?.tokens_burnt ?? 0); return t; };
const successJson = (o: any) => { const v = o?.status?.SuccessValue; return v ? JSON.parse(Buffer.from(v, "base64").toString("utf8")) : null; };

async function setOp(db: Db, id: string, state: string, extra: { tx_hash?: string; result?: unknown; offer_id?: string; failure?: string } = {}) {
  await db.query("UPDATE bot_operations SET state=$2, tx_hash=COALESCE($3,tx_hash), result=COALESCE($4::jsonb,result), offer_id=COALESCE($5,offer_id), failure=COALESCE($6,failure), updated_at=now() WHERE id=$1 AND state NOT IN ('confirmed','failed','cancelled')",
    [id, state, extra.tx_hash ?? null, extra.result === undefined ? null : JSON.stringify(extra.result), extra.offer_id ?? null, extra.failure ?? null]);
}

/**
 * The guarded transition into durable signing. It runs inside the transaction that stores the signed bytes, under
 *   - a SHARE lock on the bot row (stop / pause / config / mode changes take the same row exclusively, so they serialise with us) and
 *   - an exclusive lock on the operation row,
 * and refuses unless the operation is still pending AND the bot still wants it (execute mode; running with the same config version
 * for anything that grows exposure). A cancelled operation can therefore never be signed; one that passed this point is signed
 * and from then on is only reconciled.
 */
export function signingGuard(botId: string, op: Pick<OpRow, "id" | "kind" | "config_version">): SigningGuard {
  return async (c) => {
    const b = (await c.query("SELECT desired_state, mode, config_version FROM trading_bots WHERE id=$1 FOR SHARE", [botId])).rows[0];
    const o = (await c.query("SELECT state FROM bot_operations WHERE id=$1 FOR UPDATE", [op.id])).rows[0];
    if (!b || !o || (o.state !== "proposed" && o.state !== "submitted")) return false;
    if (b.mode !== "execute") return false;
    if (op.kind !== "cancel_offer" && (b.desired_state !== "running" || b.config_version !== op.config_version)) return false;
    return true;
  };
}

/**
 * Drive ONE operation to a verdict under its stable op key. A signed operation is always resumed with its original bytes;
 * an unsigned one passes the signing guard (above) or is cancelled without any signature.
 */
export async function runOperation(d: ExecDeps, bot: BotRow, m: MarketCtx, op: OpRow): Promise<OpResult> {
  const { db, tx } = d;
  const journal = await tx.getJournal(op.op_key);
  const signer = (await d.signer(bot)) ?? (journal ? await d.signer({ ...bot, account_id: journal.signer_id }) : null);
  if (!signer) return "blocked";
  const call = buildCall(op, m, bot);
  try {
    await setOp(db, op.id, "submitted");
    const out = await tx.execute(op.op_key, null, signer, call.receiver, call.actions, call.desc, journal ? undefined : signingGuard(bot.id, op));
    const hash = out.transaction.hash as string;
    let offerId: string | undefined;
    if (op.kind === "create_offer") {
      const ov = successJson(out) as OfferView | null;
      if (!ov?.offer_id) throw new Error("create_offer succeeded but returned no offer");
      offerId = ov.offer_id;
      await db.query(
        `INSERT INTO bot_quotes(bot_id, market_ref, offer_id, slot, price, quantity, remaining, expires_at_ns, config_version, op_id, origin, state)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,'created','active') ON CONFLICT DO NOTHING`,
        [bot.id, m.market_ref, ov.offer_id, op.params.slot, ov.price, ov.quantity, ov.expires_at_ns, op.config_version, op.id]);
    } else if (op.kind === "cancel_offer") {
      await db.query("UPDATE bot_quotes SET state='cancelled', close_reason=$4, closed_at=now(), remaining=0 WHERE bot_id=$1 AND market_ref=$2 AND offer_id=$3 AND state='active'", [bot.id, m.market_ref, op.params.offerId, op.params.reason ?? "cancelled"]);
    }
    await setOp(db, op.id, "confirmed", { tx_hash: hash, result: successJson(out) ?? {}, offer_id: offerId });
    await recordSpend(db, bot.id, op.id, op.kind, op.params, out, false);
    return "confirmed";
  } catch (e) {
    if (e instanceof SigningRefusedError) { await setOp(db, op.id, "cancelled", { failure: "not signed: the bot was stopped, paused, reconfigured or the operation was cancelled" }); return "cancelled"; }
    if (e instanceof TxUncertainError) { await setOp(db, op.id, "uncertain", { tx_hash: e.txHash }); return "uncertain"; }
    if (e instanceof TxFailedError) {
      await setOp(db, op.id, "failed", { tx_hash: e.txHash, failure: e.failure.slice(0, 500) });
      await recoverBotSpend(db, bot.id);   // a failed transaction still burnt gas: record it (exactly once) from the journal outcome
      return "failed";
    }
    if (e instanceof TxBlockedError) return "blocked";
    if (e instanceof RpcUnavailableError) return "blocked";
    throw e;
  }
}

/**
 * Actual native spending of one operation, from its final journal outcome:
 *   burnt gas (real for successful AND failed transactions) + the attached deposit when it stayed spent (successful registrations).
 * A failed transaction's attached deposit is refunded: recorded separately as `refunded_yocto`, never counted as spending.
 * Exactly once per operation (primary key on op_id).
 */
async function recordSpend(db: Db, botId: string, opId: string, kind: string, params: any, outcome: any, failed: boolean) {
  const attached = kind === "register_token" || kind === "register_market" ? BigInt(params.deposit) : 0n;
  const kept = failed ? 0n : attached, refunded = failed ? attached : 0n, fee = burnt(outcome);
  await db.query("INSERT INTO bot_native_spend(op_id, bot_id, yocto, burnt_yocto, deposit_yocto, refunded_yocto, op_outcome) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
    [opId, botId, (kept + fee).toString(), fee.toString(), kept.toString(), refunded.toString(), failed ? "failed" : "confirmed"]);
}

/** Rebuild missing spend records (confirmed AND failed operations) from the tx journal: covers crashes before recording. */
export async function recoverBotSpend(db: Db, botId: string): Promise<number> {
  const rows = (await db.query(
    `SELECT o.id, o.kind, o.params, o.state, j.outcome FROM bot_operations o JOIN tx_journal j ON j.op_key = o.op_key
     WHERE o.bot_id=$1 AND o.state IN ('confirmed','failed') AND j.state IN ('succeeded','failed') AND j.outcome IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bot_native_spend s WHERE s.op_id=o.id)`, [botId])).rows;
  for (const r of rows) await recordSpend(db, botId, r.id, r.kind, r.params, r.outcome, r.state === "failed");
  return rows.length;
}

export async function pendingOps(db: Db, botId: string, marketRef: string): Promise<OpRow[]> {
  return (await db.query("SELECT * FROM bot_operations WHERE bot_id=$1 AND market_ref=$2 AND state = ANY($3) ORDER BY id", [botId, marketRef, PENDING])).rows;
}

/**
 * Align bot_quotes with the chain. A missing offer does NOT prove a fill: it is only marked filled/cancelled when confirmed by
 * indexed events (or the bot's own cancel result); otherwise `gone_unconfirmed`. Unknown on-chain offers are adopted (they count toward exposure).
 */
export async function reconcileQuotes(db: Db, bot: BotRow, marketRef: string, offers: OfferView[], slotOf: (o: OfferView) => Slot) {
  const known = (await db.query("SELECT offer_id, state FROM bot_quotes WHERE bot_id=$1 AND market_ref=$2", [bot.id, marketRef])).rows;
  const live = new Map(offers.map((o) => [o.offer_id, o]));
  for (const o of offers) {
    const k = known.find((x: any) => x.offer_id === o.offer_id);
    if (!k) await db.query("INSERT INTO bot_quotes(bot_id, market_ref, offer_id, slot, price, quantity, remaining, expires_at_ns, origin, state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'adopted','active')", [bot.id, marketRef, o.offer_id, slotOf(o), o.price, o.quantity, o.remaining_quantity, o.expires_at_ns]);
    else await db.query("UPDATE bot_quotes SET remaining=$4, state='active', closed_at=NULL, close_reason=NULL WHERE bot_id=$1 AND market_ref=$2 AND offer_id=$3 AND state IN ('active','gone_unconfirmed')", [bot.id, marketRef, o.offer_id, o.remaining_quantity]);
  }
  for (const k of known.filter((x: any) => x.state === "active" && !live.has(x.offer_id))) {
    const ev = (await db.query("SELECT event, data FROM chain_events WHERE market_ref=$1 AND data->>'offer_id'=$2 AND event IN ('offer_filled','offer_cancelled') ORDER BY id DESC", [marketRef, k.offer_id])).rows;
    const filled = ev.find((e: any) => e.event === "offer_filled" && e.data.remaining_quantity === "0");
    const cancelled = ev.find((e: any) => e.event === "offer_cancelled");
    const state = filled ? "filled" : cancelled ? "cancelled" : "gone_unconfirmed";
    await db.query("UPDATE bot_quotes SET state=$4, remaining=0, closed_at=now(), close_reason=$5 WHERE bot_id=$1 AND market_ref=$2 AND offer_id=$3", [bot.id, marketRef, k.offer_id, state, state === "gone_unconfirmed" ? "no longer on chain; fill/cancel not confirmed by events" : state]);
  }
}
