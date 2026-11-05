import type { FastifyInstance } from "fastify";
import type { Ctx } from "./app.js";
import { freshness } from "./dto.js";
import { HttpError, intParam } from "./http.js";
import { activityDto } from "./routes-markets.js";
import { validAccountId } from "../auth/service.js";

function acct(req: any): string { const a = req.params.accountId; if (!validAccountId(a)) throw new HttpError(400, "bad_account", "invalid NEAR account id"); return a; }

export function registerAccountRoutes(app: FastifyInstance, { db }: Ctx) {
  app.get("/v1/accounts/:accountId/portfolio", async (req) => {
    const a = acct(req);
    const st = (await db.query("SELECT s.*, m.contract_id, m.internal_market_id, m.question, m.token_meta, m.contract_status, m.cutoff_ns, m.resolution FROM account_state s JOIN markets m USING (market_ref) WHERE s.account_id=$1 ORDER BY m.created_at", [a])).rows;
    const offers = (await db.query("SELECT * FROM offers WHERE owner_id=$1 AND state='open' ORDER BY market_ref, offer_id", [a])).rows;
    const wd = (await db.query("SELECT * FROM withdrawals WHERE account_id=$1 ORDER BY requested_ns DESC", [a])).rows;
    return {
      accountId: a,
      markets: st.map((s: any) => ({
        marketRef: s.market_ref, contract: { contractId: s.contract_id, marketId: s.internal_market_id }, question: s.question, status: s.contract_status, registered: s.registered,
        token: { symbol: s.token_meta.symbol, decimals: s.token_meta.decimals },
        collateral: { available: s.available_collateral, reserved: s.reserved_collateral, pendingWithdrawal: s.pending_withdrawal_amount },
        positions: { yes: { available: s.yes, reserved: s.reserved_yes, total: (BigInt(s.yes) + BigInt(s.reserved_yes)).toString() }, no: { available: s.no, reserved: s.reserved_no, total: (BigInt(s.no) + BigInt(s.reserved_no)).toString() } },
        redeemed: s.redeemed, lastReconciledHeight: s.last_reconciled_height === null ? null : Number(s.last_reconciled_height), driftNote: s.drift ?? null,
        redeemHint: s.contract_status === "Resolved" && !s.redeemed ? "Call get_redemption_preview on the market contract, then redeem; withdraw is a separate step." : null,
      })),
      openOffers: offers.map(offerDto), withdrawals: wd.map(withdrawalDto), freshness: await freshness(db),
    };
  });
  app.get("/v1/accounts/:accountId/offers", async (req) => {
    const rows = (await db.query("SELECT * FROM offers WHERE owner_id=$1 AND state IN ('open') ORDER BY market_ref, offer_id", [acct(req)])).rows;
    return { items: rows.map(offerDto), freshness: await freshness(db) };
  });
  app.get("/v1/accounts/:accountId/withdrawals", async (req) => {
    const rows = (await db.query("SELECT * FROM withdrawals WHERE account_id=$1 ORDER BY requested_ns DESC", [acct(req)])).rows;
    return { items: rows.map(withdrawalDto), freshness: await freshness(db) };
  });
  app.get("/v1/accounts/:accountId/activity", async (req) => {
    const limit = intParam((req.query as any).limit, 50, 1, 200);
    const rows = (await db.query("SELECT * FROM activity WHERE account_id=$1 ORDER BY id DESC LIMIT " + limit, [acct(req)])).rows;
    return { items: rows.map(activityDto), freshness: await freshness(db) };
  });
}

const offerDto = (o: any) => ({ marketRef: o.market_ref, offerId: o.offer_id, offerRef: `${o.market_ref}:${o.offer_id}`, outcome: o.outcome, side: o.side, price: o.price, remainingQuantity: o.remaining, originalQuantity: o.quantity, expiresAtNs: o.expires_at_ns, state: o.state });
/** `status` is explicit: a non-null record may already be Completed. Only Pending is unconfirmed. */
const withdrawalDto = (w: any) => ({ marketRef: w.market_ref, withdrawalId: w.withdrawal_id, withdrawalRef: `${w.market_ref}:${w.withdrawal_id}`, amount: w.amount, status: w.status, receiver: w.receiver_id, requestedNs: w.requested_ns, settledNs: w.settled_ns, confirmed: w.status === "Completed" || w.status === "FailedRestored" });
