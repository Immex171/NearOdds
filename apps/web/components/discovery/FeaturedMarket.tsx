"use client";
import Link from "next/link";
import { useState } from "react";
import { useAdapterData, useApp } from "@/lib/app-context";
import { compact, movement, timeUntil, yesPct } from "@/lib/format";
import type { Market } from "@/lib/types";
import { Icon } from "../ui/Icon";
import { BookmarkButton, Skeleton, TopicIcon } from "../ui/bits";
import { ProbabilityChart } from "../trading/ProbabilityChart";

export function FeaturedMarket({ markets }: { markets: Market[] | null }) {
  const { adapter, now } = useApp();
  const [i, setI] = useState(0);
  const feats = markets ? markets.filter((m) => m.featured && m.status === "open") : [];
  const list = feats.length ? feats : markets?.slice(0, 1) ?? [];
  const m = list.length ? list[i % list.length] : null;
  const hist = useAdapterData((a) => (m ? a.getHistory(m.id) : Promise.resolve(null)), [m?.id]);
  if (!markets || !m) return <Skeleton className="h-[330px]" />;
  const mv = movement(m);
  const pct = yesPct(m);
  const go = (d: number) => setI((i + d + list.length) % list.length);
  return (
    <section aria-roledescription="carousel" aria-label="Featured markets" className="relative flex min-h-[330px] flex-col lg:min-h-[340px] rounded-[14px] border border-line bg-card p-4 md:p-5">
      <div className="flex items-center gap-3">
        <TopicIcon market={m} size={36} />
        <span className="text-xs font-medium text-mute">{m.category}{m.tag ? ` · ${m.tag}` : ""}</span>
        <span className="ml-auto flex items-center gap-1">
          {list.length > 1 && (
            <>
              <button aria-label="Previous featured market" onClick={() => go(-1)} className="grid h-9 w-9 place-items-center rounded-lg text-mute hover:bg-white/10 hover:text-fg"><Icon name="left" /></button>
              <button aria-label="Next featured market" onClick={() => go(1)} className="grid h-9 w-9 place-items-center rounded-lg text-mute hover:bg-white/10 hover:text-fg"><Icon name="right" /></button>
            </>
          )}
          <BookmarkButton id={m.id} />
        </span>
      </div>
      <h2 className="mt-2 line-clamp-2 shrink-0 text-[22px] font-semibold leading-tight md:text-[28px]">
        <Link href={`/markets/${m.id}`} className="hover:underline">{m.question}</Link>
      </h2>
      <p className="mt-1 line-clamp-1 shrink-0 text-[13px] text-mute">{m.description}</p>
      <div className="mt-3 grid min-h-0 flex-1 gap-4 md:grid-cols-[230px_1fr]">
        <div className="flex min-w-0 flex-col justify-between gap-3">
          <div>
            <p className="text-3xl font-semibold leading-none"><span className="text-yes">{pct == null ? "—" : `${pct}%`}</span> <span className="text-sm font-medium text-mute">YES</span></p>
            <p className="mt-1.5 text-sm text-mute">NO <span className="text-no">{pct == null ? "—" : `${100 - pct}%`}</span>{mv && <span className={`ml-2 text-xs font-medium ${mv.delta >= 0 ? "text-yes" : "text-no"}`}>{mv.label}</span>}</p>
          </div>
          <div className="flex gap-2">
            <Link href={`/markets/${m.id}?outcome=YES`} className="flex h-10 flex-1 items-center justify-center rounded-lg bg-yes-bg text-sm font-semibold text-yes hover:brightness-125">YES</Link>
            <Link href={`/markets/${m.id}?outcome=NO`} className="flex h-10 flex-1 items-center justify-center rounded-lg bg-no-bg text-sm font-semibold text-no hover:brightness-125">NO</Link>
          </div>
        </div>
        <div className="min-w-0 self-stretch md:self-end">
          <ProbabilityChart points={hist.data} loading={hist.loading} error={hist.error} compact height={170} />
        </div>
      </div>
      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-mute">
        <span>{compact(m.volume)} {adapter.symbol} volume</span>
        <span>{timeUntil(m.closesAt, now)}</span>
        <Link href={`/markets/${m.id}`} className="font-semibold text-brand hover:underline">Open market →</Link>
        {list.length > 1 && (
          <span className="ml-auto flex gap-1.5" role="tablist" aria-label="Choose featured market">
            {list.map((f, k) => (
              <button key={f.id} role="tab" aria-selected={k === i % list.length} aria-label={`Featured ${k + 1}: ${f.question}`} onClick={() => setI(k)}
                className="grid h-6 w-5 place-items-center"><span className={`h-1.5 rounded-full transition-all ${k === i % list.length ? "w-5 bg-brand" : "w-1.5 bg-line"}`} /></button>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}

export function TrendingSidebar({ markets }: { markets: Market[] | null }) {
  const top = markets ? [...markets].filter((m) => m.status === "open").sort((a, b) => b.trendScore - a.trendScore).slice(0, 4) : null;
  return (
    <aside className="flex flex-col gap-3">
      <section className="rounded-[14px] border border-line bg-card p-4">
        <h2 className="text-base font-semibold">Trending markets</h2>
        <ol className="mt-2 divide-y divide-line/60">
          {top ? top.map((m, i) => (
            <li key={m.id}>
              <Link href={`/markets/${m.id}`} className="flex items-start gap-3 py-2 hover:text-brand">
                <span className="w-4 pt-0.5 text-sm font-semibold text-mute">{i + 1}</span>
                <span className="truncate min-w-0 flex-1 text-[13px] font-medium leading-snug">{m.question}</span>
                <span className="text-sm font-semibold">{yesPct(m) == null ? "—" : `${yesPct(m)}%`}</span>
              </Link>
            </li>
          )) : Array.from({ length: 4 }, (_, i) => <li key={i} className="py-2"><Skeleton className="h-8" /></li>)}
        </ol>
      </section>
      <section className="rounded-[14px] border border-line bg-card p-4">
        <h2 className="text-sm font-semibold">How markets settle</h2>
        <p className="mt-1.5 text-[13px] text-mute">A named resolver publishes YES or NO after trading closes. Winning shares redeem for 1 token; losing shares for 0.</p>
      </section>
    </aside>
  );
}
