"use client";
import { useApp } from "@/lib/app-context";
import type { Market } from "@/lib/types";

/** Stale, delayed, partial and unreconciled data are shown as such, never hidden. */
export function DataNotice({ market }: { market?: Market | null }) {
  const { adapter, freshness, marketsError, streamState, markets } = useApp();
  if (adapter.id !== "near") return null;
  const items: { id: string; tone: "warn" | "bad"; text: string }[] = [];
  if (marketsError) items.push({ id: "api", tone: "bad", text: markets ? `The NearOdds API did not answer (${marketsError}). Showing the last data we received; it may be out of date.` : `The NearOdds API did not answer: ${marketsError}` });
  if (freshness?.lagBlocks != null && freshness.lagBlocks > 30) items.push({ id: "lag", tone: "warn", text: `The indexer is ${freshness.lagBlocks} blocks behind the chain, so order books and history may lag. Wallet actions re-check the contract before signing.` });
  if (streamState === "reconnecting") items.push({ id: "stream", tone: "warn", text: "Live updates are paused; reconnecting. The page refreshes itself every few seconds meanwhile." });
  if (market?.coverage && !market.coverage.historyComplete) items.push({ id: "history", tone: "warn", text: `Partial history. ${market.coverage.note}` });
  if (market?.coverage?.reconcileOk === false) items.push({ id: "drift", tone: "warn", text: `The indexer’s copy of this market differs from the contract in ${market.coverage.driftCount} place${market.coverage.driftCount === 1 ? "" : "s"} and is being corrected. Balances and status shown by the wallet checks come from the contract.` });
  if (market?.chain === "unavailable") items.push({ id: "chain", tone: "warn", text: "The contract could not be read just now, so this market’s status comes from the indexer." });
  if (!items.length) return null;
  return (
    <div className="space-y-1.5" data-testid="data-notice">
      {items.map((i) => (
        <p key={i.id} role={i.tone === "bad" ? "alert" : "status"} data-notice={i.id}
          className={`rounded-lg border px-3 py-2 text-xs ${i.tone === "bad" ? "border-no/40 bg-no-bg/40 text-no" : "border-[#e8913a]/40 bg-[#e8913a]/10 text-[#f3b36b]"}`}>{i.text}</p>
      ))}
    </div>
  );
}
