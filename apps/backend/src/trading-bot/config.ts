import { z } from "zod";

const U = z.string().regex(/^\d+$/, "decimal string of base units");
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const Reference = z.object({
  yesPrice: U,                       // collateral base units per whole share, e.g. "500000" = 0.50
  label: z.string().min(1).max(120), // what this number is (a strategy INPUT, not an independent probability claim)
  source: z.string().min(1).max(300),
  asOf: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type Reference = z.infer<typeof Reference>;

export const BotConfig = z.object({
  markets: z.array(z.object({
    marketRef: z.string().min(3),
    enabled: z.boolean().default(true),
    reference: Reference.nullable(),
    quantityPerQuote: U.optional(),
  })).min(1).max(20),
  strategy: z.object({
    spread: U,                                    // distance of each bid below / ask above the reference, in price units
    quantityPerQuote: U,
    quoteLifetimeSeconds: z.number().int().min(30).max(86_400),
    requoteThresholdPct: z.number().int().min(1).max(100).default(50),   // requote when remaining < pct of the desired size
    refreshBeforeExpirySeconds: z.number().int().min(0).max(3_600).default(30),
  }),
  funding: z.object({
    trancheId: z.number().int().min(1).default(1),   // setup (deposit + split) runs once per tranche id
    depositCollateral: U.default("0"),
    splitCollateral: U.default("0"),
  }).default({ trancheId: 1, depositCollateral: "0", splitCollateral: "0" }),
  limits: z.object({
    maxOrderQuantity: U,
    maxYesInventory: U,
    maxNoInventory: U,
    maxCollateralPerMarket: U,
    maxCollateralTotal: U,
    maxActiveOffersPerMarket: z.number().int().min(1).max(10),
    maxNativeSpendYocto: U,
    minNativeReserveYocto: U,
    estimatedTxFeeYocto: U.default("5000000000000000000000"),
    maxTransactionsPerMinute: z.number().int().min(1).max(600),
    referenceMaxAgeSeconds: z.number().int().min(1),
    maxChainDataAgeSeconds: z.number().int().min(1),
    cutoffBufferSeconds: z.number().int().min(0),
  }),
}).superRefine((c, ctx) => {
  if (BigInt(c.funding.depositCollateral) > BigInt(c.limits.maxCollateralPerMarket)) ctx.addIssue({ code: "custom", message: "funding.depositCollateral exceeds limits.maxCollateralPerMarket", path: ["funding", "depositCollateral"] });
  if (BigInt(c.funding.splitCollateral) > BigInt(c.funding.depositCollateral)) ctx.addIssue({ code: "custom", message: "funding.splitCollateral exceeds funding.depositCollateral", path: ["funding", "splitCollateral"] });
  const enabled = c.markets.filter((m) => m.enabled).length;
  if (BigInt(c.funding.depositCollateral) * BigInt(enabled) > BigInt(c.limits.maxCollateralTotal)) ctx.addIssue({ code: "custom", message: "deposits across enabled markets exceed limits.maxCollateralTotal", path: ["limits", "maxCollateralTotal"] });
  if (new Set(c.markets.map((m) => m.marketRef)).size !== c.markets.length) ctx.addIssue({ code: "custom", message: "duplicate marketRef", path: ["markets"] });
});
export type BotConfig = z.infer<typeof BotConfig>;

export const NewBot = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/),
  accountId: z.string().regex(ACCOUNT).max(64),
  network: z.string().min(1),
  credentialsEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("BOT_CREDENTIALS_FILE"),
  config: BotConfig,
});
export type NewBot = z.infer<typeof NewBot>;

export const SLOTS = ["YES_BUY", "YES_SELL", "NO_BUY", "NO_SELL"] as const;
export type Slot = (typeof SLOTS)[number];
export const slotParts = (s: Slot) => ({ outcome: s.startsWith("YES") ? ("Yes" as const) : ("No" as const), side: s.endsWith("BUY") ? ("Buy" as const) : ("Sell" as const) });
export const slotOf = (outcome: "Yes" | "No", side: "Buy" | "Sell"): Slot => `${outcome === "Yes" ? "YES" : "NO"}_${side === "Buy" ? "BUY" : "SELL"}` as Slot;
