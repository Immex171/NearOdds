"use client";
import Link from "next/link";
import { useApp } from "@/lib/app-context";
import { compact, timeUntil } from "@/lib/format";
import type { Market } from "@/lib/types";
import { BookmarkButton, Gauge, TopicIcon } from "../ui/bits";

export function MarketCard({ m }: { m: Market }) {
  const { adapter, now } = useApp();
  const open = m.status === "open";
  const cta = "relative z-10 flex h-10 flex-1 items-center justify-center rounded-lg text-sm font-semibold transition-colors";
  return (
    <article className="group relative flex min-h-[200px] flex-col rounded-[14px] border border-line bg-card p-3.5 transition-colors hover:border-[#4a525d] hover:bg-white/5">
      <div className="flex items-start gap-3">
        <TopicIcon market={m} size={40} />
        <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">
          <Link href={`/markets/${m.id}`} className="line-clamp-3 hover:underline after:absolute after:inset-0 after:rounded-[14px] after:content-['']">{m.question}</Link>
        </h3>
        <Gauge price={m.lastYes} />
      </div>
      <div className="mt-auto pt-3">
        {open ? (
          <div className="flex gap-2">
            <Link href={`/markets/${m.id}?outcome=YES`} aria-label={`Trade YES: ${m.question}`} className={`${cta} bg-yes-bg text-yes hover:brightness-125`}>YES</Link>
            <Link href={`/markets/${m.id}?outcome=NO`} aria-label={`Trade NO: ${m.question}`} className={`${cta} bg-no-bg text-no hover:brightness-125`}>NO</Link>
          </div>
        ) : (
          <div className="flex h-10 items-center justify-center rounded-lg bg-elev text-sm font-medium text-mute">
            {m.status === "resolved" ? `Resolved ${m.resolution.outcome}` : m.status === "awaiting" ? "Awaiting resolution" : "Closed"}
          </div>
        )}
        <div className="mt-2.5 flex items-center justify-between text-xs text-mute">
          <span className="min-w-0 truncate">
            {m.volume > 0n ? `${compact(m.volume)} ${adapter.symbol} vol` : "No volume"} · {timeUntil(m.closesAt, now)}
          </span>
          <BookmarkButton id={m.id} className="relative z-10 -mb-1.5 -mr-2 h-8 w-8" />
        </div>
      </div>
    </article>
  );
}

export function CardSkeleton() { return <div aria-hidden className="skeleton h-[200px]" style={{ borderRadius: 14 }} />; }
