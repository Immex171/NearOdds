"use client";
import Link from "next/link";
import { formatUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { priceStr } from "@/lib/format";
import type { OpenOffer } from "@/lib/types";
import { Badge, Btn, EmptyState } from "../ui/bits";

export function OpenOffersList({ offers }: { offers: OpenOffer[] }) {
  const { markets, adapter, showToast } = useApp();
  const { run, busy } = useTx();
  if (!offers.length) return <EmptyState title="No open offers" body="Limit offers you place will rest here until someone takes them." />;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-card">
      {offers.map((o) => {
        const m = markets?.find((x) => x.id === o.marketId);
        return (
          <li key={o.id} className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_110px_90px_110px_110px] md:items-center">
            <div className="min-w-0">
              <Link href={`/markets/${o.marketId}`} className="line-clamp-2 font-medium hover:underline">{m?.question ?? o.marketId}</Link>
              <div className="mt-1 flex items-center gap-2"><Badge tone={o.outcome === "YES" ? "yes" : "no"}>{o.outcome}</Badge><Badge>{o.side === "buy" ? "Buy" : "Sell"}</Badge></div>
            </div>
            <Cell k="Price" v={`${priceStr(o.price)} ${adapter.symbol}`} />
            <Cell k="Remaining" v={formatUnits(o.qty, 0, 2)} />
            <Cell k="Status" v="Open" />
            <div className="md:text-right">
              {adapter.capabilities.cancelOffers && (
                <Btn variant="danger" disabled={busy} onClick={() => void run((r) => adapter.cancelOffer(o.id, r)).then((ok) => ok && showToast("Demo offer cancelled"))}>Cancel</Btn>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between md:block md:text-right"><span className="text-xs text-mute md:hidden">{k}</span><span className="text-sm">{v}</span></div>;
}
