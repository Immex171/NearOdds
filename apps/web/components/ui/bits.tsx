"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";
import { useApp } from "@/lib/app-context";
import { percent } from "@/lib/amounts";
import type { Market } from "@/lib/types";

const catColor: Record<string, string> = {
  Crypto: "from-[#5265ff] to-[#2a3699]", Sports: "from-[#e8913a] to-[#8a4a12]", Politics: "from-[#8a5cf0] to-[#4a2c96]",
  Economy: "from-[#2fb4a6] to-[#145f57]", Technology: "from-[#d9568f] to-[#7d2551]", _: "from-[#3a4150] to-[#1f242d]",
};

export function TopicIcon({ market, size = 40 }: { market: Pick<Market, "icon" | "category">; size?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size, fontSize: size * 0.42 }}
      className={`grid shrink-0 place-items-center rounded-xl bg-gradient-to-br font-semibold text-white ${catColor[market.category ? market.category : "_"]}`}>
      {market.icon || market.category?.[0] || "?"}
    </span>
  );
}

export function BookmarkButton({ id, className = "" }: { id: string; className?: string }) {
  const { bookmarks, toggleBookmark } = useApp();
  const on = bookmarks.includes(id);
  return (
    <button type="button" aria-pressed={on} aria-label={on ? "Remove bookmark" : "Bookmark market"}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleBookmark(id); }}
      className={`grid h-9 w-9 place-items-center rounded-lg text-mute hover:bg-white/10 hover:text-fg ${on ? "text-brand" : ""} ${className}`}>
      <Icon name={on ? "bookmarkFill" : "bookmark"} />
    </button>
  );
}

/** Semicircular probability gauge. */
export function Gauge({ price }: { price: bigint | null }) {
  const pct = price == null ? null : percent(price);
  const r = 22, c = Math.PI * r;
  return (
    <div className="relative h-[34px] w-[52px] shrink-0 text-center" aria-label={pct == null ? "No price yet" : `${pct}% chance YES`} role="img">
      <svg width="52" height="30" viewBox="0 0 52 30" aria-hidden>
        <path d="M4 28a22 22 0 0 1 44 0" fill="none" stroke="#2a3039" strokeWidth="4" strokeLinecap="round" />
        {pct != null && <path d="M4 28a22 22 0 0 1 44 0" fill="none" stroke="#35d07f" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} />}
      </svg>
      <span className="absolute inset-x-0 bottom-0 text-[13px] font-semibold leading-none">{pct == null ? "—" : `${pct}%`}</span>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) { return <div aria-hidden className={`skeleton ${className}`} />; }

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "yes" | "no" | "brand" | "warn" }) {
  const t = { neutral: "bg-elev text-mute", yes: "bg-yes-bg text-yes", no: "bg-no-bg text-no", brand: "bg-brand/20 text-[#aab4ff]", warn: "bg-[#3a2f12] text-[#f0c35a]" }[tone];
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

export function Btn({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" | "danger" }) {
  const v = {
    primary: "bg-brand text-white hover:bg-[#6677ff] disabled:bg-elev disabled:text-mute",
    ghost: "text-mute hover:bg-white/10 hover:text-fg",
    outline: "border border-line text-fg hover:bg-white/10 disabled:text-mute",
    danger: "border border-no/40 text-no hover:bg-no-bg",
  }[variant];
  return <button {...p} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors ${v} ${className}`} />;
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-dashed border-line px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-md text-mute">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-[14px] border border-no/40 bg-no-bg/40 px-5 py-4">
      <p className="font-semibold text-no">Something went wrong</p>
      <p className="mt-1 text-mute">{message}</p>
      {onRetry && <Btn variant="outline" className="mt-3" onClick={onRetry}>Try again</Btn>}
    </div>
  );
}

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return <span title={text} className="inline-flex cursor-help items-center gap-1" tabIndex={0} aria-label={text}>{children}</span>;
}
