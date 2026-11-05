import { describe, expect, it } from "vitest";
import { quoteTake } from "@/lib/quote";
import type { Offer } from "@/lib/types";

const o = (id: string, side: "buy" | "sell", price: number, qty: number, owner = "m"): Offer => ({
  id, offerId: id, marketId: "x", outcome: "YES", side, price: BigInt(price * 1e6), qty: BigInt(qty * 1e6), owner, createdAt: 0,
});

describe("quoteTake", () => {
  const book = [o("a", "sell", 0.62, 10), o("b", "sell", 0.64, 20), o("c", "buy", 0.6, 15), o("mine", "sell", 0.5, 99, "me")];
  it("buys walk the asks cheapest first and skip own offers", () => {
    const q = quoteTake(book, "YES", "buy", 25_000_000n, "me");
    expect(q.fills.map((f) => f.offerId)).toEqual(["a", "b"]);
    expect(q.total).toBe(6_200_000n + 9_600_000n);
    expect(q.unfilled).toBe(0n);
  });
  it("reports unfilled quantity when depth is short", () => {
    expect(quoteTake(book, "YES", "buy", 40_000_000n, "me").unfilled).toBe(10_000_000n);
  });
  it("sells hit bids; NO book is independent", () => {
    expect(quoteTake(book, "YES", "sell", 5_000_000n).total).toBe(3_000_000n);
    expect(quoteTake(book, "NO", "buy", 1_000_000n).filled).toBe(0n);
  });
});
