import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TxState } from "@/lib/types";

const manifest = JSON.parse(readFileSync(new URL("../../../deployments/testnet-demo.json", import.meta.url), "utf8"));
const MARKET = "mkt-demo-3879869.nearodds-deploy.testnet";
const TOKEN = "tok-demo-3879869.nearodds-deploy.testnet";
const USER = "alice.testnet";

vi.stubEnv("NEXT_PUBLIC_MARKET_CONTRACT_ID", MARKET);
vi.stubEnv("NEXT_PUBLIC_TOKEN_CONTRACT_ID", TOKEN);
vi.stubEnv("NEXT_PUBLIC_MARKET_ID", "mkt-1");

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
const queries: Array<{ method: string; params: Record<string, unknown> }> = [];
const ok = (v: Json) => ({ status: { SuccessValue: btoa(JSON.stringify(v)) }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] });

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (result: Json) => ({ ok: true, json: async () => ({ result }) });
    if (method === "block") return reply({ header: { height: 777 } });
    if (method === "tx") {
      const o = txOutcomes[params.tx_hash];
      return reply(o);
    }
    if (method === "query" && params.request_type === "view_account") return reply({ amount: "5000000000000000000000000" });
    if (method === "query") {
      queries.push({ method: params.method_name, params });
      const key = `${params.account_id === MARKET ? "M" : "T"}:${params.method_name}`;
      const v = views[key];
      if (v === undefined) throw new Error(`no view fixture for ${key}`);
      const value = typeof v === "function" ? (v as () => Json)() : v;
      return reply({ result: Array.from(new TextEncoder().encode(JSON.stringify(value))) });
    }
    throw new Error(`unexpected rpc ${method}`);
  }));
}

const mkView = (over: Record<string, unknown> = {}) => ({
  market_id: "mkt-1", question: manifest.market_terms.question, rules: manifest.market_terms.rules, resolution_source: manifest.market_terms.resolution_source,
  split_cutoff_ns: manifest.split_cutoff_ns, split_open: true, trading_cutoff_ns: manifest.split_cutoff_ns, trading_open: true, status: "Open",
  awaiting_resolution: false, resolved: false, merge_open: true, resolver_id: manifest.config.resolver_id, resolution: null,
  collateral_token_id: TOKEN, ...over,
});

async function freshAdapter() {
  vi.resetModules();
  const { NearAdapter } = await import("@/lib/near/adapter");
  NearAdapter.pollMs = 0;
  const a = new NearAdapter();
  await a.init(true);
  return a;
}
const reporter = () => { const seen: TxState[] = []; return { r: (s: TxState) => seen.push(s), seen, last: () => seen[seen.length - 1] }; };

beforeEach(() => {
  calls.length = 0; queries.length = 0; nextHash = "HASH1"; txOutcomes = {};
  views = {
    "M:get_config": manifest.config, "T:ft_metadata": manifest.token_metadata, "M:get_market": mkView(),
    "T:storage_balance_bounds": { min: "1250000000000000000000", max: null },
  };
  installFetch();
});

describe("deployment verification", () => {
  it("adopts token symbol and trading limits from the chain", async () => {
    const a = await freshAdapter();
    expect(a.deployment.state).toBe("ok");
    expect(a.symbol).toBe("tNOC");
    expect(a.limits).toMatchObject({ tick: 10_000n, lot: 100n, minOrder: 10_000n, maxOpenOffers: 10, minPrice: 10_000n, maxPrice: 990_000n });
  });
  it("disables transactions when the token metadata disagrees with the market config, and never calls the wallet", async () => {
    views["T:ft_metadata"] = { ...manifest.token_metadata, decimals: 8 };
    const a = await freshAdapter();
    expect(a.deployment.state).toBe("error");
    const t = reporter();
    await expect(a.split("mkt-1", 1_000_000n, t.r)).rejects.toThrow(/Transactions are disabled/);
    expect(calls).toHaveLength(0);
  });
  it("disables transactions when the market's collateral token is not the configured token", async () => {
    views["M:get_config"] = { ...manifest.config, collateral_token_id: "someone-else.testnet" };
    const a = await freshAdapter();
    expect(a.deployment.state).toBe("error");
  });
});

describe("transaction settings (receiver, method, args, deposit, gas)", () => {
  const T = 10n ** 12n;
  it("registers with the token: 0.00125 NEAR, registration_only", async () => {
    const a = await freshAdapter();
    views["T:storage_balance_of"] = { total: "1250000000000000000000", available: "0" };
    nextHash = "H"; txOutcomes.H = ok(null);
    await a.registerToken!(reporter().r);
    expect(calls[0]).toMatchObject({ receiver: TOKEN, method: "storage_deposit", args: { account_id: USER, registration_only: true }, deposit: "1250000000000000000000" });
  });
  it("registers with the market: get_config().storage_cost_per_account, registration_only", async () => {
    const a = await freshAdapter();
    views["M:get_account"] = { account_id: USER };
    txOutcomes.HASH1 = ok(null);
    await a.registerMarket!(reporter().r);
    expect(calls[0]).toMatchObject({ receiver: MARKET, method: "storage_deposit", args: { account_id: null, registration_only: true }, deposit: "40960000000000000000000" });
  });
  it("deposit: ft_transfer_call on the token, receiver = market, configured msg, 1 yocto, 300 Tgas", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok("5000000");
    const t = reporter();
    await a.deposit(5_000_000n, t.r);
    expect(calls[0]).toEqual({ receiver: TOKEN, method: "ft_transfer_call", args: { receiver_id: MARKET, amount: "5000000", msg: "deposit" }, deposit: "1", gas: (300n * T).toString() });
    expect(t.last().phase).toBe("confirmed");
    expect(t.last().message).toMatch(/Deposited 5 tNOC/);
  });
  it("deposit that the market fully refunds is reported as failed, not deposited", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok("0");
    const t = reporter();
    await expect(a.deposit(5_000_000n, t.r)).rejects.toThrow(/refunded/);
    expect(t.last().phase).toBe("failed");
  });
  it("deposit that is partly refunded says how much", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok("3000000");
    const t = reporter();
    await a.deposit(5_000_000n, t.r);
    expect(t.last().message).toMatch(/Deposited 3 tNOC.*2 tNOC was refunded/);
  });
  it.each([
    ["split", (a: Awaited<ReturnType<typeof freshAdapter>>, r: (s: TxState) => void) => a.split("mkt-1", 2_000_000n, r), "split_position", { market_id: "mkt-1", amount: "2000000" }],
    ["merge", (a: Awaited<ReturnType<typeof freshAdapter>>, r: (s: TxState) => void) => a.merge("mkt-1", 2_000_000n, r), "merge_positions", { market_id: "mkt-1", amount: "2000000" }],
    ["fill", (a: Awaited<ReturnType<typeof freshAdapter>>, r: (s: TxState) => void) => a.fillOffer("4", 100n, r), "fill_offer", { offer_id: "4", quantity: "100" }],
    ["cancel", (a: Awaited<ReturnType<typeof freshAdapter>>, r: (s: TxState) => void) => a.cancelOffer("9", r), "cancel_offer", { offer_id: "9" }],
  ])("%s uses the market, 1 yocto and 100 Tgas", async (_n, run, method, args) => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok(null);
    await run(a, reporter().r);
    expect(calls[0]).toEqual({ receiver: MARKET, method, args, deposit: "1", gas: (100n * T).toString() });
  });
  it("create_offer sends contract enums and base-unit strings", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok({ offer_id: "31" });
    const t = reporter();
    await a.createOffer({ marketId: "mkt-1", outcome: "NO", side: "sell", price: 400_000n, qty: 5_000_000n }, t.r);
    expect(calls[0].args).toEqual({ market_id: "mkt-1", outcome: "No", side: "Sell", price: "400000", quantity: "5000000" });
    expect(t.last().message).toMatch(/#31/);
  });
  it("fill reports the exact quantity and partial remainder from the chain result", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok({ offer_id: "4", quantity: "100", collateral_amount: "65", remaining_quantity: "9999800", status: "PartiallyFilled" });
    const t = reporter();
    await a.fillOffer("4", 100n, t.r);
    expect(t.last().message).toBe("Filled 0.0001 shares for 0.000065 tNOC (9.9998 still on that offer).");
  });
  it("redeem checks the preview first and then calls redeem with 100 Tgas", async () => {
    const a = await freshAdapter();
    views["M:get_redemption_preview"] = { redeemable: true, offers_to_release: [] };
    txOutcomes.HASH1 = ok({ payout: "10000000", released_collateral: "2000000" });
    const t = reporter();
    await a.redeem("mkt-1", t.r);
    expect(calls[0]).toMatchObject({ method: "redeem", args: { market_id: "mkt-1" }, deposit: "1" });
    expect(t.last().message).toMatch(/10 tNOC winning payout plus 2 tNOC released/);
    expect(t.last().message).toMatch(/Withdraw/);
  });
  it("redeem with nothing to redeem never reaches the wallet", async () => {
    const a = await freshAdapter();
    views["M:get_redemption_preview"] = { redeemable: false, offers_to_release: [] };
    await expect(a.redeem("mkt-1", reporter().r)).rejects.toThrow(/Nothing to redeem/);
    expect(calls).toHaveLength(0);
  });
});

describe("results are taken from the chain, not from the wallet", () => {
  it("a nested receipt failure is a failure even though the wallet returned a hash", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = { status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: insufficient available collateral" } } } } } } }] };
    const t = reporter();
    await expect(a.fillOffer("4", 100n, t.r)).rejects.toThrow(/Insufficient available collateral/);
    expect(t.last().phase).toBe("failed");
    expect(calls).toHaveLength(1); // never resent
  });
  it("a wallet result without a hash is not trusted and is not retried", async () => {
    const a = await freshAdapter();
    nextHash = "";
    await expect(a.split("mkt-1", 1_000_000n, reporter().r)).rejects.toThrow(/did not return a transaction hash/);
    expect(calls).toHaveLength(1);
  });
  it("a withdrawal that stays Pending is 'unconfirmed', never completed, and is sent exactly once", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok("Completed");
    views["M:get_account"] = { pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "Pending", receiver_id: USER } };
    const t = reporter();
    await a.withdraw(1_000_000n, t.r);
    expect(t.last().phase).toBe("unconfirmed");
    expect(t.last().message).toMatch(/NOT confirmed.*Do not resend/);
    expect(calls).toHaveLength(1);
  });
  it("a withdrawal is only 'confirmed' once the stored record says Completed", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok("Completed");
    views["M:get_account"] = { pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "Completed", receiver_id: null } };
    const t = reporter();
    await a.withdraw(1_000_000n, t.r);
    expect(t.last()).toMatchObject({ phase: "confirmed", message: "Withdrew 1 tNOC to your wallet." });
    expect(calls[0]).toMatchObject({ method: "withdraw", deposit: "1", gas: (100n * 10n ** 12n).toString() });
  });
  it("FailedRestored is reported as returned to the available balance", async () => {
    const a = await freshAdapter();
    txOutcomes.HASH1 = ok("FailedRestored");
    views["M:get_account"] = { pending_withdrawal: { withdrawal_id: "1", amount: "1000000", status: "FailedRestored", receiver_id: null } };
    const t = reporter();
    await expect(a.withdraw(1_000_000n, t.r)).rejects.toThrow(/returned to your available balance/);
  });
});

describe("order book", () => {
  const offer = (i: number, price: number, side = "Sell") => ({ offer_id: String(i), market_id: "mkt-1", owner_id: "lp.testnet", outcome: "Yes", side, price: String(price), quantity: "10000000", filled_quantity: "0", remaining_quantity: "10000000", reserved_collateral: "0", reserved_shares: "0", expires_at_ns: null, created_at_ns: "1", status: "Open", fillable: true });
  it("pages through every offer at one pinned block and sorts by price", async () => {
    const a = await freshAdapter();
    const all = Array.from({ length: 53 }, (_, i) => offer(i + 1, 990_000 - i * 10_000));
    views["M:list_offers"] = () => {
      const q = queries[queries.length - 1].params;
      const args = JSON.parse(atob(q.args_base64 as string));
      if (args.outcome !== "Yes" || args.side !== "Sell") return [];
      return all.slice(Number(args.from_index), Number(args.from_index) + args.limit);
    };
    const book = await a.getBook();
    expect(book).toHaveLength(53);
    expect(book[0].price).toBe(470_000n);
    expect(book.map((o) => o.price)).toEqual([...book.map((o) => o.price)].sort((x, y) => Number(x - y)));
    const pages = queries.filter((q) => q.method === "list_offers");
    expect(new Set(pages.map((q) => q.params.block_id))).toEqual(new Set([777]));
    expect(pages.filter((q) => { const g = JSON.parse(atob(q.params.args_base64 as string)); return g.outcome === "Yes" && g.side === "Sell"; })).toHaveLength(2);
  });
});

describe("market status comes from the contract", () => {
  it("maps Open / AwaitingResolution / Resolved and the contract's own action flags", async () => {
    const a = await freshAdapter();
    views["M:get_market"] = mkView({ status: "AwaitingResolution", awaiting_resolution: true, trading_open: false, split_open: false });
    const m = await a.getMarket();
    expect(m?.status).toBe("awaiting");
    expect(m?.flags).toEqual({ splitOpen: false, mergeOpen: true, tradingOpen: false });
    views["M:get_market"] = mkView({ status: "Resolved", resolved: true, trading_open: false, split_open: false, merge_open: false, resolution: { outcome: "No", resolver_id: "nearodds-deploy.testnet", resolved_at_ns: "1", evidence: "NiMet link" } });
    const r = await a.getMarket();
    expect(r?.status).toBe("resolved");
    expect(r?.resolution.outcome).toBe("NO");
    expect(r?.flags?.mergeOpen).toBe(false);
  });
});
