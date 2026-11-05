import type {
  AccountView, CancelResult, ConfigView, FillResult, MarketView, OfferView, Outcome as COutcome, RedeemResult, RedemptionPreview, Side as CSide, WithdrawalView,
} from "@nearodds/types";
import { formatUnits } from "../amounts";
import { config } from "../config";
import { DEFAULT_LIMITS, contractOutcome } from "../trading";
import { wallet } from "../wallet";
import { DeploymentError, verifyDeployment, type LiveSettings } from "./deployment";
import { toMarket, toOffer } from "./market-map";
import { assertAllReceiptsOk, awaitFinalOutcome, successValue, txHash } from "./outcome";
import { finalBlockHeight, nativeBalance, view } from "./rpc";
import type {
  AccountState, Capabilities, CreateOfferRequest, DataAdapter, Deployment, Limits, Market, Offer, OpenOffer, Position, RedeemPreview, TxReporter,
} from "../types";

/** Attached gas, as exercised on testnet (docs/frontend-handoff.md). */
const GAS_DEPOSIT = (300n * 10n ** 12n).toString(); // ft_transfer_call
const GAS_MARKET = (100n * 10n ** 12n).toString(); // split, merge, create/fill/cancel, redeem, withdraw
const GAS_STORAGE = (30n * 10n ** 12n).toString(); // storage_deposit
const ONE_YOCTO = "1";
const M = () => config.marketContractId;
const T = () => config.tokenContractId;

export const NEAR_CAPABILITIES: Capabilities = {
  trading: true, limitOffers: true, partialFills: true, cancelOffers: true,
  deposit: true, withdraw: true, completeSets: true, redeem: true, history: false,
};

/** Contract panic strings -> plain language. Unknown strings pass through unchanged. */
export function friendlyError(msg: string): string {
  if (msg.includes("offer not found")) return "Offer no longer available: it was filled, cancelled or released.";
  if (msg.includes("offer has expired")) return "Offer no longer available: it has expired.";
  if (msg.includes("fill quantity exceeds")) return "Offer no longer has that many shares available.";
  if (msg.includes("you cannot fill your own offer")) return "You can’t fill your own offer.";
  if (msg.includes("too many open offers")) return "You already have the maximum number of open offers. Cancel one first.";
  if (msg.includes("trading is closed")) return "Trading is closed: the market cutoff has passed.";
  if (msg.includes("the market is resolved")) return "This market is resolved, so this action is no longer available. Redeem your position instead.";
  if (msg.includes("the market is not resolved yet")) return "The market has not been resolved yet.";
  if (msg.includes("nothing to redeem")) return "Nothing to redeem: no shares and no open offers.";
  if (msg.includes("insufficient available collateral")) return "Insufficient available collateral.";
  if (msg.includes("insufficient YES/NO shares")) return "Insufficient shares.";
  if (msg.includes("account is not registered")) return "Register with the market first (Funds page).";
  if (msg.includes("is not registered")) return "Register with the token first (Funds page).";
  return msg;
}

const fmt = (v: string | bigint) => formatUnits(BigInt(v), 0, 6);

/** Live adapter for the deployed contracts (schema v3). Prices, history and activity have no on-chain source. */
export class NearAdapter implements DataAdapter {
  id = "near" as const;
  label = "Testnet";
  symbol = "tokens"; // replaced by ft_metadata().symbol once the deployment is verified
  capabilities = NEAR_CAPABILITIES;
  limits: Limits = DEFAULT_LIMITS;
  /** Delay between re-reads of a withdrawal record (tests set 0). */
  static pollMs = 1500;
  deployment: Deployment = { state: "idle" };
  settings: LiveSettings | null = null;
  private subs = new Set<() => void>();
  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private emit() { this.subs.forEach((f) => f()); }

  /** Verifies get_config / ft_metadata / get_market agree with the configured IDs, then adopts the on-chain settings. */
  async init(force = false): Promise<void> {
    this.deployment = { state: "checking" };
    this.emit();
    try {
      const s = await verifyDeployment(force);
      this.settings = s;
      this.symbol = s.token.symbol;
      const t = s.cfg.trading;
      this.limits = {
        priceScale: BigInt(t.price_scale), tick: BigInt(t.price_tick), minPrice: BigInt(t.min_price), maxPrice: BigInt(t.max_price),
        lot: BigInt(t.quantity_lot), minOrder: BigInt(t.min_order_quantity), maxOpenOffers: t.max_open_offers_per_account,
      };
      this.deployment = { state: "ok" };
    } catch (e) {
      this.deployment = { state: "error", problems: e instanceof DeploymentError ? e.problems : [e instanceof Error ? e.message : String(e)] };
    }
    this.emit();
  }
  private ready() {
    if (this.deployment.state !== "ok") {
      throw new Error(this.deployment.state === "error" ? `Transactions are disabled: ${this.deployment.problems.join(" ")}` : "Still verifying the deployment. Try again in a moment.");
    }
  }

  async getMarket(): Promise<Market | null> {
    const mv = await view<MarketView>(M(), "get_market", { market_id: config.marketId });
    return toMarket(mv, this.settings?.cfg ?? null);
  }
  async listMarkets() { const m = await this.getMarket(); return m ? [m] : []; }

  /** Every open offer of both outcomes and sides, read at ONE block so a global best bid/ask is consistent. */
  async getBook(): Promise<Offer[]> {
    const h = await finalBlockHeight();
    const seen = new Map<string, Offer>();
    for (const outcome of ["Yes", "No"] as COutcome[]) {
      for (const side of ["Buy", "Sell"] as CSide[]) {
        for (let from = 0; ; from += 50) {
          const page = await view<OfferView[]>(M(), "list_offers", { market_id: config.marketId, outcome, side, from_index: String(from), limit: 50 }, h);
          for (const o of page) seen.set(o.offer_id, toOffer(o));
          if (page.length < 50) break;
        }
      }
    }
    return [...seen.values()].sort((a, b) => (a.price === b.price ? Number(BigInt(a.id) - BigInt(b.id)) : Number(a.price - b.price)));
  }
  async getHistory() { return null; }
  async getActivity() { return []; }

  async getAccount(accountId: string): Promise<AccountState | null> {
    const h = await finalBlockHeight();
    const [acct, bal, tokenStorage, offers, cfg, near] = await Promise.all([
      view<AccountView | null>(M(), "get_account", { account_id: accountId }, h),
      view<string>(T(), "ft_balance_of", { account_id: accountId }, h),
      view<{ total: string } | null>(T(), "storage_balance_of", { account_id: accountId }, h),
      view<OfferView[]>(M(), "get_account_offers", { account_id: accountId }, h),
      view<ConfigView>(M(), "get_config", {}, h),
      nativeBalance(accountId),
    ]);
    const wd = (w: WithdrawalView | null) => (w ? { id: w.withdrawal_id, amount: BigInt(w.amount), status: w.status } : null);
    const base: AccountState = {
      accountId, isDemo: false, walletBalance: BigInt(bal), available: 0n, committed: 0n, pendingWithdrawal: 0n,
      positions: [], offers: [], activity: [], registered: Boolean(acct), tokenRegistered: Boolean(tokenStorage), nearBalance: near,
      storageCostYocto: BigInt(cfg.storage_cost_per_account), maxOpenOffers: cfg.trading.max_open_offers_per_account,
    };
    if (!acct) return base;
    base.available = BigInt(acct.available_collateral);
    base.committed = BigInt(acct.reserved_collateral);
    base.pendingWithdrawal = acct.pending_withdrawal?.status === "Pending" ? BigInt(acct.pending_withdrawal.amount) : 0n;
    base.withdrawalStatus = acct.pending_withdrawal?.status ?? null;
    base.withdrawal = wd(acct.pending_withdrawal);
    const pos = (o: "YES" | "NO", q: string, r: string): Position | null =>
      BigInt(q) + BigInt(r) > 0n ? { marketId: config.marketId, outcome: o, qty: BigInt(q), reserved: BigInt(r), avgPrice: null } : null;
    base.positions = [pos("YES", acct.yes, acct.reserved_yes), pos("NO", acct.no, acct.reserved_no)].filter((p): p is Position => p !== null);
    base.offers = offers.map((o) => ({ ...toOffer(o), status: "open" as const })) as OpenOffer[];
    return base;
  }

  async redeemPreview(_marketId: string, accountId: string): Promise<RedeemPreview | null> {
    const p = await view<RedemptionPreview>(M(), "get_redemption_preview", { account_id: accountId });
    return {
      redeemable: p.redeemable, outcome: p.outcome ? (p.outcome === "Yes" ? "YES" : "NO") : null,
      winningShares: BigInt(p.winning_shares), losingShares: BigInt(p.losing_shares), payout: BigInt(p.payout),
      releasedCollateral: BigInt(p.released_collateral), releasedShares: BigInt(p.released_shares),
      offersToRelease: p.offers_to_release.length, availableAfter: BigInt(p.available_collateral_after),
    };
  }

  /**
   * Sends one transaction through the user's wallet, then asks the CHAIN for the final result: the wallet's own
   * "success" is not trusted. `describe` turns the final outcome and refreshed state into the message and phase.
   * Nothing is ever resubmitted automatically.
   */
  private async send(
    r: TxReporter, receiver: string, method: string, args: object, deposit: string, gas: string,
    describe: (outcome: unknown) => Promise<{ phase: "confirmed" | "unconfirmed" | "failed"; message: string }> | { phase: "confirmed" | "unconfirmed" | "failed"; message: string },
  ) {
    let hash: string | undefined;
    try {
      this.ready();
      const signer = wallet.account();
      if (!signer) throw new Error("Connect a wallet first");
      r({ phase: "awaiting-wallet", message: "Approve the transaction in your wallet…" });
      const sent = await wallet.call(receiver, method, args, deposit, gas);
      hash = txHash(sent);
      if (!hash) throw new Error("Your wallet did not return a transaction hash, so the result cannot be verified. Do not resend: check your wallet history, then refresh.");
      r({ phase: "confirming", message: "Submitted. Waiting for the network to finalise every receipt…", hash });
      const final = await awaitFinalOutcome(hash, signer);
      assertAllReceiptsOk(final);
      this.emit(); // refresh reads before describing
      const out = await describe(final);
      r({ phase: out.phase, message: out.message, hash });
      if (out.phase === "failed") throw new Error(out.message);
    } catch (e) {
      const message = friendlyError(e instanceof Error ? e.message : "Transaction rejected or failed");
      r({ phase: "failed", message, ...(hash ? { hash } : {}) });
      throw new Error(message);
    } finally {
      this.emit();
    }
  }

  async registerToken(r: TxReporter) {
    const acct = wallet.account();
    if (!acct) throw new Error("Connect a wallet first");
    const min = (await verifyDeployment()).tokenStorageMin;
    await this.send(r, T(), "storage_deposit", { account_id: acct, registration_only: true }, min.toString(), GAS_STORAGE,
      async () => ((await view<unknown>(T(), "storage_balance_of", { account_id: acct })) ? { phase: "confirmed", message: `Registered with the ${this.symbol} token.` } : { phase: "failed", message: "The token still shows you as unregistered. Refresh and check the explorer; do not resend yet." }));
  }
  async registerMarket(r: TxReporter) {
    const acct = wallet.account();
    if (!acct) throw new Error("Connect a wallet first");
    const cost = (await verifyDeployment()).cfg.storage_cost_per_account;
    await this.send(r, M(), "storage_deposit", { account_id: null, registration_only: true }, cost, GAS_STORAGE,
      async () => ((await view<AccountView | null>(M(), "get_account", { account_id: acct })) ? { phase: "confirmed", message: "Registered with the market." } : { phase: "failed", message: "The market still shows you as unregistered. Refresh and check the explorer; do not resend yet." }));
  }

  async deposit(amount: bigint, r: TxReporter) {
    const cfg = (await verifyDeployment()).cfg;
    await this.send(r, T(), "ft_transfer_call", { receiver_id: M(), amount: amount.toString(), msg: cfg.deposit_msg }, ONE_YOCTO, GAS_DEPOSIT, (final) => {
      // ft_transfer_call returns the amount the receiver actually USED; the rest is refunded to the sender.
      const used = successValue<string>(final);
      if (used == null) return { phase: "unconfirmed", message: "The deposit finished but the contract returned no accepted amount. Check your balances before trying again." };
      const u = BigInt(used);
      if (u === 0n) return { phase: "failed", message: "The market refunded the whole deposit. Make sure you are registered with the market, then try again." };
      if (u < amount) return { phase: "confirmed", message: `Deposited ${fmt(u)} ${this.symbol}. ${fmt(amount - u)} ${this.symbol} was refunded to your wallet.` };
      return { phase: "confirmed", message: `Deposited ${fmt(u)} ${this.symbol} into NearOdds.` };
    });
  }

  async withdraw(amount: bigint, r: TxReporter) {
    const acct = wallet.account();
    await this.send(r, M(), "withdraw", { amount: amount.toString() }, ONE_YOCTO, GAS_MARKET, async () => {
      // The callback verdict is in the final outcome, but the stored record is what counts. Re-read it.
      let w: WithdrawalView | null = null;
      for (let i = 0; i < 6; i++) {
        w = acct ? (await view<AccountView | null>(M(), "get_account", { account_id: acct }))?.pending_withdrawal ?? null : null;
        if (w && w.status !== "Pending") break;
        await new Promise((x) => setTimeout(x, NearAdapter.pollMs));
      }
      if (w?.status === "Completed") return { phase: "confirmed", message: `Withdrew ${fmt(w.amount)} ${this.symbol} to your wallet.` };
      if (w?.status === "FailedRestored") return { phase: "failed", message: `The token transfer failed. ${fmt(w.amount)} ${this.symbol} was returned to your available balance.` };
      return { phase: "unconfirmed", message: "Withdrawal requested but NOT confirmed. Do not resend it. The amount is held until the contract records the result." };
    });
  }

  split(marketId: string, amount: bigint, r: TxReporter) {
    return this.send(r, M(), "split_position", { market_id: marketId, amount: amount.toString() }, ONE_YOCTO, GAS_MARKET,
      () => ({ phase: "confirmed", message: `Created ${fmt(amount)} YES + ${fmt(amount)} NO shares.` }));
  }
  merge(marketId: string, amount: bigint, r: TxReporter) {
    return this.send(r, M(), "merge_positions", { market_id: marketId, amount: amount.toString() }, ONE_YOCTO, GAS_MARKET,
      () => ({ phase: "confirmed", message: `Combined ${fmt(amount)} YES + ${fmt(amount)} NO shares into ${fmt(amount)} ${this.symbol}.` }));
  }
  createOffer(q: CreateOfferRequest, r: TxReporter) {
    return this.send(r, M(), "create_offer", {
      market_id: q.marketId, outcome: contractOutcome(q.outcome), side: q.side === "buy" ? "Buy" : "Sell",
      price: q.price.toString(), quantity: q.qty.toString(),
      ...(q.expiresAt ? { expires_at_ns: (BigInt(q.expiresAt) * 1_000_000n).toString() } : {}),
    }, ONE_YOCTO, GAS_MARKET, (final) => {
      const o = successValue<OfferView>(final);
      return { phase: "confirmed", message: o?.offer_id ? `Limit offer #${o.offer_id} is open.` : "Limit offer created." };
    });
  }
  fillOffer(offerId: string, qty: bigint, r: TxReporter) {
    return this.send(r, M(), "fill_offer", { offer_id: offerId, quantity: qty.toString() }, ONE_YOCTO, GAS_MARKET, (final) => {
      const f = successValue<FillResult>(final);
      return { phase: "confirmed", message: f ? `Filled ${fmt(f.quantity)} shares for ${fmt(f.collateral_amount)} ${this.symbol}${f.status === "PartiallyFilled" ? ` (${fmt(f.remaining_quantity)} still on that offer)` : ""}.` : "Offer filled." };
    });
  }
  cancelOffer(offerId: string, r: TxReporter) {
    return this.send(r, M(), "cancel_offer", { offer_id: offerId }, ONE_YOCTO, GAS_MARKET, (final) => {
      const c = successValue<CancelResult>(final);
      return { phase: "confirmed", message: c ? `Offer cancelled. Released ${BigInt(c.released_collateral) > 0n ? `${fmt(c.released_collateral)} ${this.symbol}` : `${fmt(c.released_shares)} shares`} back to your balance.` : "Offer cancelled." };
    });
  }
  async redeem(marketId: string, r: TxReporter) {
    const acct = wallet.account();
    if (acct) {
      const p = await view<RedemptionPreview>(M(), "get_redemption_preview", { account_id: acct });
      if (!p.redeemable) { r({ phase: "failed", message: "Nothing to redeem." }); throw new Error("Nothing to redeem."); }
    }
    await this.send(r, M(), "redeem", { market_id: marketId }, ONE_YOCTO, GAS_MARKET, (final) => {
      const x = successValue<RedeemResult>(final);
      return { phase: "confirmed", message: x
        ? `Redeemed: ${fmt(x.payout)} ${this.symbol} winning payout${BigInt(x.released_collateral) > 0n ? ` plus ${fmt(x.released_collateral)} ${this.symbol} released from offers` : ""} is now in your available balance inside NearOdds. Withdraw it to move it to your wallet.`
        : "Redeemed into your available balance. Withdraw it to move it to your wallet." };
    });
  }
}
