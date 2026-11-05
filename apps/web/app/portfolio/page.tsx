"use client";
import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/lib/app-context";
import { money, shortAccount, shortDate } from "@/lib/format";
import { DataNotice } from "@/components/shell/DataNotice";
import type { WithdrawalItem } from "@/lib/types";
import { nearStr } from "@/lib/format";
import { OpenOffersList } from "@/components/account/OpenOffersList";
import { PositionsList, estimate } from "@/components/account/PositionsList";
import { Btn, EmptyState, ErrorState, Skeleton } from "@/components/ui/bits";

type Tab = "positions" | "offers" | "withdrawals" | "activity";

export default function Portfolio() {
  const { session, account, accountError, adapter, markets, setConnectOpen, refresh } = useApp();
  const [tab, setTab] = useState<Tab>("positions");
  if (session.kind === "none") {
    return <EmptyState title="Connect to see your portfolio" body="Use the demo account to explore with sample balances, or connect a NEAR wallet." action={<Btn onClick={() => setConnectOpen(true)}>Connect wallet</Btn>} />;
  }
  if (accountError) return <ErrorState message={accountError} onRetry={refresh} />;
  if (!account) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  const est = new Map<string, bigint>(); // per token symbol: positions of different tokens are never added together
  for (const p of account.positions) {
    const m = markets?.find((x) => x.id === p.marketId);
    const v = estimate(p, m);
    if (m && v != null) est.set(m.token.symbol, (est.get(m.token.symbol) ?? 0n) + v);
  }
  const tabs: [Tab, string, number?][] = [["positions", "Positions", account.positions.length], ["offers", "Open offers", account.offers.length], ["withdrawals", "Withdrawals", account.withdrawals.length], ["activity", "Activity"]];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold md:text-[28px]">Portfolio</h1>
      <DataNotice />
      {account.notes?.map((n) => <p key={n} role="status" data-testid="portfolio-note" className="rounded-lg border border-[#e8913a]/40 bg-[#e8913a]/10 px-3 py-2 text-xs text-[#f3b36b]">{n}</p>)}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat k="Wallet balance" v={account.wallets.length ? account.wallets.map((w) => (w.balance == null ? `Unavailable (${w.symbol})` : money(w.balance, w.symbol))).join(" · ") : "No token"} note={<>Counted once per token. <Link href="/funds" className="text-brand">Manage funds</Link></>} />
        <Stat k="Position estimate" v={est.size ? [...est].map(([sym, v]) => money(v, sym)).join(" · ") : "No priced positions"} note="Based on display prices (midpoint or last trade), not executable quotes" />
        <Stat k="Open offers" v={String(account.offers.length)} note="Across all markets" />
        <Stat k="Native NEAR" v={account.nearBalance == null ? "Unavailable" : nearStr(account.nearBalance)} note="Fees and storage; separate from collateral" />
      </div>
      <section aria-label="Deposits by market" className="rounded-[14px] border border-line bg-card p-4" data-testid="deposits-by-market">
        <h2 className="text-base font-semibold">Deposited collateral by market</h2>
        <p className="text-xs text-mute">Each market contract holds its own deposit; they are separate balances.</p>
        {account.holdings.length === 0 ? <p className="mt-2 text-sm text-mute">You have not registered with any market yet.</p> : (
          <ul className="mt-2 divide-y divide-line/60 text-sm">
            {account.holdings.map((h) => {
              const mk = markets?.find((x) => x.id === h.marketRef);
              return (
                <li key={h.marketRef} className="grid gap-1 py-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" data-market={h.marketRef}>
                  <span className="min-w-0">{h.marketRef === "*" ? <span className="font-medium">Demo balance (one pooled sample balance)</span> : <Link href={`/funds?market=${encodeURIComponent(h.marketRef)}`} className="font-medium hover:underline">{mk?.question ?? h.marketRef}</Link>}
                    {mk?.contract && <span className="block truncate text-xs text-mute">{shortAccount(mk.contract.contractId)} · {mk.contract.marketId}</span>}
                    {h.driftNote && <span className="block text-xs text-[#f3b36b]">{h.driftNote}</span>}</span>
                  <span className="text-right">{money(h.available, h.symbol)} <span className="text-xs text-mute">available · {money(h.committed, h.symbol)} in offers{h.pendingWithdrawal > 0n ? ` · ${money(h.pendingWithdrawal, h.symbol)} withdrawal unconfirmed` : ""}</span></span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map(([k, l, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`relative min-h-11 shrink-0 px-4 text-sm font-semibold ${tab === k ? "text-fg" : "text-mute hover:text-fg"}`}>
            {l}{n != null && <span className="ml-1.5 text-xs text-mute">{n}</span>}
            {tab === k && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-brand" />}
          </button>
        ))}
      </div>
      {tab === "positions" && <PositionsList positions={account.positions} />}
      {tab === "offers" && (adapter.capabilities.limitOffers ? <OpenOffersList offers={account.offers} /> : <EmptyState title="Offers aren’t live yet" body="The deployed contract doesn’t support offers. They’ll appear here once it does." />)}
      {tab === "withdrawals" && <WithdrawalsList items={account.withdrawals} markets={markets} />}
      {tab === "activity" && (account.activity.length === 0 ? <EmptyState title="No activity yet" body={adapter.id === "near" ? "Nothing indexed for this account yet. Recent activity can lag the chain by a short while." : undefined} /> : (
        <ul className="divide-y divide-line rounded-[14px] border border-line bg-card">
          {account.activity.map((a) => <li key={a.id} className="flex justify-between gap-4 p-3 text-sm"><span>{a.text}</span><time className="shrink-0 text-xs text-mute">{shortDate(a.t)}</time></li>)}
        </ul>
      ))}
    </div>
  );
}

function Stat({ k, v, note }: { k: string; v: string; note?: React.ReactNode }) {
  return <div className="rounded-[14px] border border-line bg-card p-3.5"><p className="text-xs text-mute">{k}</p><p className="mt-1 text-lg font-semibold">{v}</p>{note && <p className="mt-0.5 text-xs text-mute">{note}</p>}</div>;
}

function WithdrawalsList({ items, markets }: { items: WithdrawalItem[]; markets: ReturnType<typeof useApp>["markets"] }) {
  if (!items.length) return <EmptyState title="No withdrawals" body="Withdrawals from any market will be listed here with their settlement status." />;
  const label = (w: WithdrawalItem) => w.status === "Pending" ? "Pending: not confirmed" : w.status === "Completed" ? "Completed: sent to your wallet" : w.status === "FailedRestored" ? "Failed: returned to your available balance" : "Unknown (before indexing)";
  return (
    <ul className="divide-y divide-line rounded-[14px] border border-line bg-card" data-testid="withdrawals">
      {items.map((w) => {
        const m = markets?.find((x) => x.id === w.marketRef);
        return (
          <li key={w.ref} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-status={w.status}>
            <span className="min-w-0"><span className="font-medium">{m?.question ?? w.marketRef}</span><span className="block text-xs text-mute">Withdrawal #{w.id}{m?.contract ? ` · ${shortAccount(m.contract.contractId)}` : ""}</span></span>
            <span className="text-right"><b>{money(w.amount, m?.token.symbol ?? "")}</b><span className={`block text-xs ${w.status === "Pending" ? "text-[#f3b36b]" : "text-mute"}`}>{label(w)}</span></span>
          </li>
        );
      })}
    </ul>
  );
}
