import type { ActivityItem, Category, HistoryPoint, Market, Offer, OpenOffer, Outcome, Position } from "../types";

/** Fixed demo clock so dates and statuses are deterministic. */
export const DEMO_NOW = Date.UTC(2026, 10, 4, 16, 0, 0);
export const DEMO_ACCOUNT = "demo-trader.testnet";
const H = 3_600_000;
const D = 24 * H;
const c = (cents: number) => BigInt(Math.round(cents * 10_000)); // cents -> base units
const tok = (n: number) => BigInt(Math.round(n * 1_000_000));

type Seed = {
  id: string; q: string; cat: Category; tag?: string; icon: string; desc: string;
  yes: number | null; prev?: number | null; vol: number; closeH: number; ageD: number; trend: number;
  status?: Market["status"]; outcome?: Outcome; featured?: boolean; noHistory?: boolean; src?: string;
};

const seeds: Seed[] = [
  { id: "near-10-dec", q: "Will NEAR trade above $10 on December 31, 2026?", cat: "Crypto", tag: "NEAR", icon: "N", desc: "NEAR has rallied alongside the AI-agent narrative. The market tracks the closing spot price on the last day of the year.", yes: 41, prev: 37, vol: 482_000, closeH: 57 * 24, ageD: 40, trend: 98, featured: true, src: "CoinGecko daily close, 00:00 UTC" },
  { id: "btc-150k", q: "Will Bitcoin reach $150,000 before 2027?", cat: "Crypto", tag: "BTC", icon: "₿", desc: "Resolves YES if any major spot exchange prints a BTC/USD trade at or above $150,000 before the close of 2026.", yes: 27, prev: 29, vol: 1_240_000, closeH: 57 * 24, ageD: 60, trend: 96, featured: true, src: "Coinbase BTC-USD trade history" },
  { id: "eth-5k-nov", q: "Will Ethereum close above $5,000 by November 30?", cat: "Crypto", tag: "ETH", icon: "Ξ", desc: "Daily close on Coinbase ETH-USD, evaluated at 00:00 UTC on November 30.", yes: 18, prev: 16, vol: 356_000, closeH: 26 * 24, ageD: 21, trend: 74, src: "Coinbase ETH-USD daily close" },
  { id: "sol-300", q: "Will Solana touch $300 this month?", cat: "Crypto", tag: "SOL", icon: "S", desc: "Resolves YES if SOL/USD trades at or above $300 on a major exchange before the end of November.", yes: 22, prev: 25, vol: 214_000, closeH: 26 * 24, ageD: 12, trend: 61, src: "Binance SOL/USDT trade history" },
  { id: "near-ai-agents", q: "Will NEAR ecosystem TVL exceed $1B by year end?", cat: "Crypto", tag: "NEAR", icon: "N", desc: "Total value locked across NEAR protocols as reported by DefiLlama.", yes: 33, prev: 33, vol: 98_500, closeH: 57 * 24, ageD: 9, trend: 55, src: "DefiLlama NEAR chain TVL" },
  { id: "btc-etf-flow", q: "Will spot BTC ETFs see net inflows this week?", cat: "Crypto", tag: "BTC", icon: "₿", desc: "Sum of daily net flows across US spot Bitcoin ETFs from Monday to Friday.", yes: 64, prev: 60, vol: 71_000, closeH: 3 * 24 + 6, ageD: 4, trend: 68, src: "Farside Investors flow table" },
  { id: "world-cup-brazil", q: "Will Brazil win the 2026 FIFA World Cup?", cat: "Sports", icon: "⚽", desc: "The tournament concluded on July 19, 2026. This market settled on the official final result.", yes: 100, prev: 100, vol: 2_900_000, closeH: -112 * 24, ageD: 300, trend: 20, status: "resolved", outcome: "YES", src: "FIFA official match report" },
  { id: "nba-lakers-title", q: "Will the Lakers win the 2027 NBA championship?", cat: "Sports", icon: "🏀", desc: "Resolves YES if the Los Angeles Lakers win the NBA Finals in June 2027.", yes: 9, prev: 8, vol: 188_000, closeH: 220 * 24, ageD: 30, trend: 52, src: "NBA.com Finals result" },
  { id: "f1-verstappen", q: "Will Max Verstappen win the next Grand Prix?", cat: "Sports", icon: "🏁", desc: "Winner of the Las Vegas Grand Prix main race.", yes: 36, prev: 40, vol: 129_000, closeH: 14 * 24, ageD: 6, trend: 66, src: "FIA classification" },
  { id: "chiefs-bills", q: "Will the Chiefs beat the Bills on Sunday?", cat: "Sports", icon: "🏈", desc: "Regulation plus overtime. Postponed games void to the rescheduled date.", yes: 55, prev: 57, vol: 94_000, closeH: 3 * 24 - 2, ageD: 5, trend: 79, src: "NFL.com final score" },
  { id: "fed-dec-cut", q: "Will the Fed cut rates at the December meeting?", cat: "Economy", icon: "%", desc: "Resolves YES on any reduction of the federal funds target range announced at the December FOMC meeting.", yes: 71, prev: 68, vol: 940_000, closeH: 38 * 24, ageD: 50, trend: 92, featured: true, src: "Federal Reserve FOMC statement" },
  { id: "cpi-below-3", q: "Will October CPI come in below 3.0% year over year?", cat: "Economy", icon: "$", desc: "Headline CPI-U, not seasonally adjusted, as first published by the BLS.", yes: 48, prev: 52, vol: 305_000, closeH: -2 * 24, ageD: 28, trend: 40, status: "awaiting", src: "BLS CPI release" },
  { id: "recession-2027", q: "Will the US enter a recession in 2027?", cat: "Economy", icon: "📉", desc: "Two consecutive quarters of negative real GDP growth, as published by the BEA.", yes: 24, prev: 24, vol: 410_000, closeH: 420 * 24, ageD: 80, trend: 47, src: "BEA GDP release" },
  { id: "unemployment-4-5", q: "Will unemployment reach 4.5% in the next report?", cat: "Economy", icon: "👥", desc: "BLS headline U-3 unemployment rate.", yes: null, vol: 0, closeH: 33 * 24, ageD: 1, trend: 10, noHistory: true, src: "BLS employment situation" },
  { id: "senate-control", q: "Will Republicans hold the Senate after the next election?", cat: "Politics", icon: "🏛", desc: "Party with 51+ seats (or 50 plus the VP) when the new Senate is sworn in.", yes: 58, prev: 56, vol: 1_760_000, closeH: 700 * 24, ageD: 120, trend: 85, src: "Senate.gov seat tally" },
  { id: "uk-pm", q: "Will the UK have a new Prime Minister by March 2027?", cat: "Politics", icon: "🇬🇧", desc: "Any change in the person holding the office of Prime Minister of the United Kingdom.", yes: 31, prev: 34, vol: 223_000, closeH: 120 * 24, ageD: 35, trend: 58, src: "gov.uk" },
  { id: "gpt-6", q: "Will OpenAI release GPT-6 before 2027?", cat: "Technology", icon: "AI", desc: "A model publicly branded GPT-6 generally available via API or ChatGPT.", yes: 44, prev: 47, vol: 612_000, closeH: 57 * 24, ageD: 45, trend: 88, src: "OpenAI announcements" },
  { id: "apple-folding", q: "Will Apple announce a foldable iPhone this year?", cat: "Technology", icon: "", desc: "Official announcement at an Apple event or press release.", yes: 12, prev: 12, vol: 145_000, closeH: 57 * 24, ageD: 55, trend: 44, src: "Apple Newsroom" },
  { id: "starship-orbit", q: "Will Starship reach orbit on its next flight?", cat: "Technology", icon: "🚀", desc: "One full orbit completed with controlled stage separation.", yes: 61, prev: 58, vol: 266_000, closeH: 20 * 24, ageD: 18, trend: 72, src: "SpaceX flight report" },
  { id: "tiktok-ban", q: "Will TikTok be unavailable in the US app stores by June?", cat: "Technology", icon: "♪", desc: "Removed from both Apple App Store and Google Play in the United States.", yes: 8, prev: 9, vol: 87_000, closeH: 200 * 24, ageD: 70, trend: 36, src: "App store availability checks" },
];

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const NOW = DEMO_NOW;

export const demoMarkets: Market[] = seeds.map((s) => {
  const status = s.status ?? "open";
  const resolved = status === "resolved";
  return {
    id: s.id, question: s.q, category: s.cat, tag: s.tag, icon: s.icon, description: s.desc, status,
    createdAt: NOW - s.ageD * D, closesAt: NOW + s.closeH * H,
    volume: tok(s.vol), lastYes: s.yes == null ? null : c(s.yes), prevYes: s.prev == null || s.yes == null ? null : c(s.prev),
    hasHistory: !s.noHistory && s.yes != null, featured: s.featured, trendScore: s.trend,
    resolution: {
      yesWins: `Resolves YES if: ${s.desc.split(". ")[0].replace(/\.$/, "")}.`,
      noWins: "Resolves NO in every other case, including if the condition is not met by the trading close time.",
      source: s.src ?? "Official public source named in the market description",
      resolver: "NearOdds demo resolver (sample data, no real authority)",
      outcome: resolved ? (s.outcome ?? "YES") : null,
      note: status === "awaiting" ? "Trading has closed. Waiting for the resolver to publish the outcome." : resolved ? "Resolved by the demo resolver." : undefined,
    },
  };
});

export const marketById = (id: string) => demoMarkets.find((m) => m.id === id);

/** Deterministic history ending at the market's current price. Hourly for 30d; 5-minute for the last day. */
export function demoHistory(m: Market): HistoryPoint[] | null {
  if (!m.hasHistory || m.lastYes == null) return null;
  const end = Math.min(NOW, m.closesAt);
  const r = rng(m.id);
  const target = Number(m.lastYes) / 1_000_000;
  const start = m.prevYes != null ? Number(m.prevYes) / 1_000_000 : target;
  const pts: HistoryPoint[] = [];
  const first = Math.max(m.createdAt, end - 30 * D);
  const steps: number[] = [];
  for (let t = first; t < end - D; t += H) steps.push(t);
  for (let t = Math.max(first, end - D); t <= end; t += 5 * 60_000) steps.push(t);
  let p = Math.min(0.95, Math.max(0.05, start + (r() - 0.5) * 0.15));
  const n = steps.length;
  steps.forEach((t, i) => {
    const pull = (i / n) ** 2;
    p += (r() - 0.5) * 0.02 + (start - p) * 0.01;
    const v = p * (1 - pull) + target * pull;
    pts.push({ t, p: Math.min(0.99, Math.max(0.01, i === n - 1 ? target : v)) });
  });
  return pts;
}

/** Seeded order book: spread around the YES price. Markets without a price or not open have no offers. */
export function demoOffers(): Offer[] {
  const out: Offer[] = [];
  for (const m of demoMarkets) {
    if (m.status !== "open" || m.lastYes == null || m.id === "unemployment-4-5") continue;
    const r = rng("book" + m.id);
    const mid = Math.round(Number(m.lastYes) / 10_000);
    const mk = (side: "buy" | "sell", outcome: Outcome, cents: number, i: number): Offer => ({
      id: `${m.id}-${outcome}-${side}-${i}`, marketId: m.id, outcome, side, price: c(cents),
      qty: tok(10 + Math.floor(r() * 18) * 5), owner: `maker${Math.floor(r() * 90 + 10)}.testnet`, createdAt: NOW - Math.floor(r() * 20) * H,
    });
    for (let i = 0; i < 4; i++) {
      const yb = mid - 1 - i * 1, ya = mid + 1 + i;
      if (yb >= 1) out.push(mk("buy", "YES", yb, i));
      if (ya <= 99) out.push(mk("sell", "YES", ya, i));
      const nb = 100 - mid - 1 - i, na = 100 - mid + 1 + i; // independent NO book; not derived from a YES quote at trade time
      if (nb >= 1) out.push(mk("buy", "NO", nb + (i % 2 === 0 ? 0 : -1), i));
      if (na <= 99) out.push(mk("sell", "NO", na + (i % 2 === 0 ? 1 : 0), i));
    }
  }
  return out;
}

export function demoActivity(m: Market): ActivityItem[] {
  const r = rng("act" + m.id);
  const items: ActivityItem[] = [];
  if (m.lastYes == null) return [{ id: m.id + "-c", t: m.createdAt, text: "Market created. No trades yet.", kind: "event" }];
  for (let i = 0; i < 8; i++) {
    const out: Outcome = r() > 0.5 ? "YES" : "NO";
    const q = 5 + Math.floor(r() * 40);
    const px = out === "YES" ? Number(m.lastYes) / 10_000 : 100 - Number(m.lastYes) / 10_000;
    items.push({ id: `${m.id}-t${i}`, t: NOW - (i * 3 + Math.floor(r() * 3)) * H, kind: "trade",
      text: `maker${Math.floor(r() * 90 + 10)}.testnet bought ${q} ${out} at ${(px / 100).toFixed(2)}` });
  }
  items.push({ id: m.id + "-c", t: m.createdAt, text: "Market created.", kind: "event" });
  if (m.status === "resolved") items.unshift({ id: m.id + "-r", t: m.closesAt + H, text: `Resolved ${m.resolution.outcome}.`, kind: "event" });
  return items.sort((a, b) => b.t - a.t);
}

export function demoInitialPositions(): Position[] {
  return [
    { marketId: "near-10-dec", outcome: "YES", qty: tok(40), avgPrice: c(36), reserved: 0n },
    { marketId: "fed-dec-cut", outcome: "NO", qty: tok(60), avgPrice: c(33), reserved: 0n },
    { marketId: "world-cup-brazil", outcome: "YES", qty: tok(25), avgPrice: c(18), reserved: 0n },
    { marketId: "gpt-6", outcome: "YES", qty: tok(30), avgPrice: null, reserved: 0n },
  ];
}

export function demoInitialOffers(): OpenOffer[] {
  return [
    { id: "mine-1", marketId: "btc-150k", outcome: "YES", side: "buy", price: c(24), qty: tok(50), owner: DEMO_ACCOUNT, createdAt: NOW - 5 * H, status: "open" },
    { id: "mine-2", marketId: "near-10-dec", outcome: "YES", side: "sell", price: c(60), qty: tok(15), owner: DEMO_ACCOUNT, createdAt: NOW - 30 * H, status: "open" },
  ];
}

export const DEMO_INITIAL = { walletBalance: tok(1000), available: tok(500) };
