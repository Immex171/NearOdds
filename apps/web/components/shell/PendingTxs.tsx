"use client";
import { useApp } from "@/lib/app-context";
import { explorerTx } from "@/lib/config";

/** Transactions sent but not yet confirmed. Shown until the network reports a final result; never resent. */
export function PendingTxs() {
  const { pending } = useApp();
  if (!pending.length) return null;
  return (
    <div className="border-b border-[#e8913a]/40 bg-[#e8913a]/10 px-4 py-1 text-center text-xs text-[#f3b36b]" role="status" data-testid="pending-txs">
      {pending.length} transaction{pending.length === 1 ? "" : "s"} awaiting confirmation (not resent):{" "}
      {pending.map((p, i) => (
        <span key={p.hash}>{i > 0 && ", "}{p.label} <a className="underline" href={explorerTx(p.hash)} target="_blank" rel="noreferrer">{p.hash.slice(0, 8)}…</a></span>
      ))}
    </div>
  );
}
