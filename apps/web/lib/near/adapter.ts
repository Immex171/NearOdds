import type {
  AccountView, CancelResult, ConfigView, FillResult, MarketView, OfferView, Outcome as COutcome, RedeemResult, RedemptionPreview, Side as CSide,
} from "@nearodds/types";
import { formatUnits } from "../amounts";
import { ApiError, type Api } from "../api/client";
import { movementFromCandles, positionsFromPortfolio, toAccountOffer, toActivity, toHistory, toMarket, toOffers, withChainView, nsToMs } from "../api/map";
import type { ApiCandle, ApiFreshness } from "../api/types";
import { contractOutcome } from "../trading";
import { wallet } from "../wallet";
import { DeploymentError, contractKey, verifyDeployment, type LiveSettings, type MarketClaim } from "./deployment";
import { UnconfirmedError, assertAllReceiptsOk, awaitFinalOutcome, successValue, txHash } from "./outcome";
import { pendingTxs } from "./pending";
import { finalBlockHeight, nativeBalance, txStatus, view } from "./rpc";
import type {
  AccountState, ActivityItem, Capabilities, CategoryCount, CreateOfferRequest, DataAdapter, Deployment, Freshness, Holding, Market, Offer, OpenOffer, Position,
  RedeemPreview, TxReporter, WalletBalance, WithdrawalItem,
} from "../types";

/** Attached gas, as exercised on testnet (docs/frontend-handoff.md). */
const GAS_DEPOSIT = (300n * 10n ** 12n).toString(); // ft_transfer_call
const GAS_MARKET = (100n * 10n ** 12n).toString(); // split, merge, create/fill/cancel, redeem, withdraw
const GAS_STORAGE = (30n * 10n ** 12n).toString(); // storage_deposit
const ONE_YOCTO = "1";

export const NEAR_CAPABILITIES: Capabilities = {
  trading: true, limitOffers: true, partialFills: true, cancelOffers: true,
  deposit: true, withdraw: true, completeSets: true, redeem: true, history: true,
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
  if (msg.includes("account is not registered")) return "Register with this market first (Funds page).";
  if (msg.includes("is not registered")) return "Register with the token first (Funds page).";
  if (/reject|denied|cancel+ed|user closed|declined/i.test(msg)) return "You declined the request in your wallet. Nothing was sent.";
  return msg;
}

const fmt = (v: string | bigint, d = 6) => formatUnits(BigInt(v), 0, d);
const toFresh = (f: ApiFreshness): Freshness => ({ blockHeight: f.blockHeight, lagBlocks: f.lagBlocks, generatedAt: f.generatedAt });
type Described = { phase: "confirmed" | "unconfirmed" | "failed"; message: string };

/**
 * Live adapter. Discovery, books, history and portfolio come from the backend API; every wallet action is built from the
 * SELECTED market (`m.contract`) after the chain has been asked again. Nothing here reads a global "current market".
 */
export class NearAdapter implements DataAdapter {
  id = "near" as const;
  label = "Testnet";
  symbol = "tokens";
  capabilities = NEAR_CAPABILITIES;
  /** Delay between re-reads of a withdrawal record (tests set 0). */
  static pollMs = 1500;
  private subs = new Set<() => void>();
  private deployments = new Map<string, Deployment>();
  private settings = new Map<string, LiveSettings>();
  private fresh: Freshness | null = null;
  /** Remembered from listings so wallet balances can be read per distinct token. */
  private tokens = new Map<string, { tokenId: string; symbol: string }>(); // keyed by marketRef
  private contracts = new Map<string, { marketRef: string; maxOffers: number }>(); // keyed by contractId|marketId
  private candleCache = new Map<string, { at: number; candles: ApiCandle[] }>();

  constructor(private api: Api) {}

  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private emit() { this.subs.forEach((f) => f()); }
  freshness() { return this.fresh; }
  private seen(f: ApiFreshness) { this.fresh = toFresh(f); }

  // ---- deployment verification (per market) -------------------------------------------------------------------
  deployment(m: Market): Deployment {
    if (!m.contract) return { state: "error", problems: ["This market has no contract."] };
    return this.deployments.get(contractKey(m.contract)) ?? { state: "idle" };
  }
  async verify(m: Market, force = false): Promise<void> {
    if (!m.contract) return;
    const key = contractKey(m.contract);
    if (!force && this.deployments.get(key)?.state === "ok") return;
    this.deployments.set(key, { state: "checking" });
    this.emit();
    try {
      this.settings.set(key, await this.settingsFor(m, force));
      this.deployments.set(key, { state: "ok" });
    } catch (e) {
      this.deployments.set(key, { state: "error", problems: e instanceof DeploymentError ? e.problems : [e instanceof Error ? e.message : String(e)] });
    }
    this.emit();
  }
  private claim(m: Market): MarketClaim | undefined {
    return m.chainClaim ? { token: { symbol: m.token.symbol, decimals: m.token.decimals }, trading: m.chainClaim.trading, question: m.chainClaim.question, cutoffNs: m.chainClaim.cutoffNs } : undefined;
  }
  private settingsFor(m: Market, force = false) {
    if (!m.contract) throw new Error("This market has no contract.");
    return verifyDeployment(m.contract, this.claim(m), force);
  }
  /** Transactions never start unless this market's contract, token, config and identity were verified. */
  private async ready(m: Market): Promise<{ s: LiveSettings; c: NonNullable<Market["contract"]> }> {
    if (!m.contract) throw new Error("This market has no contract.");
    try {
      const s = await this.settingsFor(m);
      this.settings.set(contractKey(m.contract), s);
      this.deployments.set(contractKey(m.contract), { state: "ok" });
      return { s, c: m.contract };
    } catch (e) {
      const problems = e instanceof DeploymentError ? e.problems : [e instanceof Error ? e.message : String(e)];
      this.deployments.set(contractKey(m.contract), { state: "error", problems });
      this.emit();
      throw new Error(`Transactions are disabled for this market: ${problems.join(" ")}`);
    }
  }

  costs(m: Market) {
    const s = m.contract ? this.settings.get(contractKey(m.contract)) : undefined;
    return s ? { tokenStorage: s.tokenStorageMin, marketStorage: BigInt(s.cfg.storage_cost_per_account), tokenOwnerHint: s.cfg.resolver_id } : null;
  }

  // ---- reads: backend API -----------------------------------------------------------------------------------------
  private remember(ms: Market[]) {
    for (const m of ms) {
      if (!m.contract) continue;
      this.tokens.set(m.id, { tokenId: m.contract.tokenId, symbol: m.token.symbol });
      this.contracts.set(`${m.contract.contractId}|${m.contract.marketId}`, { marketRef: m.id, maxOffers: m.limits.maxOpenOffers });
    }
    if (ms[0]) this.symbol = ms[0].token.symbol;
  }

  async listMarkets(): Promise<Market[]> {
    const out: Market[] = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await this.api.markets({ limit: 100, offset, sort: "newest" });
      this.seen(page.freshness);
      out.push(...page.items.map(toMarket));
      if (offset + page.items.length >= page.page.total || page.items.length === 0) break;
    }
    this.remember(out);
    return out;
  }
  async listCategories(): Promise<CategoryCount[]> { return (await this.api.categories()).items; }
  async searchMarkets(q: string): Promise<Market[]> {
    const page = await this.api.markets({ q, limit: 20 });
    this.seen(page.freshness);
    return page.items.map(toMarket);
  }

  async getMarket(ref: string): Promise<Market | null> {
    let m: Market;
    try {
      const a = await this.api.market(ref);
      this.seen(a.freshness);
      m = toMarket(a);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
    this.remember([m]);
    // Status and action flags must come from the contract, not from an indexer that may lag.
    try {
      const mv = await view<MarketView>(m.contract!.contractId, "get_market", { market_id: m.contract!.marketId });
      return { ...withChainView(m, mv), chain: "fresh" };
    } catch {
      return { ...m, chain: "unavailable" };
    }
  }

  async getBook(ref: string): Promise<Offer[]> {
    const b = await this.api.book(ref);
    this.seen(b.freshness);
    return toOffers(b, ref);
  }

  private async candles(ref: string): Promise<ApiCandle[]> {
    const hit = this.candleCache.get(ref);
    if (hit && Date.now() - hit.at < 5000) return hit.candles;
    const r = await this.api.candles(ref, { outcome: "Yes", interval: "1h", limit: 500 });
    this.seen(r.freshness);
    this.candleCache.set(ref, { at: Date.now(), candles: r.candles });
    return r.candles;
  }
  async getHistory(ref: string) { return toHistory(await this.candles(ref)); }
  async getMovement(m: Market, now: number) {
    if (m.lastYes == null || !m.coverage) return null;
    try { return movementFromCandles(await this.candles(m.id), now, m.lastYes, m.coverage.historyComplete); } catch { return null; }
  }

  async getActivity(ref: string): Promise<ActivityItem[]> {
    const r = await this.api.activity(ref, 50);
    this.seen(r.freshness);
    const sym = this.tokens.get(ref)?.symbol ?? "";
    return r.items.map((a) => toActivity(a, sym));
  }

  // ---- account ----------------------------------------------------------------------------------------------------
  async getAccount(accountId: string, market?: Market): Promise<AccountState | null> {
    return market ? this.marketAccount(accountId, market) : this.portfolio(accountId);
  }

  /** One market contract, read from the chain at one block (fresh by construction). */
  private async marketAccount(accountId: string, m: Market): Promise<AccountState> {
    const c = m.contract;
    if (!c) throw new Error("This market has no contract.");
    const h = await finalBlockHeight();
    const [acct, bal, tokenStorage, offers, cfg, near] = await Promise.all([
      view<AccountView | null>(c.contractId, "get_account", { account_id: accountId }, h),
      view<string>(c.tokenId, "ft_balance_of", { account_id: accountId }, h),
      view<{ total: string } | null>(c.tokenId, "storage_balance_of", { account_id: accountId }, h),
      view<OfferView[]>(c.contractId, "get_account_offers", { account_id: accountId }, h),
      view<ConfigView>(c.contractId, "get_config", {}, h),
      nativeBalance(accountId),
    ]);
    const wallets: WalletBalance[] = [{ tokenId: c.tokenId, symbol: m.token.symbol, balance: BigInt(bal), tokenRegistered: Boolean(tokenStorage) }];
    const holding: Holding = {
      marketRef: m.id, symbol: m.token.symbol, registered: Boolean(acct), available: 0n, committed: 0n, pendingWithdrawal: 0n,
      storageCostYocto: BigInt(cfg.storage_cost_per_account), maxOpenOffers: cfg.trading.max_open_offers_per_account,
    };
    const base: AccountState = { accountId, isDemo: false, wallets, nearBalance: near, holdings: [holding], positions: [], offers: [], activity: [], withdrawals: [] };
    if (!acct) return base;
    holding.available = BigInt(acct.available_collateral);
    holding.committed = BigInt(acct.reserved_collateral);
    const w = acct.pending_withdrawal;
    holding.pendingWithdrawal = w?.status === "Pending" ? BigInt(w.amount) : 0n;
    holding.withdrawal = w ? { id: w.withdrawal_id, amount: BigInt(w.amount), status: w.status } : null;
    if (w) base.withdrawals = [{ ref: `${m.id}:${w.withdrawal_id}`, marketRef: m.id, id: w.withdrawal_id, amount: BigInt(w.amount), status: w.status, requestedAt: 0, settledAt: null }];
    const pos = (o: "YES" | "NO", q: string, r: string): Position | null =>
      BigInt(q) + BigInt(r) > 0n ? { marketId: m.id, outcome: o, qty: BigInt(q), reserved: BigInt(r), avgPrice: null } : null;
    base.positions = [pos("YES", acct.yes, acct.reserved_yes), pos("NO", acct.no, acct.reserved_no)].filter((p): p is Position => p !== null);
    base.offers = offers.map((o): OpenOffer => ({
      id: `${m.id}:${o.offer_id}`, offerId: o.offer_id, marketId: m.id, outcome: o.outcome === "Yes" ? "YES" : "NO", side: o.side === "Buy" ? "buy" : "sell",
      price: BigInt(o.price), qty: BigInt(o.remaining_quantity), owner: o.owner_id, createdAt: nsToMs(o.created_at_ns) ?? 0,
      fillable: o.fillable, expiresAt: o.expires_at_ns ? nsToMs(o.expires_at_ns) : null, status: "open",
    }));
    return base;
  }

  /**
   * All markets at once: the backend portfolio, plus the wallet balance of each DISTINCT token (read once per token even
   * when several markets use it). An unreadable value stays null; it is never shown as zero.
   */
  private async portfolio(accountId: string): Promise<AccountState> {
    if (this.tokens.size === 0) await this.listMarkets().catch(() => undefined);
    const [p, act] = await Promise.all([this.api.portfolio(accountId), this.api.accountActivity(accountId, 50).catch(() => null)]);
    this.seen(p.freshness);
    const distinct = new Map<string, string>(); // tokenId -> symbol
    for (const t of this.tokens.values()) distinct.set(t.tokenId, t.symbol);
    const wallets: WalletBalance[] = await Promise.all([...distinct].map(async ([tokenId, symbol]): Promise<WalletBalance> => {
      const [bal, reg] = await Promise.all([
        view<string>(tokenId, "ft_balance_of", { account_id: accountId }).then((x) => BigInt(x)).catch(() => null),
        view<unknown>(tokenId, "storage_balance_of", { account_id: accountId }).then((x) => Boolean(x)).catch(() => null),
      ]);
      return { tokenId, symbol, balance: bal, tokenRegistered: reg };
    }));
    const near = await nativeBalance(accountId).catch(() => null);
    const lastWd = new Map<string, WithdrawalItem>();
    const withdrawals: WithdrawalItem[] = p.withdrawals.map((w) => ({
      ref: w.withdrawalRef, marketRef: w.marketRef, id: w.withdrawalId, amount: BigInt(w.amount), status: w.status, requestedAt: nsToMs(w.requestedNs) ?? 0, settledAt: nsToMs(w.settledNs),
    }));
    for (const w of withdrawals) if (!lastWd.has(w.marketRef)) lastWd.set(w.marketRef, w); // API returns newest first
    const holdings: Holding[] = p.markets.map((x) => {
      const w = lastWd.get(x.marketRef);
      const drift = Array.isArray(x.driftNote) ? x.driftNote.length : x.driftNote ? 1 : 0;
      return {
        marketRef: x.marketRef, symbol: x.token.symbol, registered: x.registered,
        available: BigInt(x.collateral.available), committed: BigInt(x.collateral.reserved), pendingWithdrawal: BigInt(x.collateral.pendingWithdrawal),
        withdrawal: w ? { id: w.id, amount: w.amount, status: w.status } : null,
        maxOpenOffers: this.contracts.get(`${x.contract.contractId}|${x.contract.marketId}`)?.maxOffers ?? 10,
        driftNote: drift ? `${drift} balance${drift === 1 ? "" : "s"} differ between the indexer and the chain` : null,
      };
    });
    const drifted = holdings.filter((h) => h.driftNote).length;
    return {
      accountId, isDemo: false, wallets, nearBalance: near, holdings,
      positions: positionsFromPortfolio(p), offers: p.openOffers.map(toAccountOffer),
      activity: act ? act.items.map((a) => toActivity(a, this.tokens.get(a.marketRef)?.symbol ?? "")) : [],
      withdrawals,
      notes: drifted ? [`The indexer and the chain disagree about ${drifted} of your market balance${drifted === 1 ? "" : "s"}. Indexed numbers may lag; open the market to read live values.`] : undefined,
    };
  }

  async redeemPreview(m: Market, accountId: string): Promise<RedeemPreview | null> {
    if (!m.contract) return null;
    const p = await view<RedemptionPreview>(m.contract.contractId, "get_redemption_preview", { account_id: accountId });
    return {
      redeemable: p.redeemable, outcome: p.outcome ? (p.outcome === "Yes" ? "YES" : "NO") : null,
      winningShares: BigInt(p.winning_shares), losingShares: BigInt(p.losing_shares), payout: BigInt(p.payout),
      releasedCollateral: BigInt(p.released_collateral), releasedShares: BigInt(p.released_shares),
      offersToRelease: p.offers_to_release.length, availableAfter: BigInt(p.available_collateral_after),
    };
  }

  // ---- transactions -----------------------------------------------------------------------------------------------
  /**
   * Sends one transaction through the user's wallet, then asks the CHAIN for the final result: the wallet's own
   * "success" is not trusted. If the result cannot be read, the transaction stays tied to its hash as "unconfirmed" and
   * is only ever re-READ. Nothing is ever resubmitted automatically.
   */
  private async send(
    m: Market, r: TxReporter, label: string, receiver: string, method: string, args: object, deposit: string, gas: string,
    describe: (outcome: unknown) => Promise<Described> | Described,
  ) {
    let hash: string | undefined;
    const signer = wallet.account();
    try {
      if (!signer) throw new Error("Connect a wallet first");
      r({ phase: "awaiting-wallet", message: "Approve the transaction in your wallet…" });
      const sent = await wallet.call(receiver, method, args, deposit, gas);
      hash = txHash(sent);
      if (!hash) throw new Error("Your wallet did not return a transaction hash, so the result cannot be verified. Do not resend: check your wallet history, then refresh.");
      r({ phase: "confirming", message: "Submitted. Waiting for the network to finalise every receipt…", hash });
      let final: unknown;
      try {
        final = await awaitFinalOutcome(hash, signer);
      } catch (e) {
        // Submitted but unreadable (timeout or RPC failure): remember the hash and keep tracking it. Never resend.
        const msg = e instanceof UnconfirmedError ? e.message : `The network could not be read (${e instanceof Error ? e.message : "unknown error"}). The transaction may still succeed. Do not resend it.`;
        pendingTxs.add({ hash, signer, label, marketRef: m.id, at: Date.now() });
        r({ phase: "unconfirmed", message: msg, hash });
        return;
      }
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

  /** Re-reads (never resends) a transaction that was left unconfirmed. */
  async checkPending(hash: string, signer: string): Promise<"done" | "failed" | "waiting"> {
    try {
      const o = await txStatus(hash, signer);
      if (!o) return "waiting";
      const x = o as { final_execution_status?: string };
      if (x.final_execution_status && x.final_execution_status !== "FINAL" && x.final_execution_status !== "EXECUTED") return "waiting";
      assertAllReceiptsOk(o);
      return "done";
    } catch (e) {
      return e instanceof Error && /RPC|fetch|network/i.test(e.message) ? "waiting" : "failed";
    }
  }

  // Preflight reads: ask the contract again right before the wallet is opened.
  private marketView = (c: { contractId: string; marketId: string }) => view<MarketView>(c.contractId, "get_market", { market_id: c.marketId });
  private accountView = (c: { contractId: string }, a: string) => view<AccountView | null>(c.contractId, "get_account", { account_id: a });
  private me() { const a = wallet.account(); if (!a) throw new Error("Connect a wallet first"); return a; }

  async registerToken(m: Market, r: TxReporter) {
    const acct = this.me();
    const { s, c } = await this.ready(m);
    await this.send(m, r, "Register with token", c.tokenId, "storage_deposit", { account_id: acct, registration_only: true }, s.tokenStorageMin.toString(), GAS_STORAGE,
      async () => ((await view<unknown>(c.tokenId, "storage_balance_of", { account_id: acct })) ? { phase: "confirmed", message: `Registered with the ${m.token.symbol} token.` } : { phase: "failed", message: "The token still shows you as unregistered. Refresh and check the explorer; do not resend yet." }));
  }
  async registerMarket(m: Market, r: TxReporter) {
    const acct = this.me();
    const { s, c } = await this.ready(m);
    await this.send(m, r, "Register with market", c.contractId, "storage_deposit", { account_id: null, registration_only: true }, s.cfg.storage_cost_per_account, GAS_STORAGE,
      async () => ((await this.accountView(c, acct)) ? { phase: "confirmed", message: "Registered with this market." } : { phase: "failed", message: "The market still shows you as unregistered. Refresh and check the explorer; do not resend yet." }));
  }

  async deposit(m: Market, amount: bigint, r: TxReporter) {
    const acct = this.me();
    const { s, c } = await this.ready(m);
    const [bal, reg] = await Promise.all([view<string>(c.tokenId, "ft_balance_of", { account_id: acct }), this.accountView(c, acct)]);
    if (!reg) throw new Error("Register with this market first (Funds page). Depositing before registering is refunded.");
    if (BigInt(bal) < amount) throw new Error(`Your wallet holds only ${fmt(bal)} ${m.token.symbol}.`);
    await this.send(m, r, `Deposit ${fmt(amount)} ${m.token.symbol}`, c.tokenId, "ft_transfer_call", { receiver_id: c.contractId, amount: amount.toString(), msg: s.cfg.deposit_msg }, ONE_YOCTO, GAS_DEPOSIT, (final) => {
      // ft_transfer_call returns the amount the receiver actually USED; the rest is refunded to the sender.
      const used = successValue<string>(final);
      if (used == null) return { phase: "unconfirmed", message: "The deposit finished but the contract returned no accepted amount. Check your balances before trying again." };
      const u = BigInt(used);
      if (u === 0n) return { phase: "failed", message: "The market refunded the whole deposit. Make sure you are registered with this market, then try again." };
      if (u < amount) return { phase: "confirmed", message: `Deposited ${fmt(u)} ${m.token.symbol}. ${fmt(amount - u)} ${m.token.symbol} was refunded to your wallet.` };
      return { phase: "confirmed", message: `Deposited ${fmt(u)} ${m.token.symbol} into this market.` };
    });
  }

  async withdraw(m: Market, amount: bigint, r: TxReporter) {
    const acct = this.me();
    const { c } = await this.ready(m);
    const [a, tokenReg] = await Promise.all([this.accountView(c, acct), view<unknown>(c.tokenId, "storage_balance_of", { account_id: acct })]);
    if (!a) throw new Error("You are not registered with this market.");
    if (a.pending_withdrawal?.status === "Pending") throw new Error("A withdrawal is already pending and unconfirmed. Wait for it to settle; do not resend it.");
    if (!tokenReg) throw new Error("Register with the token first (Funds page): the transfer would fail without it.");
    if (BigInt(a.available_collateral) < amount) throw new Error(`Only ${fmt(a.available_collateral)} ${m.token.symbol} is available to withdraw from this market.`);
    await this.send(m, r, `Withdraw ${fmt(amount)} ${m.token.symbol}`, c.contractId, "withdraw", { amount: amount.toString() }, ONE_YOCTO, GAS_MARKET, async () => {
      // The callback verdict is in the final outcome, but the stored record is what counts. Re-read it.
      let w: AccountView["pending_withdrawal"] = null;
      for (let i = 0; i < 6; i++) {
        w = (await this.accountView(c, acct))?.pending_withdrawal ?? null;
        if (w && w.status !== "Pending") break;
        await new Promise((x) => setTimeout(x, NearAdapter.pollMs));
      }
      if (w?.status === "Completed") return { phase: "confirmed", message: `Withdrew ${fmt(w.amount)} ${m.token.symbol} to your wallet.` };
      if (w?.status === "FailedRestored") return { phase: "failed", message: `The token transfer failed. ${fmt(w.amount)} ${m.token.symbol} was returned to your available balance.` };
      return { phase: "unconfirmed", message: "Withdrawal requested but NOT confirmed. Do not resend it. The amount is held until the contract records the result; this page keeps tracking it." };
    });
  }

  async split(m: Market, amount: bigint, r: TxReporter) {
    const acct = this.me();
    const { c } = await this.ready(m);
    const [mv, a] = await Promise.all([this.marketView(c), this.accountView(c, acct)]);
    if (!mv.split_open) throw new Error("Creating shares is closed: the trading cutoff has passed.");
    if (!a) throw new Error("Register with this market first (Funds page).");
    if (BigInt(a.available_collateral) < amount) throw new Error(`Only ${fmt(a.available_collateral)} ${m.token.symbol} is available in this market.`);
    await this.send(m, r, "Create shares", c.contractId, "split_position", { market_id: c.marketId, amount: amount.toString() }, ONE_YOCTO, GAS_MARKET,
      () => ({ phase: "confirmed", message: `Created ${fmt(amount)} YES + ${fmt(amount)} NO shares.` }));
  }
  async merge(m: Market, amount: bigint, r: TxReporter) {
    const acct = this.me();
    const { c } = await this.ready(m);
    const [mv, a] = await Promise.all([this.marketView(c), this.accountView(c, acct)]);
    if (!mv.merge_open) throw new Error("Combining shares is closed: this market is resolved. Redeem instead.");
    if (!a || BigInt(a.yes) < amount || BigInt(a.no) < amount) throw new Error("You need that many available YES and NO shares in this market.");
    await this.send(m, r, "Combine shares", c.contractId, "merge_positions", { market_id: c.marketId, amount: amount.toString() }, ONE_YOCTO, GAS_MARKET,
      () => ({ phase: "confirmed", message: `Combined ${fmt(amount)} YES + ${fmt(amount)} NO shares into ${fmt(amount)} ${m.token.symbol}.` }));
  }

  async createOffer(m: Market, q: CreateOfferRequest, r: TxReporter) {
    const acct = this.me();
    const { c } = await this.ready(m);
    const [mv, a, mine] = await Promise.all([this.marketView(c), this.accountView(c, acct), view<OfferView[]>(c.contractId, "get_account_offers", { account_id: acct })]);
    if (!mv.trading_open) throw new Error("Trading is closed: the market cutoff has passed.");
    if (!a) throw new Error("Register with this market first (Funds page).");
    if (mine.length >= m.limits.maxOpenOffers) throw new Error("You already have the maximum number of open offers. Cancel one first.");
    const need = (q.price * q.qty) / m.limits.priceScale; // floor: if even this is unaffordable, the offer certainly is
    if (q.side === "buy" && BigInt(a.available_collateral) < need) throw new Error(`Insufficient available collateral in this market: need ${fmt(need)} ${m.token.symbol}, have ${fmt(a.available_collateral)}.`);
    if (q.side === "sell" && BigInt(q.outcome === "YES" ? a.yes : a.no) < q.qty) throw new Error(`Insufficient ${q.outcome} shares in this market.`);
    await this.send(m, r, "Create offer", c.contractId, "create_offer", {
      market_id: c.marketId, outcome: contractOutcome(q.outcome), side: q.side === "buy" ? "Buy" : "Sell",
      price: q.price.toString(), quantity: q.qty.toString(),
      ...(q.expiresAt ? { expires_at_ns: (BigInt(q.expiresAt) * 1_000_000n).toString() } : {}),
    }, ONE_YOCTO, GAS_MARKET, (final) => {
      const o = successValue<OfferView>(final);
      return { phase: "confirmed", message: o?.offer_id ? `Limit offer #${o.offer_id} is open.` : "Limit offer created." };
    });
  }

  async fillOffer(m: Market, offer: Offer, qty: bigint, r: TxReporter) {
    const acct = this.me();
    const { c } = await this.ready(m);
    // Refresh the exact offer from THIS market's contract before the wallet opens.
    const [mv, o, a] = await Promise.all([this.marketView(c), view<OfferView | null>(c.contractId, "get_offer", { offer_id: offer.offerId }), this.accountView(c, acct)]);
    if (!mv.trading_open) throw new Error("Trading is closed: the market cutoff has passed.");
    if (!o) throw new Error("This offer is no longer available: another trader filled or cancelled it. Pick another offer.");
    if (o.owner_id !== offer.owner || BigInt(o.price) !== offer.price) throw new Error("This offer changed since you opened the ticket. Review the updated book and try again.");
    if (!o.fillable) throw new Error("This offer can no longer be filled (expired).");
    if (BigInt(o.remaining_quantity) < qty) throw new Error(`Only ${fmt(o.remaining_quantity)} shares remain on this offer now. Lower the quantity.`);
    if (!a) throw new Error("Register with this market first (Funds page).");
    if (offer.side === "sell") {
      const cost = (offer.price * qty) / m.limits.priceScale;
      if (BigInt(a.available_collateral) < cost) throw new Error(`Insufficient available collateral in this market: need ${fmt(cost)} ${m.token.symbol}, have ${fmt(a.available_collateral)}.`);
    } else if (BigInt(offer.outcome === "YES" ? a.yes : a.no) < qty) throw new Error(`Insufficient ${offer.outcome} shares in this market.`);
    await this.send(m, r, "Take offer", c.contractId, "fill_offer", { offer_id: offer.offerId, quantity: qty.toString() }, ONE_YOCTO, GAS_MARKET, (final) => {
      const f = successValue<FillResult>(final);
      return { phase: "confirmed", message: f ? `Filled ${fmt(f.quantity)} shares for ${fmt(f.collateral_amount)} ${m.token.symbol}${f.status === "PartiallyFilled" ? ` (${fmt(f.remaining_quantity)} still on that offer)` : ""}.` : "Offer filled." };
    });
  }

  async cancelOffer(m: Market, offer: Offer, r: TxReporter) {
    const { c } = await this.ready(m);
    const o = await view<OfferView | null>(c.contractId, "get_offer", { offer_id: offer.offerId });
    if (!o) throw new Error("This offer is already gone: it was filled, cancelled or released. Nothing to cancel.");
    await this.send(m, r, "Cancel offer", c.contractId, "cancel_offer", { offer_id: offer.offerId }, ONE_YOCTO, GAS_MARKET, (final) => {
      const x = successValue<CancelResult>(final);
      return { phase: "confirmed", message: x ? `Offer cancelled. Released ${BigInt(x.released_collateral) > 0n ? `${fmt(x.released_collateral)} ${m.token.symbol}` : `${fmt(x.released_shares)} shares`} back to your balance.` : "Offer cancelled." };
    });
  }

  async redeem(m: Market, r: TxReporter) {
    const acct = this.me();
    const { c } = await this.ready(m);
    const [mv, p] = await Promise.all([this.marketView(c), view<RedemptionPreview>(c.contractId, "get_redemption_preview", { account_id: acct })]);
    if (mv.status !== "Resolved") throw new Error("The market has not been resolved yet.");
    if (!p.redeemable) throw new Error("Nothing to redeem.");
    await this.send(m, r, "Redeem", c.contractId, "redeem", { market_id: c.marketId }, ONE_YOCTO, GAS_MARKET, (final) => {
      const x = successValue<RedeemResult>(final);
      return { phase: "confirmed", message: x
        ? `Redeemed: ${fmt(x.payout)} ${m.token.symbol} winning payout${BigInt(x.released_collateral) > 0n ? ` plus ${fmt(x.released_collateral)} ${m.token.symbol} released from offers` : ""} is now in your available balance inside this market. Withdraw it to move it to your wallet.`
        : "Redeemed into your available balance. Withdraw it to move it to your wallet." };
    });
  }
}

export type { COutcome, CSide };
