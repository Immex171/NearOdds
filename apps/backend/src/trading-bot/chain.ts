import type { AccountView, ConfigView, MarketView, OfferView, RedemptionPreview } from "@nearodds/types";
import type { Rpc } from "../near/rpc.js";
import type { Snapshot } from "./decide.js";
import { tradingFrom } from "./strategy.js";

export class IdentityError extends Error { constructor(msg: string) { super(msg); this.name = "IdentityError"; } }
export interface MarketRow { market_ref: string; network: string; contract_id: string; internal_market_id: string; token_id: string; cutoff_ns: string }
export interface FullSnapshot extends Snapshot { readAt: number; blockHash: string; redemption: RedemptionPreview | null; collateralTokenId: string }

/**
 * One COHERENT read: every view is evaluated at the same finalized block. Chain state, never the indexer's cache,
 * authorises spending. Throws RpcUnavailableError on outages (the caller records "chain unavailable" and does nothing).
 */
export async function readSnapshot(rpc: Rpc, m: MarketRow, botAccount: string): Promise<FullSnapshot> {
  const fb = await rpc.finalBlock();
  const at = { block_id: fb.height };
  const [cfg, market, account, native] = await Promise.all([
    rpc.callView<ConfigView & { storage_cost_per_account: string }>(m.contract_id, "get_config", {}, at),
    rpc.callView<MarketView>(m.contract_id, "get_market", { market_id: m.internal_market_id }, at),
    rpc.callView<AccountView | null>(m.contract_id, "get_account", { account_id: botAccount }, at),
    rpc.viewAccount(botAccount, at),
  ]);
  if (cfg.market_id !== m.internal_market_id) throw new IdentityError(`contract market_id ${cfg.market_id} != registered ${m.internal_market_id}`);
  if (cfg.collateral_token_id !== m.token_id) throw new IdentityError(`contract collateral token ${cfg.collateral_token_id} != registered ${m.token_id}`);
  const [tokBal, tokReg, bounds] = await Promise.all([
    rpc.callView<string>(m.token_id, "ft_balance_of", { account_id: botAccount }, at),
    rpc.callView<unknown>(m.token_id, "storage_balance_of", { account_id: botAccount }, at),
    rpc.callView<{ min: string }>(m.token_id, "storage_balance_bounds", {}, at),
  ]);
  const offers = account ? await rpc.callView<OfferView[]>(m.contract_id, "get_account_offers", { account_id: botAccount }, at) : [];
  const redemption = account && market.resolved ? await rpc.callView<RedemptionPreview>(m.contract_id, "get_redemption_preview", { account_id: botAccount }, at) : null;
  return {
    blockHeight: fb.height, blockHash: fb.hash, blockTsNs: BigInt(fb.timestampNs), readAt: Date.now(),
    trading: tradingFrom(cfg.trading), storageCostPerAccount: BigInt(cfg.storage_cost_per_account), tokenRegistrationDeposit: BigInt(bounds.min),
    market: { status: market.status, tradingOpen: market.trading_open ?? market.status === "Open", cutoffNs: BigInt(market.trading_cutoff_ns ?? market.split_cutoff_ns), resolved: market.resolved },
    account, offers, tokenBalance: BigInt(tokBal), tokenRegistered: tokReg !== null,
    nativeBalance: native.exists ? BigInt(native.amount) : 0n, redemption, collateralTokenId: cfg.collateral_token_id,
  };
}

/** JSON-safe summary stored for status/monitoring. */
export function summarize(s: FullSnapshot) {
  const a = s.account;
  return {
    blockHeight: s.blockHeight, readAt: new Date(s.readAt).toISOString(), marketStatus: s.market.status,
    registeredWithToken: s.tokenRegistered, registeredWithMarket: !!a, tokenBalance: s.tokenBalance.toString(), nativeBalanceYocto: s.nativeBalance.toString(),
    collateral: a ? { available: a.available_collateral, reserved: a.reserved_collateral } : null,
    shares: a ? { yes: { available: a.yes, reserved: a.reserved_yes }, no: { available: a.no, reserved: a.reserved_no } } : null,
    openOffers: s.offers.map((o) => ({ offerId: o.offer_id, outcome: o.outcome, side: o.side, price: o.price, remaining: o.remaining_quantity, quantity: o.quantity, expiresAtNs: o.expires_at_ns, fillable: o.fillable })),
    redemption: s.redemption ? { outcome: s.redemption.outcome, redeemable: s.redemption.redeemable, payout: s.redemption.payout, releasedCollateral: s.redemption.released_collateral, winningShares: s.redemption.winning_shares } : null,
  };
}
