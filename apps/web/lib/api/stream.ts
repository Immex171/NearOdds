import type { StreamEvent } from "./types";

export type StreamState = "connecting" | "live" | "reconnecting" | "closed";
const TYPES = ["hello", "heartbeat", "market_created", "market_status", "book", "trade", "account"] as const;

interface ES {
  readyState: number; close(): void;
  addEventListener(t: string, f: (e: MessageEvent) => void): void;
  onerror: ((e: unknown) => void) | null;
}
export interface StreamOptions {
  url: string;
  onEvent: (e: StreamEvent) => void;
  onState?: (s: StreamState) => void;
  /** Injected in tests. */
  create?: (url: string) => ES;
  /** No message (heartbeats included) for this long = treat the connection as dead and reopen it. */
  staleMs?: number;
  retryMs?: number;
}

/**
 * Server-sent events as NOTIFICATIONS only. The consumer refetches REST snapshots on every event and on every
 * `hello` (sent on each (re)connect, so missed updates are always repaired). One call = one connection; close() ends it
 * and cancels every timer, so replacing a subscription never leaves a stale one running.
 */
export function openStream(o: StreamOptions) {
  const make = o.create ?? ((u: string) => new EventSource(u) as unknown as ES);
  const staleMs = o.staleMs ?? 30_000, retryMs = o.retryMs ?? 3_000;
  let es: ES | null = null, closed = false, watchdog: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined, everLive = false;
  const state = (s: StreamState) => o.onState?.(s);
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { if (!closed) { state("reconnecting"); reopen(); } }, staleMs); };
  const reopen = () => { es?.close(); es = null; clearTimeout(retry); retry = setTimeout(connect, retryMs); };
  function connect() {
    if (closed) return;
    state(everLive ? "reconnecting" : "connecting");
    es = make(o.url);
    for (const t of TYPES) {
      es.addEventListener(t, (m) => {
        arm();
        if (t === "hello") { everLive = true; state("live"); }
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(m.data) as Record<string, unknown>; } catch { /* a malformed payload is still a reason to refetch */ }
        o.onEvent({ type: t, marketRef: (data.marketRef as string | null | undefined) ?? null, account: (data.account as string | null | undefined) ?? null, freshness: data.freshness as StreamEvent["freshness"], resync: data.resync as boolean | undefined });
      });
    }
    es.onerror = () => { if (closed) return; state("reconnecting"); if (es && es.readyState === 2) reopen(); };
    arm();
  }
  connect();
  return { close() { closed = true; clearTimeout(watchdog); clearTimeout(retry); es?.close(); es = null; state("closed"); } };
}
