"use client";
import { useState } from "react";
import { formatUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { money, priceStr } from "@/lib/format";
import { MAX_OPEN_OFFERS, MIN_ORDER_QUANTITY, exactCost, parsePrice, parseQuantity, resolveOffer, type TicketValue } from "@/lib/trading";
import type { Market, Offer } from "@/lib/types";
import { TransactionStatus } from "../account/TransactionStatus";
import { Badge, Btn, TopicIcon } from "../ui/bits";

function Seg<T extends string>({ value, onChange, options, label, tone }: {
  value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[]; label: string; tone?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded-lg bg-elev p-0.5">
      {options.map(([k, l]) => {
        const on = value === k;
        const c = on ? (tone ? (k === "YES" ? "bg-yes-bg text-yes ring-1 ring-yes/50" : "bg-no-bg text-no ring-1 ring-no/50") : "bg-card text-fg shadow ring-1 ring-line") : "text-mute hover:text-fg";
        return <button key={k} type="button" role="radio" aria-checked={on} onClick={() => onChange(k)} className={`min-h-10 rounded-md px-2 text-sm font-semibold ${c}`}>{l}</button>;
      })}
    </div>
  );
}

/** Controlled by the page so the order book and ticket always agree on outcome, side and selected offer. */
export function TradeTicket({ m, book, value, onChange }: { m: Market; book: Offer[]; value: TicketValue; onChange: (p: Partial<TicketValue>) => void }) {
  const { adapter, account, accountId, accountStatus, session, setConnectOpen, showToast, wrongNetwork, refresh } = useApp();
  const { side, outcome, mode } = value;
  const [qtyS, setQtyS] = useState("");
  const [priceS, setPriceS] = useState("");
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const { tx, run, reset, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = adapter.symbol;
  const caps = adapter.capabilities;
  const edit = () => { setReviewKey(null); if (tx.phase !== "idle") reset(); };
  const change = (p: Partial<TicketValue>) => { onChange(p); edit(); };

  const held = account?.positions.find((p) => p.marketId === m.id && p.outcome === outcome)?.qty ?? 0n;
  const avail = account?.available ?? 0n;
  const maxOffers = account?.maxOpenOffers ?? MAX_OPEN_OFFERS;
  const { offer, gone, candidates } = resolveOffer(book, value, accountId);

  const q = parseQuantity(qtyS, { min: mode === "limit" ? MIN_ORDER_QUANTITY : undefined });
  const qty = q.ok ? q.value : 0n;
  const pr = parsePrice(priceS);
  const unit = mode === "take" ? offer?.price ?? null : pr.ok ? pr.value : null;
  const total = unit != null && qty > 0n ? exactCost(unit, qty) : null;
  const crossing = mode === "limit" && pr.ok && candidates.length > 0 && (side === "buy" ? pr.value >= candidates[0].price : pr.value <= candidates[0].price);

  let block: string | null = null;
  let hint: string | null = null;
  if (m.status !== "open") block = "Market closed";
  else if (session.kind === "none") block = null;
  else if (wrongNetwork) block = "Wrong network";
  else if (!caps.trading) block = "Trading unavailable";
  else if (accountStatus === "loading") block = "Loading balance…";
  else if (accountStatus === "error") block = "Balance unavailable";
  else if (mode === "take" && gone) block = "Offer no longer available";
  else if (mode === "take" && !offer) { block = "No available offers"; hint = caps.limitOffers ? "Nobody is offering this right now. Switch to “Place a limit offer” to wait for a match." : null; }
  else if (mode === "limit" && !pr.ok) block = priceS ? pr.error : "Enter a price";
  else if (!q.ok) block = qtyS ? q.error : "Enter an amount";
  else if (mode === "take" && offer && qty > offer.qty) block = `Only ${formatUnits(offer.qty, 0, 4)} shares available`;
  else if (mode === "limit" && account && account.offers.length >= maxOffers) block = `Open-offer limit reached (${maxOffers})`;
  else if (total == null) block = "Invalid price or quantity";
  else if (side === "buy" && total > avail) block = "Insufficient balance";
  else if (side === "sell" && qty > held) block = "Insufficient shares";

  const key = `${side}|${outcome}|${mode}|${offer?.id ?? ""}|${qtyS}|${priceS}`;
  const review = reviewKey === key;
  const label = demo
    ? (mode === "limit" ? `Simulate limit ${side} ${outcome}` : `Simulate ${side} ${outcome}`)
    : mode === "limit" ? "Confirm limit offer in wallet" : "Confirm in wallet";

  const submit = async () => {
    const consumes = mode === "take" && offer ? qty >= offer.qty : false;
    const ok = await run((r) => (mode === "limit"
      ? adapter.createOffer({ marketId: m.id, outcome, side, price: pr.ok ? pr.value : 0n, qty }, r)
      : adapter.fillOffer(offer!.id, qty, r)));
    if (ok) {
      setQtyS(""); setReviewKey(null);
      if (consumes) onChange({ offerId: null });
      showToast(demo ? (mode === "limit" ? "Demo limit offer placed" : side === "buy" ? "Demo trade completed" : "Demo sale completed") : "Confirmed");
    }
  };

  let cta: { text: string; disabled: boolean; onClick: () => void };
  if (session.kind === "none") cta = { text: "Connect wallet", disabled: false, onClick: () => setConnectOpen(true) };
  else if (block) cta = { text: block, disabled: true, onClick: () => {} };
  else if (!review) cta = { text: "Review order", disabled: false, onClick: () => setReviewKey(key) };
  else cta = { text: busy ? "Working…" : label, disabled: busy, onClick: () => void submit() };

  const balance = session.kind === "none" ? "Connect a wallet to see your balance"
    : accountStatus === "loading" ? "Loading balance…"
    : accountStatus === "error" ? null
    : side === "buy" ? money(avail, sym) : `${formatUnits(held, 0, 4)} ${outcome} shares`;

  return (
    <section aria-label="Trade" className="flex min-h-0 flex-col rounded-[14px] border border-line bg-card">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        <div className="flex items-center gap-3">
          <TopicIcon market={m} size={32} />
          <p className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-snug">{m.question}</p>
          <Badge tone={outcome === "YES" ? "yes" : "no"}>{side === "buy" ? "Buy" : "Sell"} {outcome}</Badge>
        </div>
        <Seg label="Buy or sell" value={side} onChange={(v) => change({ side: v, offerId: null })} options={[["buy", "Buy"], ["sell", "Sell"]] as const} />
        <Seg label="Outcome" value={outcome} tone onChange={(v) => change({ outcome: v, offerId: null })} options={[["YES", "YES"], ["NO", "NO"]] as const} />
        <Seg label="Order type" value={mode} onChange={(v) => change({ mode: v })} options={[["take", "Take an offer"], ["limit", "Place a limit offer"]] as const} />

        {mode === "take" ? (
          <div>
            {gone && <p role="alert" className="mb-2 rounded-lg bg-no-bg/50 px-3 py-2 text-xs text-no">That offer is no longer available (filled, cancelled or expired). Choose another.</p>}
            {offer ? (
              <div data-testid="selected-offer" className="flex items-center justify-between gap-2 rounded-lg border border-brand/60 bg-brand/10 px-3 py-2 text-sm">
                <span><b>Price: {priceStr(offer.price)} {sym}</b> <span className="text-mute">· Available: {formatUnits(offer.qty, 0, 4)} shares</span></span>
                {candidates.length > 1 && <button type="button" onClick={() => setChanging(!changing)} aria-expanded={changing} className="shrink-0 text-xs font-semibold text-brand hover:underline">Change offer</button>}
              </div>
            ) : (
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm text-mute">
                <span>{gone ? "No offer selected" : "No available offers"}</span>
                {candidates.length > 0 && <button type="button" onClick={() => setChanging(!changing)} className="text-xs font-semibold text-brand hover:underline">Choose offer</button>}
              </div>
            )}
            {changing && (
              <ul className="mt-1 max-h-36 divide-y divide-line/60 overflow-y-auto rounded-lg border border-line" aria-label="Choose an offer">
                {candidates.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => { change({ offerId: o.id }); setChanging(false); }} aria-pressed={offer?.id === o.id}
                      className={`flex min-h-9 w-full items-center justify-between px-3 text-sm hover:bg-white/10 ${offer?.id === o.id ? "text-brand" : ""}`}>
                      <span className="font-semibold">{priceStr(o.price)} {sym}</span><span className="text-mute">{formatUnits(o.qty, 0, 4)} shares</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div>
            <label htmlFor="limit-price" className="text-xs text-mute">Limit price ({sym} per share, 0.01 steps)</label>
            <input id="limit-price" inputMode="decimal" value={priceS} onChange={(e) => { setPriceS(e.target.value); edit(); }} placeholder="0.50" aria-invalid={!!priceS && !pr.ok}
              className="mt-1 min-h-11 w-full rounded-lg border border-line bg-page px-3 text-base" />
            {priceS && !pr.ok && <p className="mt-1 text-xs text-no" role="alert">{pr.error}</p>}
            {crossing && <p className="mt-1 text-xs text-[#f0c35a]">This price matches an existing offer, so it will rest instead of filling. To trade now, use “Take an offer”.</p>}
          </div>
        )}

        <div>
          <label htmlFor="qty" className="text-xs text-mute">Shares</label>
          <div className="mt-1 flex gap-2">
            <input id="qty" inputMode="decimal" value={qtyS} onChange={(e) => { setQtyS(e.target.value); edit(); }} placeholder="0" aria-invalid={!!qtyS && !q.ok}
              className="min-h-11 w-full rounded-lg border border-line bg-page px-3 text-base" />
            {mode === "take" && offer && <Btn variant="outline" type="button" onClick={() => { setQtyS(formatUnits(offer.qty)); edit(); }}>Max</Btn>}
            {mode === "limit" && side === "sell" && <Btn variant="outline" type="button" onClick={() => { setQtyS(formatUnits(held)); edit(); }}>Max</Btn>}
          </div>
          {qtyS && !q.ok && <p className="mt-1 text-xs text-no" role="alert">{q.error}</p>}
        </div>

        <p className="text-xs text-mute" data-testid="balance">
          {side === "buy" ? "Available collateral" : `Available ${outcome} shares`}:{" "}
          {balance ? <b className="text-fg">{balance}</b> : <span role="alert" className="text-no">Couldn’t load your balance. <button type="button" onClick={refresh} className="font-semibold underline">Retry</button></span>}
        </p>

        <dl className="space-y-1.5 rounded-xl bg-elev p-3 text-sm" aria-label="Order summary">
          <Row k="Price per share" v={unit == null ? "—" : `${priceStr(unit)} ${sym}`} />
          <Row k={side === "buy" ? "Shares to buy" : "Shares to sell"} v={qty > 0n ? formatUnits(qty, 0, 6) : "—"} />
          {mode === "limit" && <Row k={side === "buy" ? "Collateral reserved" : "Shares reserved"} v={qty > 0n && total != null ? (side === "buy" ? money(total, sym) : formatUnits(qty, 0, 6)) : "—"} />}
          <Row k={side === "buy" ? (mode === "limit" ? "Total if fully filled" : "Cost") : (mode === "limit" ? "Proceeds if filled" : "Proceeds")} v={total != null && qty > 0n ? money(total, sym) : "—"} bold />
          <Row k="Fees" v={`0 ${sym}`} />
          {side === "buy" && <Row k={`Payout if ${outcome} wins`} v={qty > 0n ? money(qty, sym) : "—"} tone={outcome === "YES" ? "text-yes" : "text-no"} />}
        </dl>

        {hint && <p className="rounded-lg bg-elev px-3 py-2 text-xs text-mute">{hint}</p>}
        {wrongNetwork && <p role="alert" className="rounded-lg bg-no-bg/50 px-3 py-2 text-xs text-no">This wallet looks like a mainnet account but the app is set to testnet. Switch your wallet to testnet.</p>}
      </div>
      <div className="shrink-0 space-y-2 border-t border-line p-4">
        <TransactionStatus tx={tx} demo={demo} />
        <Btn className="min-h-12 w-full" disabled={cta.disabled} onClick={cta.onClick}>{cta.text}</Btn>
        {review && tx.phase === "idle" && <Btn variant="ghost" className="w-full" onClick={edit}>Edit order</Btn>}
      </div>
    </section>
  );
}

function Row({ k, v, bold, tone }: { k: string; v: string; bold?: boolean; tone?: string }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{k}</dt><dd className={`text-right ${bold ? "font-semibold" : ""} ${tone ?? ""}`}>{v}</dd></div>;
}
