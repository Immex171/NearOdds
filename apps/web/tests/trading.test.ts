import { describe, expect, it } from "vitest";
import { exactCost, parsePrice, parseQuantity } from "@/lib/trading";

describe("trading input rules", () => {
  it("enforces the 0.01 tick", () => {
    expect(parsePrice("0.62")).toEqual({ ok: true, value: 620_000n });
    expect(parsePrice("0.625").ok).toBe(false);
    expect(parsePrice("0").ok).toBe(false);
    expect(parsePrice("1").ok).toBe(false);
    expect(parsePrice("0.99").ok).toBe(true);
  });
  it("enforces the 100-base-unit lot and does not treat base units as whole shares", () => {
    expect(parseQuantity("25")).toEqual({ ok: true, value: 25_000_000n });
    expect(parseQuantity("0.0001")).toEqual({ ok: true, value: 100n });
    expect(parseQuantity("0.00005").ok).toBe(false);
    expect(parseQuantity("0.000001").ok).toBe(false);
    expect(parseQuantity("0.001", { min: 10_000n }).ok).toBe(false);
  });
  it("computes exact cost", () => {
    expect(exactCost(620_000n, 25_000_000n)).toBe(15_500_000n);
    expect(exactCost(620_000n, 100n)).toBe(62n);
  });
});
