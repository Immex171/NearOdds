"use client";
import { dateTime, statusLabel } from "@/lib/format";
import type { Market } from "@/lib/types";

export function ResolutionRules({ m }: { m: Market }) {
  const r = m.resolution;
  const rows: [string, string][] = [
    ["Resolution source", r.source], ["Resolver", r.resolver], ["Trading closes", dateTime(m.closesAt)],
    ["Current status", r.outcome ? `${statusLabel[m.status]}: ${r.outcome}` : statusLabel[m.status]],
  ];
  return (
    <section aria-label="Rules" className="rounded-[14px] border border-line bg-card p-4">
      <h2 className="text-lg font-semibold">Rules</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-yes-bg/60 p-3"><p className="text-xs font-semibold text-yes">YES wins</p><p className="mt-1 text-sm">{r.yesWins}</p></div>
        <div className="rounded-xl bg-no-bg/60 p-3"><p className="text-xs font-semibold text-no">NO wins</p><p className="mt-1 text-sm">{r.noWins}</p></div>
      </div>
      <dl className="mt-3 divide-y divide-line/60 text-sm">
        {rows.map(([k, v]) => <div key={k} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between sm:gap-4"><dt className="text-mute">{k}</dt><dd className="sm:text-right">{v}</dd></div>)}
      </dl>
      {r.note && <p className="mt-2 rounded-lg bg-elev px-3 py-2 text-sm text-mute">{r.note}</p>}
      <p className="mt-3 text-sm text-mute">{m.description}</p>
    </section>
  );
}
