"use client";
import { useState } from "react";
import { formatUnits, tryParseUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { config } from "@/lib/config";
import { useTx } from "@/lib/hooks";
import { money, nearStr } from "@/lib/format";
import { Btn } from "../ui/bits";
import { TransactionStatus } from "./TransactionStatus";

function Form({ kind }: { kind: "deposit" | "withdraw" }) {
  const { adapter, account, showToast } = useApp();
  const [amt, setAmt] = useState("");
  const [review, setReview] = useState(false);
  const { tx, run, reset, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = adapter.symbol;
  const max = kind === "deposit" ? account?.walletBalance ?? 0n : account?.available ?? 0n;
  const p = tryParseUnits(amt);
  const v = p.ok ? p.value : 0n;
  const pending = kind === "withdraw" && (account?.pendingWithdrawal ?? 0n) > 0n && !demo;
  let err: string | null = null;
  if (!p.ok) err = amt ? p.error : "Enter an amount";
  else if (v === 0n) err = "Enter an amount above zero";
  else if (v > max) err = kind === "deposit" ? "Insufficient wallet balance" : "Insufficient available collateral";
  else if (pending) err = "A withdrawal is already in progress";
  else if (!demo && account && !account.registered) err = "Register first";
  const word = kind === "deposit" ? "Deposit" : "Withdraw";
  const act = async () => {
    const ok = await run((r) => (kind === "deposit" ? adapter.deposit(v, r) : adapter.withdraw(v, r)));
    if (ok) { setAmt(""); setReview(false); showToast(demo ? `Demo ${kind} completed` : `${word} submitted`); }
  };
  return (
    <div className="rounded-[14px] border border-line bg-card p-4">
      <h2 className="text-lg font-semibold">{word}</h2>
      <p className="mt-1 text-sm text-mute">{kind === "deposit" ? "Move collateral from your wallet into NearOdds so you can trade." : "Send available collateral back to your wallet."}</p>
      <label htmlFor={`${kind}-amt`} className="mt-3 block text-xs text-mute">Amount ({sym})</label>
      <div className="mt-1 flex gap-2">
        <input id={`${kind}-amt`} inputMode="decimal" placeholder="0" value={amt} aria-invalid={!!amt && !!err}
          onChange={(e) => { setAmt(e.target.value); setReview(false); reset(); }} className="min-h-11 w-full rounded-lg border border-line bg-page px-3 text-base" />
        <Btn variant="outline" type="button" onClick={() => { setAmt(formatUnits(max)); setReview(false); }}>Max</Btn>
      </div>
      <p className="mt-1 text-xs text-mute">Maximum: {money(max, sym)}</p>
      {amt && err && <p role="alert" className="mt-1 text-xs text-no">{err}</p>}
      {review && !err && <p className="mt-3 rounded-lg bg-elev px-3 py-2 text-sm">{word} <b>{money(v, sym)}</b>{demo ? " (simulated)." : kind === "deposit" ? " from your wallet. If the contract refunds it, your balance won’t change." : ". The transfer settles asynchronously."}</p>}
      <div className="mt-3"><TransactionStatus tx={tx} demo={demo} /></div>
      <Btn className="mt-3 w-full" disabled={!!err || busy} onClick={() => (review ? void act() : setReview(true))}>
        {busy ? "Working…" : review ? (demo ? `Simulate ${kind}` : `Confirm ${kind}`) : "Review"}
      </Btn>
    </div>
  );
}

export function FundsPanel() {
  const { adapter, account, showToast } = useApp();
  const reg = useTx();
  if (!account) return null;
  const sym = adapter.symbol;
  const demo = adapter.id === "demo";
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([["In your wallet", account.walletBalance, "Held by you, outside NearOdds"], ["In NearOdds", account.available, "Available to trade or withdraw"],
          ["Committed to offers", account.committed, "Locked by your resting buy offers"], ["Pending withdrawals", account.pendingWithdrawal, "On the way to your wallet"]] as const).map(([k, v, n]) => (
          <div key={k} className="rounded-[14px] border border-line bg-card p-3.5"><p className="text-xs text-mute">{k}</p><p className="mt-1 text-lg font-semibold">{money(v, sym)}</p><p className="mt-0.5 text-xs text-mute">{n}</p></div>
        ))}
      </div>
      <div className="rounded-[14px] border border-line bg-card p-3.5 text-sm" aria-label="Native NEAR registration">
        <p className="text-xs text-mute">Native NEAR registration (separate from trading collateral)</p>
        <p className="mt-1 font-semibold">{demo ? "Not needed in demo mode" : account.storageCostYocto != null ? `${nearStr(account.storageCostYocto)} one-time storage deposit` : "—"}</p>
        <p className="mt-0.5 text-xs text-mute">{demo ? "On testnet you pay this in NEAR, not in tNOC, to register with the market." : account.registered ? "You are registered with the market." : "Not registered yet. This NEAR pays for your account’s storage, including up to 10 open offers; it is not collateral and can’t be traded."}</p>
      </div>
      {!demo && account.registered === false && (
        <div className="rounded-[14px] border border-brand/40 bg-brand/10 p-4">
          <p className="font-semibold">Register to use NearOdds</p>
          <p className="mt-1 text-sm text-mute">Your account must be registered with the market contract (a small refundable-storage NEAR deposit, separate from collateral) and with the token before depositing.</p>
          <TransactionStatus tx={reg.tx} demo={false} />
          <Btn className="mt-3" disabled={reg.busy} onClick={() => void reg.run((r) => adapter.register!(r))}>Register with market</Btn>
        </div>
      )}
      {!demo && account.withdrawalStatus === "Pending" && <p role="status" className="rounded-xl border border-line bg-elev px-4 py-3 text-sm">Withdrawal in progress. Do not submit another one. If it stays pending for more than a minute, the transfer may have been sent but is unconfirmed — do not retry; automatic recovery is not available yet.</p>}
      {!demo && account.withdrawalStatus === "FailedRestored" && <p role="status" className="rounded-xl border border-line bg-elev px-4 py-3 text-sm">The token transfer failed and your collateral was returned to your available balance.</p>}
      {!demo && config.faucetNote && <p className="rounded-xl bg-elev px-4 py-3 text-sm text-mute">Need test tokens? {config.faucetNote} Test tokens have no monetary value.</p>}
      <div className="grid gap-4 md:grid-cols-2"><Form kind="deposit" /><Form kind="withdraw" /></div>
      {demo && <p className="text-xs text-mute" onClick={() => showToast("Demo only")}>Demo mode: deposits and withdrawals only move sample balances.</p>}
    </div>
  );
}
