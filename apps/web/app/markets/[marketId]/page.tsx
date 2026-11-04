"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useAdapterData, useApp } from "@/lib/app-context";
import { dateTime, money, movement, priceStr, statusLabel, yesPct } from "@/lib/format";
import { bestPrice } from "@/lib/quote";
import { useMediaQuery } from "@/lib/hooks";
import type { Offer, Outcome, Side } from "@/lib/types";
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
  const { adapter, markets, marketsError, showToast, account, refresh } = useApp();
  const sp = useSearchParams();
  const initial: Outcome = sp.get("outcome") === "NO" ? "NO" : "YES";
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [sheet, setSheet] = useState(false);
  const [manage, setManage] = useState(false);
  const [pick, setPick] = useState<{ seq: number; outcome: Outcome; side: Side; offerId: string } | null>(null);
  const [bookOutcome, setBookOutcome] = useState<Outcome>(initial);
  const market = useAdapterData((a) => a.getMarket(id), [id]);
  const book = useAdapterData((a) => a.getBook(id), [id]);
  const hist = useAdapterData((a) => a.getHistory(id), [id]);
  const act = useAdapterData((a) => a.getActivity(id), [id]);

  if (marketsError || market.error) return <ErrorState message={marketsError ?? market.error ?? ""} onRetry={refresh} />;
  if (market.loading || !markets) return <div className="grid gap-6 lg:grid-cols-[1fr_360px]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>;
  const m = market.data;
  if (!m) return <EmptyState title="Market not found" body="This market doesn’t exist in the current data source." action={<Link href="/markets" className="font-semibold text-brand">Browse markets</Link>} />;

  const pct = yesPct(m);
  const mv = movement(m);
  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); showToast("Link copied"); } catch { showToast("Couldn’t copy. Copy the address bar instead."); }
  };
  const tone = m.status === "open" ? "yes" : m.status === "resolved" ? "brand" : "warn";
  const onPick = (o: Offer) => {
    setPick({ seq: (pick?.seq ?? 0) + 1, outcome: o.outcome, side: o.side === "sell" ? "buy" : "sell", offerId: o.id });
    setBookOutcome(o.outcome);
    if (!desktop) setSheet(true);
  };
  const ticket = <TradeTicket key={`${initial}-${pick?.seq ?? 0}`} m={m} book={book.data ?? []}
    init={pick ? { outcome: pick.outcome, side: pick.side, offerId: pick.offerId } : { outcome: initial }} />;
  const yesAsk = bestPrice(book.data ?? [], "YES", "buy");
  const yesBid = bestPrice(book.data ?? [], "YES", "sell");
  const holds = account?.positions.filter((p) => p.marketId === m.id) ?? [];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-4">
        <nav aria-label="Breadcrumb" className="text-xs text-mute">
          <Link href="/markets" className="hover:text-fg">Markets</Link> / <Link href={`/markets?category=${m.category}`} className="hover:text-fg">{m.category}</Link>
        </nav>
        <header className="flex items-start gap-3">
          <TopicIcon market={m} size={48} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold leading-tight md:text-[28px]">{m.question}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-mute">
              <Badge tone={tone}>{statusLabel[m.status]}</Badge>
              <span>{m.status === "open" ? "Closes" : "Closed"} {dateTime(m.closesAt)}</span>
              <span>Volume <b className="text-fg">{money(m.volume, adapter.symbol, 0)}</b></span>
            </div>
          </div>
          <div className="flex shrink-0">
            <BookmarkButton id={m.id} />
            <button onClick={copy} aria-label="Copy link" className="grid h-9 w-9 place-items-center rounded-lg text-mute hover:bg-elev hover:text-fg"><Icon name="link" /></button>
          </div>
        </header>

        <section className="rounded-[14px] border border-line bg-card p-4">
          <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <p className="text-xs text-mute">
                <Tooltip text="Headline probability = price of the most recent YES trade (a NO trade is shown as its YES-equivalent). It is a display value, not an executable price and not what the ticket uses.">Chance of YES ⓘ</Tooltip>
              </p>
              <p className="text-3xl font-semibold text-yes">{pct == null ? "—" : `${pct}%`}</p>
            </div>
            {mv ? <p className={`pb-1 text-sm font-medium ${mv.delta >= 0 ? "text-yes" : "text-no"}`}>{mv.label}</p> : <p className="pb-1 text-sm text-mute">{pct == null ? "No trades yet" : "Price movement unavailable"}</p>}
            <dl className="ml-auto grid grid-cols-3 gap-x-5 text-right text-xs">
              <div><dt className="text-mute">Last YES trade</dt><dd className="text-sm font-semibold">{priceStr(m.lastYes)}</dd></div>
              <div><dt className="text-mute">Best YES ask</dt><dd className="text-sm font-semibold text-no">{priceStr(yesAsk)}</dd></div>
              <div><dt className="text-mute">Best YES bid</dt><dd className="text-sm font-semibold text-yes">{priceStr(yesBid)}</dd></div>
            </dl>
          </div>
          <p className="mb-1 text-xs text-mute">Implied probability of YES, % (last-trade based). {adapter.id === "demo" ? "Demo data: simulated history." : "Live history needs a price indexer, which doesn’t exist yet."}</p>
          <ProbabilityChart points={hist.data} loading={hist.loading} error={hist.error} demo={adapter.id === "demo"} height={desktop ? 300 : 220} />
        </section>

        {holds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-card px-4 py-3 text-sm">
            <span className="text-mute">Your shares:</span>
            {holds.map((p) => <Badge key={p.outcome} tone={p.outcome === "YES" ? "yes" : "no"}>{p.outcome} {Number(p.qty) / 1e6}</Badge>)}
          </div>
        )}

        <OffersPanel book={book.data} market={m} account={account?.accountId ?? null} loading={book.loading} tradable={m.status === "open"}
          onPick={onPick} selectedId={pick?.offerId ?? null} outcome={bookOutcome} setOutcome={setBookOutcome} />
        <ResolutionRules m={m} />
        <ActivityList items={act.data} loading={act.loading} />
        <Btn variant="outline" onClick={() => setManage(true)} className="w-full sm:w-auto">Manage shares</Btn>
      </div>

      {desktop && <aside><div className="sticky top-[150px] space-y-3">{ticket}</div></aside>}
      {!desktop && (
        <>
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-page/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <Btn className="min-h-12 w-full text-base" onClick={() => setSheet(true)}>Trade</Btn>
          </div>
          <Modal open={sheet} onClose={() => setSheet(false)} title="Trade" variant="sheet">{ticket}</Modal>
        </>
      )}
      <ManageShares m={m} open={manage} onClose={() => setManage(false)} />
    </div>
  );
}

export default function MarketPage({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = use(params);
  return <Suspense><Detail id={decodeURIComponent(marketId)} /></Suspense>;
}
