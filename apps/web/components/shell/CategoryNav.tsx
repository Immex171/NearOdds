"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { useApp } from "@/lib/app-context";

type Item = { label: string; href: string; match: (p: URLSearchParams, path: string) => boolean };

export function CategoryNav() {
  const path = usePathname();
  const sp = useSearchParams();
  const { categories } = useApp();
  // Categories come from the backend (/v1/categories), so a new one such as "Weather" appears without a redeploy.
  const ITEMS: Item[] = [
    { label: "Trending", href: "/", match: (p, pth) => pth === "/" },
    { label: "New", href: "/markets?view=new", match: (p, pth) => pth === "/markets" && p.get("view") === "new" },
    ...categories.map((c) => ({
      label: c.category, href: `/markets?category=${encodeURIComponent(c.category)}`, match: (p: URLSearchParams, pth: string) => pth === "/markets" && p.get("category")?.toLowerCase() === c.category.toLowerCase(),
    })),
  ];
  return (
    <nav aria-label="Categories" className="border-t border-line/60">
      <ul className="no-scrollbar mx-auto flex h-11 max-w-[1320px] items-stretch gap-1 overflow-x-auto px-4 md:gap-3 md:px-6">
        {ITEMS.map((i) => {
          const active = i.match(sp, path);
          return (
            <li key={i.label} className="shrink-0">
              <Link href={i.href} aria-current={active ? "page" : undefined}
                className={`relative flex h-full items-center px-2.5 text-sm font-medium ${active ? "text-fg" : "text-mute hover:text-fg"}`}>
                {i.label}
                {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
