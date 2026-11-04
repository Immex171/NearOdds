"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryPoint } from "@/lib/types";


const RANGES = [
  { key: "1H", ms: 3_600_000 }, { key: "24H", ms: 86_400_000 }, { key: "1W", ms: 7 * 86_400_000 }, { key: "All", ms: Infinity },
] as const;

const fmtTime = (t: number, long: boolean) =>
  new Intl.DateTimeFormat("en-US", long ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }).format(t);

export function ProbabilityChart({ points, loading, error, compact = false, height = 260, demo = false, showRanges = true }: {
  points: HistoryPoint[] | null; loading?: boolean; error?: string | null; compact?: boolean; height?: number; demo?: boolean; showRanges?: boolean;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>(compact ? "All" : "All");
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, points]);

  const data = useMemo(() => {
    if (!points?.length) return [];
    const end = points[points.length - 1].t;
    const ms = RANGES.find((r) => r.key === range)!.ms;
    const f = points.filter((p) => p.t >= end - ms);
    return f.length > 1 ? f : points.slice(-2);
  }, [points, range]);

  if (loading) return <div aria-hidden className="skeleton w-full" style={{ height }} />;
  if (error) return <div role="alert" style={{ height }} className="grid place-items-center rounded-xl border border-line text-center text-mute"><p>Price history is unavailable.<br /><span className="text-xs">{error}</span></p></div>;
  if (!points || points.length < 2) {
    return <div style={{ height }} className="grid place-items-center rounded-xl border border-dashed border-line px-4 text-center text-mute"><p>No price history yet.<br /><span className="text-xs">A chart appears after the first trades.</span></p></div>;
  }

  const padL = 4, padR = compact ? 36 : 44, padT = 8, padB = compact ? 8 : 22;
  const w = width, h = height;
  const t0 = data[0].t, t1 = data[data.length - 1].t;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const y = (p: number) => padT + (1 - p) * (h - padT - padB);
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)} ${y(d.p).toFixed(1)}`).join(" ");
  const last = data[data.length - 1];
  const hp = hover != null ? data[hover] : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - padL) / (w - padL - padR)) * (t1 - t0);
    let lo = 0, hi = data.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (data[m].t < t) lo = m + 1; else hi = m; }
    setHover(lo);
  };
  const ticks = compact ? [] : [0, 0.25, 0.5, 0.75, 1];
  const xl = compact ? [] : [0, 0.5, 1].map((f) => t0 + (t1 - t0) * f);
  return (
    <div ref={wrap} className="w-full min-w-0 overflow-hidden">
      <div className="relative">
        <svg width={w} height={h} role="img" aria-label={`Probability history, latest ${Math.round(last.p * 100)}% YES`}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block max-w-full touch-pan-y select-none">
          {(compact ? [0.5] : ticks).map((v) => (
            <g key={v}>
              <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="#2a3039" strokeDasharray={v === 0 || v === 1 ? undefined : "3 4"} strokeWidth="1" />
              <text x={w - padR + 6} y={y(v) + 4} fontSize="11" fill="#9ba4ae">{Math.round(v * 100)}%</text>
            </g>
          ))}
          {xl.map((t, i) => <text key={t} x={i === 0 ? padL : i === 2 ? w - padR : x(t)} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} y={h - 4} fontSize="11" fill="#9ba4ae">{fmtTime(t, range === "1H" || range === "24H")}</text>)}
          <path d={path} fill="none" stroke="#5265ff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(last.t)} cy={y(last.p)} r="3.5" fill="#5265ff" />
          {hp && (<g><line x1={x(hp.t)} x2={x(hp.t)} y1={padT} y2={h - padB} stroke="#9ba4ae" strokeDasharray="3 3" /><circle cx={x(hp.t)} cy={y(hp.p)} r="4.5" fill="#fff" stroke="#5265ff" strokeWidth="2" /></g>)}
        </svg>
        {hp && (
          <div className="pointer-events-none absolute top-1 rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(x(hp.t) - 60, 0), w - 130) }}>
            <p className="font-semibold">{(hp.p * 100).toFixed(1)}% YES</p>
            <p className="text-mute">{fmtTime(hp.t, true)}</p>
          </div>
        )}
      </div>
      {!compact && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {showRanges ? (
            <div role="group" aria-label="Time range" className="flex gap-1">
              {RANGES.map((r) => (
                <button key={r.key} aria-pressed={range === r.key} onClick={() => setRange(r.key)}
                  className={`min-h-8 rounded-md px-2.5 text-xs font-semibold ${range === r.key ? "bg-elev text-fg" : "text-mute hover:text-fg"}`}>{r.key}</button>
              ))}
            </div>
          ) : <span />}
          {demo && <span className="text-xs text-mute">Demo history (simulated)</span>}
        </div>
      )}
    </div>
  );
}
