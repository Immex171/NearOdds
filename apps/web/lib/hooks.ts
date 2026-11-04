"use client";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { TxReporter, TxState } from "./types";

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

/** Tracks a transaction lifecycle. `run` never throws; failures land in state. */
export function useTx() {
  const [tx, setTx] = useState<TxState>({ phase: "idle" });
  const run = useCallback(async (fn: (r: TxReporter) => Promise<unknown>): Promise<boolean> => {
    setTx({ phase: "awaiting-wallet" });
    try {
      await fn((s) => setTx((prev) => ({ ...prev, ...s })));
      return true;
    } catch (e) {
      setTx((p) => (p.phase === "failed" ? p : { phase: "failed", message: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }, []);
  const reset = useCallback(() => setTx({ phase: "idle" }), []);
  return { tx, run, reset, busy: ["awaiting-wallet", "submitted", "confirming"].includes(tx.phase) };
}
