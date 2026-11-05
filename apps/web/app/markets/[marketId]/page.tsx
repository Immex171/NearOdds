"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useAdapterData, useApp, useMarketAccount } from "@/lib/app-context";
import { DataNotice } from "@/components/shell/DataNotice";
import { basisLabel, cutoffLabel, dateTimeUtc, money, priceStr, statusLabel, yesPct } from "@/lib/format";
import { positionsOf } from "@/lib/account";
import { bestPrice } from "@/lib/quote";
import { resolveOffer, type TicketValue } from "@/lib/trading";
import { useMediaQuery } from "@/lib/hooks";
import type { Market, Offer, Outcome } from "@/lib/types";
import { ActivityList } from "@/components/trading/ActivityList";
import { ManageShares } from "@/components/trading/ManageShares";
import { OffersPanel } from "@/components/trading/OffersPanel";
import { ProbabilityChart } from "@/components/trading/ProbabilityChart";
import { ResolutionRules } from "@/components/trading/ResolutionRules";
import { TradeTicket } from "@/components/trading/TradeTicket";
import { BookmarkButton, Badge, Btn, EmptyState, ErrorState, Skeleton, Tooltip, TopicIcon } from "@/components/ui/bits";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";

function Detail({ id }: { id: string }) {
  const { adapter, markets, marketsError, showToast, accountId, refresh, now, setActiveMarket } = useApp();
  const sp = useSearchParams();
  const initial: Outcome = sp.get("outcome") === "NO" ? "NO" : "YES";
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [sheet, setSheet] = useState(false);
  const [manage, setManage] = useState(false);
  const [ticket, setTicket] = useState<TicketValue>({ outcome: initial, side: "buy", mode: "take", offerId: null });
  const market = useAdapterData((a) => a.getMarket(id), [id]);
  const book = useAdapterData((a) => a.getBook(id), [id]);
  const hist = useAdapterData((a) => a.getHistory(id), [id]);
  const act = useAdapterData((a) => a.getActivity(id), [id]);
  const mvm = useAdapterData((a) => (market.data ? a.getMovement(market.data, now) : Promise.resolve(null)), [market.data?.id, market.data?.lastYes?.toString()]);
  // Route stream events (book/trade) for the market that is on screen.
  useEffect(() => { setActiveMarket(id); return () => setActiveMarket(null); }, [id, setActiveMarket]);

  if (marketsError || market.error) return <ErrorState message={marketsError ?? market.error ?? ""} onRetry={refresh} />;
  if (market.loading || !markets) return <div className="grid gap-6 lg:grid-cols-[1fr_360px]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>;
  const m = market.data;
  if (!m) return <EmptyState title="Market not found" body="This market doesn’t exist in the current data source." action={<Link href="/markets" className="font-semibold text-brand">Browse markets</Link>} />;

  const live = adapter.id === "near";
  const pct = yesPct(m);
  const mv = mvm.data;
  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); showToast("Link copied"); } catch { showToast("Couldn’t copy. Copy the address bar instead."); }
  };
  const tone = m.status === "open" ? "yes" : m.status === "resolved" ? "brand" : "warn";
  const patch = (p: Partial<TicketValue>) => setTicket((t) => ({ ...t, ...p }));
  const onPick = (o: Offer) => {
    patch({ outcome: o.outcome, side: o.side === "sell" ? "buy" : "sell", mode: "take", offerId: o.id });
    if (!desktop) setSheet(true);
  };
  const selected = resolveOffer(book.data ?? [], ticket, accountId).offer;
  const ticketEl = <TradeTicket m={m} book={book.data ?? []} value={ticket} onChange={patch} onManage={() => setManage(true)} />;
  // The last CONFIRMED YES trade. Live: from fills only; a midpoint is never shown as a trade.
  const lastTrade = m.quotes ? m.quotes.YES.lastTrade : m.lastYes;
  const yesAsk = bestPrice(book.data ?? [], "YES", "buy");
  const yesBid = bestPrice(book.data ?? [], "YES", "sell");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-4">
        <DataNotice market={m} />
        <nav aria-label="Breadcrumb" className="text-xs text-mute">
          <Link href="/markets" className="hover:text-fg">Markets</Link>{m.category && <> / <Link href={`/markets?category=${m.category}`} className="hover:text-fg">{m.category}</Link></>}
        </nav>
        <header className="flex items-start gap-3">
          <TopicIcon market={m} size={48} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold leading-tight md:text-[28px]">{m.question}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-mute">
              <Badge tone={tone}>{statusLabel[m.status]}</Badge>
              <span>Trading {m.status === "open" ? "closes" : "closed"} {live ? cutoffLabel(m.closesAt) : dateTimeUtc(m.closesAt)}</span>
              <span>Volume <b className="text-fg" data-testid="volume">{m.volume == null ? "unavailable" : `${m.volumePartial && m.volume > 0n ? "at least " : ""}${money(m.volume, m.token.symbol, m.volume > 0n && m.volume < 1_000_000n ? 6 : 0)}`}</b>{m.volumePartial && <span className="ml-1 text-xs" title={m.coverage?.note}>(partial history)</span>}</span>
            </div>
          </div>
          <div className="flex shrink-0">
            <BookmarkButton id={m.id} />
            <button onClick={copy} aria-label="Copy link" className="grid h-9 w-9 place-items-center rounded-lg text-mute hover:bg-white/10 hover:text-fg"><Icon name="link" /></button>
          </div>
        </header>

        <section className="rounded-[14px] border border-line bg-card p-4">
          <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <p className="text-xs text-mute">
                <Tooltip text={live ? `Display value for YES: ${basisLabel(m.yesBasis)}. The backend uses the midpoint of the best bid and ask when both exist and the spread is at most 0.10, otherwise the last confirmed YES trade. It is not executable and the ticket never uses it.` : "Headline probability = price of the most recent YES trade (a NO trade is shown as its YES-equivalent). It is a display value, not an executable price, and the ticket never uses it."}>Chance of YES ⓘ</Tooltip>
              </p>
              <p className="text-3xl font-semibold text-yes" data-testid="headline-price">{pct == null ? "—" : `${pct}%`}</p>
              {live && <p className="text-[11px] text-mute" data-testid="price-basis">{basisLabel(m.yesBasis)}</p>}
            </div>
            {mv ? <p className={`pb-1 text-sm font-medium ${mv.delta >= 0 ? "text-yes" : "text-no"}`} data-testid="movement">{mv.label}</p> : <p className="pb-1 text-sm text-mute" data-testid="movement-unavailable">{pct == null ? (live ? "No price yet" : "No trades yet") : "24h movement unavailable"}</p>}
            <dl className="ml-auto grid grid-cols-3 gap-x-5 text-right text-xs">
              <div><dt className="text-mute">Last YES trade</dt><dd className="text-sm font-semibold" data-testid="last-yes-trade">{(lastTrade) == null ? "none" : `${priceStr(lastTrade)} ${m.token.symbol}`}</dd></div>
              <div><dt className="text-mute">Best YES ask</dt><dd className="text-sm font-semibold text-no">{priceStr(yesAsk)} {m.token.symbol}</dd></div>
              <div><dt className="text-mute">Best YES bid</dt><dd className="text-sm font-semibold text-yes">{priceStr(yesBid)} {m.token.symbol}</dd></div>
            </dl>
          </div>
          <ProbabilityChart points={hist.data} loading={hist.loading} error={hist.error} demo={adapter.id === "demo"} height={desktop ? 300 : 220}
            partial={live && m.coverage && !m.coverage.historyComplete ? m.coverage.note : undefined}
            unavailable={live ? "No confirmed trades have been indexed for this market yet. Current prices come from the order book below." : undefined} />
        </section>

        <Holds m={m} />

        <OffersPanel book={book.data} market={m} account={accountId} loading={book.loading} tradable={m.status === "open"}
          onPick={onPick} selectedId={ticket.mode === "take" ? selected?.id ?? null : null} outcome={ticket.outcome} setOutcome={(o) => patch({ outcome: o, offerId: null })} />
        <ResolutionRules m={m} />
        <ActivityList items={act.data} loading={act.loading} error={act.error} unavailable={live ? "No indexed activity for this market yet." : undefined} />
        <Btn variant="outline" onClick={() => setManage(true)} className="w-full sm:w-auto">Manage shares</Btn>
      </div>

      {desktop && (
        <aside className="self-stretch">
          {/* Sticks below the full header (banner + both rows, measured into --header-h), bounded by the viewport (16px above, 32px for the page bottom padding) so the ticket scrolls internally and never rides under the header. */}
          <div className="sticky flex flex-col" style={{ top: "calc(var(--header-h, 140px) + 16px)", maxHeight: "calc(100dvh - var(--header-h, 140px) - 48px)" }}>{ticketEl}</div>
        </aside>
      )}
      {!desktop && (
        <>
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-page/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <Btn className="min-h-12 w-full text-base" onClick={() => setSheet(true)}>Trade</Btn>
          </div>
          <Modal open={sheet} onClose={() => setSheet(false)} title="Trade" variant="sheet">{ticketEl}</Modal>
        </>
      )}
      <ManageShares m={m} open={manage} onClose={() => setManage(false)} />
    </div>
  );
}

function Holds({ m }: { m: Market }) {
  const { account } = useMarketAccount(m);
  const holds = positionsOf(account, m);
  if (!holds.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-card px-4 py-3 text-sm">
      <span className="text-mute">Your shares in this market:</span>
      {holds.map((p) => <Badge key={p.outcome} tone={p.outcome === "YES" ? "yes" : "no"}>{p.outcome} {Number(p.qty) / 1e6}</Badge>)}
    </div>
  );
}

export default function MarketPage({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = use(params);
  return <Suspense><Detail id={decodeURIComponent(marketId)} /></Suspense>;
}
