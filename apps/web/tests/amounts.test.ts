import { describe, expect, it } from "vitest";
import { formatUnits, mulPrice, parseUnits, tryParseUnits } from "@/lib/amounts";

describe("amounts", () => {
  it("parses exact values", () => {
    expect(parseUnits("12.5")).toBe(12_500_000n);
    expect(parseUnits("0.000001")).toBe(1n);
    expect(parseUnits("1")).toBe(1_000_000n);
    expect(parseUnits("123456789012345678901234567890")).toBe(123456789012345678901234567890n * 1_000_000n);
  });
  it("rejects invalid input", () => {
    for (const bad of ["", "1.0000001", "-1", "1e3", "abc", "1.", ".5", "1,5"]) {
      expect(tryParseUnits(bad).ok).toBe(false);
    }
  });
  it("formats", () => {
    expect(formatUnits(12_500_000n)).toBe("12.5");
    expect(formatUnits(1n)).toBe("0.000001");
    expect(formatUnits(15_500_000n, 2)).toBe("15.50");
    expect(formatUnits(1_234_567_890_000n, 2, 2)).toBe("1,234,567.89");
  });
  it("prices a purchase of 25 shares at 0.62", () => {
    expect(mulPrice(620_000n, 25_000_000n)).toBe(15_500_000n);
  });
});
