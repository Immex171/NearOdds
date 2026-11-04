"use client";
import { applyFilters, facetTags, matchCounts, type Filters, hasActive } from "@/lib/filters";
import type { Market } from "@/lib/types";

const STATUS = [["open", "Open"], ["closing", "Closing soon"], ["resolved", "Resolved"]] as const;
const PERIOD = [["today", "Today"], ["week", "This week"], ["month", "This month"]] as const;

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-b border-line py-4 first:pt-0 last:border-0">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-mute">{title}</legend>
      <div className="space-y-0.5">{children}</div>
    </fieldset>
  );
}

function Check({ label, count, checked, onChange }: { label: string; count: number; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 text-sm hover:bg-elev">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 accent-[#5265ff]" />
      <span className="flex-1">{label}</span>
      <span className="text-xs text-mute">{count}</span>
    </label>
  );
}

const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

export function FilterRail({ f, onChange, markets, now, bookmarks }: {
  f: Filters; onChange: (f: Filters) => void; markets: Market[]; now: number; bookmarks: string[];
}) {
  const base = { ...f, status: [], period: [], tags: [] } as Filters;
  const cat = applyFilters(markets, { ...f, tags: [] }, now, bookmarks, "tags");
  const tags = facetTags(markets, f.category);
  return (
    <div>
      <Group title="Market status">
        {STATUS.map(([k, l]) => <Check key={k} label={l} count={matchCounts.status(applyFilters(markets, base, now, bookmarks), now, k)} checked={f.status.includes(k)} onChange={() => onChange({ ...f, status: toggle(f.status, k) })} />)}
      </Group>
      <Group title="Closing period">
        {PERIOD.map(([k, l]) => <Check key={k} label={l} count={matchCounts.period(applyFilters(markets, base, now, bookmarks), now, k)} checked={f.period.includes(k)} onChange={() => onChange({ ...f, period: toggle(f.period, k) })} />)}
      </Group>
      {tags.length > 0 && (
        <Group title={f.category === "Crypto" ? "Asset" : "Topic"}>
          {tags.map((t) => <Check key={t} label={t} count={cat.filter((m) => m.tag === t).length} checked={f.tags.includes(t)} onChange={() => onChange({ ...f, tags: toggle(f.tags, t) })} />)}
        </Group>
      )}
      <Group title="Saved">
        <Check label="Saved markets only" count={bookmarks.length} checked={f.saved} onChange={() => onChange({ ...f, saved: !f.saved })} />
      </Group>
      {hasActive(f) && (
        <button onClick={() => onChange({ ...f, status: [], period: [], tags: [], saved: false, q: "" })}
          className="mt-3 w-full rounded-lg border border-line py-2 text-sm font-semibold hover:bg-elev">Clear filters</button>
      )}
    </div>
  );
}
