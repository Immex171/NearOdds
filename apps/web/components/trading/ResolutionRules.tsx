"use client";
import { dateTimeUtc, statusLabel } from "@/lib/format";
import type { Market } from "@/lib/types";

export function ResolutionRules({ m }: { m: Market }) {
  const r = m.resolution;
  const obs = r.observation ?? { at: null, text: "As defined in the rules" };
  const src = typeof r.source === "string" ? { name: r.source, field: "" } : r.source ?? { name: "Not provided", field: "" };
  const rows: [string, React.ReactNode][] = [
    ["Trading closes", <>{dateTimeUtc(m.closesAt)}<span className="block text-xs text-mute">Last moment users can trade.</span></>],
    ["Price observation", <>{obs.at ? dateTimeUtc(obs.at) : "No single instant"}<span className="block text-xs text-mute">{obs.text}</span></>],
    ["Resolution source", <>{src.name}<span className="block text-xs text-mute">{src.field}</span></>],
    ["Resolver", r.resolver],
    ["Status", r.outcome ? `${statusLabel[m.status]}: ${r.outcome}` : statusLabel[m.status]],
  ];
  return (
    <section aria-label="Rules" className="rounded-[14px] border border-line bg-card p-4">
      <h2 className="text-lg font-semibold">Rules</h2>
      {r.noWins ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-yes-bg/60 p-3"><p className="text-xs font-semibold text-yes">YES wins if</p><p className="mt-1 text-sm">{r.yesWins}</p></div>
          <div className="rounded-xl bg-no-bg/60 p-3"><p className="text-xs font-semibold text-no">NO wins if</p><p className="mt-1 text-sm">{r.noWins}</p></div>
        </div>
      ) : (
        <div className="mt-3 rounded-xl bg-elev p-3"><p className="text-xs font-semibold text-mute">Rules (as configured in the contract)</p><p className="mt-1 whitespace-pre-wrap text-sm">{r.yesWins}</p></div>
      )}
      <dl className="mt-3 divide-y divide-line/60 text-sm">
        {rows.map(([k, v]) => <div key={k} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between sm:gap-4"><dt className="shrink-0 text-mute">{k}</dt><dd className="sm:text-right">{v}</dd></div>)}
      </dl>
      <p className="mt-2 rounded-lg bg-elev px-3 py-2 text-sm text-mute">{r.ifMissing}</p>
      {r.note && <p className="mt-2 text-sm text-mute">{r.note}</p>}
    </section>
  );
}
