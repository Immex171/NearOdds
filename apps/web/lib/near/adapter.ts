import { config } from "../config";
import { wallet } from "../wallet";
import { assertAllReceiptsOk, txHash } from "./outcome";
import { view } from "./rpc";
import type {
  AccountState, Capabilities, DataAdapter, Market, TxReporter,
} from "../types";

const TGAS = (n: number) => (BigInt(n) * 10n ** 12n).toString();
const YOCTO = "1";

interface MarketView { question: string; rules: string; split_cutoff_ns: string; split_open: boolean; outstanding_yes: string; outstanding_no: string; market_backing: string }
interface AccountView { available_collateral: string; yes: string; no: string; pending_withdrawal: null | { amount: string; status: string } }
interface Config { deposit_msg: string; storage_cost_per_account: string }

export const NEAR_CAPABILITIES: Capabilities = {
  trading: false, limitOffers: false, partialFills: false, cancelOffers: false,
  deposit: true, withdraw: true, completeSets: true, redeem: false, history: false,
};

/** Live adapter: only what Milestone 1 of the contract supports. No prices, offers, history or resolution exist on-chain yet. */
export class NearAdapter implements DataAdapter {
  id = "near" as const;
  label = "Testnet";
  symbol = "tNOC";
  capabilities = NEAR_CAPABILITIES;
  private subs = new Set<() => void>();
  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private emit() { this.subs.forEach((f) => f()); }

  async getMarket(): Promise<Market | null> {
    const mv = await view<MarketView>(config.marketContractId, "get_market", { market_id: config.marketId });
    const closesAt = Number(BigInt(mv.split_cutoff_ns) / 1_000_000n);
    return {
      id: config.marketId, question: mv.question, category: "Crypto", icon: "N", description: mv.rules,
      status: mv.split_open ? "open" : "closed", createdAt: closesAt, closesAt,
      volume: 0n, lastYes: null, prevYes: null, hasHistory: false, trendScore: 0,
      resolution: {
        yesWins: mv.rules, noWins: "See the rules text above. Resolution is not implemented in this contract milestone.",
        source: "Not available yet", resolver: "Not available yet", outcome: null,
        note: "The contract does not support trading or resolution yet. Only collateral and complete-set actions are live.",
      },
    };
  }
  async listMarkets() { const m = await this.getMarket(); return m ? [m] : []; }
  async getBook() { return []; }
  async getHistory() { return null; }
  async getActivity() { return []; }

  async getAccount(accountId: string): Promise<AccountState | null> {
    const [acct, bal] = await Promise.all([
      view<AccountView | null>(config.marketContractId, "get_account", { account_id: accountId }),
      view<string>(config.tokenContractId, "ft_balance_of", { account_id: accountId }),
    ]);
    const base: AccountState = {
      accountId, isDemo: false, walletBalance: BigInt(bal), available: 0n, committed: 0n, pendingWithdrawal: 0n,
      positions: [], offers: [], activity: [], registered: Boolean(acct),
    };
    if (!acct) return base;
    base.available = BigInt(acct.available_collateral);
    base.pendingWithdrawal = acct.pending_withdrawal?.status === "Pending" ? BigInt(acct.pending_withdrawal.amount) : 0n;
    base.withdrawalStatus = (acct.pending_withdrawal?.status as AccountState["withdrawalStatus"]) ?? null;
    const yes = BigInt(acct.yes), no = BigInt(acct.no);
    if (yes > 0n) base.positions.push({ marketId: config.marketId, outcome: "YES", qty: yes, avgPrice: null });
    if (no > 0n) base.positions.push({ marketId: config.marketId, outcome: "NO", qty: no, avgPrice: null });
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
      const message = e instanceof Error ? e.message : "Transaction rejected or failed";
      r({ phase: "failed", message });
      throw e;
    }
  }

  async register(r: TxReporter) {
    const acct = wallet.account();
    if (!acct) throw new Error("Connect a wallet first");
    const cfg = await view<Config>(config.marketContractId, "get_config");
    await this.send(r, config.marketContractId, "storage_deposit", { account_id: null }, cfg.storage_cost_per_account, TGAS(30), "Registered with the market");
  }
  async deposit(amount: bigint, r: TxReporter) {
    const cfg = await view<Config>(config.marketContractId, "get_config");
    await this.send(r, config.tokenContractId, "ft_transfer_call",
      { receiver_id: config.marketContractId, amount: amount.toString(), msg: cfg.deposit_msg }, YOCTO, TGAS(100), "Deposit submitted. Check that your balance changed: deposits can be refunded.");
  }
  withdraw(amount: bigint, r: TxReporter) {
    return this.send(r, config.marketContractId, "withdraw", { amount: amount.toString() }, YOCTO, TGAS(100), "Withdrawal requested. It settles asynchronously.");
  }
  split(marketId: string, amount: bigint, r: TxReporter) {
    return this.send(r, config.marketContractId, "split_position", { market_id: marketId, amount: amount.toString() }, YOCTO, TGAS(100), "YES + NO shares created");
  }
  merge(marketId: string, amount: bigint, r: TxReporter) {
    return this.send(r, config.marketContractId, "merge_positions", { market_id: marketId, amount: amount.toString() }, YOCTO, TGAS(100), "YES + NO shares combined");
  }
  async trade(): Promise<void> { throw new Error("Trading is not available in the deployed contract yet"); }
  async cancelOffer(): Promise<void> { throw new Error("Offers are not available in the deployed contract yet"); }
  async redeem(): Promise<void> { throw new Error("Redemption is not available in the deployed contract yet"); }
}
