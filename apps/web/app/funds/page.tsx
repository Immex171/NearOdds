"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/app-context";
import { FundsPanel } from "@/components/account/FundsPanel";
import { DataNotice } from "@/components/shell/DataNotice";
import { Btn, EmptyState, ErrorState, Skeleton } from "@/components/ui/bits";
import { money, shortAccount } from "@/lib/format";
import { holdingOf } from "@/lib/account";

function Funds() {
  const { session, markets, marketsError, account, setConnectOpen, refresh, adapter } = useApp();
  const sp = useSearchParams();
  const router = useRouter();
  if (session.kind === "none") return <EmptyState title="Connect to manage funds" action={<Btn onClick={() => setConnectOpen(true)}>Connect wallet</Btn>} />;
  if (!markets) return marketsError ? <ErrorState message={marketsError} onRetry={refresh} /> : <Skeleton className="h-64" />;
  if (!markets.length) return <EmptyState title="No markets yet" body="Funds are managed per market. A market has to exist first." />;
  const chosen = markets.find((m) => m.id === sp.get("market")) ?? markets.find((m) => m.status === "open") ?? markets[0];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold md:text-[28px]">Funds</h1>
        {markets.length > 1 || adapter.id === "near" ? (
          <label className="block min-w-0 text-xs text-mute">Market contract
            <select value={chosen.id} onChange={(e) => router.replace(`/funds?market=${encodeURIComponent(e.target.value)}`)} data-testid="market-picker"
              className="mt-1 block h-11 w-full max-w-[420px] rounded-lg border border-line bg-card px-3 text-sm text-fg">
              {markets.map((m) => <option key={m.id} value={m.id}>{m.question}{m.contract ? ` · ${shortAccount(m.contract.contractId)}` : ""}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      <DataNotice market={chosen} />
      <FundsPanel key={chosen.id} m={chosen} />
      {adapter.id === "near" && account && account.holdings.length > 0 && (
        <section aria-label="Deposits by market" className="rounded-[14px] border border-line bg-card p-4" data-testid="deposits-by-market">
          <h2 className="text-lg font-semibold">Your deposits by market</h2>
          <p className="mt-1 text-xs text-mute">Each market contract holds its own deposit. These are separate balances, not one pool.</p>
          <ul className="mt-2 divide-y divide-line/60 text-sm">
            {account.holdings.map((h) => {
              const mk = markets.find((x) => x.id === h.marketRef);
              return (
                <li key={h.marketRef} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0"><Link href={`/funds?market=${encodeURIComponent(h.marketRef)}`} className="font-medium hover:underline">{mk?.question ?? h.marketRef}</Link>
                    {mk?.contract && <span className="block truncate text-xs text-mute">{mk.contract.contractId}</span>}</span>
                  <span className="text-right">{money(holdingOf(account, { id: h.marketRef })?.available ?? 0n, h.symbol)} <span className="text-xs text-mute">available · {money(h.committed, h.symbol)} in offers</span></span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function Page() { return <Suspense><Funds /></Suspense>; }
