/* Loading server state and resuming a stored claim intentionally set state from effects. */
/* eslint-disable react-hooks/set-state-in-effect */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api as defaultApi } from "./api/instance";
import { ApiError, type Api } from "./api/client";
import type { ApiFaucetClaim, ApiFaucetState } from "./api/types";

/** Human text for the faucet's refusal codes (apps/backend/src/faucet/service.ts). */
export function faucetRefusal(e: ApiError): { kind: "cooldown" | "quota" | "disabled" | "auth" | "other"; message: string } {
  switch (e.code) {
    case "cooldown": return { kind: "cooldown", message: `Please wait before claiming again. ${e.message}.` };
    case "account_quota": return { kind: "quota", message: `You have reached the per-account limit of free test tokens. ${e.message}.` };
    case "global_quota": return { kind: "quota", message: "The faucet’s 24-hour limit has been reached. Try again later." };
    case "native_budget": return { kind: "disabled", message: "The faucet’s network-fee budget is used up, so it is paused. Ask the project owner to top it up." };
    case "faucet_disabled": return { kind: "disabled", message: e.message };
    case "unauthenticated": return { kind: "auth", message: "Sign in with your wallet to claim test tokens." };
    case "idempotency_key_required": return { kind: "other", message: "The request was missing its request id. Reload the page and try again." };
    default: return { kind: "other", message: e.message };
  }
}

/** One idempotency key per INTENDED claim. It survives a reload so a retry can never mint twice. */
const keyStore = (account: string) => `nearodds:faucet-intent:${account}`;
export interface Intent { key: string; claimId: string | null }
const readIntent = (account: string): Intent | null => { try { const v = sessionStorage.getItem(keyStore(account)); return v ? (JSON.parse(v) as Intent) : null; } catch { return null; } };
const writeIntent = (account: string, i: Intent | null) => { try { if (i) sessionStorage.setItem(keyStore(account), JSON.stringify(i)); else sessionStorage.removeItem(keyStore(account)); } catch { /* unavailable */ } };
export const newIntentKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

export type ClaimPhase =
  | { phase: "idle" }
  | { phase: "submitting" }
  /** Accepted but not minted: the wallet is NOT funded yet. */
  | { phase: "queued"; claimId: string; amount: string }
  | { phase: "minted"; claimId: string; amount: string }
  | { phase: "failed"; claimId: string; message: string }
  /** The request could not be confirmed (network/5xx). The same key will be reused on retry. */
  | { phase: "retry"; message: string }
  | { phase: "refused"; kind: ReturnType<typeof faucetRefusal>["kind"]; message: string };

export function useFaucet(opts: { accountId: string | null; signedIn: boolean; onMinted?: () => void; api?: Api; pollMs?: number }) {
  const { accountId, signedIn, onMinted } = opts;
  const api = opts.api ?? defaultApi;
  const pollMs = opts.pollMs ?? 3000;
  const [state, setState] = useState<ApiFaucetState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimPhase>({ phase: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mintedCb = useRef(onMinted);
  useEffect(() => { mintedCb.current = onMinted; });

  const loadState = useCallback(async () => {
    try { setState(await api.faucet()); setStateError(null); } catch (e) { setStateError(e instanceof Error ? e.message : String(e)); }
  }, [api]);
  useEffect(() => { void loadState(); }, [loadState, accountId]);

  const track = useCallback((account: string, claimId: string) => {
    clearTimeout(timer.current);
    const tick = async () => {
      try {
        const c = await api.faucetClaim(claimId);
        if (c.state === "minted") { writeIntent(account, null); setClaim({ phase: "minted", claimId, amount: c.amount }); mintedCb.current?.(); void loadState(); return; }
        if (c.state === "failed") { writeIntent(account, null); setClaim({ phase: "failed", claimId, message: c.note ?? "The mint failed. No tokens were sent." }); return; }
        setClaim({ phase: "queued", claimId, amount: c.amount });
      } catch { /* transient: keep polling */ }
      timer.current = setTimeout(tick, pollMs);
    };
    timer.current = setTimeout(tick, pollMs);
  }, [api, loadState, pollMs]);

  // Resume an in-flight claim after a reload.
  useEffect(() => {
    clearTimeout(timer.current);
    setClaim({ phase: "idle" });
    if (!accountId || !signedIn) return;
    const i = readIntent(accountId);
    if (i?.claimId) { setClaim({ phase: "queued", claimId: i.claimId, amount: "" }); track(accountId, i.claimId); }
    return () => clearTimeout(timer.current);
  }, [accountId, signedIn, track]);

  const request = useCallback(async () => {
    if (!accountId) return;
    // Reuse the stored key when the previous attempt of this intended claim was not resolved; otherwise mint a new key.
    const intent = readIntent(accountId) ?? { key: newIntentKey(), claimId: null };
    writeIntent(accountId, intent);
    setClaim({ phase: "submitting" });
    try {
      const c: ApiFaucetClaim = await api.claimFaucet(intent.key);
      writeIntent(accountId, { key: intent.key, claimId: c.claimId });
      setClaim(c.state === "minted" ? { phase: "minted", claimId: c.claimId, amount: c.amount } : { phase: "queued", claimId: c.claimId, amount: c.amount });
      if (c.state === "minted") { writeIntent(accountId, null); mintedCb.current?.(); } else track(accountId, c.claimId);
      void loadState();
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        writeIntent(accountId, null); // a definite refusal: the next click is a new intended claim
        const r = faucetRefusal(e);
        setClaim({ phase: "refused", kind: r.kind, message: r.message });
        void loadState();
      } else {
        setClaim({ phase: "retry", message: "We couldn’t confirm whether the request was received. Retrying uses the same request id, so you can’t be minted twice." });
      }
    }
  }, [accountId, api, loadState, track]);

  const reset = useCallback(() => { if (accountId) writeIntent(accountId, null); setClaim({ phase: "idle" }); }, [accountId]);
  return { state, stateError, claim, request, reset, reload: loadState };
}
