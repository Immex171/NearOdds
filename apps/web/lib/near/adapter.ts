import type {
  AccountView, ConfigView, MarketView, OfferView, Outcome as COutcome, RedemptionPreview, Side as CSide,
} from "@nearodds/types";
import { config } from "../config";
import { contractOutcome, uiOutcome } from "../trading";
import { wallet } from "../wallet";
import { assertAllReceiptsOk, txHash } from "./outcome";
import { finalBlockHeight, view } from "./rpc";
import type {
  AccountState, Capabilities, CreateOfferRequest, DataAdapter, Market, MarketStatus, Offer, OpenOffer, Position, TxReporter,
} from "../types";

const TGAS = (n: number) => (BigInt(n) * 10n ** 12n).toString();
const YOCTO = "1";
const M = () => config.marketContractId;

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
  if (msg.includes("too many open offers")) return "You already have 10 open offers. Cancel one first.";
  if (msg.includes("trading is closed")) return "Trading is closed: the market cutoff has passed.";
  if (msg.includes("insufficient available collateral")) return "Insufficient available collateral.";
  if (msg.includes("insufficient YES/NO shares")) return "Insufficient shares.";
  return msg;
}

const toMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);

function toOffer(o: OfferView): Offer {
  return {
    id: o.offer_id, marketId: o.market_id, outcome: uiOutcome(o.outcome), side: o.side === "Buy" ? "buy" : "sell",
    price: BigInt(o.price), qty: BigInt(o.remaining_quantity), owner: o.owner_id, createdAt: toMs(o.created_at_ns), fillable: o.fillable,
  };
}

const STATUS: Record<MarketView["status"], MarketStatus> = { Open: "open", AwaitingResolution: "awaiting", Resolved: "resolved" };

/** Live adapter for the deployed contract (schema v3). Prices, history and activity have no on-chain source. */
export class NearAdapter implements DataAdapter {
  id = "near" as const;
  label = "Testnet";
  symbol = "tNOC";
  capabilities = NEAR_CAPABILITIES;
  private subs = new Set<() => void>();
  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private emit() { this.subs.forEach((f) => f()); }

  async getMarket(): Promise<Market | null> {
    const mv = await view<MarketView>(M(), "get_market", { market_id: config.marketId });
    const closesAt = toMs(mv.split_cutoff_ns);
    const res = mv.resolution;
    return {
      id: config.marketId, question: mv.question, category: "Crypto", icon: "N", description: mv.rules,
      status: STATUS[mv.status], createdAt: closesAt, closesAt,
      volume: 0n, lastYes: null, prevYes: null, hasHistory: false, trendScore: 0,
      resolution: {
        // Canonical contract configuration, shown as published. Not rewritten by the frontend.
        yesWins: mv.rules, noWins: "",
        source: { name: mv.resolution_source || "Not provided", field: "As described in the rules text" },
        observation: { at: null, text: "As defined in the rules text" },
        ifMissing: "Only the trusted resolver can resolve the market, once, after the cutoff. VOID and disputes are not supported.",
        resolver: `${mv.resolver_id} (trusted resolver)`,
        outcome: res ? uiOutcome(res.outcome) : null,
        note: res ? `Resolved by ${res.resolver_id}. Evidence (recorded, not verified): ${res.evidence}` : mv.awaiting_resolution ? "Trading has closed. Waiting for the trusted resolver." : undefined,
      },
    };
  }
  async listMarkets() { const m = await this.getMarket(); return m ? [m] : []; }

  /** Every open offer of both outcomes and sides, read at ONE block so a global best bid/ask is consistent. */
  async getBook(): Promise<Offer[]> {
    const h = await finalBlockHeight();
    const out: Offer[] = [];
    for (const outcome of ["Yes", "No"] as COutcome[]) {
      for (const side of ["Buy", "Sell"] as CSide[]) {
        for (let from = 0; ; from += 50) {
          const page = await view<OfferView[]>(M(), "list_offers", { market_id: config.marketId, outcome, side, from_index: String(from), limit: 50 }, h);
          out.push(...page.map(toOffer));
          if (page.length < 50) break;
        }
      }
    }
    return out;
  }
  async getHistory() { return null; }
  async getActivity() { return []; }

  async getAccount(accountId: string): Promise<AccountState | null> {
    const h = await finalBlockHeight();
    const [acct, bal, offers, cfg] = await Promise.all([
      view<AccountView | null>(M(), "get_account", { account_id: accountId }, h),
      view<string>(config.tokenContractId, "ft_balance_of", { account_id: accountId }),
      view<OfferView[]>(M(), "get_account_offers", { account_id: accountId }, h),
      view<ConfigView>(M(), "get_config", {}, h),
    ]);
    const base: AccountState = {
      accountId, isDemo: false, walletBalance: BigInt(bal), available: 0n, committed: 0n, pendingWithdrawal: 0n,
      positions: [], offers: [], activity: [], registered: Boolean(acct),
      storageCostYocto: BigInt(cfg.storage_cost_per_account), maxOpenOffers: cfg.trading.max_open_offers_per_account,
    };
    if (!acct) return base;
    base.available = BigInt(acct.available_collateral);
    base.committed = BigInt(acct.reserved_collateral);
    base.pendingWithdrawal = acct.pending_withdrawal?.status === "Pending" ? BigInt(acct.pending_withdrawal.amount) : 0n;
    base.withdrawalStatus = acct.pending_withdrawal?.status ?? null;
    const pos = (o: "YES" | "NO", q: string, r: string): Position | null =>
      BigInt(q) + BigInt(r) > 0n ? { marketId: config.marketId, outcome: o, qty: BigInt(q), reserved: BigInt(r), avgPrice: null } : null;
    base.positions = [pos("YES", acct.yes, acct.reserved_yes), pos("NO", acct.no, acct.reserved_no)].filter((p): p is Position => p !== null);
    base.offers = offers.map((o) => ({ ...toOffer(o), status: "open" as const })) as OpenOffer[];
    return base;
  }

  private async send(r: TxReporter, receiver: string, method: string, args: object, deposit: string, gas: string, done: string) {
    try {
      r({ phase: "awaiting-wallet", message: "Approve the transaction in your wallet…" });
      const out = await wallet.call(receiver, method, args, deposit, gas);
      r({ phase: "confirming", message: "Checking every receipt…", hash: txHash(out) });
      assertAllReceiptsOk(out);
      this.emit();
      r({ phase: "confirmed", message: done, hash: txHash(out) });
    } catch (e) {
      const message = friendlyError(e instanceof Error ? e.message : "Transaction rejected or failed");
      r({ phase: "failed", message });
      throw new Error(message);
    }
  }

  async register(r: TxReporter) {
    if (!wallet.account()) throw new Error("Connect a wallet first");
    const cfg = await view<ConfigView>(M(), "get_config");
    await this.send(r, M(), "storage_deposit", { account_id: null }, cfg.storage_cost_per_account, TGAS(30), "Registered with the market");
  }
  async deposit(amount: bigint, r: TxReporter) {
    const cfg = await view<ConfigView>(M(), "get_config");
    await this.send(r, config.tokenContractId, "ft_transfer_call",
      { receiver_id: M(), amount: amount.toString(), msg: cfg.deposit_msg }, YOCTO, TGAS(100), "Deposit submitted. Check that your balance changed: deposits can be refunded.");
  }
  withdraw(amount: bigint, r: TxReporter) {
    return this.send(r, M(), "withdraw", { amount: amount.toString() }, YOCTO, TGAS(100), "Withdrawal requested. It settles asynchronously; never resend it.");
  }
  split(marketId: string, amount: bigint, r: TxReporter) {
    return this.send(r, M(), "split_position", { market_id: marketId, amount: amount.toString() }, YOCTO, TGAS(100), "YES + NO shares created");
  }
  merge(marketId: string, amount: bigint, r: TxReporter) {
    return this.send(r, M(), "merge_positions", { market_id: marketId, amount: amount.toString() }, YOCTO, TGAS(100), "YES + NO shares combined");
  }
  createOffer(q: CreateOfferRequest, r: TxReporter) {
    return this.send(r, M(), "create_offer", {
      market_id: q.marketId, outcome: contractOutcome(q.outcome), side: q.side === "buy" ? "Buy" : "Sell",
      price: q.price.toString(), quantity: q.qty.toString(),
    }, YOCTO, TGAS(100), "Limit offer created");
  }
  fillOffer(offerId: string, qty: bigint, r: TxReporter) {
    return this.send(r, M(), "fill_offer", { offer_id: offerId, quantity: qty.toString() }, YOCTO, TGAS(100), "Offer filled");
  }
  cancelOffer(offerId: string, r: TxReporter) {
    return this.send(r, M(), "cancel_offer", { offer_id: offerId }, YOCTO, TGAS(100), "Offer cancelled; the unfilled remainder was released");
  }
  async redeem(marketId: string, r: TxReporter) {
    const acct = wallet.account();
    if (acct) {
      const p = await view<RedemptionPreview>(M(), "get_redemption_preview", { account_id: acct });
      if (!p.redeemable) { r({ phase: "failed", message: "Nothing to redeem." }); throw new Error("Nothing to redeem."); }
    }
    await this.send(r, M(), "redeem", { market_id: marketId }, YOCTO, TGAS(100), "Redeemed into your available collateral. Withdraw it from Funds.");
  }
}
