"use client";
import { useMemo, useState } from "react";
import { useApp } from "@/lib/app-context";
import { SORTS, applyFilters, hasActive, sortMarkets, type Filters, type SortKey } from "@/lib/filters";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { Btn, EmptyState, ErrorState } from "../ui/bits";
import { FilterRail } from "./FilterRail";
import { MarketGrid } from "./MarketGrid";

const CHIP = "inline-flex min-h-8 items-center rounded-full border px-3 text-[13px] font-medium whitespace-nowrap";

/** Heading, chips, sort, filter drawer, grid. `rail` shows the sticky left filter rail on desktop. */
export function Browser({ f, setF, rail, title }: { f: Filters; setF: (f: Filters) => void; rail: boolean; title: string }) {
  const { markets, marketsError, now, bookmarks, refresh } = useApp();
  const [drawer, setDrawer] = useState(false);
  const shown = useMemo(() => (markets ? sortMarkets(applyFilters(markets, f, now, bookmarks), f.sort, now) : null), [markets, f, now, bookmarks]);
  const clear = () => setF({ ...f, status: [], period: [], tags: [], saved: false, q: "" });
  const chips: { label: string; on: () => void }[] = [
    ...f.status.map((s) => ({ label: `Status: ${s}`, on: () => setF({ ...f, status: f.status.filter((x) => x !== s) }) })),
    ...f.period.map((s) => ({ label: `Closes: ${s}`, on: () => setF({ ...f, period: f.period.filter((x) => x !== s) }) })),
    ...f.tags.map((s) => ({ label: s, on: () => setF({ ...f, tags: f.tags.filter((x) => x !== s) }) })),
    ...(f.saved ? [{ label: "Saved", on: () => setF({ ...f, saved: false }) }] : []),
    ...(f.q ? [{ label: `“${f.q}”`, on: () => setF({ ...f, q: "" }) }] : []),
  ];
  const railEl = markets && <FilterRail f={f} onChange={setF} markets={markets} now={now} bookmarks={bookmarks} />;
  return (
    <div className={rail ? "lg:grid lg:grid-cols-[212px_1fr] lg:gap-6" : ""}>
      {rail && <aside className="hidden lg:block"><div className="sticky top-[150px]">{railEl}</div></aside>}
      <section aria-label={title}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold md:text-[26px]">{title}</h2>
          <span className="text-sm text-mute" aria-live="polite">{shown ? `${shown.length} market${shown.length === 1 ? "" : "s"}` : ""}</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor="sort">Sort markets</label>
            <select id="sort" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value as SortKey })}
              className="min-h-10 rounded-lg border border-line bg-card px-3 text-sm">
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <button onClick={() => setF({ ...f, saved: !f.saved })} aria-pressed={f.saved}
              className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${f.saved ? "border-brand text-fg" : "border-line text-mute hover:text-fg"}`}>
              <Icon name={f.saved ? "bookmarkFill" : "bookmark"} size={16} /> Saved
            </button>
            <button onClick={() => setDrawer(true)} className={`inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-sm font-medium text-mute hover:text-fg ${rail ? "lg:hidden" : ""}`}>
              <Icon name="filter" size={16} /> Filters
            </button>
          </div>
        </div>
        {(chips.length > 0 || !rail) && (
          <div className="no-scrollbar mt-3 flex items-center gap-2 overflow-x-auto" role="group" aria-label="Active filters">
            {!rail && ["All", "Crypto", "Sports", "Politics", "Economy", "Technology"].map((c) => {
              const on = (c === "All" && !f.category) || f.category === c;
              return <button key={c} aria-pressed={on} onClick={() => setF({ ...f, category: c === "All" ? null : (c as Filters["category"]) })}
                className={`${CHIP} ${on ? "border-fg bg-fg text-page" : "border-line text-mute hover:text-fg"}`}>{c}</button>;
            })}
            {chips.map((c) => <button key={c.label} onClick={c.on} className={`${CHIP} border-brand/50 bg-brand/15 text-[#c5ccff]`}>{c.label} <span aria-hidden className="ml-1.5">×</span><span className="sr-only">remove</span></button>)}
            {hasActive(f) && <button onClick={clear} className={`${CHIP} border-transparent text-brand`}>Clear filters</button>}
          </div>
        )}
        <div className="mt-4">
          {marketsError ? <ErrorState message={marketsError} onRetry={refresh} />
            : shown && shown.length === 0 ? (
              <EmptyState title="No markets match these filters"
                body={f.saved && bookmarks.length === 0 ? "You haven't saved any markets yet. Use the bookmark icon on a card to save one." : "Try removing a filter or searching for something else."}
                action={<Btn variant="outline" onClick={clear}>Clear filters</Btn>} />
            ) : <MarketGrid markets={shown} cols={rail ? "category" : "home"} />}
        </div>
      </section>
      <Modal open={drawer} onClose={() => setDrawer(false)} title="Filters" variant="drawer">
        {railEl}
        <Btn className="mt-4 w-full" onClick={() => setDrawer(false)}>Show {shown?.length ?? 0} markets</Btn>
      </Modal>
    </div>
  );
}
