"use client";
import { useMemo, useState } from "react";
import { ONE, formatUnits, mulPrice, tryParseUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { money, priceStr } from "@/lib/format";
import { bestPrice, depth, quoteTake } from "@/lib/quote";
import type { Market, Offer, Outcome, Side } from "@/lib/types";
import { TransactionStatus } from "../account/TransactionStatus";
import { Btn } from "../ui/bits";

function Seg<T extends string>({ value, onChange, options, label, tone }: {
  value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[]; label: string; tone?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded-lg bg-elev p-0.5">
      {options.map(([k, l]) => {
        const on = value === k;
        const c = on ? (tone ? (k === "YES" ? "bg-yes-bg text-yes" : "bg-no-bg text-no") : "bg-card text-fg shadow") : "text-mute hover:text-fg";
        return <button key={k} type="button" role="radio" aria-checked={on} onClick={() => onChange(k)} className={`min-h-10 rounded-md px-2 text-sm font-semibold ${c}`}>{l}</button>;
      })}
    </div>
  );
}

export function TradeTicket({ m, book, initialOutcome }: { m: Market; book: Offer[]; initialOutcome: Outcome }) {
  const { adapter, account, accountId, session, setConnectOpen, showToast } = useApp();
  const [side, setSide] = useState<Side>("buy");
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);
  const [mode, setMode] = useState<"take" | "limit">("take");
  const [qtyS, setQtyS] = useState("");
  const [priceS, setPriceS] = useState("");
  const [review, setReview] = useState(false);
  const { tx, run, reset, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = adapter.symbol;
  const caps = adapter.capabilities;
  const edit = () => { setReview(false); if (tx.phase !== "idle") reset(); };

  const holding = account?.positions.find((p) => p.marketId === m.id && p.outcome === outcome)?.qty ?? 0n;
  const avail = account?.available ?? 0n;
  const q = tryParseUnits(qtyS);
  const qty = q.ok ? q.value : 0n;
  const pr = tryParseUnits(priceS);
  const limitPrice = pr.ok ? pr.value : 0n;
  const quote = useMemo(() => quoteTake(book, outcome, side, qty > 0n ? qty : 1n, accountId ?? undefined), [book, outcome, side, qty, accountId]);
  const dep = depth(book, outcome, side, accountId ?? undefined);
  const best = bestPrice(book, outcome, side, accountId ?? undefined);
  const edge = bestPrice(book, outcome, side, accountId ?? undefined);

  const unitPrice = mode === "take" ? (qty > 0n ? quote.avgPrice : best) : pr.ok ? limitPrice : null;
  const total = mode === "take" ? (qty > 0n ? quoteTake(book, outcome, side, qty, accountId ?? undefined).total : 0n) : mulPrice(limitPrice, qty);

  // First blocking reason, in the order the user should fix it.
  let block: string | null = null;
  let hint: string | null = null;
  const takeQ = qty > 0n ? quoteTake(book, outcome, side, qty, accountId ?? undefined) : null;
  if (m.status !== "open") block = "Market closed";
  else if (!session.kind || session.kind === "none") block = null;
  else if (!caps.trading) block = "Trading unavailable";
  else if (mode === "limit" && !caps.limitOffers) block = "Limit offers unavailable";
  else if (!q.ok) block = qtyS ? q.error : "Enter an amount";
  else if (qty === 0n) block = "Enter an amount";
  else if (mode === "take" && dep === 0n) { block = "No available offers"; hint = caps.limitOffers ? "Nobody is offering this right now. Place a limit offer to wait for a match." : null; }
  else if (mode === "take" && takeQ && takeQ.unfilled > 0n && !caps.partialFills) block = `Only ${formatUnits(dep, 0, 2)} shares are offered`;
  else if (mode === "take" && takeQ && takeQ.unfilled > 0n) block = `Only ${formatUnits(dep, 0, 2)} shares are offered`;
  else if (mode === "limit" && !pr.ok) block = priceS ? pr.error : "Enter a price";
  else if (mode === "limit" && (limitPrice <= 0n || limitPrice >= ONE)) block = "Price must be between 0 and 1";
  else if (mode === "limit" && edge != null && (side === "buy" ? limitPrice >= edge : limitPrice <= edge)) block = "This price matches an existing offer";
  else if (side === "buy" && total > avail) block = "Insufficient balance";
  else if (side === "sell" && qty > holding) block = "Insufficient shares";

  const label = demo ? (mode === "limit" ? "Simulate limit offer" : side === "buy" ? "Simulate buy" : "Simulate sell") : "Confirm in wallet";
  const doneMsg = mode === "limit" ? "Demo limit offer placed" : side === "buy" ? "Demo trade completed" : "Demo sale completed";

  const submit = async () => {
    const ok = await run((r) => adapter.trade({ marketId: m.id, outcome, side, mode, qty, price: mode === "limit" ? limitPrice : undefined }, r));
    if (ok) { setQtyS(""); setReview(false); showToast(demo ? doneMsg : "Order confirmed"); }
  };

  let cta: { text: string; disabled: boolean; onClick: () => void };
  if (session.kind === "none") cta = { text: "Connect wallet", disabled: false, onClick: () => setConnectOpen(true) };
  else if (block) cta = { text: block, disabled: true, onClick: () => {} };
  else if (!review) cta = { text: "Review order", disabled: false, onClick: () => setReview(true) };
  else cta = { text: busy ? "Working…" : label, disabled: busy, onClick: () => void submit() };

  return (
    <section aria-label="Trade" className="rounded-[14px] border border-line bg-card p-4">
      <div className="space-y-3">
        <Seg label="Buy or sell" value={side} onChange={(v) => { setSide(v); edit(); }} options={[["buy", "Buy"], ["sell", "Sell"]] as const} />
        <Seg label="Outcome" value={outcome} tone onChange={(v) => { setOutcome(v); edit(); }} options={[["YES", "YES"], ["NO", "NO"]] as const} />
        <Seg label="Order type" value={mode} onChange={(v) => { setMode(v); edit(); }} options={[["take", "Take an offer"], ["limit", "Place a limit offer"]] as const} />

        {mode === "take" ? (
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-mute">Best offer price</span>
            <span className="font-semibold">{best == null ? "No offers" : `${priceStr(best)} ${sym}`}</span>
          </div>
        ) : (
          <div>
            <label htmlFor="limit-price" className="text-xs text-mute">Limit price ({sym} per share, 0–1)</label>
            <input id="limit-price" inputMode="decimal" value={priceS} onChange={(e) => { setPriceS(e.target.value); edit(); }} placeholder="0.50" aria-invalid={!!priceS && !pr.ok}
              className="mt-1 min-h-11 w-full rounded-lg border border-line bg-page px-3 text-base" />
          </div>
        )}

        <div>
          <label htmlFor="qty" className="text-xs text-mute">Shares</label>
          <div className="mt-1 flex gap-2">
            <input id="qty" inputMode="decimal" value={qtyS} onChange={(e) => { setQtyS(e.target.value); edit(); }} placeholder="0" aria-invalid={!!qtyS && !q.ok}
              className="min-h-11 w-full rounded-lg border border-line bg-page px-3 text-base" />
            {side === "sell" && <Btn variant="outline" type="button" onClick={() => { setQtyS(formatUnits(holding)); edit(); }}>Max</Btn>}
          </div>
          {qtyS && !q.ok && <p className="mt-1 text-xs text-no" role="alert">{q.error}</p>}
        </div>

        <div className="flex justify-between text-xs text-mute">
          {side === "buy" ? <span>Available collateral: <b className="text-fg">{account ? money(avail, sym) : "—"}</b></span>
            : <span>Your {outcome} shares: <b className="text-fg">{account ? formatUnits(holding, 0, 2) : "—"}</b></span>}
        </div>

        <dl className="space-y-1.5 rounded-xl bg-elev p-3 text-sm" aria-label="Order summary">
          <Row k="Price per share" v={unitPrice == null ? "—" : `${priceStr(unitPrice)} ${sym}`} />
          <Row k={side === "buy" ? "Shares to buy" : "Shares to sell"} v={qty > 0n ? formatUnits(qty, 0, 6) : "—"} />
          <Row k={side === "buy" ? "Estimated total cost" : "Estimated proceeds"} v={qty > 0n && unitPrice != null ? money(total, sym) : "—"} bold />
          <Row k="Fees" v={demo ? `0 ${sym} (demo has no fees)` : "Not available yet"} />
          {side === "buy" && <Row k="Payout if this outcome wins" v={qty > 0n ? money(qty, sym) : "—"} tone={outcome === "YES" ? "text-yes" : "text-no"} />}
        </dl>

        {hint && <p className="rounded-lg bg-elev px-3 py-2 text-xs text-mute">{hint}</p>}
        {!caps.trading && session.kind !== "none" && <p className="rounded-lg bg-elev px-3 py-2 text-xs text-mute">The deployed contract doesn’t support trading yet. Use “Manage shares” for complete sets.</p>}
        {review && !busy && tx.phase === "idle" && <p className="text-xs text-mute">Review the summary above, then confirm. {demo ? "This is a simulation." : ""}</p>}

        <TransactionStatus tx={tx} demo={demo} />
        <Btn className={`w-full min-h-12 ${cta.disabled ? "" : ""}`} disabled={cta.disabled} onClick={cta.onClick}>{cta.text}</Btn>
        {review && tx.phase === "idle" && <Btn variant="ghost" className="w-full" onClick={edit}>Edit order</Btn>}
        {demo && <p className="text-center text-xs text-mute">Demo mode — no real funds or wallet involved.</p>}
      </div>
    </section>
  );
}

function Row({ k, v, bold, tone }: { k: string; v: string; bold?: boolean; tone?: string }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{k}</dt><dd className={`text-right ${bold ? "font-semibold" : ""} ${tone ?? ""}`}>{v}</dd></div>;
}
