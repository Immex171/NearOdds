"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/** Dialog that becomes a bottom sheet on mobile (variant="sheet") or a side drawer (variant="drawer"). */
export function Modal({ open, onClose, title, children, variant = "dialog", wide = false }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; variant?: "dialog" | "sheet" | "drawer"; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    const o = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = o; prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  const pos =
    variant === "sheet" ? "items-end md:items-center" : variant === "drawer" ? "items-stretch justify-start" : "items-center";
  const box =
    variant === "sheet" ? "max-h-[88dvh] w-full rounded-t-2xl md:max-w-md md:rounded-2xl"
    : variant === "drawer" ? "h-dvh w-[88vw] max-w-sm rounded-r-2xl"
    : `max-h-[88dvh] w-[calc(100%-2rem)] ${wide ? "max-w-2xl" : "max-w-md"} rounded-2xl`;
  return (
    <div className={`fixed inset-0 z-50 flex justify-center ${pos}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-black/60" aria-hidden onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={`relative flex flex-col overflow-hidden border border-line bg-card shadow-2xl outline-none ${box}`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-lg text-mute hover:bg-white/10 hover:text-fg"><Icon name="close" /></button>
        </div>
        <div className="overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  );
}
