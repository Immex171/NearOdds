"use client";
import { useState } from "react";
import { formatUnits, tryParseUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { money } from "@/lib/format";
import type { Market } from "@/lib/types";
import { TransactionStatus } from "../account/TransactionStatus";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/bits";

export function ManageShares({ m, open, onClose }: { m: Market; open: boolean; onClose: () => void }) {
  const { adapter, account, session, setConnectOpen, showToast } = useApp();
  const [mode, setMode] = useState<"split" | "merge">("split");
  const [amt, setAmt] = useState("");
  const { tx, run, reset, busy } = useTx();
  const sym = adapter.symbol;
  const parsed = tryParseUnits(amt);
  const v = parsed.ok ? parsed.value : 0n;
  const yes = account?.positions.find((p) => p.marketId === m.id && p.outcome === "YES")?.qty ?? 0n;
  const no = account?.positions.find((p) => p.marketId === m.id && p.outcome === "NO")?.qty ?? 0n;
  const avail = account?.available ?? 0n;
  const maxV = mode === "split" ? avail : yes < no ? yes : no;
  let problem: string | null = null;
  if (!parsed.ok) problem = amt ? parsed.error : "Enter an amount";
  else if (v === 0n) problem = "Enter an amount above zero";
  else if (v > maxV) problem = mode === "split" ? "Insufficient available collateral" : "Insufficient shares: you need equal YES and NO";
  else if (mode === "split" && !(m.flags?.splitOpen ?? m.status === "open")) problem = "Creating shares is closed: the market cutoff has passed";
  else if (mode === "merge" && !(m.flags?.mergeOpen ?? m.status !== "resolved")) problem = "Combining shares is closed: this market is resolved. Redeem instead";
  else if (adapter.id === "near" && account?.registered === false) problem = "Register with the market first (Funds page)";
  const ok = problem == null && !!account;
  const confirm = async () => {
    const done = await run((r) => (mode === "split" ? adapter.split(m.id, v, r) : adapter.merge(m.id, v, r)));
    if (done) { setAmt(""); showToast(adapter.id === "demo" ? "Demo: shares updated" : "Shares updated"); }
  };
  const after = mode === "split"
    ? { c: avail - v, y: yes + v, n: no + v } : { c: avail + v, y: yes - v, n: no - v };
  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Manage shares" variant="sheet">
      {!account ? (
        <div><p className="text-mute">Connect a wallet or use the demo account to manage shares.</p><Btn className="mt-3 w-full" onClick={() => setConnectOpen(true)}>Connect wallet</Btn></div>
      ) : (
        <div className="space-y-4">
          <div role="tablist" className="grid grid-cols-2 rounded-lg bg-elev p-0.5">
            {([["split", "Create YES + NO shares"], ["merge", "Combine YES + NO shares"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={mode === k} onClick={() => { setMode(k); reset(); }} className={`min-h-10 rounded-md px-2 text-xs font-semibold ${mode === k ? "bg-card text-fg" : "text-mute"}`}>{l}</button>
            ))}
          </div>
          <p className="text-sm text-mute">
            {mode === "split" ? `1 ${sym} becomes 1 YES + 1 NO share. The collateral is locked in this market.` : `1 YES + 1 NO share returns 1 ${sym} to your available balance.`}
          </p>
          <div>
            <label htmlFor="ms-amt" className="text-xs text-mute">{mode === "split" ? `Collateral (${sym})` : "Pairs of shares"}</label>
            <div className="mt-1 flex gap-2">
              <input id="ms-amt" inputMode="decimal" value={amt} onChange={(e) => { setAmt(e.target.value); reset(); }} placeholder="0" aria-invalid={!!amt && !!problem}
                className="min-h-11 flex-1 rounded-lg border border-line bg-page px-3 text-base" />
              <Btn variant="outline" type="button" onClick={() => setAmt(formatUnits(maxV))}>Max</Btn>
            </div>
            {amt && problem && <p className="mt-1 text-xs text-no" role="alert">{problem}</p>}
          </div>
          <dl className="space-y-1.5 rounded-xl bg-elev p-3 text-sm">
            {([["Available collateral", avail, after.c, sym], ["YES shares", yes, after.y, ""], ["NO shares", no, after.n, ""]] as const).map(([l, b, a, s]) => (
              <div key={l} className="flex justify-between"><dt className="text-mute">{l}</dt><dd>{formatUnits(b, 2, 2)} → <b>{ok ? formatUnits(a, 2, 2) : formatUnits(b, 2, 2)}</b> {s}</dd></div>
            ))}
          </dl>
          <TransactionStatus tx={tx} demo={adapter.id === "demo"} />
          <Btn className="w-full" disabled={!ok || busy} onClick={confirm}>
            {busy ? "Working…" : adapter.id === "demo" ? (mode === "split" ? "Simulate create shares" : "Simulate combine shares") : mode === "split" ? "Create YES + NO shares" : "Combine YES + NO shares"}
          </Btn>
          {session.kind === "demo" && <p className="text-center text-xs text-mute">Demo mode: nothing is sent to a wallet. Balance: {money(avail, sym)}</p>}
        </div>
      )}
    </Modal>
  );
}
