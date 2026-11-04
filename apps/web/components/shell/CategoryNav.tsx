"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const ITEMS: { label: string; href: string; match: (p: URLSearchParams, path: string) => boolean }[] = [
  { label: "Trending", href: "/", match: (p, path) => path === "/" },
  { label: "New", href: "/markets?view=new", match: (p, path) => path === "/markets" && p.get("view") === "new" },
  ...["Crypto", "Sports", "Politics", "Economy", "Technology"].map((c) => ({
    label: c, href: `/markets?category=${c}`, match: (p: URLSearchParams, path: string) => path === "/markets" && p.get("category") === c,
  })),
];

export function CategoryNav() {
  const path = usePathname();
  const sp = useSearchParams();
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
