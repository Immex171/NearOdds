"use client";
import { useEffect, useState } from "react";
import { formatUnits, tryParseUnits } from "@/lib/amounts";
import { holdingOf, walletOf } from "@/lib/account";
import { useApp, useDeployment, useMarketAccount } from "@/lib/app-context";
import { explorerAccount } from "@/lib/config";
import { useTx } from "@/lib/hooks";
import { money, nearStr } from "@/lib/format";
import type { AccountState, Market } from "@/lib/types";
import { Btn } from "../ui/bits";
import { FaucetPanel } from "./FaucetPanel";
import { TransactionStatus } from "./TransactionStatus";

function Form({ kind, m, account }: { kind: "deposit" | "withdraw"; m: Market; account: AccountState }) {
  const { adapter, showToast } = useApp();
  const { deployment } = useDeployment(m);
  const holding = holdingOf(account, m);
  const wallet = walletOf(account, m);
  const [amt, setAmt] = useState("");
  const [review, setReview] = useState(false);
  const { tx, run, reset, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = m.token.symbol;
  const max = kind === "deposit" ? wallet?.balance ?? 0n : holding?.available ?? 0n;
  const p = tryParseUnits(amt);
  const v = p.ok ? p.value : 0n;
  const pending = kind === "withdraw" && (holding?.pendingWithdrawal ?? 0n) > 0n && !demo;
  let err: string | null = null;
  if (!p.ok) err = amt ? p.error : "Enter an amount";
  else if (v === 0n) err = "Enter an amount above zero";
  else if (v > max) err = kind === "deposit" ? "Insufficient wallet balance" : "Insufficient available collateral";
  else if (pending) err = "A withdrawal is already in progress";
  else if (!demo && deployment.state !== "ok") err = deployment.state === "error" ? "This market failed verification" : "Verifying this market…";
  else if (!demo && (!holding?.registered || !wallet?.tokenRegistered)) err = "Finish account setup for this market first";
  const word = kind === "deposit" ? "Deposit" : "Withdraw";
  const act = async () => {
    const ok = await run((r) => (kind === "deposit" ? adapter.deposit(m, v, r) : adapter.withdraw(m, v, r)));
    if (ok) { setAmt(""); setReview(false); showToast(demo ? `Demo ${kind} completed` : `${word} finished: see the status above`); }
  };
  return (
    <div className="rounded-[14px] border border-line bg-card p-4">
      <h2 className="text-lg font-semibold">{word} <span className="text-sm font-normal text-mute">· {m.question.length > 40 ? `${m.question.slice(0, 39)}…` : m.question}</span></h2>
      <p className="mt-1 text-sm text-mute">{kind === "deposit" ? `Move ${sym} from your wallet into THIS market’s contract (${m.contract?.contractId ?? "demo"}). Each market keeps its own deposit.` : "Send this market’s available collateral back to your wallet. If you won a resolved market, redeem it first on the market page."}</p>
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

/** Live account setup for ONE market: native NEAR, token registration, market registration, test tokens, deposit. Each step reflects chain state. */
function SetupChecklist({ m, account }: { m: Market; account: AccountState }) {
  const { adapter, accountId, wrongNetwork } = useApp();
  const { deployment, retry } = useDeployment(m);
  const tokenReg = useTx();
  const marketReg = useTx();
  if (adapter.id !== "near" || !accountId) return null;
  const costs = adapter.costs?.(m) ?? null;
  const holding = holdingOf(account, m);
  const wallet = walletOf(account, m);
  const sym = m.token.symbol;
  const tokenCost = costs?.tokenStorage ?? null;
  const marketCost = holding?.storageCostYocto ?? costs?.marketStorage ?? null;
  const needNear = tokenCost != null && marketCost != null ? tokenCost + marketCost + NEAR_MARGIN : null;
  const haveNear = account.nearBalance ?? null;
  const nearOk = needNear != null && haveNear != null && haveNear >= needNear;
  const tokenOk = wallet?.tokenRegistered === true;
  const marketOk = holding?.registered === true;
  const hasTokens = (wallet?.balance ?? 0n) > 0n || (holding?.available ?? 0n) > 0n;
  const hasDeposit = (holding?.available ?? 0n) > 0n;
  const disabled = deployment.state !== "ok" || wrongNetwork;
  const run = async (h: ReturnType<typeof useTx>, f: (r: Parameters<NonNullable<typeof adapter.registerToken>>[1]) => Promise<void>) => { await h.run(f); };
  return (
    <section aria-label="Account setup" className="rounded-[14px] border border-line bg-card p-4" data-testid="setup">
      <h2 className="text-lg font-semibold">Set up your account for this market</h2>
      <p className="mt-1 text-sm text-mute">Everything is signed in your wallet. Native NEAR pays for fees and storage; {sym} is the test collateral you trade with. Neither has monetary value. Registration and deposits are per market contract: <b className="text-fg">{m.contract?.contractId}</b>.</p>
      {deployment.state === "error" && <p role="alert" data-testid="deployment-error" className="mt-2 rounded-lg bg-no-bg/50 px-3 py-2 text-sm text-no">This market failed verification, so wallet actions are off: {deployment.problems.join(" ")} <button type="button" className="font-semibold underline" onClick={retry}>Check again</button></p>}
      <ol className="mt-2 divide-y divide-line/60">
        <Step n={1} done title={`Connected as ${accountId}`} />
        <Step n={2} done={nearOk} title="Testnet NEAR for fees and storage">
          {haveNear == null ? "Your NEAR balance could not be read." : <>You have <b className="text-fg">{nearStr(haveNear)}</b>.</>}{needNear != null && <> You need about {nearStr(needNear)} for both registrations plus fees.</>}
          {!nearOk && haveNear != null && <> Get testnet NEAR from a testnet faucet or your wallet’s testnet setup; NearOdds does not provide it.</>}
        </Step>
        <Step n={3} done={tokenOk} title={`Register with the ${sym} token`}>
          {tokenOk ? "Registered." : <>One-time storage deposit of <b className="text-fg">{tokenCost != null ? nearStr(tokenCost) : "…"}</b> paid in NEAR to <a className="text-brand underline" href={explorerAccount(m.contract?.tokenId ?? "")} target="_blank" rel="noreferrer">{m.contract?.tokenId}</a>. Needed to hold, deposit and withdraw {sym}.</>}
          {!tokenOk && (<div className="mt-2"><TransactionStatus tx={tokenReg.tx} demo={false} />
            <Btn className="mt-2" disabled={tokenReg.busy || disabled} onClick={() => void run(tokenReg, (r) => adapter.registerToken!(m, r))}>{tokenReg.busy ? "Working…" : "Register with token"}</Btn></div>)}
        </Step>
        <Step n={4} done={marketOk} title="Register with this market">
          {marketOk ? "Registered." : <>One-time storage deposit of <b className="text-fg">{marketCost != null ? nearStr(marketCost) : "…"}</b> paid in NEAR to this market’s contract. It prepays your account record, a withdrawal record and up to {m.limits.maxOpenOffers} open offers. It is not collateral.</>}
          {!marketOk && (<div className="mt-2"><TransactionStatus tx={marketReg.tx} demo={false} />
            <Btn className="mt-2" disabled={marketReg.busy || disabled} onClick={() => void run(marketReg, (r) => adapter.registerMarket!(m, r))}>{marketReg.busy ? "Working…" : "Register with market"}</Btn></div>)}
        </Step>
        <Step n={5} done={hasTokens} title={`Get ${sym} test collateral`}>
          {hasTokens ? <>You hold {money(wallet?.balance ?? 0n, sym)} in your wallet.</> : <>Use the faucet below, or ask the token owner ({costs?.tokenOwnerHint ?? "the operator"}) to mint some by hand with <code className="rounded bg-page px-1">scripts/testnet-mint.sh</code>.</>}
        </Step>
        <Step n={6} done={hasDeposit} title={`Deposit ${sym} into this market`}>{hasDeposit ? <>You have {money(holding?.available ?? 0n, sym)} available to trade here.</> : "Use the Deposit form below once steps 3–5 are done."}</Step>
      </ol>
    </section>
  );
}

function WithdrawalNotice({ m, account }: { m: Market; account: AccountState }) {
  const { adapter, now } = useApp();
  const w = holdingOf(account, m)?.withdrawal ?? null;
  // When this page first saw the withdrawal pending (the contract stores no timestamp for it).
  const [first, setFirst] = useState<{ id: string; t: number } | null>(null);
  const pendingId = w?.status === "Pending" ? w.id : null;
  // eslint-disable-next-line react-hooks/set-state-in-effect -- records an external fact (when it was first seen) once per withdrawal id
  useEffect(() => { if (pendingId && first?.id !== pendingId) setFirst({ id: pendingId, t: Date.now() }); }, [pendingId, first]);
  if (adapter.id !== "near" || !w) return null;
  const sym = m.token.symbol;
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
  if (w.status === "Unsettled") return <p role="status" className="rounded-xl border border-line bg-elev px-4 py-3 text-sm">An older withdrawal ({money(w.amount, sym)}) was recorded before indexing began, so its result is not known to the API. Check the contract record on the explorer.</p>;
  return <p role="status" className="rounded-xl border border-line bg-elev px-4 py-3 text-sm">Last withdrawal: {money(w.amount, sym)} was sent to your wallet and confirmed.</p>;
}

export function FundsPanel({ m }: { m: Market }) {
  const { adapter, showToast } = useApp();
  const { account, error } = useMarketAccount(m);
  const { deployment } = useDeployment(m);
  if (error && !account) return <p role="alert" className="rounded-xl border border-no/40 bg-no-bg/40 px-4 py-3 text-sm text-no" data-testid="funds-error">Couldn’t read your account in this market: {error}</p>;
  if (!account) return <div className="skeleton h-64" aria-hidden />;
  const sym = m.token.symbol;
  const demo = adapter.id === "demo";
  const holding = holdingOf(account, m);
  const wallet = walletOf(account, m);
  const hint = adapter.costs?.(m)?.tokenOwnerHint;
  return (
    <div className="space-y-5" data-testid="funds-panel" data-market={m.id}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([["In your wallet", wallet?.balance ?? null, `Your ${sym} wallet balance, outside NearOdds (shared by every market using this token)`],
          ["In this market", holding?.available ?? 0n, "Available here to trade or withdraw"],
          ["Committed to offers", holding?.committed ?? 0n, "Locked by your resting buy offers in this market"],
          ["Pending withdrawals", holding?.pendingWithdrawal ?? 0n, "Unconfirmed: not yet in your wallet"]] as const).map(([k, v, n]) => (
          <div key={k} className="rounded-[14px] border border-line bg-card p-3.5"><p className="text-xs text-mute">{k}</p><p className="mt-1 text-lg font-semibold" data-testid={`stat-${k}`}>{v == null ? "Unavailable" : money(v, sym)}</p><p className="mt-0.5 text-xs text-mute">{n}</p></div>
        ))}
      </div>
      {demo && (
        <div className="rounded-[14px] border border-line bg-card p-3.5 text-sm" aria-label="Native NEAR registration">
          <p className="text-xs text-mute">Native NEAR registration (separate from trading collateral)</p>
          <p className="mt-1 font-semibold">Not needed in demo mode</p>
          <p className="mt-0.5 text-xs text-mute">On testnet you pay storage deposits in NEAR, not in tNOC, to register with the token and the market.</p>
        </div>
      )}
      <SetupChecklist m={m} account={account} />
      {!demo && <FaucetPanel m={m} ownerHint={hint} />}
      <WithdrawalNotice m={m} account={account} />
      <div className="grid gap-4 md:grid-cols-2"><Form kind="deposit" m={m} account={account} /><Form kind="withdraw" m={m} account={account} /></div>
      {!demo && deployment.state === "ok" && <p className="text-xs text-mute">Verified: contract <b className="text-fg">{m.contract?.contractId}</b> · market id <b className="text-fg">{m.contract?.marketId}</b> · token <b className="text-fg">{m.contract?.tokenId}</b>.</p>}
      {!demo && <p className="rounded-xl bg-elev px-4 py-3 text-xs text-mute"><b className="text-fg">Redeem vs withdraw.</b> Redeeming a resolved market only credits your winnings to your available balance inside that market’s contract. Withdrawing is a separate step that sends available collateral to your wallet. A withdrawal marked Pending is unconfirmed and is never retried automatically. Test tokens have no monetary value.</p>}
      {demo && <p className="text-xs text-mute" onClick={() => showToast("Demo only")}>Demo mode: deposits and withdrawals only move sample balances.</p>}
    </div>
  );
}
