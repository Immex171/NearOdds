import type { AccountView, OfferView } from "@nearodds/types";
import { BotConfig } from "../../src/trading-bot/config.js";
import type { Facts, Snapshot } from "../../src/trading-bot/decide.js";
import type { Trading } from "../../src/trading-bot/strategy.js";

export const U = (n: number) => String(Math.round(n * 1_000_000));
export const T: Trading = { scale: 1_000_000n, tick: 10_000n, minPrice: 10_000n, maxPrice: 990_000n, lot: 100n, minOrder: 10_000n, maxOpenOffers: 10 };
export const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

export function botConfig(over: Record<string, any> = {}, marketRef = "m_test") {
  return BotConfig.parse({
    markets: [{ marketRef, enabled: true, reference: { yesPrice: "500000", label: "test fixture 0.50", source: "unit test", asOf: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString() } }],
    strategy: { spread: "50000", quantityPerQuote: U(10), quoteLifetimeSeconds: 3600, requoteThresholdPct: 50, refreshBeforeExpirySeconds: 30 },
    funding: { trancheId: 1, depositCollateral: U(20), splitCollateral: U(10) },
    limits: { maxOrderQuantity: U(10), maxYesInventory: U(20), maxNoInventory: U(20), maxCollateralPerMarket: U(20), maxCollateralTotal: U(40), maxActiveOffersPerMarket: 4, maxNativeSpendYocto: "1000000000000000000000000", minNativeReserveYocto: "100000000000000000000000", maxTransactionsPerMinute: 60, referenceMaxAgeSeconds: 600, maxChainDataAgeSeconds: 120, cutoffBufferSeconds: 300 },
    ...over,
  });
}
export const acct = (o: Partial<AccountView> = {}): AccountView => ({ account_id: "bot.test", storage_deposit: "1", available_collateral: "0", reserved_collateral: "0", yes: "0", no: "0", reserved_yes: "0", reserved_no: "0", open_offer_ids: [], pending_withdrawal: null, ...o });
export const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  blockHeight: 100, blockTsNs: BigInt(NOW) * 1_000_000n, trading: T, storageCostPerAccount: 40_960_000_000_000_000_000_000n, tokenRegistrationDeposit: 1_250_000_000_000_000_000_000n,
  market: { status: "Open", tradingOpen: true, cutoffNs: BigInt(NOW + 7_200_000) * 1_000_000n, resolved: false },
  account: acct({ available_collateral: U(10), yes: U(10), no: U(10) }), offers: [], tokenBalance: 0n, tokenRegistered: true, nativeBalance: 5_000_000_000_000_000_000_000_000n, ...o,
});
export const facts = (o: Partial<Facts> = {}): Facts => ({ desired: "running", mode: "execute", hasPendingOps: false, allocatedCollateral: 0n, allocatedTotal: 0n, nativeSpent: 0n, txLastMinute: 0, recentFailures: 0, trancheDone: { deposit: true, split: true }, ...o });
export const offer = (o: Partial<OfferView> & { offer_id: string }): OfferView => ({ market_id: "mkt-1", owner_id: "bot.test", outcome: "Yes", side: "Buy", price: "450000", quantity: U(10), filled_quantity: "0", remaining_quantity: U(10), reserved_collateral: "0", reserved_shares: "0", expires_at_ns: (BigInt(NOW + 3_000_000) * 1_000_000n).toString(), created_at_ns: "1", status: "Open", fillable: true, ...o } as OfferView);
