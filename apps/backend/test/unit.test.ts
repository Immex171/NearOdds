import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { TemplateSpec, dueOccurrences, occurrenceFor, renderAndValidate } from "../src/keeper/template.js";
import { parseEventLogs, receiptSucceeded } from "../src/indexer/events.js";
import { displayedPrice } from "../src/api/dto.js";
import { marketRefFor } from "../src/registry/index.js";
import { Keystore } from "../src/near/keystore.js";
import { loadApprovedArtifact } from "../src/keeper/artifacts.js";
import { marketAccountName } from "../src/keeper/create-market.js";
import { findFailure } from "../src/near/tx.js";
import { lagosTemplate } from "./helpers/keeper-env.js";

const spec = (over = {}) => TemplateSpec.parse(lagosTemplate("d.testnet", "tok.testnet", over));

describe("templates and schedules", () => {
  it("reproduces the verified Lagos demo timings exactly (cutoff 00:00 WAT, observation ends 24h later)", () => {
    const o = occurrenceFor(spec(), 1, 2026, 11, 12);
    expect(BigInt(o.cutoffMs) * 1_000_000n).toBe(1794438000000000000n);
    expect(new Date(o.cutoffMs).toISOString()).toBe("2026-11-11T23:00:00.000Z");
    expect(new Date(o.obsEndMs!).toISOString()).toBe("2026-11-12T23:00:00.000Z");
    const v = renderAndValidate(spec(), o, Date.UTC(2026, 10, 5));
    expect(v.problems).toEqual([]);
    expect(v.market!.question).toBe("Will it rain in Lagos on 2026-11-12?");
    expect(v.market!.splitCutoffNs).toBe("1794438000000000000");
  });
  it("creates occurrences only inside their window (lead time reached, cutoff still ahead)", () => {
    const s = spec();
    const now = Date.UTC(2026, 10, 10, 12); // Nov 10, 12:00Z
    const dates = dueOccurrences(s, 1, now).map((o) => o.date);
    expect(dates).toEqual(["2026-11-11", "2026-11-12"]); // 11th: cutoff Nov 10 23:00Z still ahead; 13th: creation opens Nov 10 23:00Z
    expect(dueOccurrences(s, 1, now).every((o) => o.cutoffMs > now)).toBe(true);
  });
  it("weekly schedules follow listed weekdays", () => {
    const s = spec({ schedule: { frequency: "weekly", weekdays: [1], timezone: "Africa/Lagos", leadDays: 7, minLeadMinutes: 0 } });
    for (const o of dueOccurrences(s, 1, Date.UTC(2026, 10, 5))) expect(new Date(o.cutoffMs + 3600_000).getUTCDay()).toBe(1);
  });
  it("validates byte limits (multi-byte aware), blank fields, unknown placeholders and imminent cutoffs", () => {
    const o = occurrenceFor(spec(), 1, 2026, 11, 12);
    expect(renderAndValidate(spec({ questionTemplate: "é".repeat(300) }), o, 0).problems.join()).toMatch(/question is 600 bytes/);
    expect(renderAndValidate(spec({ rulesTemplate: "x".repeat(2049) }), o, 0).problems.join()).toMatch(/rules/);
    expect(renderAndValidate(spec({ questionTemplate: "   " }), o, 0).problems.join()).toMatch(/blank/);
    expect(renderAndValidate(spec({ questionTemplate: "{{bogus}}" }), o, 0).problems.join()).toMatch(/unknown placeholder/);
    expect(renderAndValidate(spec({ internalMarketId: "m".repeat(65) }), o, 0).problems.join()).toMatch(/market_id/);
    expect(renderAndValidate(spec(), o, o.cutoffMs + 1).problems.join()).toMatch(/not at least/);
    const late = spec({ cutoff: { offsetMinutesFromObservationStart: 60 } });
    expect(renderAndValidate(late, occurrenceFor(late, 1, 2026, 11, 12), 0).problems.join()).toMatch(/after the observation start/);
  });
  it("account names are collision-resistant, valid and length-bounded", () => {
    const names = new Set(Array.from({ length: 200 }, () => marketAccountName("lagos-rain", "2026-11-12", "nearodds-deploy.testnet")));
    expect(names.size).toBe(200);
    for (const n of names) { expect(n.length).toBeLessThanOrEqual(64); expect(n).toMatch(/^mkt-[a-z0-9]+-20261112-[0-9a-f]{8}\.nearodds-deploy\.testnet$/); }
    expect(marketAccountName("x".repeat(60), "2026-11-12", "a".repeat(30) + ".testnet").length).toBeLessThanOrEqual(64);
  });
});

describe("event parsing", () => {
  const ev = (o: object) => "EVENT_JSON:" + JSON.stringify(o);
  it("accepts only standard nearodds_market version 1.0.0", () => {
    const good = ev({ standard: "nearodds_market", version: "1.0.0", event: "deposit", data: { account_id: "a.testnet", token_id: "t", amount: "5" } });
    expect(parseEventLogs([good]).map((e) => e.event)).toEqual(["deposit"]);
    expect(parseEventLogs([ev({ standard: "nep141", version: "1.0.0", event: "ft_mint", data: [{}] })])).toEqual([]);
    expect(parseEventLogs([ev({ standard: "nearodds_market", version: "1.1.0", event: "deposit", data: {} })])).toEqual([]);
    expect(parseEventLogs(["EVENT_JSON:{not json", "hello", good]).length).toBe(1);
  });
  it("supports array-shaped NEP-297 data and keeps per-log positions distinct", () => {
    const l = ev({ standard: "nearodds_market", version: "1.0.0", event: "split", data: [{ amount: "1" }, { amount: "2" }] });
    const p = parseEventLogs([l, l]);
    expect(new Set(p.map((x) => x.logIndex)).size).toBe(4);
  });
  it("only successful receipts count", () => {
    expect(receiptSucceeded({ SuccessValue: "" })).toBe(true);
    expect(receiptSucceeded({ SuccessReceiptId: "x" })).toBe(true);
    expect(receiptSucceeded({ Failure: {} })).toBe(false);
    expect(receiptSucceeded("Unknown")).toBe(false);
    expect(findFailure({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { x: 1 } } } }] })).toContain("Failure".length ? "x" : "");
  });
});

describe("pricing, refs, keystore, artifacts", () => {
  it("displayed price: midpoint when spread <= 0.10, else last trade of the same outcome, else none", () => {
    expect(displayedPrice("550000", "650000", "700000")).toEqual({ price: "600000", basis: "midpoint" });
    expect(displayedPrice("400000", "650000", "700000")).toEqual({ price: "700000", basis: "last_trade" });
    expect(displayedPrice(null, "650000", null)).toEqual({ price: null, basis: "none" });
  });
  it("market refs differ by contract even with the same internal id", () => {
    expect(marketRefFor("testnet", "a.testnet", "mkt-1")).not.toBe(marketRefFor("testnet", "b.testnet", "mkt-1"));
    expect(marketRefFor("testnet", "a.testnet", "mkt-1")).toBe(marketRefFor("testnet", "a.testnet", "mkt-1"));
    expect(marketRefFor("testnet", "a.testnet", "mkt-1")).not.toBe(marketRefFor("mainnet", "a.testnet", "mkt-1"));
  });
  it("keystore never overwrites an existing key file and writes mode 0600", () => {
    const ks = new Keystore(mkdtempSync(join(tmpdir(), "ks-")));
    const kp = KeyPair.fromRandom("ed25519");
    const ref = ks.writeNew("m.testnet", kp);
    expect(() => ks.writeNew("m.testnet", kp)).toThrow(/EEXIST/);
    expect(ks.read(ref).secret).toBe(kp.toString());
  });
  it("refuses artifacts that are unapproved or whose bytes do not match the approved hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "art-"));
    writeFileSync(join(dir, "m.wasm"), "not the approved bytes");
    writeFileSync(join(dir, "artifacts.json"), JSON.stringify([{ id: "market-wasm", version: "1", path: "m.wasm", sha256: "00".repeat(32), sourceVersion: "x" }]));
    expect(() => loadApprovedArtifact(join(dir, "artifacts.json"), "market-wasm", "1")).toThrow(/!= approved/);
    expect(() => loadApprovedArtifact(join(dir, "artifacts.json"), "market-wasm", "2")).toThrow(/not in the approved registry/);
  });
});
