"use client";
import { useState } from "react";
import { formatUnits } from "@/lib/amounts";
import { priceStr } from "@/lib/format";
import type { Offer, Outcome } from "@/lib/types";
import { EmptyState } from "../ui/bits";

export function OffersPanel({ book, account, loading }: { book: Offer[] | null; account: string | null; loading?: boolean }) {
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const sel = (book ?? []).filter((o) => o.outcome === outcome);
  const bids = sel.filter((o) => o.side === "buy").sort((a, b) => Number(b.price - a.price));
  const asks = sel.filter((o) => o.side === "sell").sort((a, b) => Number(a.price - b.price));
  const col = (title: string, rows: Offer[], tone: string) => (
    <div className="min-w-0">
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 border-b border-line px-1 pb-1.5 text-xs text-mute"><span>{title}</span><span className="text-right">Price</span><span className="w-16 text-right">Shares</span></div>
      {rows.length === 0 && <p className="px-1 py-4 text-sm text-mute">No {title.toLowerCase()}</p>}
      {rows.slice(0, 8).map((o, i) => (
        <div key={o.id} className={`grid grid-cols-[1fr_1fr_auto] gap-2 rounded px-1 py-1 text-sm ${i === 0 ? "bg-elev/60" : ""}`}>
          <span className="truncate text-xs text-mute">{o.owner === account ? "Your offer" : o.owner}</span>
          <span className={`text-right font-medium ${tone}`}>{priceStr(o.price)}</span>
          <span className="w-16 text-right">{formatUnits(o.qty, 0, 2)}</span>
        </div>
      ))}
    </div>
  );
  return (
    <section aria-label="Offers" className="rounded-[14px] border border-line bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Offers</h2>
        <div role="tablist" aria-label="Order book outcome" className="flex rounded-lg bg-elev p-0.5">
          {(["YES", "NO"] as const).map((o) => (
            <button key={o} role="tab" aria-selected={outcome === o} onClick={() => setOutcome(o)}
              className={`min-h-8 rounded-md px-3 text-xs font-semibold ${outcome === o ? (o === "YES" ? "bg-yes-bg text-yes" : "bg-no-bg text-no") : "text-mute"}`}>{o}</button>
          ))}
        </div>
      </div>
      {loading ? <div className="skeleton h-32" /> : sel.length === 0 ? (
        <EmptyState title="No offers yet" body="Nobody is offering this outcome. You can place a limit offer to start the book." />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">{col("Bids (buy)", bids, "text-yes")}{col("Asks (sell)", asks, "text-no")}</div>
      )}
      <p className="mt-3 text-xs text-mute">YES and NO have separate books. A NO price is never calculated from a YES price.</p>
    </section>
  );
}
