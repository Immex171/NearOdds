"use client";
import { useState } from "react";
import { useApp } from "@/lib/app-context";
import type { Filters } from "@/lib/filters";
import { Browser } from "@/components/discovery/Browser";
import { FeaturedMarket, TrendingSidebar } from "@/components/discovery/FeaturedMarket";
import { ErrorState } from "@/components/ui/bits";

const INIT: Filters = { category: null, status: [], period: [], tags: [], saved: false, q: "", sort: "trending", view: null };

export default function Home() {
  const { markets, marketsError, refresh } = useApp();
  const [f, setF] = useState<Filters>(INIT);
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        {marketsError ? <ErrorState message={marketsError} onRetry={refresh} /> : <FeaturedMarket markets={markets} />}
        <TrendingSidebar markets={markets} />
      </div>
      <Browser f={f} setF={setF} rail={false} title="All markets" />
    </div>
  );
}
