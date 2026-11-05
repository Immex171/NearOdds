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
  { id: "near-10-dec", q: "Will NEAR close above $10 on December 31, 2026?", cat: "Crypto", tag: "NEAR", icon: "N", desc: "Resolves on the CoinGecko NEAR/USD daily close for December 31, 2026 (UTC). Strictly above $10.00 is YES; $10.00 or lower is NO.", yes: 41, prev: 37, vol: 482_000, closeH: 57 * 24 + 7, ageD: 40, trend: 98, featured: true, src: "CoinGecko daily close, 00:00 UTC" },
  { id: "btc-150k", q: "Will Bitcoin reach $150,000 before 2027?", cat: "Crypto", tag: "BTC", icon: "₿", desc: "Resolves YES if any major spot exchange prints a BTC/USD trade at or above $150,000 before the close of 2026.", yes: 27, prev: 29, vol: 1_240_000, closeH: 57 * 24, ageD: 60, trend: 96, featured: true, src: "Coinbase BTC-USD trade history" },
  { id: "eth-5k-nov", q: "Will Ethereum close above $5,000 on November 30, 2026?", cat: "Crypto", tag: "ETH", icon: "Ξ", desc: "Daily close on Coinbase ETH-USD, evaluated at 00:00 UTC on November 30.", yes: 18, prev: 16, vol: 356_000, closeH: 26 * 24, ageD: 21, trend: 74, src: "Coinbase ETH-USD daily close" },
  { id: "sol-300", q: "Will Solana trade at or above $300 before November 30, 2026?", cat: "Crypto", tag: "SOL", icon: "S", desc: "Resolves YES if SOL/USD trades at or above $300 on a major exchange before the end of November.", yes: 22, prev: 25, vol: 214_000, closeH: 26 * 24, ageD: 12, trend: 61, src: "Binance SOL/USDT trade history" },
  { id: "near-ai-agents", q: "Will NEAR ecosystem TVL exceed $1B by year end?", cat: "Crypto", tag: "NEAR", icon: "N", desc: "Total value locked across NEAR protocols as reported by DefiLlama.", yes: 33, prev: 33, vol: 98_500, closeH: 57 * 24, ageD: 9, trend: 55, src: "DefiLlama NEAR chain TVL" },
  { id: "btc-etf-flow", q: "Will spot BTC ETFs see net inflows this week?", cat: "Crypto", tag: "BTC", icon: "₿", desc: "Sum of daily net flows across US spot Bitcoin ETFs from Monday to Friday.", yes: 64, prev: 60, vol: 71_000, closeH: 3 * 24 + 6, ageD: 4, trend: 68, src: "Farside Investors flow table" },
  { id: "world-cup-brazil", q: "Will Brazil win the 2026 FIFA World Cup?", cat: "Sports", icon: "⚽", desc: "The tournament concluded on July 19, 2026. This market settled on the official final result.", yes: 100, prev: 100, vol: 2_900_000, closeH: -112 * 24, ageD: 300, trend: 20, status: "resolved", outcome: "YES", src: "FIFA official match report" },
  { id: "nba-lakers-title", q: "Will the Lakers win the 2027 NBA championship?", cat: "Sports", icon: "🏀", desc: "Resolves YES if the Los Angeles Lakers win the NBA Finals in June 2027.", yes: 9, prev: 8, vol: 188_000, closeH: 220 * 24, ageD: 30, trend: 52, src: "NBA.com Finals result" },
  { id: "f1-verstappen", q: "Will Max Verstappen win the 2026 Las Vegas Grand Prix?", cat: "Sports", icon: "🏁", desc: "Winner of the Las Vegas Grand Prix main race.", yes: 36, prev: 40, vol: 129_000, closeH: 14 * 24, ageD: 6, trend: 66, src: "FIA classification" },
  { id: "chiefs-bills", q: "Will the Chiefs beat the Bills on Sunday, November 8, 2026?", cat: "Sports", icon: "🏈", desc: "Regulation plus overtime. Postponed games void to the rescheduled date.", yes: 55, prev: 57, vol: 94_000, closeH: 3 * 24 - 2, ageD: 5, trend: 79, src: "NFL.com final score" },
  { id: "fed-dec-cut", q: "Will the Fed lower rates at its December 2026 meeting?", cat: "Economy", icon: "%", desc: "Resolves YES on any reduction of the federal funds target range announced at the December FOMC meeting.", yes: 71, prev: 68, vol: 940_000, closeH: 38 * 24, ageD: 50, trend: 92, featured: true, src: "Federal Reserve FOMC statement" },
  { id: "cpi-below-3", q: "Will October CPI come in below 3.0% year over year?", cat: "Economy", icon: "$", desc: "Headline CPI-U, not seasonally adjusted, as first published by the BLS.", yes: 48, prev: 52, vol: 305_000, closeH: -2 * 24, ageD: 28, trend: 40, status: "awaiting", src: "BLS CPI release" },
  { id: "recession-2027", q: "Will the US enter a recession in 2027?", cat: "Economy", icon: "📉", desc: "Two consecutive quarters of negative real GDP growth, as published by the BEA.", yes: 24, prev: 24, vol: 410_000, closeH: 420 * 24, ageD: 80, trend: 47, src: "BEA GDP release" },
  { id: "unemployment-4-5", q: "Will the next BLS report show unemployment at 4.5% or higher?", cat: "Economy", icon: "👥", desc: "BLS headline U-3 unemployment rate.", yes: null, vol: 0, closeH: 33 * 24, ageD: 1, trend: 10, noHistory: true, src: "BLS employment situation" },
  { id: "senate-control", q: "Will Republicans control the Senate after the 2028 election?", cat: "Politics", icon: "🏛", desc: "Party with 51+ seats (or 50 plus the VP) when the new Senate is sworn in.", yes: 58, prev: 56, vol: 1_760_000, closeH: 700 * 24, ageD: 120, trend: 85, src: "Senate.gov seat tally" },
  { id: "uk-pm", q: "Will the UK have a new Prime Minister by March 2027?", cat: "Politics", icon: "🇬🇧", desc: "Any change in the person holding the office of Prime Minister of the United Kingdom.", yes: 31, prev: 34, vol: 223_000, closeH: 120 * 24, ageD: 35, trend: 58, src: "gov.uk" },
  { id: "gpt-6", q: "Will OpenAI release GPT-6 before 2027?", cat: "Technology", icon: "AI", desc: "A model publicly branded GPT-6 generally available via API or ChatGPT.", yes: 44, prev: 47, vol: 612_000, closeH: 57 * 24, ageD: 45, trend: 88, src: "OpenAI announcements" },
  { id: "apple-folding", q: "Will Apple announce a foldable iPhone in 2026?", cat: "Technology", icon: "", desc: "Official announcement at an Apple event or press release.", yes: 12, prev: 12, vol: 145_000, closeH: 57 * 24, ageD: 55, trend: 44, src: "Apple Newsroom" },
  { id: "starship-orbit", q: "Will Starship complete a full orbit on a flight launching by November 24, 2026?", cat: "Technology", icon: "🚀", desc: "One full orbit completed with controlled stage separation.", yes: 61, prev: 58, vol: 266_000, closeH: 20 * 24, ageD: 18, trend: 72, src: "SpaceX flight report" },
  { id: "tiktok-ban", q: "Will TikTok be unavailable in the US app stores on June 1, 2027?", cat: "Technology", icon: "♪", desc: "Removed from both Apple App Store and Google Play in the United States.", yes: 8, prev: 9, vol: 87_000, closeH: 200 * 24, ageD: 70, trend: 36, src: "App store availability checks" },
];


const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m, d, h, mi);
type Rule = { yes: string; no: string; src: string; field: string; obsAt: number | null; obs: string; missing?: string };
const MISSING = "If the source has no value for the observation time, the market stays awaiting resolution. It does not default to NO.";
/** Explicit, objective resolution terms per market. Never derived from the description. */
const RULES: Record<string, Rule> = {
  "near-10-dec": { yes: "The CoinGecko NEAR/USD daily closing price for December 31, 2026 (UTC) is strictly greater than $10.00.", no: "That price is $10.00 or less.", src: "CoinGecko", field: "NEAR/USD historical daily price (USD), the 00:00:00 UTC snapshot on January 1, 2027, which is the close of December 31, 2026", obsAt: utc(2027, 0, 1), obs: "Single observation: the December 31, 2026 daily close (UTC). Not an intraday high or any-time touch." },
  "btc-150k": { yes: "At least one BTC-USD trade at or above $150,000.00 prints on Coinbase between market creation and trading close.", no: "No such trade prints in that window.", src: "Coinbase", field: "BTC-USD trade history (trade price)", obsAt: null, obs: "Any trade in the window from market creation until trading close (touch market)." },
  "eth-5k-nov": { yes: "The Coinbase ETH-USD daily close for November 30, 2026 (UTC) is strictly greater than $5,000.00.", no: "That close is $5,000.00 or less.", src: "Coinbase", field: "ETH-USD daily candle close, read at 00:00:00 UTC on December 1, 2026", obsAt: utc(2026, 11, 1), obs: "Single observation: the November 30, 2026 daily close (UTC)." },
  "sol-300": { yes: "At least one SOL/USDT trade at or above $300.00 prints on Binance before trading close.", no: "No such trade prints before trading close.", src: "Binance", field: "SOL/USDT trade history (trade price)", obsAt: null, obs: "Any trade from market creation until trading close (touch market)." },
  "near-ai-agents": { yes: "DefiLlama's NEAR chain TVL is strictly greater than $1,000,000,000 at the observation time.", no: "It is $1,000,000,000 or less at that time.", src: "DefiLlama", field: "Chain TVL for NEAR (USD, default methodology)", obsAt: utc(2027, 0, 1), obs: "Single observation at 00:00:00 UTC on January 1, 2027." },
  "btc-etf-flow": { yes: "The total net flow across US spot Bitcoin ETFs for Monday to Friday of this week is strictly greater than $0.", no: "It is $0 or negative.", src: "Farside Investors", field: "BTC ETF flow table, weekly total (US$m), read after Friday's data is published", obsAt: utc(2026, 10, 9, 12), obs: "Read at 12:00 UTC on Monday, November 9, 2026." },
  "world-cup-brazil": { yes: "Brazil is the official winner of the 2026 FIFA World Cup final.", no: "Any other team wins.", src: "FIFA", field: "Official match report for the final", obsAt: utc(2026, 6, 19, 22), obs: "Result of the final played on July 19, 2026." },
  "nba-lakers-title": { yes: "The Los Angeles Lakers win the 2027 NBA Finals.", no: "Any other team wins, or the Lakers do not reach the Finals.", src: "NBA.com", field: "Official Finals series result", obsAt: null, obs: "Final result of the 2027 NBA Finals." },
  "f1-verstappen": { yes: "Max Verstappen is classified first in the Las Vegas Grand Prix race, per the FIA final classification.", no: "Any other driver is classified first, or he does not finish first.", src: "FIA", field: "Race final classification, after any penalties published within 24 hours", obsAt: null, obs: "Final classification of the race." , missing: "If the race is cancelled or postponed beyond the observation window, the market stays awaiting resolution." },
  "chiefs-bills": { yes: "The Kansas City Chiefs have more points than the Buffalo Bills at the end of regulation plus overtime on November 8, 2026.", no: "The Bills have more points, or the game ends tied.", src: "NFL.com", field: "Official final score", obsAt: utc(2026, 10, 9), obs: "Final score of the November 8, 2026 game.", missing: "If the game is postponed, the market stays awaiting resolution until it is played." },
  "fed-dec-cut": { yes: "The FOMC statement for its December 2026 meeting lowers the federal funds target range.", no: "The statement keeps or raises the target range.", src: "Federal Reserve", field: "FOMC statement, target range for the federal funds rate", obsAt: null, obs: "Statement released at the end of the December 2026 FOMC meeting." },
  "cpi-below-3": { yes: "Headline CPI-U (not seasonally adjusted), 12-month change for October 2026, as first published by the BLS, is strictly below 3.0%.", no: "It is 3.0% or higher.", src: "US Bureau of Labor Statistics", field: "CPI-U all items, 12-month percent change, first release", obsAt: utc(2026, 10, 12, 13, 30), obs: "First published value in the October 2026 CPI release." },
  "recession-2027": { yes: "The BEA's first published estimates show negative real GDP growth in two consecutive quarters of calendar 2027.", no: "They do not.", src: "US Bureau of Economic Analysis", field: "Real GDP, percent change from preceding quarter, first estimates", obsAt: null, obs: "First estimates for Q1 to Q4 2027." },
  "unemployment-4-5": { yes: "The BLS U-3 unemployment rate in the next Employment Situation report is 4.5% or higher.", no: "It is below 4.5%.", src: "US Bureau of Labor Statistics", field: "Employment Situation, U-3 rate, first release", obsAt: null, obs: "First published value in that report." },
  "senate-control": { yes: "Republicans hold 51 or more seats, or 50 seats with a Republican Vice President, when the Senate sworn in after the 2028 election convenes.", no: "They do not.", src: "Senate.gov", field: "Seat tally on the first day of the new Senate", obsAt: null, obs: "Seat tally when the new Senate convenes in January 2029." },
  "uk-pm": { yes: "The person holding the office of UK Prime Minister at 00:00 UTC on April 1, 2027 is not the person who held it on November 4, 2026.", no: "It is the same person.", src: "gov.uk", field: "Prime Minister office-holder page", obsAt: utc(2027, 3, 1), obs: "Single observation at 00:00:00 UTC on April 1, 2027." },
  "gpt-6": { yes: "OpenAI makes a model publicly named GPT-6 generally available via its API or ChatGPT before 00:00 UTC on January 1, 2027.", no: "It does not.", src: "OpenAI", field: "Official announcements and model documentation", obsAt: utc(2027, 0, 1), obs: "Any release before 00:00:00 UTC on January 1, 2027." },
  "apple-folding": { yes: "Apple officially announces a foldable iPhone (event or press release) between market creation and 23:59 UTC on December 31, 2026.", no: "It does not.", src: "Apple Newsroom", field: "Official press releases and event recordings", obsAt: utc(2027, 0, 1), obs: "Any announcement before the end of 2026 (UTC)." },
  "starship-orbit": { yes: "A Starship flight launching by November 24, 2026 completes one full orbit with controlled stage separation, per SpaceX's flight report.", no: "No flight does, including if no flight launches by that date.", src: "SpaceX", field: "Official flight report", obsAt: null, obs: "Flight report for any launch by November 24, 2026." },
  "tiktok-ban": { yes: "TikTok is unavailable in both the US Apple App Store and Google Play on June 1, 2027 (00:00 UTC).", no: "It is available in at least one of them.", src: "Apple App Store and Google Play", field: "US storefront availability checks", obsAt: utc(2027, 5, 1), obs: "Single observation at 00:00:00 UTC on June 1, 2027." },
};

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
      yesWins: RULES[s.id].yes,
      noWins: RULES[s.id].no,
      source: { name: RULES[s.id].src, field: RULES[s.id].field },
      observation: { at: RULES[s.id].obsAt, text: RULES[s.id].obs },
      ifMissing: RULES[s.id].missing ?? MISSING,
      resolver: "Demo resolver",
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
  const first = Math.max(m.createdAt ?? end - 30 * D, end - 30 * D);
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
  if (m.lastYes == null) return [{ id: m.id + "-c", t: m.createdAt ?? NOW, text: "Market created. No trades yet.", kind: "event" }];
  for (let i = 0; i < 8; i++) {
    const out: Outcome = r() > 0.5 ? "YES" : "NO";
    const q = 5 + Math.floor(r() * 40);
    const px = out === "YES" ? Number(m.lastYes) / 10_000 : 100 - Number(m.lastYes) / 10_000;
    items.push({ id: `${m.id}-t${i}`, t: NOW - (i * 3 + Math.floor(r() * 3)) * H, kind: "trade",
      text: `maker${Math.floor(r() * 90 + 10)}.testnet bought ${q} ${out} at ${(px / 100).toFixed(2)}` });
  }
  items.push({ id: m.id + "-c", t: m.createdAt ?? NOW, text: "Market created.", kind: "event" });
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
