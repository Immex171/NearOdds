"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/app-context";
import { statusLabel } from "@/lib/format";
import { Icon } from "../ui/Icon";
import { TopicIcon } from "../ui/bits";

/** Combobox search: arrow keys move, Enter opens, Esc closes. Mobile collapses to an icon that expands the field. */
export function SearchDialog() {
  const { markets } = useApp();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !markets) return [];
    return markets.filter((m) => m.question.toLowerCase().includes(t) || m.category.toLowerCase().includes(t) || m.tag?.toLowerCase() === t).slice(0, 7);
  }, [q, markets]);

  useEffect(() => {
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); } };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); setMobileOpen(true); setTimeout(() => input.current?.focus(), 0); } };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const go = (id: string) => { setOpen(false); setQ(""); setMobileOpen(false); router.push(`/markets/${id}`); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[active]) go(results[active].id); else if (q.trim()) { setOpen(false); setMobileOpen(false); router.push(`/markets?q=${encodeURIComponent(q.trim())}`); } }
    else if (e.key === "Escape") { setOpen(false); setMobileOpen(false); }
  };

  return (
    <div ref={box} className={`relative min-w-0 flex-1 ${mobileOpen ? "" : "max-md:flex-none max-md:ml-auto"} md:max-w-[560px] md:mx-auto`}>
      <button className={`grid h-10 w-10 place-items-center rounded-lg text-mute hover:bg-elev md:hidden ${mobileOpen ? "hidden" : ""}`} aria-label="Search markets"
        onClick={() => { setMobileOpen(true); setTimeout(() => input.current?.focus(), 0); }}><Icon name="search" /></button>
      <div className={`${mobileOpen ? "flex" : "hidden"} md:flex relative items-center`}>
        <Icon name="search" className="pointer-events-none absolute left-3 text-mute" />
        <input ref={input} type="search" role="combobox" aria-expanded={open && results.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined} aria-label="Search markets"
          value={q} placeholder="Search markets…" autoComplete="off"
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
          className="h-10 w-full rounded-lg border border-line bg-card pl-10 pr-3 text-sm placeholder:text-mute focus:border-brand" />
      </div>
      {open && q.trim() && (
        <ul id={listId} role="listbox" className="absolute left-0 right-0 top-12 z-50 max-h-[70dvh] overflow-auto rounded-xl border border-line bg-card p-1 shadow-2xl">
          {results.length === 0 && <li className="px-3 py-3 text-mute">No markets match “{q}”.</li>}
          {results.map((m, i) => (
            <li key={m.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(m.id)}
              className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${i === active ? "bg-elev" : ""}`}>
              <TopicIcon market={m} size={32} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.question}</p>
                <p className="text-xs text-mute">{m.category} · {statusLabel[m.status]}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
