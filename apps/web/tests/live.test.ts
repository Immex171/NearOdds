import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConfigView, MarketView } from "@nearodds/types";
// @ts-expect-error plain ESM script without types
import { deriveEnv, envConflicts } from "../scripts/deployment.mjs";
import { checkAgreement } from "@/lib/near/deployment";
import { observationFromRules, toMarket } from "@/lib/near/market-map";
import { assertAllReceiptsOk, successValue } from "@/lib/near/outcome";
import { friendlyError } from "@/lib/near/adapter";
import { DEFAULT_LIMITS, parsePrice, parseQuantity } from "@/lib/trading";
import { nearStr, cutoffLabel } from "@/lib/format";

const manifest = JSON.parse(readFileSync(new URL("../../../deployments/testnet-demo.json", import.meta.url), "utf8"));

describe("deployment manifest -> public env", () => {
  it("derives the verified configuration from the committed manifest", () => {
    const { env, problems } = deriveEnv(manifest);
    expect(problems).toEqual([]);
    expect(env).toEqual({
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_RPC_URL: "https://test.rpc.fastnear.com",
      NEXT_PUBLIC_MARKET_CONTRACT_ID: "mkt-demo-3879869.nearodds-deploy.testnet",
      NEXT_PUBLIC_TOKEN_CONTRACT_ID: "tok-demo-3879869.nearodds-deploy.testnet",
      NEXT_PUBLIC_MARKET_ID: "mkt-1",
    });
  });
  it("rejects a manifest whose token, market id or decimals disagree", () => {
    const bad = structuredClone(manifest);
    bad.config.collateral_token_id = "other.testnet";
    bad.config.market_id = "mkt-2";
    bad.token_metadata.decimals = 8;
    bad.split_cutoff_ns = "1794438000000000001";
    const { problems } = deriveEnv(bad);
    expect(problems.join("\n")).toMatch(/collateral_token_id/);
    expect(problems.join("\n")).toMatch(/config.market_id/);
    expect(problems.join("\n")).toMatch(/decimals/);
    expect(problems.join("\n")).toMatch(/split_cutoff/);
  });
  it("rejects mainnet-style accounts and unverified manifests", () => {
    const bad = structuredClone(manifest);
    bad.accounts.market = "market.near";
    bad.verified = false;
    expect(deriveEnv(bad).problems.length).toBeGreaterThanOrEqual(2);
  });
  it("flags an env override that disagrees with the manifest", () => {
    const { env } = deriveEnv(manifest);
    expect(envConflicts(env, { NEXT_PUBLIC_MARKET_ID: "mkt-9" })).toHaveLength(1);
    expect(envConflicts(env, { NEXT_PUBLIC_MARKET_ID: "mkt-1", NEXT_PUBLIC_RPC_URL: "https://other" })).toEqual([]);
  });
});

const cfg = manifest.config as ConfigView;
const meta = { name: "n", symbol: "tNOC", decimals: 6 };
const mv = { market_id: "mkt-1", collateral_token_id: cfg.collateral_token_id, resolver_id: cfg.resolver_id } as MarketView;
const input = { marketAccount: "m", tokenAccount: cfg.collateral_token_id, marketId: "mkt-1", cfg, meta, market: mv };

describe("on-chain agreement", () => {
  it("accepts a consistent deployment", () => expect(checkAgreement(input)).toEqual([]));
  it("reports each disagreement", () => {
    expect(checkAgreement({ ...input, tokenAccount: "x.testnet" }).join()).toMatch(/collateral token/);
    expect(checkAgreement({ ...input, marketId: "mkt-2" }).join()).toMatch(/market mkt-1/);
    expect(checkAgreement({ ...input, meta: { ...meta, decimals: 8 } }).join()).toMatch(/decimals/);
    expect(checkAgreement({ ...input, cfg: { ...cfg, schema_version: 4 } }).join()).toMatch(/schema 4/);
    expect(checkAgreement({ ...input, meta: { ...meta, symbol: "" } }).join()).toMatch(/symbol/);
  });
});

describe("live market mapping", () => {
  const view = {
    market_id: "mkt-1", question: "Will it rain in Lagos on 2026-11-12?", rules: manifest.market_terms.rules, resolution_source: manifest.market_terms.resolution_source,
    split_cutoff_ns: manifest.split_cutoff_ns, split_open: true, trading_cutoff_ns: manifest.split_cutoff_ns, trading_open: true, status: "Open",
    awaiting_resolution: false, resolved: false, merge_open: true, resolver_id: "nearodds-deploy.testnet", resolution: null,
  } as unknown as MarketView;
  it("invents no category, creation date or volume", () => {
    const m = toMarket(view, cfg);
    expect(m.category).toBeNull();
    expect(m.createdAt).toBeNull();
    expect(m.volume).toBeNull();
    expect(m.lastYes).toBeNull();
    expect(m.hasHistory).toBe(false);
  });
  it("keeps the trading cutoff separate from the observation period", () => {
    const m = toMarket(view, cfg);
    expect(new Date(m.closesAt).toISOString()).toBe("2026-11-11T23:00:00.000Z");
    expect(m.resolution.observation.text).toBe("the Lagos calendar day 2026-11-12, 00:00 to 24:00 WAT (UTC+1)");
    expect(m.resolution.ifMissing).toBe(cfg.resolution_model);
    expect(cutoffLabel(m.closesAt)).toBe("Nov 11, 2026, 11:00 PM UTC (Nov 12, 2026, 12:00 AM WAT)");
  });
  it("maps the contract status, not the clock", () => {
    expect(toMarket({ ...view, status: "AwaitingResolution", awaiting_resolution: true, trading_open: false, split_open: false }, cfg).status).toBe("awaiting");
    const r = toMarket({ ...view, status: "Resolved", resolved: true, resolution: { outcome: "Yes", resolver_id: "r", resolved_at_ns: "1", evidence: "link" } }, cfg);
    expect(r.status).toBe("resolved");
    expect(r.resolution.outcome).toBe("YES");
  });
  it("returns null when rules state no observation period", () => expect(observationFromRules("Resolves YES if X.")).toBeNull());
});

describe("receipts and results", () => {
  const ok = { status: { SuccessValue: btoa('"1000000"') }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] };
  it("decodes the final return value", () => expect(successValue<string>(ok)).toBe("1000000"));
  it("passes when every receipt succeeded", () => expect(() => assertAllReceiptsOk(ok)).not.toThrow());
  it("fails when a nested receipt failed even though the wallet reported success", () => {
    const bad = { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }, { outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: offer not found (never existed, fully filled or cancelled)" } } } } } } }] };
    expect(() => assertAllReceiptsOk(bad)).toThrow(/offer not found/);
    expect(friendlyError("offer not found (never existed)")).toMatch(/no longer available/);
  });
});

describe("limits come from the contract, not constants", () => {
  const L = { ...DEFAULT_LIMITS, tick: 50_000n, minPrice: 50_000n, maxPrice: 950_000n, lot: 1_000n, minOrder: 100_000n };
  it("uses the supplied tick and bounds", () => {
    expect(parsePrice("0.55", L)).toEqual({ ok: true, value: 550_000n });
    expect(parsePrice("0.52", L).ok).toBe(false);
    expect(parsePrice("0.99", L).ok).toBe(false);
    expect(parsePrice("0.52", DEFAULT_LIMITS).ok).toBe(true);
  });
  it("uses the supplied lot", () => {
    expect(parseQuantity("0.001", { limits: L }).ok).toBe(true);
    expect(parseQuantity("0.0005", { limits: L }).ok).toBe(false);
  });
});

describe("native NEAR display is exact", () => {
  it("shows the registration deposits without rounding", () => {
    expect(nearStr(40_960_000_000_000_000_000_000n)).toBe("0.04096 NEAR");
    expect(nearStr(1_250_000_000_000_000_000_000n)).toBe("0.00125 NEAR");
  });
});
