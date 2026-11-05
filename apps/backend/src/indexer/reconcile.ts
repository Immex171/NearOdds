import type { AccountView, MarketView, OfferView, WithdrawalView } from "@nearodds/types";
import type { Db } from "../db/index.js";
import { withTx } from "../db/index.js";
import type { Rpc } from "../near/rpc.js";

export interface ReconcileReport {
  marketRef: string; blockHeight: number; at: string; ok: boolean;
  offersChecked: number; offerDrift: string[]; accountsChecked: number; accountDrift: string[]; withdrawalFixes: string[]; skipped?: string;
}

const COMBOS: ["Yes" | "No", "Buy" | "Sell"][] = [["Yes", "Buy"], ["Yes", "Sell"], ["No", "Buy"], ["No", "Sell"]];

/** Complete, paged offer list at a fixed block. list_offers is storage-ordered, so page until a short page. */
export async function fetchAllOffers(rpc: Rpc, contract: string, marketId: string, block: { block_id: number } | { finality: "final" }): Promise<OfferView[]> {
  const all: OfferView[] = [];
  for (const [outcome, side] of COMBOS) {
    for (let from = 0; ; from += 50) {
      const page = await rpc.callView<OfferView[]>(contract, "list_offers", { market_id: marketId, outcome, side, from_index: String(from), limit: 50 }, block);
      all.push(...page);
      if (page.length < 50) break;
    }
  }
  return all;
}

/**
 * Compare projections with contract views AT THE INDEXER CHECKPOINT BLOCK, then correct to the views.
 * Called by the worker right after the indexer step so no later events are applied yet.
 */
export async function reconcileMarket(db: Db, rpc: Rpc, marketRef: string, height: number): Promise<ReconcileReport> {
  const m = (await db.query("SELECT * FROM markets WHERE market_ref=$1", [marketRef])).rows[0];
  const rep: ReconcileReport = { marketRef, blockHeight: height, at: new Date().toISOString(), ok: true, offersChecked: 0, offerDrift: [], accountsChecked: 0, accountDrift: [], withdrawalFixes: [] };
  const block = { block_id: height };
  let mv: MarketView, offers: OfferView[];
  try {
    mv = await rpc.callView<MarketView>(m.contract_id, "get_market", { market_id: m.internal_market_id }, block);
    offers = await fetchAllOffers(rpc, m.contract_id, m.internal_market_id, block);
  } catch (e) { rep.ok = false; rep.skipped = `views unavailable at block ${height}: ${(e as Error).message}`; await db.query("UPDATE markets SET reconcile=$2 WHERE market_ref=$1", [marketRef, JSON.stringify(rep)]); return rep; }

  const accounts = (await db.query("SELECT account_id FROM account_state WHERE market_ref=$1", [marketRef])).rows.map((r: any) => r.account_id as string);
  for (const o of offers) if (!accounts.includes(o.owner_id)) accounts.push(o.owner_id);
  // participants seen in ANY event (including historical ones that could not change balances) are hydrated from the views too
  for (const r of (await db.query("SELECT account_id FROM market_participants WHERE market_ref=$1", [marketRef])).rows) if (!accounts.includes(r.account_id)) accounts.push(r.account_id);
  const views = new Map<string, AccountView | null>();
  const wd = new Map<string, WithdrawalView | null>();
  try {
    for (const a of accounts) {
      views.set(a, await rpc.callView<AccountView | null>(m.contract_id, "get_account", { account_id: a }, block));
      wd.set(a, await rpc.callView<WithdrawalView | null>(m.contract_id, "get_withdrawal", { account_id: a }, block));
    }
  } catch (e) { rep.ok = false; rep.skipped = `account views unavailable: ${(e as Error).message}`; await db.query("UPDATE markets SET reconcile=$2 WHERE market_ref=$1", [marketRef, JSON.stringify(rep)]); return rep; }

  await withTx(db, async (c) => {
    // Serialise with ingestion for this market. Never overwrite a snapshot that already contains newer events.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [marketRef]);
    const cur = (await c.query("SELECT snapshot_height, applied_height FROM markets WHERE market_ref=$1", [marketRef])).rows[0];
    const newest = Math.max(Number(cur.snapshot_height ?? 0), Number(cur.applied_height ?? 0));
    if (newest > height) { rep.ok = false; rep.skipped = `stale reconcile at ${height}: snapshot already reflects block ${newest}`; return; }
    await c.query("UPDATE markets SET snapshot_height=$2, applied_height=$2 WHERE market_ref=$1", [marketRef, height]);
    await c.query("UPDATE markets SET contract_status=$2, resolution=$3, outstanding_yes=$4, outstanding_no=$5, market_backing=$6 WHERE market_ref=$1",
      [marketRef, mv.status, mv.resolution ? JSON.stringify(mv.resolution) : null, mv.outstanding_yes, mv.outstanding_no, mv.market_backing]);
    // --- offers
    const live = new Set(offers.map((o) => o.offer_id));
    rep.offersChecked = offers.length;
    const db_ = (await c.query("SELECT offer_id, remaining, state FROM offers WHERE market_ref=$1 AND state='open'", [marketRef])).rows;
    for (const r of db_) if (!live.has(r.offer_id)) {
      // "No active record" does not prove it was filled: keep it out of quotes but do not claim a history.
      rep.offerDrift.push(`offer ${r.offer_id}: open in projection but absent on chain`);
      await c.query("UPDATE offers SET state='gone', remaining=0 WHERE market_ref=$1 AND offer_id=$2", [marketRef, r.offer_id]);
    }
    const have = new Map(db_.map((r: any) => [r.offer_id, r.remaining]));
    for (const o of offers) {
      if (!have.has(o.offer_id)) {
        const ex = await c.query("SELECT state FROM offers WHERE market_ref=$1 AND offer_id=$2", [marketRef, o.offer_id]);
        if (ex.rowCount) { rep.offerDrift.push(`offer ${o.offer_id}: projection state ${ex.rows[0].state} but live on chain`); }
        else rep.offerDrift.push(`offer ${o.offer_id}: live on chain but never seen in events (pre-coverage history)`);
      } else if (have.get(o.offer_id) !== o.remaining_quantity) rep.offerDrift.push(`offer ${o.offer_id}: remaining ${have.get(o.offer_id)} != chain ${o.remaining_quantity}`);
      await c.query(
        `INSERT INTO offers(market_ref, offer_id, owner_id, outcome, side, price, quantity, remaining, expires_at_ns, created_ns, state, reserved_collateral, reserved_shares, updated_height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,$12,$13)
         ON CONFLICT (market_ref, offer_id) DO UPDATE SET remaining=$8, state='open', reserved_collateral=$11, reserved_shares=$12, updated_height=$13`,
        [marketRef, o.offer_id, o.owner_id, o.outcome, o.side, o.price, o.quantity, o.remaining_quantity, o.expires_at_ns, o.created_at_ns, o.reserved_collateral, o.reserved_shares, height]);
    }
    // --- accounts
    for (const a of accounts) {
      const v = views.get(a);
      if (!v) continue;
      rep.accountsChecked++;
      const cur = (await c.query("SELECT * FROM account_state WHERE market_ref=$1 AND account_id=$2", [marketRef, a])).rows[0];
      const pend = v.pending_withdrawal?.status === "Pending" ? v.pending_withdrawal.amount : "0";
      const want: Record<string, string> = { available_collateral: v.available_collateral, reserved_collateral: v.reserved_collateral, yes: v.yes, no: v.no, reserved_yes: v.reserved_yes, reserved_no: v.reserved_no, pending_withdrawal_amount: pend };
      const diffs = cur ? Object.keys(want).filter((k) => cur[k] !== want[k]).map((k) => `${a}.${k}: projected ${cur[k]} chain ${want[k]}`) : [`${a}: not projected`];
      rep.accountDrift.push(...diffs);
      await c.query(
        `INSERT INTO account_state(market_ref, account_id, registered, available_collateral, reserved_collateral, yes, no, reserved_yes, reserved_no, pending_withdrawal_amount, last_reconciled_height, drift, updated_height)
         VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10)
         ON CONFLICT (market_ref, account_id) DO UPDATE SET registered=true, available_collateral=$3, reserved_collateral=$4, yes=$5, no=$6, reserved_yes=$7, reserved_no=$8, pending_withdrawal_amount=$9, last_reconciled_height=$10, drift=$11`,
        [marketRef, a, want.available_collateral, want.reserved_collateral, want.yes, want.no, want.reserved_yes, want.reserved_no, want.pending_withdrawal_amount, height, diffs.length ? JSON.stringify(diffs) : null]);
      // --- withdrawal status checked EXPLICITLY (a non-null record can be Completed)
      const w = wd.get(a);
      if (w) {
        const cw = (await c.query("SELECT status FROM withdrawals WHERE market_ref=$1 AND withdrawal_id=$2", [marketRef, w.withdrawal_id])).rows[0];
        if (!cw) {
          await c.query("INSERT INTO withdrawals(market_ref, withdrawal_id, account_id, receiver_id, amount, status, requested_ns) VALUES ($1,$2,$3,$4,$5,$6,0)", [marketRef, w.withdrawal_id, a, w.receiver_id, w.amount, w.status]);
          rep.withdrawalFixes.push(`${a} withdrawal ${w.withdrawal_id}: inserted as ${w.status}`);
        } else if (cw.status !== w.status) {
          await c.query("UPDATE withdrawals SET status=$3, receiver_id=$4 WHERE market_ref=$1 AND withdrawal_id=$2", [marketRef, w.withdrawal_id, w.status, w.receiver_id]);
          rep.withdrawalFixes.push(`${a} withdrawal ${w.withdrawal_id}: ${cw.status} -> ${w.status}`);
        }
      }
    }
    await c.query("UPDATE market_participants SET hydrated_at=now() WHERE market_ref=$1 AND account_id = ANY($2)", [marketRef, accounts]);
    rep.ok = rep.offerDrift.length === 0 && rep.accountDrift.length === 0;
    await c.query("UPDATE markets SET reconcile=$2 WHERE market_ref=$1", [marketRef, JSON.stringify(rep)]);
  });
  return rep;
}
