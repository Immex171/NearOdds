import type { Category, Market } from "./types";

export type SortKey = "trending" | "newest" | "volume" | "closing";
export const SORTS: { key: SortKey; label: string }[] = [
  { key: "trending", label: "Trending" }, { key: "newest", label: "Newest" },
  { key: "volume", label: "Highest volume" }, { key: "closing", label: "Closing soon" },
];

export interface Filters {
  category: Category | null;
  status: string[]; // open | closing | resolved
  period: string[]; // today | week | month
  tags: string[];
  saved: boolean;
  q: string;
  sort: SortKey;
  view: "trending" | "new" | null;
}

const DAY = 86_400_000;

export function parseFilters(sp: URLSearchParams): Filters {
  const list = (k: string) => (sp.get(k) ? sp.get(k)!.split(",").filter(Boolean) : []);
  const cat = sp.get("category");
  const sort = sp.get("sort") as SortKey | null;
  const view = sp.get("view");
  return {
    category: (["Crypto", "Sports", "Politics", "Economy", "Technology"].includes(cat ?? "") ? cat : null) as Category | null,
    status: list("status"), period: list("period"), tags: list("tag"), saved: sp.get("saved") === "1",
    q: sp.get("q") ?? "", sort: SORTS.some((s) => s.key === sort) ? sort! : view === "new" ? "newest" : "trending",
    view: view === "trending" || view === "new" ? view : null,
  };
}

export function toParams(f: Filters): string {
  const p = new URLSearchParams();
  if (f.category) p.set("category", f.category);
  if (f.view) p.set("view", f.view);
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.period.length) p.set("period", f.period.join(","));
  if (f.tags.length) p.set("tag", f.tags.join(","));
  if (f.saved) p.set("saved", "1");
  if (f.q) p.set("q", f.q);
  if (f.sort !== "trending") p.set("sort", f.sort);
  return p.toString();
}

export const hasActive = (f: Filters) => f.status.length + f.period.length + f.tags.length > 0 || f.saved || !!f.q;

const matchStatus = (m: Market, now: number, s: string) =>
  s === "open" ? m.status === "open" : s === "closing" ? m.status === "open" && m.closesAt - now <= 7 * DAY : s === "resolved" ? m.status === "resolved" : true;
const matchPeriod = (m: Market, now: number, p: string) => {
  const d = m.closesAt - now;
  return m.status === "open" && d > 0 && (p === "today" ? d <= DAY : p === "week" ? d <= 7 * DAY : d <= 30 * DAY);
};

/** Apply one dimension at a time so facet counts can ignore their own group. */
export function applyFilters(markets: Market[], f: Filters, now: number, bookmarks: string[], skip?: "status" | "period" | "tags"): Market[] {
  const q = f.q.trim().toLowerCase();
  return markets.filter((m) =>
    (!f.category || m.category === f.category) &&
    (!q || m.question.toLowerCase().includes(q)) &&
    (!f.saved || bookmarks.includes(m.id)) &&
    (f.view !== "new" || now - m.createdAt <= 14 * DAY) &&
    (skip === "status" || !f.status.length || f.status.some((s) => matchStatus(m, now, s))) &&
    (skip === "period" || !f.period.length || f.period.some((p) => matchPeriod(m, now, p))) &&
    (skip === "tags" || !f.tags.length || (m.tag != null && f.tags.includes(m.tag))));
}

export function sortMarkets(ms: Market[], sort: SortKey, now: number): Market[] {
  const live = (m: Market) => (m.status === "open" ? 0 : 1);
  const by: Record<SortKey, (a: Market, b: Market) => number> = {
    trending: (a, b) => b.trendScore - a.trendScore,
    newest: (a, b) => b.createdAt - a.createdAt,
    volume: (a, b) => Number(b.volume - a.volume),
    closing: (a, b) => {
      const fa = a.closesAt > now ? a.closesAt : Infinity, fb = b.closesAt > now ? b.closesAt : Infinity;
      return fa - fb;
    },
  };
  return [...ms].sort((a, b) => live(a) - live(b) || by[sort](a, b));
}

export const facetTags = (markets: Market[], category: Category | null) =>
  Array.from(new Set(markets.filter((m) => !category || m.category === category).map((m) => m.tag).filter(Boolean) as string[]));

export const matchCounts = {
  status: (ms: Market[], now: number, key: string) => ms.filter((m) => matchStatus(m, now, key)).length,
  period: (ms: Market[], now: number, key: string) => ms.filter((m) => matchPeriod(m, now, key)).length,
};
