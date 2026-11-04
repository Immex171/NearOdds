"use client";
import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/lib/app-context";
import { money, shortDate } from "@/lib/format";
import { OpenOffersList } from "@/components/account/OpenOffersList";
import { PositionsList, estimate } from "@/components/account/PositionsList";
import { Btn, EmptyState, ErrorState, Skeleton } from "@/components/ui/bits";

type Tab = "positions" | "offers" | "activity";

export default function Portfolio() {
  const { session, account, accountError, adapter, markets, setConnectOpen, refresh } = useApp();
  const [tab, setTab] = useState<Tab>("positions");
  const sym = adapter.symbol;
  if (session.kind === "none") {
    return <EmptyState title="Connect to see your portfolio" body="Use the demo account to explore with sample balances, or connect a NEAR wallet." action={<Btn onClick={() => setConnectOpen(true)}>Connect wallet</Btn>} />;
  }
  if (accountError) return <ErrorState message={accountError} onRetry={refresh} />;
  if (!account) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  const est = account.positions.reduce((a, p) => a + (estimate(p, markets?.find((m) => m.id === p.marketId)) ?? 0n), 0n);
  const tabs: [Tab, string, number?][] = [["positions", "Positions", account.positions.length], ["offers", "Open offers", account.offers.length], ["activity", "Activity"]];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold md:text-[28px]">Portfolio</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat k="Available collateral" v={money(account.available, sym)} />
        <Stat k="Committed to offers" v={money(account.committed, sym)} />
        <Stat k="Position estimate" v={money(est, sym)} note="Based on display prices, not executable quotes" />
        <Stat k="Wallet balance" v={money(account.walletBalance, sym)} note={<Link href="/funds" className="text-brand">Manage funds</Link>} />
      </div>
      <div role="tablist" className="flex gap-1 border-b border-line">
        {tabs.map(([k, l, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`relative min-h-11 px-4 text-sm font-semibold ${tab === k ? "text-fg" : "text-mute hover:text-fg"}`}>
            {l}{n != null && <span className="ml-1.5 text-xs text-mute">{n}</span>}
            {tab === k && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-brand" />}
          </button>
        ))}
      </div>
      {tab === "positions" && <PositionsList positions={account.positions} />}
      {tab === "offers" && (adapter.capabilities.limitOffers ? <OpenOffersList offers={account.offers} /> : <EmptyState title="Offers aren’t live yet" body="The deployed contract doesn’t support offers. They’ll appear here once it does." />)}
      {tab === "activity" && (account.activity.length === 0 ? <EmptyState title="No activity yet" body={adapter.id === "near" ? "Activity history needs an indexer, which doesn’t exist yet." : undefined} /> : (
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
