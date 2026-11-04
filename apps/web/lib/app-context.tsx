/* Hydrating from localStorage / async adapters needs setState inside effects. */
/* eslint-disable react-hooks/set-state-in-effect */
"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { liveConfigured } from "./config";
import { DEMO_ACCOUNT, DEMO_NOW } from "./demo/data";
import { DemoAdapter } from "./demo/adapter";
import { NearAdapter } from "./near/adapter";
import { wallet } from "./wallet";
import type { AccountState, DataAdapter, Market } from "./types";

type Session = { kind: "none" } | { kind: "demo" } | { kind: "wallet"; accountId: string };

interface Ctx {
  adapter: DataAdapter;
  session: Session;
  accountId: string | null;
  markets: Market[] | null;
  marketsError: string | null;
  account: AccountState | null;
  accountError: string | null;
  refresh: () => void;
  version: number;
  now: number;
  bookmarks: string[];
  toggleBookmark: (id: string) => void;
  connectOpen: boolean; setConnectOpen: (v: boolean) => void;
  helpOpen: boolean; setHelpOpen: (v: boolean) => void;
  useDemoAccount: () => void;
  connectWallet: () => Promise<void>;
  disconnect: () => Promise<void>;
  resetDemo: () => void;
  liveConfigured: boolean;
  toast: string | null; showToast: (s: string) => void;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("AppProvider missing");
  return c;
};

const demo = new DemoAdapter();
const near = new NearAdapter();
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ kind: "none" });
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const adapter: DataAdapter = session.kind === "wallet" ? near : demo;
  const accountId = session.kind === "demo" ? DEMO_ACCOUNT : session.kind === "wallet" ? session.accountId : null;

  useEffect(() => {
    setBookmarks(store.get<string[]>("nearodds:bookmarks", []));
    if (store.get<string>("nearodds:session", "") === "demo") setSession({ kind: "demo" });
    const off = wallet.subscribe((id) => {
      if (id) { setSession({ kind: "wallet", accountId: id }); }
      else setSession((s) => (s.kind === "wallet" ? { kind: "none" } : s));
    });
    if (liveConfigured) void wallet.restore();
    return off;
  }, []);

  useEffect(() => adapter.subscribe(() => setVersion((v) => v + 1)), [adapter]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Poll the live adapter so pending withdrawals/deposits resolve.
  useEffect(() => {
    if (adapter.id !== "near") return;
    const t = setInterval(() => { setLiveNow(Date.now()); refresh(); }, 8000);
    return () => clearInterval(t);
  }, [adapter, refresh]);

  useEffect(() => {
    let live = true;
    adapter.listMarkets().then((m) => { if (live) { setMarkets(m); setMarketsError(null); } })
      .catch((e: Error) => { if (live) setMarketsError(e.message); });
    return () => { live = false; };
  }, [adapter, version]);

  useEffect(() => {
    if (!accountId) { setAccount(null); return; }
    let live = true;
    adapter.getAccount(accountId).then((a) => { if (live) { setAccount(a); setAccountError(null); } })
      .catch((e: Error) => { if (live) setAccountError(e.message); });
    return () => { live = false; };
  }, [adapter, accountId, version]);

  const showToast = useCallback((s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const toggleBookmark = useCallback((id: string) => {
    setBookmarks((b) => {
      const next = b.includes(id) ? b.filter((x) => x !== id) : [...b, id];
      store.set("nearodds:bookmarks", next);
      return next;
    });
  }, []);

  const value = useMemo<Ctx>(() => ({
    adapter, session, accountId, markets, marketsError, account, accountError, refresh, version,
    now: adapter.id === "demo" ? DEMO_NOW : liveNow,
    bookmarks, toggleBookmark, connectOpen, setConnectOpen, helpOpen, setHelpOpen,
    useDemoAccount: () => { store.set("nearodds:session", "demo"); setSession({ kind: "demo" }); setConnectOpen(false); },
    connectWallet: async () => { await wallet.connect(); setConnectOpen(false); },
    disconnect: async () => {
      store.set("nearodds:session", "");
      if (session.kind === "wallet") await wallet.disconnect();
      setSession({ kind: "none" });
    },
    resetDemo: () => { demo.reset(); showToast("Demo reset to its initial state"); },
    liveConfigured, toast, showToast,
  }), [adapter, session, accountId, markets, marketsError, account, accountError, refresh, version, bookmarks, toggleBookmark, connectOpen, helpOpen, toast, showToast, liveNow]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Fetch per-market data via the adapter, refetching on adapter changes. */
export function useAdapterData<T>(fn: (a: DataAdapter) => Promise<T>, deps: unknown[]) {
  const { adapter, version } = useApp();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const key = JSON.stringify(deps);
  useEffect(() => {
    let live = true;
    fnRef.current(adapter)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e: Error) => live && setState((s) => ({ ...s, error: e.message, loading: false })));
    return () => { live = false; };
  }, [adapter, version, key]);
  return state;
}
