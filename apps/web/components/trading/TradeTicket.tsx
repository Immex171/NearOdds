"use client";
import { useMemo, useState } from "react";
import { formatUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { money, priceStr } from "@/lib/format";
import { MAX_OPEN_OFFERS, exactCost, parsePrice, parseQuantity, MIN_ORDER_QUANTITY } from "@/lib/trading";
import type { Market, Offer, Outcome, Side } from "@/lib/types";
import { TransactionStatus } from "../account/TransactionStatus";
import { Badge, Btn, TopicIcon } from "../ui/bits";

export interface TicketInit { outcome: Outcome; side?: Side; offerId?: string | null }

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

export function TradeTicket({ m, book, init }: { m: Market; book: Offer[]; init: TicketInit }) {
  const { adapter, account, accountId, session, setConnectOpen, showToast, wrongNetwork } = useApp();
  const [side, setSide] = useState<Side>(init.side ?? "buy");
  const [outcome, setOutcome] = useState<Outcome>(init.outcome);
  const [mode, setMode] = useState<"take" | "limit">("take");
  const [offerId, setOfferId] = useState<string | null>(init.offerId ?? null);
  const [qtyS, setQtyS] = useState("");
  const [priceS, setPriceS] = useState("");
  const [review, setReview] = useState(false);
  const { tx, run, reset, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = adapter.symbol;
  const caps = adapter.capabilities;
  const edit = () => { setReview(false); if (tx.phase !== "idle") reset(); };

  const held = account?.positions.find((p) => p.marketId === m.id && p.outcome === outcome)?.qty ?? 0n;
  const avail = account?.available ?? 0n;
  const maxOffers = account?.maxOpenOffers ?? MAX_OPEN_OFFERS;

  // Executable offers the user could take: opposite side of the maker, not their own, fillable.
  const candidates = useMemo(() => {
    const makerSide: Side = side === "buy" ? "sell" : "buy";
    return book.filter((o) => o.outcome === outcome && o.side === makerSide && o.fillable !== false && o.owner !== accountId && o.qty > 0n)
      .sort((a, b) => (side === "buy" ? Number(a.price - b.price) : Number(b.price - a.price)));
  }, [book, outcome, side, accountId]);
  const picked = offerId ? book.find((o) => o.id === offerId) : undefined;
  const pickedValid = picked && candidates.some((o) => o.id === picked.id);
  const gone = Boolean(offerId) && !pickedValid;
  const offer = offerId ? (pickedValid ? picked : undefined) : candidates[0];

  const q = parseQuantity(qtyS, { min: mode === "limit" ? MIN_ORDER_QUANTITY : undefined });
  const qty = q.ok ? q.value : 0n;
  const pr = parsePrice(priceS);
  const unit = mode === "take" ? offer?.price ?? null : pr.ok ? pr.value : null;
  const total = unit != null && qty > 0n ? exactCost(unit, qty) : null;

  const crossing = mode === "limit" && pr.ok && (side === "buy"
    ? candidates.length > 0 && pr.value >= candidates[0].price
    : candidates.length > 0 && pr.value <= candidates[0].price);

  let block: string | null = null;
  let hint: string | null = null;
  if (m.status !== "open") block = "Market closed";
  else if (session.kind === "none") block = null;
  else if (wrongNetwork) block = "Wrong network";
  else if (!caps.trading) block = "Trading unavailable";
  else if (mode === "take" && gone) block = "Offer no longer available";
  else if (mode === "take" && !offer) { block = "No available offers"; hint = caps.limitOffers ? "Nobody is offering this right now. Switch to “Place a limit offer” to wait for a match." : null; }
  else if (mode === "limit" && !pr.ok) block = priceS ? pr.error : "Enter a price";
  else if (!q.ok) block = qtyS ? q.error : "Enter an amount";
  else if (mode === "take" && offer && qty > offer.qty) block = `Only ${formatUnits(offer.qty, 0, 4)} shares left on this offer`;
  else if (mode === "limit" && account && account.offers.length >= maxOffers) block = `Open-offer limit reached (${maxOffers})`;
  else if (total == null) block = "Invalid price or quantity";
  else if (side === "buy" && total > avail) block = "Insufficient balance";
  else if (side === "sell" && qty > held) block = "Insufficient shares";

  const label = demo
    ? (mode === "limit" ? `Simulate limit ${side}` : side === "buy" ? "Simulate buy" : "Simulate sell")
    : mode === "limit" ? "Confirm limit offer in wallet" : "Confirm in wallet";

  const submit = async () => {
    const ok = await run((r) => (mode === "limit"
      ? adapter.createOffer({ marketId: m.id, outcome, side, price: pr.ok ? pr.value : 0n, qty }, r)
      : adapter.fillOffer(offer!.id, qty, r)));
    if (ok) {
      setQtyS(""); setReview(false);
      showToast(demo ? (mode === "limit" ? "Demo limit offer placed" : side === "buy" ? "Demo trade completed" : "Demo sale completed") : "Confirmed");
    }
  };

  let cta: { text: string; disabled: boolean; onClick: () => void };
  if (session.kind === "none") cta = { text: "Connect wallet", disabled: false, onClick: () => setConnectOpen(true) };
  else if (block) cta = { text: block, disabled: true, onClick: () => {} };
  else if (!review) cta = { text: "Review order", disabled: false, onClick: () => setReview(true) };
  else cta = { text: busy ? "Working…" : label, disabled: busy, onClick: () => void submit() };

  const win = outcome === "YES" ? "YES" : "NO";
  return (
    <section aria-label="Trade" className="rounded-[14px] border border-line bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <TopicIcon market={m} size={32} />
        <p className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-snug">{m.question}</p>
        <Badge tone={outcome === "YES" ? "yes" : "no"}>{side === "buy" ? "Buy" : "Sell"} {outcome}</Badge>
      </div>
      <div className="space-y-3">
        <Seg label="Buy or sell" value={side} onChange={(v) => { setSide(v); setOfferId(null); edit(); }} options={[["buy", "Buy"], ["sell", "Sell"]] as const} />
        <Seg label="Outcome" value={outcome} tone onChange={(v) => { setOutcome(v); setOfferId(null); edit(); }} options={[["YES", "YES"], ["NO", "NO"]] as const} />
        <Seg label="Order type" value={mode} onChange={(v) => { setMode(v); edit(); }} options={[["take", "Take an offer"], ["limit", "Place a limit offer"]] as const} />

        {mode === "take" ? (
          <div>
            <p className="text-xs text-mute">{side === "buy" ? "Sell offers you can buy from" : "Buy offers you can sell into"}</p>
            {gone && <p role="alert" className="mt-1 rounded-lg bg-no-bg/50 px-3 py-2 text-xs text-no">That offer is no longer available (filled, cancelled or expired). Choose another.</p>}
            {candidates.length === 0 ? <p className="mt-1 text-sm text-mute">No available offers</p> : (
              <ul className="mt-1 space-y-1" aria-label="Available offers">
                {candidates.slice(0, 4).map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => { setOfferId(o.id); edit(); }} aria-pressed={offer?.id === o.id}
                      className={`flex min-h-10 w-full items-center justify-between rounded-lg border px-3 text-sm ${offer?.id === o.id ? "border-brand bg-brand/10" : "border-line hover:bg-elev"}`}>
                      <span className="whitespace-nowrap font-semibold">{priceStr(o.price)} {sym}</span>
                      <span className="whitespace-nowrap text-mute">{formatUnits(o.qty, 0, 4)} shares{/^\d+$/.test(o.id) ? ` · #${o.id}` : ""}</span>
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
            {crossing && <p className="mt-1 text-xs text-[#f0c35a]">This price already matches an existing offer. It will rest instead of filling; to trade now, use “Take an offer”.</p>}
          </div>
        )}

        <div>
          <label htmlFor="qty" className="text-xs text-mute">Shares {mode === "take" && offer ? `(max ${formatUnits(offer.qty, 0, 4)})` : ""}</label>
          <div className="mt-1 flex gap-2">
            <input id="qty" inputMode="decimal" value={qtyS} onChange={(e) => { setQtyS(e.target.value); edit(); }} placeholder="0" aria-invalid={!!qtyS && !q.ok}
              className="min-h-11 w-full rounded-lg border border-line bg-page px-3 text-base" />
            {mode === "take" && offer && <Btn variant="outline" type="button" onClick={() => { setQtyS(formatUnits(offer.qty)); edit(); }}>Max</Btn>}
            {mode === "limit" && side === "sell" && <Btn variant="outline" type="button" onClick={() => { setQtyS(formatUnits(held)); edit(); }}>Max</Btn>}
          </div>
          {qtyS && !q.ok && <p className="mt-1 text-xs text-no" role="alert">{q.error}</p>}
        </div>

        <div className="flex justify-between text-xs text-mute">
          {side === "buy" ? <span>Available collateral: <b className="text-fg">{account ? money(avail, sym) : "—"}</b></span>
            : <span>Your available {outcome} shares: <b className="text-fg">{account ? formatUnits(held, 0, 4) : "—"}</b></span>}
        </div>

        <dl className="space-y-1.5 rounded-xl bg-elev p-3 text-sm" aria-label="Order summary">
          <Row k="Price per share" v={unit == null ? "—" : `${priceStr(unit)} ${sym}`} />
          <Row k={side === "buy" ? "Shares to buy" : "Shares to sell"} v={qty > 0n ? formatUnits(qty, 0, 6) : "—"} />
          {mode === "limit" && <Row k={side === "buy" ? "Collateral reserved" : "Shares reserved"} v={qty > 0n && total != null ? (side === "buy" ? money(total, sym) : formatUnits(qty, 0, 6)) : "—"} />}
          <Row k={side === "buy" ? (mode === "limit" ? "Total if fully filled" : "Estimated total cost") : (mode === "limit" ? "Proceeds if filled" : "Estimated proceeds")} v={total != null && qty > 0n ? money(total, sym) : "—"} bold />
          <Row k="Fees" v={`0 ${sym} (none at this stage)`} />
          {side === "buy" && <Row k={`Payout if ${win} wins`} v={qty > 0n ? money(qty, sym) : "—"} tone={outcome === "YES" ? "text-yes" : "text-no"} />}
        </dl>

        {hint && <p className="rounded-lg bg-elev px-3 py-2 text-xs text-mute">{hint}</p>}
        {m.status === "open" && session.kind !== "none" && !caps.trading && <p className="rounded-lg bg-elev px-3 py-2 text-xs text-mute">This data source doesn’t support trading.</p>}
        {wrongNetwork && <p role="alert" className="rounded-lg bg-no-bg/50 px-3 py-2 text-xs text-no">This wallet looks like a mainnet account but the app is configured for testnet. Switch your wallet to testnet.</p>}
        {review && !busy && tx.phase === "idle" && <p className="text-xs text-mute">Review the summary above, then confirm.{demo ? " This is a simulation." : ""}</p>}

        <TransactionStatus tx={tx} demo={demo} />
        <Btn className="min-h-12 w-full" disabled={cta.disabled} onClick={cta.onClick}>{cta.text}</Btn>
        {review && tx.phase === "idle" && <Btn variant="ghost" className="w-full" onClick={edit}>Edit order</Btn>}
        {demo && <p className="text-center text-xs text-mute">Demo mode — no real funds or wallet involved.</p>}
      </div>
    </section>
  );
}

function Row({ k, v, bold, tone }: { k: string; v: string; bold?: boolean; tone?: string }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{k}</dt><dd className={`text-right ${bold ? "font-semibold" : ""} ${tone ?? ""}`}>{v}</dd></div>;
}
