// Read-only: replays REAL testnet transactions from deployments/testnet-demo.json through the adapter's own parsing
// (awaitFinalOutcome / assertAllReceiptsOk / successValue). Public RPC only, no keys, nothing is sent.
// Run with: NEARODDS_LIVE=1 pnpm vitest run tests/chain-replay.live.test.ts
import { describe, expect, it, vi } from "vitest";

vi.stubEnv("NEXT_PUBLIC_RPC_URL", "https://test.rpc.fastnear.com");
vi.stubEnv("NEXT_PUBLIC_MARKET_CONTRACT_ID", "mkt-demo-3879869.nearodds-deploy.testnet");
vi.stubEnv("NEXT_PUBLIC_TOKEN_CONTRACT_ID", "tok-demo-3879869.nearodds-deploy.testnet");
vi.stubEnv("NEXT_PUBLIC_MARKET_ID", "mkt-1");

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
  it("the live adapter verifies the deployment, adopts tNOC/6 decimals, and reads the full seeded book", async () => {
    const { NearAdapter } = await import("@/lib/near/adapter");
    const a = new NearAdapter();
    await a.init(true);
    expect(a.deployment).toEqual({ state: "ok" });
    expect(a.symbol).toBe("tNOC");
    expect(a.limits).toMatchObject({ tick: 10_000n, lot: 100n, minOrder: 10_000n, maxOpenOffers: 10 });
    const book = await a.getBook();
    const ids = new Set(book.map((o) => o.id));
    for (const id of ["4", "8", "12", "18", "22", "25", "29"]) expect(ids.has(id)).toBe(true);
    const o4 = book.find((o) => o.id === "4")!;
    expect(o4.qty).toBe(9_999_900n); // 10 shares minus the 0.0001 probe fill
    const m = await a.getMarket();
    expect(m?.status).toBe("open");
    expect(m?.category).toBeNull();
    expect(new Date(m!.closesAt).toISOString()).toBe("2026-11-11T23:00:00.000Z");
  }, 60_000);
  it("reads a real account: LP is registered with both contracts, holds offers, and has no native-NEAR shortfall flagged as unregistered", async () => {
    const { NearAdapter } = await import("@/lib/near/adapter");
    const a = new NearAdapter();
    await a.init(true);
    const acct = await a.getAccount(`lp-demo-3879869${SUFFIX}`);
    expect(acct?.registered).toBe(true);
    expect(acct?.tokenRegistered).toBe(true);
    expect(acct?.offers.length).toBeGreaterThanOrEqual(7);
    const nobody = await a.getAccount("nobody-registered.testnet");
    expect(nobody).toMatchObject({ registered: false, tokenRegistered: false, nearBalance: 0n });
  }, 60_000);
});
