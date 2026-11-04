import type { Market } from "@/lib/types";
import { CardSkeleton, MarketCard } from "./MarketCard";

export function MarketGrid({ markets, cols = "home" }: { markets: Market[] | null; cols?: "home" | "category" }) {
  const grid = cols === "home"
    ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3";
  return (
    <div className={`grid gap-3 ${grid}`}>
      {markets ? markets.map((m) => <MarketCard key={m.id} m={m} />) : Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}
    </div>
  );
}
