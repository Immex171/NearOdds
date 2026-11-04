"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/app-context";
import { shortAccount } from "@/lib/format";
import { Icon } from "../ui/Icon";
import { Badge, Btn } from "../ui/bits";

export function AccountMenu() {
  const { session, accountId, disconnect, setConnectOpen, setHelpOpen, resetDemo, rejectNext, setRejectNext } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, []);
  const item = "block w-full rounded-lg px-3 py-2.5 text-left text-sm hover:bg-white/10";
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      {session.kind === "none" ? (
        <div className="flex items-center gap-1">
          <span className="hidden md:block"><Btn onClick={() => setConnectOpen(true)}>Connect wallet</Btn></span>
          <button aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)} className="grid h-10 w-10 place-items-center rounded-lg text-mute hover:bg-white/10 md:hidden"><Icon name="menu" /></button>
        </div>
      ) : (
        <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-medium hover:bg-white/10">
          <Icon name="user" size={16} className="text-mute" />
          <span className="hidden max-w-[150px] truncate sm:inline">{session.kind === "demo" ? "Demo account" : shortAccount(accountId!)}</span>
          <Icon name="caret" size={16} className="text-mute" />
        </button>
      )}
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-64 rounded-xl border border-line bg-card p-1.5 shadow-2xl">
          {session.kind !== "none" && (
            <div className="px-3 py-2">
              <p className="truncate text-sm font-semibold">{session.kind === "demo" ? "Demo account" : shortAccount(accountId!)}</p>
              {session.kind === "demo" ? <Badge tone="brand">Sample balances only</Badge> : <Badge tone="yes">Testnet</Badge>}
            </div>
          )}
          <div className="md:hidden">
            <Link role="menuitem" className={item} href="/markets" onClick={close}>Markets</Link>
            <Link role="menuitem" className={item} href="/portfolio" onClick={close}>Portfolio</Link>
          </div>
          {session.kind !== "none" && <Link role="menuitem" className={item} href="/funds" onClick={close}>Funds</Link>}
          <button role="menuitem" className={item} onClick={() => { close(); setHelpOpen(true); }}>How it works</button>
          <button role="menuitem" className={item} onClick={() => { close(); resetDemo(); }}>Reset demo</button>
          {session.kind === "demo" && (
            <button role="menuitemcheckbox" aria-checked={rejectNext} className={item} onClick={() => { setRejectNext(!rejectNext); close(); }}>
              {rejectNext ? "✓ " : ""}Demo: reject next transaction
            </button>
          )}
          {session.kind === "none"
            ? <button role="menuitem" className={`${item} font-semibold text-brand`} onClick={() => { close(); setConnectOpen(true); }}>Connect wallet</button>
            : <button role="menuitem" className={`${item} text-no`} onClick={() => { close(); void disconnect(); }}>Disconnect</button>}
        </div>
      )}
    </div>
  );
}
