"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { useApp } from "@/lib/app-context";
import { Logo } from "../ui/Icon";
import { CategoryNav } from "./CategoryNav";
import { SearchDialog } from "./SearchDialog";
import { AccountMenu } from "./AccountMenu";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" || path.startsWith("/markets") : path.startsWith(href);
  return (
    <Link href={href} aria-current={active ? "page" : undefined}
      className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${active ? "text-fg" : "text-mute hover:text-fg"}`}>{children}</Link>
  );
}

export function AppHeader() {
  const { adapter, setHelpOpen } = useApp();
  const live = adapter.id === "near";
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-page">
      <div className="border-b border-brand/30 bg-brand/10 text-center py-0.5 text-xs text-[#c5ccff]" role="status">
        {live ? "Testnet, test funds only — live contract data" : "Demo mode — sample markets and balances"}
      </div>
        <div className="mx-auto flex h-[60px] max-w-[1320px] items-center gap-3 px-4 md:h-[68px] md:gap-5 md:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="NearOdds home">
            <Logo />
            <span className="hidden text-lg font-bold tracking-tight min-[420px]:inline">NearOdds</span>
          </Link>
          <nav aria-label="Primary" className="hidden items-center md:flex">
            <NavLink href="/markets">Markets</NavLink>
            <NavLink href="/portfolio">Portfolio</NavLink>
          </nav>
          <SearchDialog />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button onClick={() => setHelpOpen(true)} className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-mute hover:text-fg xl:block">How it works</button>
            <span className={`hidden rounded-full border px-2.5 py-1 text-xs font-medium lg:inline-flex ${live ? "border-yes/40 text-yes" : "border-line text-mute"}`}>
              {live ? "NEAR testnet" : "Demo"}
            </span>
            <AccountMenu />
          </div>
        </div>
        <Suspense fallback={<div className="h-11 border-t border-line" />}>
          <CategoryNav />
        </Suspense>
      </header>
    </>
  );
}

