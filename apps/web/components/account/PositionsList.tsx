"use client";
import Link from "next/link";
import { formatUnits, mulPrice, ONE } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { money, priceStr } from "@/lib/format";
import type { Market, Position } from "@/lib/types";
import { Badge, Btn, EmptyState } from "../ui/bits";

/** Estimated value from the market's display price (last trade) or the final outcome. Returns null when no defensible price exists. */
export function estimate(p: Position, m: Market | undefined): bigint | null {
  if (!m) return null;
  const all = p.qty + p.reserved;
  if (m.status === "resolved" && m.resolution.outcome) return m.resolution.outcome === p.outcome ? all : 0n;
  if (m.lastYes == null) return null;
  const px = p.outcome === "YES" ? m.lastYes : ONE - m.lastYes;
  return mulPrice(px, all);
}

export function PositionsList({ positions }: { positions: Position[] }) {
  const { markets, adapter, showToast } = useApp();
  const { run, busy } = useTx();
  const sym = adapter.symbol;
  if (!positions.length) return <EmptyState title="No positions yet" body="Shares you buy or create will appear here." action={<Link href="/markets" className="font-semibold text-brand">Browse markets</Link>} />;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-card">
      {positions.map((p) => {
        const m = markets?.find((x) => x.id === p.marketId);
        const est = estimate(p, m);
        const won = m?.status === "resolved" && m.resolution.outcome === p.outcome;
        const lost = m?.status === "resolved" && !won;
        return (
          <li key={`${p.marketId}-${p.outcome}`} className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_130px_110px_130px_190px] md:items-center">
            <div className="min-w-0">
              <Link href={`/markets/${p.marketId}`} className="line-clamp-2 font-medium hover:underline">{m?.question ?? p.marketId}</Link>
              <div className="mt-1 flex items-center gap-2"><Badge tone={p.outcome === "YES" ? "yes" : "no"}>{p.outcome}</Badge>{m && m.status !== "open" && <span className="text-xs text-mute">{m.status === "resolved" ? `Resolved ${m.resolution.outcome}` : "Awaiting resolution"}</span>}</div>
            </div>
            <Cell k="Shares" v={`${formatUnits(p.qty + p.reserved, 0, 4)}${p.reserved > 0n ? ` (${formatUnits(p.reserved, 0, 4)} in offers)` : ""}`} />
            <Cell k="Avg entry" v={p.avgPrice == null ? "Unknown" : `${priceStr(p.avgPrice)} ${sym}`} />
            <Cell k="Est. value" v={est == null ? "No price" : money(est, sym)} />
            <div className="flex gap-2 md:justify-end">
              <Link href={`/markets/${p.marketId}?outcome=${p.outcome}`} className="inline-flex min-h-10 items-center rounded-lg border border-line px-3 text-sm font-semibold hover:bg-white/10">{m?.status === "open" ? "Sell" : "View market"}</Link>
              {m?.status === "resolved" && adapter.capabilities.redeem && (
                <Btn disabled={busy || lost} onClick={() => void run((r) => adapter.redeem(p.marketId, r)).then((ok) => ok && showToast("Demo redemption completed"))}>{lost ? "No payout" : "Redeem"}</Btn>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between md:block md:text-right"><span className="text-xs text-mute md:hidden">{k}</span><span className="text-sm">{v}</span></div>;
}
