"use client";
import { useEffect, useState } from "react";
import { formatUnits, tryParseUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { config, explorerAccount } from "@/lib/config";
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
  else if (!demo && account && (!account.registered || !account.tokenRegistered)) err = "Finish account setup first";
  const word = kind === "deposit" ? "Deposit" : "Withdraw";
  const act = async () => {
    const ok = await run((r) => (kind === "deposit" ? adapter.deposit(v, r) : adapter.withdraw(v, r)));
    if (ok) { setAmt(""); setReview(false); showToast(demo ? `Demo ${kind} completed` : `${word} finished: see the status above`); }
  };
  return (
    <div className="rounded-[14px] border border-line bg-card p-4">
      <h2 className="text-lg font-semibold">{word}</h2>
      <p className="mt-1 text-sm text-mute">{kind === "deposit" ? "Move collateral from your wallet into NearOdds so you can trade." : "Send available collateral back to your wallet. If you won a resolved market, redeem it first on the market page."}</p>
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

const NEAR_MARGIN = 10n ** 22n; // 0.01 NEAR kept for gas on top of the two storage deposits

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-3">
      <span aria-hidden className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-yes-bg text-yes" : "bg-elev text-mute"}`}>{done ? "✓" : n}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title} <span className="sr-only">{done ? "(done)" : "(to do)"}</span></p>
        {children && <div className="mt-1 text-sm text-mute">{children}</div>}
      </div>
    </li>
  );
}

/** Live account setup: native NEAR, token registration, market registration, tNOC, deposit. Each step reflects chain state. */
function SetupChecklist() {
  const { adapter, account, accountId, deployment, wrongNetwork, showToast } = useApp();
  const tokenReg = useTx();
  const marketReg = useTx();
  if (!account || adapter.id !== "near" || !accountId) return null;
  const near = adapter as unknown as { settings: { cfg: { storage_cost_per_account: string; resolver_id: string }; tokenStorageMin: bigint } | null };
  const s = near.settings;
  const sym = adapter.symbol;
  const tokenCost = s?.tokenStorageMin ?? null;
  const marketCost = account.storageCostYocto ?? null;
  const needNear = tokenCost != null && marketCost != null ? tokenCost + marketCost + NEAR_MARGIN : null;
  const haveNear = account.nearBalance ?? 0n;
  const nearOk = needNear != null && haveNear >= needNear;
  const tokenOk = account.tokenRegistered === true;
  const marketOk = account.registered === true;
  const hasTokens = account.walletBalance > 0n || account.available > 0n;
  const hasDeposit = account.available > 0n;
  const disabled = deployment.state !== "ok" || wrongNetwork;
  const cmd = [`NEARODDS_TESTNET_PARENT=${s?.cfg.resolver_id ?? "<token owner account>"} \\`, `NEARODDS_TOKEN=${config.tokenContractId} \\`, `NEARODDS_MINT="${accountId}:100" \\`, "  bash scripts/testnet-mint.sh"].join("\n");
  const run = async (h: ReturnType<typeof useTx>, f: (r: Parameters<NonNullable<typeof adapter.registerToken>>[0]) => Promise<void>) => { await h.run(f); };
  return (
    <section aria-label="Account setup" className="rounded-[14px] border border-line bg-card p-4" data-testid="setup">
      <h2 className="text-lg font-semibold">Set up your testnet account</h2>
      <p className="mt-1 text-sm text-mute">Everything is signed in your wallet. Native NEAR pays for fees and storage; {sym} is the test collateral you trade with. Neither has monetary value.</p>
      <ol className="mt-2 divide-y divide-line/60">
        <Step n={1} done title={`Connected as ${accountId}`} />
        <Step n={2} done={nearOk} title="Testnet NEAR for fees and storage">
          You have <b className="text-fg">{nearStr(haveNear)}</b>.{needNear != null && <> You need about {nearStr(needNear)} for both registrations plus fees.</>}
          {!nearOk && <> Get testnet NEAR from a testnet faucet or your wallet’s testnet setup; NearOdds does not provide it.</>}
        </Step>
        <Step n={3} done={tokenOk} title={`Register with the ${sym} token`}>
          {tokenOk ? "Registered." : <>One-time storage deposit of <b className="text-fg">{tokenCost != null ? nearStr(tokenCost) : "…"}</b> paid in NEAR. Needed to hold, deposit and withdraw {sym}.</>}
          {!tokenOk && (<div className="mt-2"><TransactionStatus tx={tokenReg.tx} demo={false} />
            <Btn className="mt-2" disabled={tokenReg.busy || disabled} onClick={() => void run(tokenReg, (r) => adapter.registerToken!(r))}>{tokenReg.busy ? "Working…" : "Register with token"}</Btn></div>)}
        </Step>
        <Step n={4} done={marketOk} title="Register with the market">
          {marketOk ? "Registered." : <>One-time storage deposit of <b className="text-fg">{marketCost != null ? nearStr(marketCost) : "…"}</b> paid in NEAR. It prepays your account record, a withdrawal record and up to {account.maxOpenOffers} open offers. It is not collateral.</>}
          {!marketOk && (<div className="mt-2"><TransactionStatus tx={marketReg.tx} demo={false} />
            <Btn className="mt-2" disabled={marketReg.busy || disabled} onClick={() => void run(marketReg, (r) => adapter.registerMarket!(r))}>{marketReg.busy ? "Working…" : "Register with market"}</Btn></div>)}
        </Step>
        <Step n={5} done={hasTokens} title={`Get ${sym} test collateral`}>
          {hasTokens ? <>You hold {money(account.walletBalance, sym)} in your wallet.</> : <>There is <b className="text-fg">no public faucet</b>. {sym} is minted only by the token owner account ({s?.cfg.resolver_id ?? "the deployer"}), by hand. Ask the operator to run this for you (it registers you with the token first if needed):</>}
          {!hasTokens && (
            <div className="mt-2">
              <pre className="overflow-x-auto rounded-lg bg-page p-3 text-xs text-fg" data-testid="mint-command">{cmd}</pre>
              <button type="button" className="mt-1 text-xs font-semibold text-brand hover:underline" onClick={() => { void navigator.clipboard?.writeText(cmd).then(() => showToast("Command copied")).catch(() => showToast("Couldn’t copy")); }}>Copy command</button>
              <span className="ml-2 text-xs">Token contract: <a className="text-brand underline" href={explorerAccount(config.tokenContractId)} target="_blank" rel="noreferrer">{config.tokenContractId}</a></span>
            </div>
          )}
        </Step>
        <Step n={6} done={hasDeposit} title={`Deposit ${sym} into NearOdds`}>{hasDeposit ? <>You have {money(account.available, sym)} available to trade.</> : "Use the Deposit form below once steps 3–5 are done."}</Step>
      </ol>
    </section>
  );
}

function WithdrawalNotice() {
  const { account, adapter, now } = useApp();
  const w = account?.withdrawal;
  // When this page first saw the withdrawal pending (the contract stores no timestamp for it).
  const [first, setFirst] = useState<{ id: string; t: number } | null>(null);
  const pendingId = w?.status === "Pending" ? w.id : null;
  // eslint-disable-next-line react-hooks/set-state-in-effect -- records an external fact (when it was first seen) once per withdrawal id
  useEffect(() => { if (pendingId && first?.id !== pendingId) setFirst({ id: pendingId, t: Date.now() }); }, [pendingId, first]);
  if (!account || adapter.id !== "near" || !w) return null;
  const sym = adapter.symbol;
  const age = w.status === "Pending" && first?.id === w.id ? now - first.t : 0;
  if (w.status === "Pending") {
    return (
      <p role="status" data-testid="withdrawal-pending" className="rounded-xl border border-[#e8913a]/50 bg-[#e8913a]/10 px-4 py-3 text-sm">
        <b>Withdrawal of {money(w.amount, sym)} in progress: not confirmed.</b> The amount has left your available balance but the contract has not recorded the result, so it may or may not have reached your wallet. Do not submit another withdrawal.
        {age > 60_000 && <> This has not settled after about a minute. Do not retry. Automatic recovery is not available yet.</>}
      </p>
    );
  }
  if (w.status === "FailedRestored") return <p role="status" className="rounded-xl border border-line bg-elev px-4 py-3 text-sm">The last withdrawal ({money(w.amount, sym)}) failed at the token. Your collateral was returned to your available balance and can be traded or withdrawn again.</p>;
  return <p role="status" className="rounded-xl border border-line bg-elev px-4 py-3 text-sm">Last withdrawal: {money(w.amount, sym)} was sent to your wallet and confirmed.</p>;
}

export function FundsPanel() {
  const { adapter, account, showToast } = useApp();
  if (!account) return null;
  const sym = adapter.symbol;
  const demo = adapter.id === "demo";
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([["In your wallet", account.walletBalance, "Held by you, outside NearOdds"], ["In NearOdds", account.available, "Available to trade or withdraw"],
          ["Committed to offers", account.committed, "Locked by your resting buy offers"], ["Pending withdrawals", account.pendingWithdrawal, "Unconfirmed: not yet in your wallet"]] as const).map(([k, v, n]) => (
          <div key={k} className="rounded-[14px] border border-line bg-card p-3.5"><p className="text-xs text-mute">{k}</p><p className="mt-1 text-lg font-semibold">{money(v, sym)}</p><p className="mt-0.5 text-xs text-mute">{n}</p></div>
        ))}
      </div>
      {demo && (
        <div className="rounded-[14px] border border-line bg-card p-3.5 text-sm" aria-label="Native NEAR registration">
          <p className="text-xs text-mute">Native NEAR registration (separate from trading collateral)</p>
          <p className="mt-1 font-semibold">Not needed in demo mode</p>
          <p className="mt-0.5 text-xs text-mute">On testnet you pay storage deposits in NEAR, not in tNOC, to register with the token and the market.</p>
        </div>
      )}
      <SetupChecklist />
      <WithdrawalNotice />
      <div className="grid gap-4 md:grid-cols-2"><Form kind="deposit" /><Form kind="withdraw" /></div>
      {!demo && <p className="rounded-xl bg-elev px-4 py-3 text-xs text-mute"><b className="text-fg">Redeem vs withdraw.</b> Redeeming a resolved market only credits your winnings to your available balance inside NearOdds. Withdrawing is a separate step that sends available collateral to your wallet. A withdrawal marked Pending is unconfirmed and is never retried automatically. Test tokens have no monetary value.</p>}
      {demo && <p className="text-xs text-mute" onClick={() => showToast("Demo only")}>Demo mode: deposits and withdrawals only move sample balances.</p>}
    </div>
  );
}
