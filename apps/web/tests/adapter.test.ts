import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@/lib/api/client";
import { toMarket } from "@/lib/api/map";
import { clearDeploymentCache } from "@/lib/near/deployment";
import { NearAdapter } from "@/lib/near/adapter";
import { pendingTxs } from "@/lib/near/pending";
import type { Market, Offer, TxState } from "@/lib/types";
import { FRESH, apiMarket, chainConfig, chainMarket, type Contract } from "./helpers";

const USER = "alice.testnet";
// Two DIFFERENT market contracts that share the internal market id "mkt-1", the same token, and the same local offer id "4".
const CA: Contract = { contractId: "mkt-a.testnet", marketId: "mkt-1", tokenId: "tok.testnet" };
const CB: Contract = { contractId: "mkt-b.testnet", marketId: "mkt-1", tokenId: "tok.testnet" };
const CC: Contract = { contractId: "mkt-c.testnet", marketId: "mkt-9", tokenId: "tok2.testnet" };

const calls: Array<{ receiver: string; method: string; args: Record<string, unknown>; deposit: string; gas: string }> = [];
let nextHash = "HASH1";
vi.mock("@/lib/wallet", () => ({
  wallet: {
    account: () => USER,
    call: vi.fn(async (receiver: string, method: string, args: Record<string, unknown>, deposit: string, gas: string) => {
      calls.push({ receiver, method, args, deposit, gas });
      return nextHash ? { transaction_outcome: { id: nextHash } } : {};
    }),
  },
}));

type Json = unknown;
let views: Record<string, Json | (() => Json)> = {};
let txOutcomes: Record<string, Json> = {};
let failRpc = false;
const queried: Array<{ account: string; method: string; at: unknown }> = [];
const ok = (v: Json) => ({ status: { SuccessValue: btoa(JSON.stringify(v)) }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] });

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    if (failRpc) throw new Error("network down");
    const { method, params } = JSON.parse(init.body);
    const reply = (result: Json) => ({ ok: true, json: async () => ({ result }) });
    if (method === "block") return reply({ header: { height: 777 } });
    if (method === "tx") return reply(txOutcomes[params.tx_hash]);
    if (method === "query" && params.request_type === "view_account") return reply({ amount: "5000000000000000000000000" });
    if (method === "query") {
      queried.push({ account: params.account_id, method: params.method_name, at: params.block_id ?? params.finality });
      const key = `${params.account_id}:${params.method_name}`;
      const v = views[key];
      if (v === undefined) throw new Error(`no view fixture for ${key}`);
      return reply({ result: Array.from(new TextEncoder().encode(JSON.stringify(typeof v === "function" ? (v as () => Json)() : v))) });
    }
    throw new Error(`unexpected rpc ${method}`);
  }));
}

const markets = new Map<string, Market>();
const portfolioMarkets: unknown[] = [];
const api = {
  markets: async () => ({ items: [...markets.values()].map((m) => apiMarket(m.id, m.contract!)), page: { limit: 100, offset: 0, total: markets.size }, freshness: FRESH }),
  market: async (ref: string) => { const m = markets.get(ref); if (!m) { const { ApiError } = await import("@/lib/api/client"); throw new ApiError(404, "not_found", "market not found"); } return { ...apiMarket(ref, m.contract!), freshness: FRESH }; },
  book: async () => ({ yes: { bids: [], asks: [] }, no: { bids: [], asks: [] }, unfillable: [], freshness: FRESH }),
  candles: async () => ({ candles: [], freshness: FRESH }),
  portfolio: async () => ({ accountId: USER, markets: portfolioMarkets, openOffers: [], withdrawals: [], freshness: FRESH }),
  accountActivity: async () => ({ items: [], freshness: FRESH }),
} as unknown as Api;

const A = () => markets.get("m_a")!;
const B = () => markets.get("m_b")!;
const reporter = () => { const seen: TxState[] = []; return { r: (s: TxState) => seen.push(s), last: () => seen[seen.length - 1] }; };
const offer = (m: Market, id: string, over: Partial<Offer> = {}): Offer => ({
  id: `${m.id}:${id}`, offerId: id, marketId: m.id, outcome: "YES", side: "sell", price: 650_000n, qty: 10_000_000n, owner: "lp.testnet", createdAt: 0, fillable: true, ...over,
});
const offerView = (id: string, over: Record<string, unknown> = {}) => ({ offer_id: id, owner_id: "lp.testnet", outcome: "Yes", side: "Sell", price: "650000", remaining_quantity: "10000000", fillable: true, ...over });
const account = (over: Record<string, unknown> = {}) => ({ available_collateral: "50000000", reserved_collateral: "0", yes: "20000000", no: "20000000", reserved_yes: "0", reserved_no: "0", pending_withdrawal: null, ...over });

function setChain(c: Contract, o: { account?: unknown; offers?: Record<string, unknown>; market?: Record<string, unknown> } = {}) {
  views[`${c.contractId}:get_config`] = chainConfig(c);
  views[`${c.contractId}:get_market`] = chainMarket(c, o.market);
  views[`${c.contractId}:get_account`] = o.account === undefined ? account() : o.account;
  views[`${c.contractId}:get_account_offers`] = [];
  views[`${c.contractId}:get_offer`] = () => null;
  views[`${c.tokenId}:ft_metadata`] = { name: "NearOdds TEST Collateral (no value)", symbol: "tNOC", decimals: 6 };
  views[`${c.tokenId}:storage_balance_bounds`] = { min: "1250000000000000000000", max: null };
  views[`${c.tokenId}:storage_balance_of`] = { total: "1250000000000000000000", available: "0" };
  views[`${c.tokenId}:ft_balance_of`] = "100000000";
}

let adapter: NearAdapter;
beforeEach(() => {
  calls.length = 0; queried.length = 0; nextHash = "HASH1"; txOutcomes = {}; failRpc = false; portfolioMarkets.length = 0;
  clearDeploymentCache();
  pendingTxs.list().forEach((p) => pendingTxs.remove(p.hash));
  NearAdapter.pollMs = 0;
  views = {};
  setChain(CA); setChain(CB);
  markets.clear();
  markets.set("m_a", toMarket(apiMarket("m_a", CA, { question: `Question for ${CA.contractId}?` })));
  markets.set("m_b", toMarket(apiMarket("m_b", CB, { question: `Question for ${CB.contractId}?` })));
  installFetch();
  adapter = new NearAdapter(api);
});

describe("per-market verification", () => {
  it("verifies each market's own contract, token, config and identity", async () => {
    await adapter.verify(A());
    expect(adapter.deployment(A()).state).toBe("ok");
    expect(adapter.deployment(B()).state).toBe("idle");
    expect(queried.filter((q) => q.method === "get_config").map((q) => q.account)).toEqual([CA.contractId]);
  });
  it("one market failing verification disables only that market", async () => {
    views[`${CB.contractId}:get_config`] = { ...chainConfig(CB), collateral_token_id: "someone-else.testnet" };
    await adapter.verify(A()); await adapter.verify(B());
    expect(adapter.deployment(A()).state).toBe("ok");
    expect(adapter.deployment(B()).state).toBe("error");
    txOutcomes.HASH1 = ok(null);
    await expect(adapter.split(B(), 1_000_000n, reporter().r)).rejects.toThrow(/Transactions are disabled for this market/);
    expect(calls).toHaveLength(0);
    await adapter.split(A(), 1_000_000n, reporter().r);
    expect(calls).toHaveLength(1);
  });
  it("refuses a market whose on-chain question differs from what the API lists", async () => {
    views[`${CA.contractId}:get_market`] = chainMarket(CA, {}, "A different question?");
    await adapter.verify(A());
    expect(adapter.deployment(A())).toMatchObject({ state: "error" });
  });
  it("the same market id on two contracts does not share a verification cache entry", async () => {
    views[`${CB.contractId}:get_market`] = chainMarket(CB, { split_cutoff_ns: "1" });
    await adapter.verify(A()); await adapter.verify(B());
    expect([adapter.deployment(A()).state, adapter.deployment(B()).state]).toEqual(["ok", "error"]);
  });
});

describe("every wallet action targets the SELECTED contract", () => {
  const T = 10n ** 12n;
  it.each([["A", () => A(), CA], ["B", () => B(), CB]] as const)("market %s: split/merge/create/fill/cancel/redeem/withdraw go to its own contract with its own market_id", async (_n, get, c) => {
    const m = get();
    views[`${c.contractId}:get_offer`] = () => offerView("4");
    views[`${c.contractId}:get_redemption_preview`] = { redeemable: true, offers_to_release: [] };
    txOutcomes.HASH1 = ok(null);
    await adapter.split(m, 2_000_000n, reporter().r);
    await adapter.merge(m, 2_000_000n, reporter().r);
    await adapter.createOffer(m, { marketId: m.id, outcome: "NO", side: "sell", price: 400_000n, qty: 5_000_000n }, reporter().r);
    await adapter.fillOffer(m, offer(m, "4"), 100n, reporter().r);
    await adapter.cancelOffer(m, offer(m, "4"), reporter().r);
    views[`${c.contractId}:get_market`] = chainMarket(c, { status: "Resolved", resolved: true, trading_open: false, split_open: false, merge_open: false });
    await adapter.redeem(m, reporter().r);
    const byMethod = Object.fromEntries(calls.map((x) => [x.method, x]));
    expect(calls.every((x) => x.receiver === c.contractId)).toBe(true);
    expect(byMethod.split_position.args).toEqual({ market_id: c.marketId, amount: "2000000" });
    expect(byMethod.merge_positions.args).toEqual({ market_id: c.marketId, amount: "2000000" });
    expect(byMethod.create_offer.args).toEqual({ market_id: c.marketId, outcome: "No", side: "Sell", price: "400000", quantity: "5000000" });
    expect(byMethod.fill_offer.args).toEqual({ offer_id: "4", quantity: "100" });
    expect(byMethod.cancel_offer.args).toEqual({ offer_id: "4" });
    expect(byMethod.redeem.args).toEqual({ market_id: c.marketId });
    expect(calls.every((x) => x.deposit === "1" && x.gas === (100n * T).toString())).toBe(true);
  });
  it("the same local offer id on two contracts is filled on the contract of the offer's own market", async () => {
    views[`${CA.contractId}:get_offer`] = () => offerView("4");
    views[`${CB.contractId}:get_offer`] = () => offerView("4");
    txOutcomes.HASH1 = ok({ offer_id: "4", quantity: "100", collateral_amount: "65", remaining_quantity: "9999900", status: "PartiallyFilled" });
    const a = offer(A(), "4"), b = offer(B(), "4");
    expect(a.id).not.toBe(b.id); // frontend identities differ
    expect(a.offerId).toBe(b.offerId); // contract-local ids collide
    await adapter.fillOffer(A(), a, 100n, reporter().r);
    await adapter.fillOffer(B(), b, 100n, reporter().r);
    expect(calls.map((c) => [c.receiver, c.args.offer_id])).toEqual([[CA.contractId, "4"], [CB.contractId, "4"]]);
  });
  it("registration: token registration goes to the token, market registration to the selected market contract", async () => {
    txOutcomes.HASH1 = ok(null);
    await adapter.registerToken!(B(), reporter().r);
    await adapter.registerMarket!(B(), reporter().r);
    expect(calls[0]).toMatchObject({ receiver: CB.tokenId, method: "storage_deposit", args: { account_id: USER, registration_only: true }, deposit: "1250000000000000000000" });
    expect(calls[1]).toMatchObject({ receiver: CB.contractId, method: "storage_deposit", args: { account_id: null, registration_only: true }, deposit: "40960000000000000000000" });
  });
  it("deposit: ft_transfer_call on the token with receiver_id = the SELECTED market contract, 1 yocto, 300 Tgas", async () => {
    txOutcomes.HASH1 = ok("5000000");
    const t = reporter();
    await adapter.deposit(B(), 5_000_000n, t.r);
    expect(calls[0]).toEqual({ receiver: CB.tokenId, method: "ft_transfer_call", args: { receiver_id: CB.contractId, amount: "5000000", msg: "deposit" }, deposit: "1", gas: (300n * T).toString() });
    expect(t.last().message).toMatch(/Deposited 5 tNOC/);
  });
  it("deposit: a full refund is a failure; a partial refund says how much", async () => {
    txOutcomes.HASH1 = ok("0");
    const t = reporter();
    await expect(adapter.deposit(A(), 5_000_000n, t.r)).rejects.toThrow(/refunded/);
    txOutcomes.HASH1 = ok("3000000");
    const t2 = reporter();
    await adapter.deposit(A(), 5_000_000n, t2.r);
    expect(t2.last().message).toMatch(/Deposited 3 tNOC.*2 tNOC was refunded/);
  });
  it("withdraw: market contract, only {amount}, 1 yocto, 100 Tgas", async () => {
    txOutcomes.HASH1 = ok("Completed");
    views[`${CB.contractId}:get_account`] = () => account({ pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "Completed", receiver_id: null } });
    // before the call there is no record; the preflight read happens first
    let n = 0;
    views[`${CB.contractId}:get_account`] = () => (n++ === 0 ? account() : account({ pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "Completed", receiver_id: null } }));
    const t = reporter();
    await adapter.withdraw(B(), 1_000_000n, t.r);
    expect(calls[0]).toEqual({ receiver: CB.contractId, method: "withdraw", args: { amount: "1000000" }, deposit: "1", gas: (100n * T).toString() });
    expect(t.last()).toMatchObject({ phase: "confirmed", message: "Withdrew 1 tNOC to your wallet." });
  });
});

describe("refresh and validate against the contract before signing", () => {
  it("a taken offer that vanished is explained and the wallet is never opened", async () => {
    views[`${CA.contractId}:get_offer`] = () => null;
    await expect(adapter.fillOffer(A(), offer(A(), "4"), 100n, reporter().r)).rejects.toThrow(/another trader filled or cancelled it/);
    expect(calls).toHaveLength(0);
  });
  it("an offer with fewer shares left than requested says how many remain", async () => {
    views[`${CA.contractId}:get_offer`] = () => offerView("4", { remaining_quantity: "50" });
    await expect(adapter.fillOffer(A(), offer(A(), "4"), 100n, reporter().r)).rejects.toThrow(/Only 0.00005 shares remain/);
    expect(calls).toHaveLength(0);
  });
  it("an offer whose owner or price changed is refused", async () => {
    views[`${CA.contractId}:get_offer`] = () => offerView("4", { owner_id: "someone-else.testnet" });
    await expect(adapter.fillOffer(A(), offer(A(), "4"), 100n, reporter().r)).rejects.toThrow(/changed/);
    views[`${CA.contractId}:get_offer`] = () => offerView("4", { price: "700000" });
    await expect(adapter.fillOffer(A(), offer(A(), "4"), 100n, reporter().r)).rejects.toThrow(/changed/);
    expect(calls).toHaveLength(0);
  });
  it("after the cutoff the contract says trading is closed, even if the indexed status still said Open", async () => {
    views[`${CA.contractId}:get_market`] = chainMarket(CA, { status: "AwaitingResolution", trading_open: false, split_open: false, awaiting_resolution: true });
    views[`${CA.contractId}:get_offer`] = () => offerView("4");
    await expect(adapter.fillOffer(A(), offer(A(), "4"), 100n, reporter().r)).rejects.toThrow(/Trading is closed/);
    await expect(adapter.createOffer(A(), { marketId: "m_a", outcome: "YES", side: "buy", price: 500_000n, qty: 1_000_000n }, reporter().r)).rejects.toThrow(/Trading is closed/);
    await expect(adapter.split(A(), 1_000_000n, reporter().r)).rejects.toThrow(/Creating shares is closed/);
    expect(calls).toHaveLength(0);
  });
  it("after the cutoff cancel, deposit and merge are still allowed; after resolution merge closes", async () => {
    views[`${CA.contractId}:get_market`] = chainMarket(CA, { status: "AwaitingResolution", trading_open: false, split_open: false, awaiting_resolution: true });
    views[`${CA.contractId}:get_offer`] = () => offerView("4");
    txOutcomes.HASH1 = ok(null);
    await adapter.cancelOffer(A(), offer(A(), "4"), reporter().r);
    await adapter.merge(A(), 1_000_000n, reporter().r);
    txOutcomes.HASH1 = ok("5000000");
    await adapter.deposit(A(), 5_000_000n, reporter().r);
    expect(calls.map((c) => c.method)).toEqual(["cancel_offer", "merge_positions", "ft_transfer_call"]);
    views[`${CA.contractId}:get_market`] = chainMarket(CA, { status: "Resolved", resolved: true, trading_open: false, split_open: false, merge_open: false });
    await expect(adapter.merge(A(), 1_000_000n, reporter().r)).rejects.toThrow(/resolved/);
  });
  it("cancelling an offer that is already gone never opens the wallet", async () => {
    await expect(adapter.cancelOffer(A(), offer(A(), "4"), reporter().r)).rejects.toThrow(/already gone/);
    expect(calls).toHaveLength(0);
  });
  it("deposit before registering with the market, or beyond the wallet balance, is stopped up front", async () => {
    views[`${CA.contractId}:get_account`] = null;
    await expect(adapter.deposit(A(), 1_000_000n, reporter().r)).rejects.toThrow(/Register with this market first/);
    views[`${CA.contractId}:get_account`] = account();
    views[`${CA.tokenId}:ft_balance_of`] = "1000000";
    await expect(adapter.deposit(A(), 5_000_000n, reporter().r)).rejects.toThrow(/wallet holds only 1 tNOC/);
    expect(calls).toHaveLength(0);
  });
  it("balances are checked against THIS market's account, not another one", async () => {
    views[`${CB.contractId}:get_account`] = account({ available_collateral: "0" });
    await expect(adapter.split(B(), 1_000_000n, reporter().r)).rejects.toThrow(/Only 0 tNOC is available in this market/);
    txOutcomes.HASH1 = ok(null);
    await adapter.split(A(), 1_000_000n, reporter().r);
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c.receiver === CA.contractId)).toBe(true);
  });
  it("redeem with nothing to redeem or an unresolved market never reaches the wallet", async () => {
    views[`${CA.contractId}:get_redemption_preview`] = { redeemable: false, offers_to_release: [] };
    await expect(adapter.redeem(A(), reporter().r)).rejects.toThrow(/not been resolved/);
    views[`${CA.contractId}:get_market`] = chainMarket(CA, { status: "Resolved", resolved: true, trading_open: false, split_open: false, merge_open: false });
    await expect(adapter.redeem(A(), reporter().r)).rejects.toThrow(/Nothing to redeem/);
    expect(calls).toHaveLength(0);
  });
});

describe("results are taken from the chain, not from the wallet", () => {
  it("a nested receipt failure is a failure even though the wallet returned a hash, and is never resent", async () => {
    views[`${CA.contractId}:get_offer`] = () => offerView("4");
    txOutcomes.HASH1 = { status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: insufficient available collateral" } } } } } } }] };
    const t = reporter();
    await expect(adapter.fillOffer(A(), offer(A(), "4"), 100n, t.r)).rejects.toThrow(/Insufficient available collateral/);
    expect(t.last().phase).toBe("failed");
    expect(calls).toHaveLength(1);
  });
  it("a wallet result without a hash is not trusted and is not retried", async () => {
    nextHash = "";
    await expect(adapter.split(A(), 1_000_000n, reporter().r)).rejects.toThrow(/did not return a transaction hash/);
    expect(calls).toHaveLength(1);
  });
  it("a wallet rejection is explained and nothing is pending", async () => {
    const { wallet } = await import("@/lib/wallet");
    (wallet.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("User rejected the request"));
    const t = reporter();
    await expect(adapter.split(A(), 1_000_000n, t.r)).rejects.toThrow(/declined the request in your wallet/);
    expect(t.last().phase).toBe("failed");
    expect(pendingTxs.list()).toHaveLength(0);
  });
  it("an RPC failure after submission leaves the transaction UNCONFIRMED and tied to its hash; it is not resent", async () => {
    failRpc = false;
    const orig = globalThis.fetch;
    // let preflight reads pass, then break the network at the first `tx` poll
    vi.stubGlobal("fetch", vi.fn(async (u: string, init: { body: string }) => { if (JSON.parse(init.body).method === "tx") throw new Error("network down"); return orig(u, init as never); }));
    const t = reporter();
    await adapter.split(A(), 1_000_000n, t.r);
    expect(t.last()).toMatchObject({ phase: "unconfirmed", hash: "HASH1" });
    expect(t.last().message).toMatch(/may still succeed.*Do not resend/);
    expect(calls).toHaveLength(1);
    expect(pendingTxs.list()).toEqual([expect.objectContaining({ hash: "HASH1", signer: USER, marketRef: "m_a" })]);
    // tracking only re-READS the hash
    vi.stubGlobal("fetch", orig);
    txOutcomes.HASH1 = ok(null);
    expect(await adapter.checkPending("HASH1", USER)).toBe("done");
    expect(calls).toHaveLength(1);
  });
  it("a withdrawal that stays Pending is 'unconfirmed', never completed, and is sent exactly once", async () => {
    txOutcomes.HASH1 = ok("Completed");
    let n = 0;
    views[`${CA.contractId}:get_account`] = () => (n++ === 0 ? account() : account({ pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "Pending", receiver_id: USER } }));
    const t = reporter();
    await adapter.withdraw(A(), 1_000_000n, t.r);
    expect(t.last().phase).toBe("unconfirmed");
    expect(t.last().message).toMatch(/NOT confirmed.*Do not resend/);
    expect(calls).toHaveLength(1);
  });
  it("a second withdrawal is refused while one is Pending", async () => {
    views[`${CA.contractId}:get_account`] = account({ pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "Pending", receiver_id: USER } });
    await expect(adapter.withdraw(A(), 1_000_000n, reporter().r)).rejects.toThrow(/already pending/);
    expect(calls).toHaveLength(0);
  });
  it("FailedRestored is reported as returned to the available balance", async () => {
    txOutcomes.HASH1 = ok("FailedRestored");
    let n = 0;
    views[`${CA.contractId}:get_account`] = () => (n++ === 0 ? account() : account({ pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "FailedRestored", receiver_id: null } }));
    await expect(adapter.withdraw(A(), 1_000_000n, reporter().r)).rejects.toThrow(/returned to your available balance/);
  });
});

describe("balances: separate per market contract, wallet counted once per token", () => {
  it("portfolio keeps each market's deposit separate and reads each token's wallet balance once", async () => {
    markets.set("m_c", toMarket(apiMarket("m_c", CC)));
    setChain(CC);
    views[`${CC.tokenId}:ft_balance_of`] = "7000000";
    const pm = (ref: string, c: Contract, available: string) => ({ marketRef: ref, contract: { contractId: c.contractId, marketId: c.marketId }, question: ref, status: "Open", registered: true, token: { symbol: "tNOC", decimals: 6 }, collateral: { available, reserved: "0", pendingWithdrawal: "0" }, positions: { yes: { available: "0", reserved: "0", total: "0" }, no: { available: "0", reserved: "0", total: "0" } }, redeemed: false, lastReconciledHeight: 1, driftNote: null, redeemHint: null });
    portfolioMarkets.push(pm("m_a", CA, "10000000"), pm("m_b", CB, "25000000"), pm("m_c", CC, "3000000"));
    await adapter.listMarkets();
    const acct = (await adapter.getAccount(USER))!;
    expect(acct.holdings.map((h) => [h.marketRef, h.available])).toEqual([["m_a", 10_000_000n], ["m_b", 25_000_000n], ["m_c", 3_000_000n]]);
    expect(acct.wallets.map((w) => [w.tokenId, w.balance])).toEqual([["tok.testnet", 100_000_000n], ["tok2.testnet", 7_000_000n]]);
    expect(queried.filter((q) => q.method === "ft_balance_of" && q.account === "tok.testnet")).toHaveLength(1); // A and B share one token: read once
  });
  it("an unreadable wallet balance stays unavailable instead of becoming zero", async () => {
    await adapter.listMarkets();
    views[`${CA.tokenId}:ft_balance_of`] = () => { throw new Error("rpc"); };
    const acct = (await adapter.getAccount(USER))!;
    expect(acct.wallets[0].balance).toBeNull();
  });
  it("a market-scoped account reads that contract at one block and lists only its offers and shares", async () => {
    views[`${CB.contractId}:get_account_offers`] = [offerView("4", { owner_id: USER })];
    views[`${CB.contractId}:get_account`] = account({ yes: "5000000", reserved_yes: "1000000" });
    const acct = (await adapter.getAccount(USER, B()))!;
    expect(acct.holdings).toHaveLength(1);
    expect(acct.holdings[0].marketRef).toBe("m_b");
    expect(acct.offers[0]).toMatchObject({ id: "m_b:4", offerId: "4", marketId: "m_b" });
    expect(acct.positions).toEqual([expect.objectContaining({ marketId: "m_b", outcome: "YES", qty: 5_000_000n, reserved: 1_000_000n }), expect.objectContaining({ outcome: "NO" })]);
    expect(new Set(queried.filter((q) => q.account === CB.contractId).map((q) => q.at))).toEqual(new Set([777]));
    expect(queried.some((q) => q.account === CA.contractId)).toBe(false);
  });
});

describe("market status comes from the contract", () => {
  it("overlays the contract's status and action flags on the indexed market", async () => {
    views[`${CA.contractId}:get_market`] = chainMarket(CA, { status: "AwaitingResolution", awaiting_resolution: true, trading_open: false, split_open: false });
    const m = await adapter.getMarket("m_a");
    expect(m).toMatchObject({ status: "awaiting", chain: "fresh", flags: { splitOpen: false, mergeOpen: true, tradingOpen: false } });
  });
  it("keeps the indexed data and says the contract could not be read when the RPC fails", async () => {
    failRpc = true;
    const m = await adapter.getMarket("m_a");
    expect(m).toMatchObject({ id: "m_a", chain: "unavailable", status: "open" });
    expect(m?.flags).toBeUndefined();
  });
  it("an unknown market is null (not an error)", async () => { expect(await adapter.getMarket("m_nope")).toBeNull(); });
});
