"use client";
import { Suspense, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Browser } from "@/components/discovery/Browser";
import { parseFilters, toParams, type Filters } from "@/lib/filters";

function Inner() {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const f = useMemo(() => parseFilters(new URLSearchParams(sp.toString())), [sp]);
  const setF = (n: Filters) => { const q = toParams(n); router.replace(q ? `${path}?${q}` : path, { scroll: false }); };
  const title = f.category ?? (f.view === "new" ? "New markets" : f.q ? "Search results" : "All markets");
  return <Browser f={f} setF={setF} rail title={title} />;
}

export default function MarketsPage() {
  return <Suspense><Inner /></Suspense>;
}
