import { ONE, formatUnits, percent } from "./amounts";
import type { Market, MarketStatus } from "./types";

export const money = (v: bigint, symbol: string, min = 2) => `${formatUnits(v, min, 6)} ${symbol}`;
export const priceStr = (p: bigint | null) => (p == null ? "—" : formatUnits(p, 2, 4));
export const centsStr = (p: bigint | null) => (p == null ? "—" : `${percent(p)}¢`);

export function compact(v: bigint): string {
  const n = Number(v / ONE);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function timeUntil(ts: number, now: number): string {
  const d = ts - now;
  const abs = Math.abs(d);
  const m = Math.floor(abs / 60_000), h = Math.floor(abs / 3_600_000), days = Math.floor(abs / 86_400_000);
  const s = days >= 60 ? `${Math.round(days / 30)}mo` : days >= 1 ? `${days}d` : h >= 1 ? `${h}h` : `${Math.max(m, 1)}m`;
  return d >= 0 ? `Closes in ${s}` : `Closed ${s} ago`;
}

export function dateTime(ts: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ts);
}
export function shortDate(ts: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ts);
}

export const statusLabel: Record<MarketStatus, string> = {
  open: "Open", closed: "Closed", awaiting: "Awaiting resolution", resolved: "Resolved",
};

export function shortAccount(id: string) {
  return id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

export function yesPct(m: Market): number | null { return m.lastYes == null ? null : percent(m.lastYes); }

export function movement(m: Market): { delta: number; label: string } | null {
  if (m.lastYes == null || m.prevYes == null || !m.hasHistory) return null;
  const d = percent(m.lastYes) - percent(m.prevYes);
  return { delta: d, label: `${d >= 0 ? "▲" : "▼"} ${Math.abs(d)} pts vs 24h ago` };
}

export const isTradable = (m: Market) => m.status === "open";
