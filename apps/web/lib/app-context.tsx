/* Hydrating from localStorage / async adapters needs setState inside effects. */
/* eslint-disable react-hooks/set-state-in-effect */
"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api/instance";
import { openStream, type StreamState } from "./api/stream";
import { ApiError } from "./api/client";
import { authenticate, sessionStore, type AppSession } from "./auth";
import { config, liveConfigured } from "./config";
import { DEMO_ACCOUNT, DEMO_NOW } from "./demo/data";
import { DemoAdapter } from "./demo/adapter";
import { NearAdapter } from "./near/adapter";
import { pendingTxs, type PendingTx } from "./near/pending";
import { setApiToken } from "./api/instance";
import { wallet } from "./wallet";
import type { AccountState, CategoryCount, DataAdapter, Deployment, Freshness, Market } from "./types";

type Session = { kind: "none" } | { kind: "demo" } | { kind: "wallet"; accountId: string };
export type AuthState = { state: "signed-out" } | { state: "signing" } | { state: "signed-in"; accountId: string; isAdmin: boolean } | { state: "error"; message: string };

interface Ctx {
  adapter: DataAdapter;
  session: Session;
  accountId: string | null;
  markets: Market[] | null;
  /** Set when the last markets request failed. If `markets` is non-null they are the previous (stale) answer. */
  marketsError: string | null;
  categories: CategoryCount[];
  /** Freshness of the most recent backend answer. */
  freshness: Freshness | null;
  streamState: StreamState;
  account: AccountState | null;
  accountError: string | null;
  /** none = not connected; loading = fetching; ready; error. */
  accountStatus: "none" | "loading" | "ready" | "error";
  refresh: () => void;
  version: number;
  now: number;
  /** Saved markets (marketRefs): the backend watchlist when signed in, local bookmarks in demo. */
  bookmarks: string[];
  toggleBookmark: (id: string) => void;
  auth: AuthState;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  connectOpen: boolean; setConnectOpen: (v: boolean) => void;
  helpOpen: boolean; setHelpOpen: (v: boolean) => void;
  useDemoAccount: () => void;
  connectWallet: () => Promise<void>;
  disconnect: () => Promise<void>;
  resetDemo: () => void;
  liveConfigured: boolean;
  /** Leave demo mode and return to live testnet data. */
  exitDemo: () => void;
  /** The market page tells the app which market is on screen so stream events can be routed. */
  setActiveMarket: (ref: string | null) => void;
  /** Transactions sent but not confirmed. They are tracked by hash and never resent. */
  pending: PendingTx[];
  /** Heuristic: a mainnet-style (.near) account while the app is configured for testnet. */
  wrongNetwork: boolean;
  rejectNext: boolean;
  setRejectNext: (v: boolean) => void;
  toast: string | null; showToast: (s: string) => void;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("AppProvider missing");
  return c;
};

const demo = new DemoAdapter();
const near = new NearAdapter(api);
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ kind: "none" });
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("closed");
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [localMarks, setLocalMarks] = useState<string[]>([]);
  const [watch, setWatch] = useState<string[]>([]);
  const [app, setApp] = useState<AppSession | null>(null);
  const [auth, setAuth] = useState<AuthState>({ state: "signed-out" });
  const [pending, setPending] = useState<PendingTx[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rejectNext, setRejectNext] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeRef = useRef<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Live testnet data is the default whenever the backend is configured; Demo is only ever an explicit choice.
  const adapter: DataAdapter = session.kind === "demo" || !liveConfigured ? demo : near;
  const live = adapter.id === "near";
  const accountId = session.kind === "demo" ? DEMO_ACCOUNT : session.kind === "wallet" ? session.accountId : null;

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const showToast = useCallback((s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // ---- boot ------------------------------------------------------------------------------------------------------
  useEffect(() => {
    setLocalMarks(store.get<string[]>("nearodds:bookmarks", []));
    if (store.get<string>("nearodds:session", "") === "demo") setSession({ kind: "demo" });
    const off = wallet.subscribe((id) => {
      if (id) setSession((s) => (s.kind === "demo" ? s : { kind: "wallet", accountId: id }));
      else setSession((s) => (s.kind === "wallet" ? { kind: "none" } : s));
    });
    if (liveConfigured) void wallet.restore();
    // Test hook (opt-in): lets browser tests simulate an offer disappearing. No effect unless the flag is set.
    if (localStorage.getItem("nearodds:debug") === "1") (window as unknown as { __demo?: DemoAdapter }).__demo = demo;
    return off;
  }, []);

  useEffect(() => adapter.subscribe(() => setVersion((v) => v + 1)), [adapter]);

  // ---- application session (NEP-413) ---------------------------------------------------------------------------------
  const dropSession = useCallback((why?: string) => {
    setApiToken(null); sessionStore.clear(); setApp(null); setWatch([]);
    setAuth(why ? { state: "error", message: why } : { state: "signed-out" });
  }, []);

  // Restore a saved session only for the SAME wallet account and network, and only if the server still accepts it.
  useEffect(() => {
    if (!live || !accountId) return; // the wallet restores asynchronously: judge the saved session only once the account is known
    const saved = sessionStore.load();
    if (!saved || saved.network !== config.network || saved.accountId !== accountId || Date.parse(saved.expiresAt) <= Date.now()) {
      if (saved) dropSession(); // other account / network / expired
      return;
    }
    setApiToken(saved.token);
    api.session().then((s) => { setApp(saved); setAuth({ state: "signed-in", accountId: s.accountId, isAdmin: s.isAdmin }); })
      .catch((e) => { if (e instanceof ApiError && e.unauthenticated) dropSession(); else { setApp(saved); setAuth({ state: "signed-in", accountId: saved.accountId, isAdmin: saved.isAdmin }); } });
  }, [live, accountId, dropSession]);

  const signIn = useCallback(async (): Promise<boolean> => {
    if (!accountId || session.kind !== "wallet") { setConnectOpen(true); return false; }
    setAuth({ state: "signing" });
    try {
      const s = await authenticate(api, wallet, accountId, config.network);
      setApiToken(s.token); sessionStore.save(s); setApp(s);
      setAuth({ state: "signed-in", accountId: s.accountId, isAdmin: s.isAdmin });
      return true;
    } catch (e) {
      const m = /reject|denied|declin|cancel/i.test(msg(e)) ? "Sign-in was cancelled in your wallet. Nothing was changed." : msg(e);
      setApiToken(null); setAuth({ state: "error", message: m });
      return false;
    }
  }, [accountId, session.kind]);

  const signOut = useCallback(async () => {
    if (app) await api.logout().catch(() => undefined); // best effort: the local session is dropped either way
    dropSession();
  }, [app, dropSession]);

  // Switching wallet account (or disconnecting) ends the application session immediately.
  useEffect(() => { if (app && app.accountId !== accountId) { void api.logout().catch(() => undefined); dropSession(); } }, [accountId, app, dropSession]);

  // ---- data ------------------------------------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    adapter.listMarkets().then((m) => { if (alive) { setMarkets(m); setMarketsError(null); setFreshness(adapter.freshness()); } })
      .catch((e: Error) => { if (alive) setMarketsError(e.message); }); // keeps the previous list: stale beats blank
    adapter.listCategories().then((c) => { if (alive) setCategories(c); }).catch(() => undefined);
    return () => { alive = false; };
  }, [adapter, version]);

  useEffect(() => { setMarkets(null); setMarketsError(null); setFreshness(null); }, [adapter]);

  useEffect(() => {
    if (!accountId) { setAccount(null); setAccountError(null); return; }
    let alive = true;
    adapter.getAccount(accountId).then((a) => { if (alive) { setAccount(a); setAccountError(null); } })
      .catch((e: Error) => { if (alive) setAccountError(e.message); });
    return () => { alive = false; };
  }, [adapter, accountId, version]);

  // ---- watchlist ---------------------------------------------------------------------------------------------------
  useEffect(() => {
    if (!live || auth.state !== "signed-in") return;
    let alive = true;
    api.watchlist().then((w) => { if (alive) setWatch(w.items.map((i) => i.marketRef)); })
      .catch((e) => { if (e instanceof ApiError && e.unauthenticated) dropSession("Your session expired. Sign in again."); });
    return () => { alive = false; };
  }, [live, auth.state, version, dropSession]);

  const bookmarks = live ? watch : localMarks;
  const toggleBookmark = useCallback((id: string) => {
    if (!live) {
      setLocalMarks((b) => { const next = b.includes(id) ? b.filter((x) => x !== id) : [...b, id]; store.set("nearodds:bookmarks", next); return next; });
      return;
    }
    void (async () => {
      if (auth.state !== "signed-in") {
        showToast(session.kind === "wallet" ? "Sign in with your wallet to keep a watchlist." : "Connect a wallet and sign in to keep a watchlist.");
        if (session.kind !== "wallet") setConnectOpen(true);
        else if (!(await signIn())) return;
        else return; // the user presses the bookmark again now that they are signed in
      }
      const on = watch.includes(id);
      setWatch((w) => (on ? w.filter((x) => x !== id) : [...w, id])); // optimistic
      try { await (on ? api.unwatch(id) : api.watch(id)); }
      catch (e) {
        setWatch((w) => (on ? [...w, id] : w.filter((x) => x !== id)));
        if (e instanceof ApiError && e.unauthenticated) dropSession("Your session expired. Sign in again.");
        showToast(`Couldn’t update your watchlist: ${msg(e)}`);
      }
    })();
  }, [live, auth.state, session.kind, watch, signIn, showToast, dropSession]);

  // ---- stream ----------------------------------------------------------------------------------------------------
  // ONE connection for all markets (so a newly created market reaches discovery even while another is open), scoped to the
  // connected account. Events are only hints: they trigger REST refetches. Closed and reopened whenever the account changes.
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    const bump = () => { clearTimeout(debounce.current); debounce.current = setTimeout(() => setVersion((v) => v + 1), 300); };
    const h = openStream({
      url: api.streamUrl({ account: accountId }),
      onState: setStreamState,
      onEvent: (e) => {
        if (e.freshness) setFreshness({ blockHeight: e.freshness.blockHeight, lagBlocks: e.freshness.lagBlocks, generatedAt: e.freshness.generatedAt });
        if (e.type === "heartbeat") return;
        if (e.type === "book" || e.type === "trade") { if (activeRef.current && e.marketRef !== activeRef.current) return; }
        bump(); // hello (every (re)connect), market_created, market_status, account, and relevant book/trade
      },
    });
    return () => { clearTimeout(debounce.current); h.close(); };
  }, [live, accountId]);

  // Safety net if the stream is down.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { setLiveNow(Date.now()); refresh(); }, streamState === "live" ? 60_000 : 10_000);
    return () => clearInterval(t);
  }, [live, refresh, streamState]);

  // ---- transactions left unconfirmed -------------------------------------------------------------------------------
  useEffect(() => {
    if (!live) return;
    const sync = () => setPending(pendingTxs.list(accountId));
    sync();
    const off = pendingTxs.subscribe(sync);
    const t = setInterval(async () => {
      for (const p of pendingTxs.list(accountId)) {
        const r = await near.checkPending(p.hash, p.signer);
        if (r === "waiting") continue;
        pendingTxs.remove(p.hash);
        showToast(r === "done" ? `${p.label} was confirmed.` : `${p.label} failed on-chain.`);
        refresh();
      }
    }, 8000);
    return () => { off(); clearInterval(t); };
  }, [live, accountId, refresh, showToast]);

  const setActiveMarket = useCallback((ref: string | null) => { activeRef.current = ref; }, []);

  const value = useMemo<Ctx>(() => ({
    adapter, session, accountId, markets, marketsError, categories, freshness, streamState, account, accountError, refresh, version,
    accountStatus: !accountId ? "none" : accountError && !account ? "error" : account ? "ready" : "loading",
    now: adapter.id === "demo" ? DEMO_NOW : liveNow,
    bookmarks, toggleBookmark, auth, signIn, signOut, connectOpen, setConnectOpen, helpOpen, setHelpOpen,
    useDemoAccount: () => { store.set("nearodds:session", "demo"); setSession({ kind: "demo" }); setConnectOpen(false); },
    connectWallet: async () => { await wallet.connect(); setConnectOpen(false); },
    disconnect: async () => {
      store.set("nearodds:session", "");
      if (session.kind === "wallet") await wallet.disconnect();
      setSession({ kind: "none" });
    },
    resetDemo: () => { demo.reset(); showToast("Demo reset to its initial state"); },
    liveConfigured, toast, showToast, setActiveMarket, pending,
    exitDemo: () => { store.set("nearodds:session", ""); setSession({ kind: "none" }); },
    wrongNetwork: session.kind === "wallet" && config.network === "testnet" && session.accountId.endsWith(".near"),
    rejectNext, setRejectNext: (v: boolean) => { demo.setRejectNext(v); setRejectNext(v); },
  }), [rejectNext, adapter, session, accountId, markets, marketsError, categories, freshness, streamState, account, accountError, refresh, version, bookmarks, toggleBookmark, auth, signIn, signOut, connectOpen, helpOpen, toast, showToast, liveNow, setActiveMarket, pending]);

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
    let alive = true;
    fnRef.current(adapter)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((e: Error) => alive && setState((s) => ({ ...s, error: e.message, loading: false })));
    return () => { alive = false; };
  }, [adapter, version, key]);
  return state;
}

/** The connected account's state inside ONE market contract, read from the chain (fresh). */
export function useMarketAccount(m: Market | null) {
  const { adapter, accountId, version } = useApp();
  const [s, setS] = useState<{ account: AccountState | null; error: string | null; forKey: string }>({ account: null, error: null, forKey: "" });
  const key = `${adapter.id}|${accountId}|${m?.id}`;
  useEffect(() => {
    if (!accountId || !m) return;
    let alive = true;
    adapter.getAccount(accountId, m)
      .then((account) => alive && setS({ account, error: null, forKey: key }))
      .catch((e: Error) => alive && setS((p) => ({ account: p.forKey === key ? p.account : null, error: e.message, forKey: key })));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, accountId, m?.id, version]);
  const mine = s.forKey === key;
  return { account: mine ? s.account : null, error: mine ? s.error : null, loading: Boolean(accountId && m) && !(mine && (s.account || s.error)) };
}

/** Verification state of the SELECTED market's contract. Wallet actions stay disabled until it is ok. */
export function useDeployment(m: Market | null): { deployment: Deployment; retry: () => void } {
  const { adapter } = useApp();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (m) void adapter.verify(m); }, [adapter, m?.id]);
  return { deployment: m ? adapter.deployment(m) : { state: "idle" }, retry: () => { if (m) void adapter.verify(m, true); } };
}
