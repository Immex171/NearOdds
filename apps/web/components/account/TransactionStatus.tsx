import { explorerTx } from "@/lib/config";
import type { TxState } from "@/lib/types";

const STEPS = [["awaiting-wallet", "Awaiting wallet approval"], ["submitted", "Submitted"], ["confirming", "Confirming"], ["confirmed", "Confirmed"]] as const;

export function TransactionStatus({ tx, demo }: { tx: TxState; demo: boolean }) {
  if (tx.phase === "idle" || tx.phase === "review") return null;
  const failed = tx.phase === "failed";
  const unconfirmed = tx.phase === "unconfirmed";
  const idx = STEPS.findIndex(([k]) => k === (unconfirmed ? "confirming" : tx.phase));
  return (
    <div role="status" aria-live="polite" className={`rounded-xl border p-3 text-sm ${failed ? "border-no/40 bg-no-bg/40" : unconfirmed ? "border-[#e8913a]/50 bg-[#e8913a]/10" : tx.phase === "confirmed" ? "border-yes/40 bg-yes-bg/40" : "border-line bg-elev"}`}>
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {STEPS.map(([k, l], i) => (
          <li key={k} className={i <= idx && !failed ? "font-semibold text-fg" : "text-mute"}>{i < idx ? "✓ " : i === idx && !failed ? "● " : "○ "}{l}</li>
        ))}
      </ol>
      <p className={`mt-2 font-medium ${failed ? "text-no" : ""}`}>
        {failed ? `Failed: ${tx.message ?? "The transaction was rejected."}` : unconfirmed ? `Not confirmed: ${tx.message ?? ""}` : tx.message}
      </p>
      {tx.hash && !demo && <a className="mt-1 inline-block text-xs text-brand underline" href={explorerTx(tx.hash)} target="_blank" rel="noreferrer">View on explorer</a>}
      {tx.hash && demo && <p className="mt-1 text-xs text-mute">Simulated reference {tx.hash}</p>}
    </div>
  );
}
