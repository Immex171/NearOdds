"use client";
import { useState } from "react";
import { formatUnits, mulPrice } from "@/lib/amounts";
import { priceStr } from "@/lib/format";
import type { Market, Offer, Outcome } from "@/lib/types";
import { EmptyState, Tooltip } from "../ui/bits";

const SHOW = 7;

interface Row { o: Offer; cumQty: bigint; cumCost: bigint }

/** Cumulative from the best quote outward; each side is computed on its own. */
function build(offers: Offer[], bestFirst: boolean): Row[] {
  const sorted = [...offers].sort((a, b) => (bestFirst ? Number(a.price - b.price) : Number(b.price - a.price)));
  let q = 0n, c = 0n;
  return sorted.map((o) => { q += o.qty; c += mulPrice(o.price, o.qty); return { o, cumQty: q, cumCost: c }; });
}

export function OffersPanel({ book, market, account, loading, onPick, selectedId, outcome, setOutcome, tradable }: {
  book: Offer[] | null; market: Market; account: string | null; loading?: boolean; tradable: boolean;
  onPick: (o: Offer) => void; selectedId: string | null; outcome: Outcome; setOutcome: (o: Outcome) => void;
}) {
  const sym = market.token.symbol;
  const [all, setAll] = useState(false);
  const sel = (book ?? []).filter((o) => o.outcome === outcome && o.fillable !== false);
  const asks = build(sel.filter((o) => o.side === "sell"), true); // best (lowest) first
  const bids = build(sel.filter((o) => o.side === "buy"), false); // best (highest) first
  const askShown = (all ? asks : asks.slice(0, SHOW)).reverse(); // best ask nearest the separator (bottom of red block)
  const bidShown = all ? bids : bids.slice(0, SHOW);
  const maxQ = [asks, bids].map((r) => (r.length ? r[Math.min(r.length, all ? r.length : SHOW) - 1].cumQty : 0n)).reduce((a, b) => (a > b ? a : b), 1n);
  // Last CONFIRMED trade of this outcome. Live: from fills only (a midpoint is never shown here). Demo: its last YES trade.
  const last = market.quotes ? market.quotes[outcome].lastTrade : outcome === "YES" ? market.lastYes : null;
  const spread = asks[0] && bids[0] ? asks[0].o.price - bids[0].o.price : null;

  const row = (r: Row, tone: "ask" | "bid") => {
    const own = r.o.owner === account;
    const sel = r.o.id === selectedId;
    const w = Number((r.cumQty * 100n) / maxQ);
    const disabled = own || !tradable;
    return (
      <button key={r.o.id} type="button" disabled={disabled} onClick={() => onPick(r.o)} data-offer-id={r.o.id} data-own={own || undefined} aria-pressed={sel}
        title={own ? `Your offer #${r.o.offerId}: cancel it from your portfolio` : `Offer #${r.o.offerId} by ${r.o.owner}`}
        aria-label={`${tone === "ask" ? "Buy" : "Sell"} ${outcome} offer at ${priceStr(r.o.price)}, ${formatUnits(r.o.qty, 0, 4)} shares${own ? ", your offer" : ""}`}
        className={`relative grid w-full grid-cols-3 gap-2 overflow-hidden px-2 py-1.5 text-left text-[13px] ${disabled ? "cursor-not-allowed" : "hover:bg-white/10"} ${sel ? "ring-1 ring-inset ring-brand" : ""} ${own ? "outline outline-1 -outline-offset-1 outline-brand/50" : ""}`}>
        <span aria-hidden className={`absolute inset-y-0 right-0 ${tone === "ask" ? "bg-no/10" : "bg-yes/10"}`} style={{ width: `${w}%` }} />
        <span className={`relative font-semibold ${tone === "ask" ? "text-no" : "text-yes"}`}>{priceStr(r.o.price)}{own && <span className="ml-1.5 rounded bg-brand/25 px-1 text-[10px] font-semibold text-[#c5ccff]">YOU</span>}{sel && <span className="ml-1.5 rounded bg-brand px-1 text-[10px] font-semibold text-white">SELECTED</span>}</span>
        <span className="relative text-right">{formatUnits(r.o.qty, 0, 4)}</span>
        <span className="relative text-right text-mute">{formatUnits(r.cumCost, 2, 2)}</span>
      </button>
    );
  };

  return (
    <section aria-label="Order book" className="rounded-[14px] border border-line bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Order book</h2>
        <div role="tablist" aria-label="Order book outcome" className="flex rounded-lg bg-elev p-0.5">
          {(["YES", "NO"] as const).map((o) => (
            <button key={o} role="tab" aria-selected={outcome === o} onClick={() => setOutcome(o)}
              className={`min-h-8 rounded-md px-3 text-xs font-semibold ${outcome === o ? (o === "YES" ? "bg-yes-bg text-yes" : "bg-no-bg text-no") : "text-mute"}`}>{o}</button>
          ))}
        </div>
      </div>
      {loading ? <div className="skeleton h-48" /> : sel.length === 0 ? (
        <EmptyState title={`No ${outcome} offers`} body={tradable ? "Nobody is offering this outcome right now. Place a limit offer to start its book." : "Trading is closed for this market."} />
      ) : (
        <div>
          <div className="grid grid-cols-3 gap-2 border-b border-line px-2 pb-1.5 text-xs text-mute">
            <span>Price ({sym}/share)</span><span className="text-right">Shares</span>
            <span className="text-right"><Tooltip text="Cumulative value = collateral needed from the best price outward, for this side only. Asks and bids are calculated independently. Example: 55 × 0.42 = 23.10, then + 95 × 0.43 = 63.95.">Cumulative value ({sym}) ⓘ</Tooltip></span>
          </div>
          <div aria-label={`${outcome} sell offers (asks)`}>
            <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-no">Asks · sell offers</p>
            {askShown.length ? askShown.map((r) => row(r, "ask")) : <p className="px-2 py-3 text-sm text-mute">No sell offers</p>}
          </div>
          <div className="my-1 flex items-center justify-between border-y border-line bg-elev/50 px-2 py-1.5 text-xs text-mute">
            <span>Spread <b className="text-fg">{spread == null ? "—" : `${priceStr(spread)} ${sym}`}</b></span>
            <span data-testid="last-trade">Last {outcome} trade <b className="text-fg">{last == null ? "none recorded" : `${priceStr(last)} ${sym}`}</b></span>
          </div>
          <div aria-label={`${outcome} buy offers (bids)`}>
            <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-yes">Bids · buy offers</p>
            {bidShown.length ? bidShown.map((r) => row(r, "bid")) : <p className="px-2 py-3 text-sm text-mute">No buy offers</p>}
          </div>
          {(asks.length > SHOW || bids.length > SHOW) && (
            <button onClick={() => setAll(!all)} className="mt-2 text-xs font-semibold text-brand hover:underline">{all ? "Show fewer offers" : `Show all ${asks.length + bids.length} offers`}</button>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-mute">Select an offer to set up your trade.</p>
    </section>
  );
}
