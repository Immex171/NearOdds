// Read-only: replays REAL testnet transactions from deployments/testnet-demo.json through the adapter's own parsing
// (awaitFinalOutcome / assertAllReceiptsOk / successValue). Public RPC only, no keys, nothing is sent.
// Run with: NEARODDS_LIVE=1 pnpm vitest run tests/chain-replay.live.test.ts
import { describe, expect, it, vi } from "vitest";

vi.stubEnv("NEXT_PUBLIC_RPC_URL", "https://test.rpc.fastnear.com");

const live = process.env.NEARODDS_LIVE === "1";
const SUFFIX = ".nearodds-deploy.testnet";

describe.skipIf(!live)("real testnet transactions", () => {
  it("deposit (ft_transfer_call): the final value is the accepted amount", async () => {
    const { awaitFinalOutcome, assertAllReceiptsOk, successValue } = await import("@/lib/near/outcome");
    const o = await awaitFinalOutcome("DD5kT6QUJ8qy3f6yeW3bNeM6MvZDKK4viUp4LiSYLxL9", `lp-demo-3879869${SUFFIX}`, 30_000);
    expect(() => assertAllReceiptsOk(o)).not.toThrow();
    const used = successValue<string>(o);
    expect(typeof used).toBe("string");
    expect(BigInt(used!)).toBeGreaterThan(0n);
  }, 40_000);
  it("fill_offer: the final value is a FillResult", async () => {
    const { awaitFinalOutcome, assertAllReceiptsOk, successValue } = await import("@/lib/near/outcome");
    const o = await awaitFinalOutcome("CvpvdFJPKjDoVrEtkco82HUyrnzZ4sTR9nxRHccXfooQ", `probe-demo-3879869${SUFFIX}`, 30_000);
    assertAllReceiptsOk(o);
    expect(successValue<{ offer_id: string; quantity: string; collateral_amount: string; status: string }>(o)).toMatchObject({ offer_id: "4", quantity: "100", collateral_amount: "65", status: "PartiallyFilled" });
  }, 40_000);
  it("create_offer: the final value carries the offer id", async () => {
    const { awaitFinalOutcome, successValue } = await import("@/lib/near/outcome");
    const o = await awaitFinalOutcome("4FanRtXB7e8JJN6v1LSm6GT6uvgaFVARaTennr4zs8BM", `lp-demo-3879869${SUFFIX}`, 30_000);
    expect(successValue<{ offer_id: string }>(o)?.offer_id).toBe("4");
  }, 40_000);
  it("the live adapter discovers the market through the backend, verifies its contract on chain, and reads the seeded book", async () => {
    const { NearAdapter } = await import("@/lib/near/adapter");
    const { createApi } = await import("@/lib/api/client");
    const a = new NearAdapter(createApi({ baseUrl: process.env.NEARODDS_API ?? "http://localhost:4000" }));
    const list = await a.listMarkets();
    const lagos = list.find((m) => m.contract?.contractId === `mkt-demo-3879869${SUFFIX}`)!;
    expect(lagos).toBeDefined();
    expect(lagos.contract).toEqual({ contractId: `mkt-demo-3879869${SUFFIX}`, marketId: "mkt-1", tokenId: `tok-demo-3879869${SUFFIX}` });
    expect(lagos.category).toBe("Weather");
    await a.verify(lagos, true);
    expect(a.deployment(lagos)).toEqual({ state: "ok" });
    expect(lagos.token.symbol).toBe("tNOC");
    const book = await a.getBook(lagos.id);
    const local = new Set(book.map((o) => o.offerId));
    for (const id of ["4", "8", "12", "18", "22", "25", "29"]) expect(local.has(id)).toBe(true);
    expect(book.find((o) => o.offerId === "4")!.id).toBe(`${lagos.id}:4`);
    const m = await a.getMarket(lagos.id);
    expect(m).toMatchObject({ status: "open", chain: "fresh" });
    expect(new Date(m!.closesAt).toISOString()).toBe("2026-11-11T23:00:00.000Z");
  }, 60_000);
  it("reads real accounts from the chain for the selected market", async () => {
    const { NearAdapter } = await import("@/lib/near/adapter");
    const { createApi } = await import("@/lib/api/client");
    const a = new NearAdapter(createApi({ baseUrl: process.env.NEARODDS_API ?? "http://localhost:4000" }));
    const lagos = (await a.listMarkets()).find((m) => m.contract?.contractId === `mkt-demo-3879869${SUFFIX}`)!;
    const acct = await a.getAccount(`lp-demo-3879869${SUFFIX}`, lagos);
    expect(acct?.holdings[0].registered).toBe(true);
    expect(acct?.wallets[0].tokenRegistered).toBe(true);
    expect(acct?.offers.length).toBeGreaterThanOrEqual(7);
    const nobody = await a.getAccount("nobody-registered.testnet", lagos);
    expect(nobody?.holdings[0].registered).toBe(false);
    expect(nobody?.wallets[0].tokenRegistered).toBe(false);
    expect(nobody?.nearBalance).toBe(0n);
  }, 60_000);
});
