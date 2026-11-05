import type { Tx } from "../db/index.js";

export interface EventCtx {
  marketRef: string; receiptId: string; logIndex: number; height: number; tsNs: string; txHash: string | null; event: string; data: any;
}

const ZERO = "0";
async function ensureAcct(c: Tx, ref: string, id: string, height: number) {
  await c.query("INSERT INTO account_state(market_ref, account_id, updated_height) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [ref, id, height]);
}
/** Adjust numeric columns by signed deltas, expressed in SQL so arithmetic is exact (NUMERIC). */
async function adj(c: Tx, ref: string, id: string, height: number, d: Partial<Record<"available_collateral" | "reserved_collateral" | "yes" | "no" | "reserved_yes" | "reserved_no" | "pending_withdrawal_amount", string>>) {
  await ensureAcct(c, ref, id, height);
  const entries = Object.entries(d);
  if (!entries.length) return;
  const params: unknown[] = [ref, id, height];
  const sets = entries.map(([k, v]) => {
    if (!/^-?\d+$/.test(String(v))) throw new Error(`bad amount for ${k}: ${v}`);
    params.push(v);
    return `${k} = ${k} + $${params.length}::numeric`;
  });
  await c.query(`UPDATE account_state SET ${sets.join(", ")}, updated_height=$3 WHERE market_ref=$1 AND account_id=$2`, params);
}
const neg = (v: string) => (v === "0" ? "0" : "-" + v);
const outcomeKey = (o: string) => (o === "Yes" ? "yes" : "no") as "yes" | "no";
const reservedKey = (o: string) => (o === "Yes" ? "reserved_yes" : "reserved_no") as "reserved_yes" | "reserved_no";

async function activity(c: Tx, x: EventCtx, account: string, kind: string, amount: string | null, detail: object = {}) {
  await c.query("INSERT INTO activity(market_ref, account_id, kind, amount, detail, receipt_id, log_index, ts_ns) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
    [x.marketRef, account, kind, amount, JSON.stringify(detail), x.receiptId, x.logIndex, x.tsNs]);
}
async function notify(c: Tx, ref: string, account: string | null, type: string, payload: object) {
  await c.query("INSERT INTO stream_events(market_ref, account_id, type, payload) VALUES ($1,$2,$3,$4)", [ref, account, type, JSON.stringify(payload)]);
}

/** Apply ONE event to the projections. Called only after the (receipt_id, log_index) insert succeeded (first time seen). */
export async function applyEvent(c: Tx, x: EventCtx): Promise<void> {
  const d = x.data, ref = x.marketRef, h = x.height;
  switch (x.event) {
    case "storage_registered":
      await ensureAcct(c, ref, d.account_id, h);
      await c.query("UPDATE account_state SET registered=true, updated_height=$3 WHERE market_ref=$1 AND account_id=$2", [ref, d.account_id, h]);
      await activity(c, x, d.account_id, "registered", null);
      await notify(c, ref, d.account_id, "account", { kind: "registered" });
      break;
    case "deposit":
      await adj(c, ref, d.account_id, h, { available_collateral: d.amount });
      await activity(c, x, d.account_id, "deposit", d.amount);
      await notify(c, ref, d.account_id, "account", { kind: "deposit" });
      break;
    case "split":
      await adj(c, ref, d.account_id, h, { available_collateral: neg(d.amount), yes: d.amount, no: d.amount });
      await activity(c, x, d.account_id, "split", d.amount);
      await notify(c, ref, d.account_id, "account", { kind: "split" });
      break;
    case "merge":
      await adj(c, ref, d.account_id, h, { available_collateral: d.amount, yes: neg(d.amount), no: neg(d.amount) });
      await activity(c, x, d.account_id, "merge", d.amount);
      await notify(c, ref, d.account_id, "account", { kind: "merge" });
      break;
    case "offer_created": {
      const k = outcomeKey(d.outcome);
      await adj(c, ref, d.owner_id, h, d.side === "Sell"
        ? { [k]: neg(d.reserved_shares), [reservedKey(d.outcome)]: d.reserved_shares }
        : { available_collateral: neg(d.reserved_collateral), reserved_collateral: d.reserved_collateral });
      await c.query(
        `INSERT INTO offers(market_ref, offer_id, owner_id, outcome, side, price, quantity, remaining, expires_at_ns, created_ns, state, reserved_collateral, reserved_shares, updated_height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,'open',$10,$11,$12) ON CONFLICT DO NOTHING`,
        [ref, d.offer_id, d.owner_id, d.outcome, d.side, d.price, d.quantity, d.expires_at_ns ?? null, x.tsNs, d.reserved_collateral, d.reserved_shares, h]);
      await activity(c, x, d.owner_id, "offer_created", d.quantity, { offerId: d.offer_id, outcome: d.outcome, side: d.side, price: d.price });
      await notify(c, ref, d.owner_id, "book", { offerId: d.offer_id, outcome: d.outcome, side: d.side });
      break;
    }
    case "offer_filled": {
      const k = outcomeKey(d.outcome);
      // Volume: exactly one fills row per (receipt, log), guarded by the chain_events insert upstream AND this unique key.
      const ins = await c.query(
        `INSERT INTO fills(market_ref, receipt_id, log_index, offer_id, maker_id, taker_id, outcome, maker_side, price, quantity, collateral_amount, block_height, ts_ns)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
        [ref, x.receiptId, x.logIndex, d.offer_id, d.maker_id, d.taker_id, d.outcome, d.maker_side, d.price, d.quantity, d.collateral_amount, h, x.tsNs]);
      if (!ins.rowCount) break;
      if (d.maker_side === "Sell") { // maker gives reserved shares, taker pays collateral
        await adj(c, ref, d.maker_id, h, { [reservedKey(d.outcome)]: neg(d.quantity), available_collateral: d.collateral_amount });
        await adj(c, ref, d.taker_id, h, { available_collateral: neg(d.collateral_amount), [k]: d.quantity });
      } else { // maker buys: pays from reserved collateral; taker gives available shares
        await adj(c, ref, d.maker_id, h, { reserved_collateral: neg(d.collateral_amount), [k]: d.quantity });
        await adj(c, ref, d.taker_id, h, { [k]: neg(d.quantity), available_collateral: d.collateral_amount });
      }
      const sellRes = d.maker_side === "Sell" ? d.quantity : ZERO, buyRes = d.maker_side === "Buy" ? d.collateral_amount : ZERO;
      await c.query(
        `UPDATE offers SET remaining=LEAST(remaining, $3::numeric), state=CASE WHEN $3::numeric=0 THEN 'filled' ELSE state END,
           reserved_shares = GREATEST(reserved_shares - $4::numeric, 0), reserved_collateral = GREATEST(reserved_collateral - $5::numeric, 0), updated_height=$6
         WHERE market_ref=$1 AND offer_id=$2`, [ref, d.offer_id, d.remaining_quantity, sellRes, buyRes, h]);
      const det = { offerId: d.offer_id, outcome: d.outcome, price: d.price, quantity: d.quantity, collateral: d.collateral_amount };
      await activity(c, x, d.maker_id, "fill_maker", d.collateral_amount, det);
      await activity(c, x, d.taker_id, "fill_taker", d.collateral_amount, det);
      await notify(c, ref, null, "trade", { ...det, ts_ns: x.tsNs });
      await notify(c, ref, d.maker_id, "account", { kind: "fill" });
      await notify(c, ref, d.taker_id, "account", { kind: "fill" });
      break;
    }
    case "offer_cancelled": {
      const k = outcomeKey(d.outcome);
      await adj(c, ref, d.owner_id, h, d.side === "Sell"
        ? { [reservedKey(d.outcome)]: neg(d.released_shares), [k]: d.released_shares }
        : { reserved_collateral: neg(d.released_collateral), available_collateral: d.released_collateral });
      await c.query("UPDATE offers SET state='cancelled', remaining=0, closed_receipt=$3, updated_height=$4 WHERE market_ref=$1 AND offer_id=$2", [ref, d.offer_id, x.receiptId, h]);
      await activity(c, x, d.owner_id, "offer_cancelled", d.remaining_quantity, { offerId: d.offer_id });
      await notify(c, ref, d.owner_id, "book", { offerId: d.offer_id, cancelled: true });
      break;
    }
    case "market_resolved":
      await c.query("UPDATE markets SET contract_status='Resolved', resolution=$2 WHERE market_ref=$1", [ref, JSON.stringify({ outcome: d.outcome, resolver_id: d.resolver_id, resolved_at_ns: d.resolved_at_ns, evidence: d.evidence })]);
      await c.query("UPDATE resolution_proposals SET decision='submitted' WHERE market_ref=$1 AND decision IN ('approved','pending')", [ref]);
      await notify(c, ref, null, "market_status", { status: "Resolved", outcome: d.outcome });
      break;
    case "position_redeemed": {
      // Cancellations released by this redeem already moved reserved -> available through their own offer_cancelled
      // events (same receipt). Here ONLY the payout is new collateral; every remaining share is burned.
      await ensureAcct(c, ref, d.account_id, h);
      await c.query("UPDATE account_state SET available_collateral = available_collateral + $3::numeric, yes=0, no=0, reserved_yes=0, reserved_no=0, reserved_collateral=0, redeemed=true, updated_height=$4 WHERE market_ref=$1 AND account_id=$2",
        [ref, d.account_id, d.payout, h]);
      await c.query("UPDATE offers SET state='released' WHERE market_ref=$1 AND closed_receipt=$2 AND state='cancelled'", [ref, x.receiptId]);
      await activity(c, x, d.account_id, "redeem", d.payout, { releasedCollateral: d.released_collateral, outcome: d.outcome });
      await notify(c, ref, d.account_id, "account", { kind: "redeem" });
      break;
    }
    case "withdrawal_requested":
      await adj(c, ref, d.account_id, h, { available_collateral: neg(d.amount), pending_withdrawal_amount: d.amount });
      await c.query("INSERT INTO withdrawals(market_ref, withdrawal_id, account_id, receiver_id, amount, status, requested_ns) VALUES ($1,$2,$3,$4,$5,'Pending',$6) ON CONFLICT DO NOTHING",
        [ref, d.withdrawal_id, d.account_id, d.receiver_id, d.amount, x.tsNs]);
      await activity(c, x, d.account_id, "withdrawal_requested", d.amount, { withdrawalId: d.withdrawal_id });
      await notify(c, ref, d.account_id, "account", { kind: "withdrawal_requested" });
      break;
    case "withdrawal_completed":
    case "withdrawal_failed_restored": {
      const ok = x.event === "withdrawal_completed";
      const upd = await c.query("UPDATE withdrawals SET status=$3, receiver_id=NULL, settled_ns=$4 WHERE market_ref=$1 AND withdrawal_id=$2 AND status='Pending'",
        [ref, d.withdrawal_id, ok ? "Completed" : "FailedRestored", x.tsNs]);
      if (!upd.rowCount) break; // already settled or unknown: never double-apply
      await adj(c, ref, d.account_id, h, ok ? { pending_withdrawal_amount: neg(d.amount) } : { pending_withdrawal_amount: neg(d.amount), available_collateral: d.amount });
      await activity(c, x, d.account_id, ok ? "withdrawal_completed" : "withdrawal_failed_restored", d.amount, { withdrawalId: d.withdrawal_id });
      await notify(c, ref, d.account_id, "account", { kind: x.event });
      break;
    }
  }
}
