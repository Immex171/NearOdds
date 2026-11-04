"use client";
import { useState } from "react";
import { formatUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { money, priceStr, shortTitle } from "@/lib/format";
import { MAX_OPEN_OFFERS, MIN_ORDER_QUANTITY, exactCost, parsePrice, parseQuantity, resolveOffer, takeCandidates, type TicketValue } from "@/lib/trading";
import type { Market, Offer, Outcome } from "@/lib/types";
import { TransactionStatus } from "../account/TransactionStatus";
import { Icon } from "../ui/Icon";
import { TopicIcon } from "../ui/bits";

const EXPIRY = [["none", "No expiry", 0], ["1h", "1 hour", 3_600_000], ["24h", "24 hours", 86_400_000], ["7d", "7 days", 7 * 86_400_000]] as const;
const FIELD = "flex h-11 items-center gap-2 rounded-xl bg-[#14191E] px-3 focus-within:ring-1 focus-within:ring-brand";

/** Compact Kalshi-style ticket. Controlled by the page so the order book, ticket and portfolio agree on outcome, side and offer. */
export function TradeTicket({ m, book, value, onChange }: { m: Market; book: Offer[]; value: TicketValue; onChange: (p: Partial<TicketValue>) => void }) {
  const { adapter, account, accountId, accountStatus, session, setConnectOpen, showToast, wrongNetwork, refresh, now } = useApp();
  const { side, outcome, mode } = value;
  const [qtyS, setQtyS] = useState("");
  const [priceS, setPriceS] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number][0]>("none");
  const [changing, setChanging] = useState(false);
  const { tx, run, reset, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = adapter.symbol;
  const caps = adapter.capabilities;
  const edit = () => { if (tx.phase !== "idle") reset(); };
  const change = (p: Partial<TicketValue>) => { onChange(p); edit(); };

  const connected = session.kind !== "none";
  const held = account?.positions.find((p) => p.marketId === m.id && p.outcome === outcome)?.qty ?? 0n;
  const avail = account?.available ?? 0n;
  const maxOffers = account?.maxOpenOffers ?? MAX_OPEN_OFFERS;
  const { offer, gone, candidates } = resolveOffer(book, value, accountId);

  // Independent executable quotes per outcome (best ask to buy, best bid to sell). Never derived from each other.
  const ask = (o: Outcome) => takeCandidates(book, o, "buy", accountId)[0]?.price ?? null;
  const bid = (o: Outcome) => takeCandidates(book, o, "sell", accountId)[0]?.price ?? null;

  const q = parseQuantity(qtyS, { min: mode === "limit" ? MIN_ORDER_QUANTITY : undefined });
  const qty = q.ok ? q.value : 0n;
  const pr = parsePrice(priceS);
  const unit = mode === "take" ? offer?.price ?? null : pr.ok ? pr.value : null;
  const total = unit != null && qty > 0n ? exactCost(unit, qty) : null;
  const crossing = mode === "limit" && pr.ok && candidates.length > 0 && (side === "buy" ? pr.value >= candidates[0].price : pr.value <= candidates[0].price);

  let block: string | null = null;
  if (m.status !== "open") block = "Market closed";
  else if (!connected) block = null;
  else if (wrongNetwork) block = "Wrong network";
  else if (!caps.trading) block = "Trading unavailable";
  else if (accountStatus === "loading") block = "Loading balance…";
  else if (accountStatus === "error") block = "Balance unavailable";
  else if (mode === "take" && gone) block = "Offer no longer available";
  else if (mode === "take" && !offer) block = "No available offers";
  else if (mode === "limit" && !pr.ok) block = priceS ? pr.error : "Enter a price";
  else if (!q.ok) block = qtyS ? q.error : "Enter an amount";
  else if (mode === "take" && offer && qty > offer.qty) block = `Only ${formatUnits(offer.qty, 0, 4)} shares available`;
  else if (mode === "limit" && account && account.offers.length >= maxOffers) block = `Open-offer limit reached (${maxOffers})`;
  else if (total == null) block = "Invalid price or quantity";
  else if (side === "buy" && total > avail) block = "Insufficient balance";
  else if (side === "sell" && qty > held) block = "Insufficient shares";

  const verb = side === "buy" ? "Buy" : "Sell";
  const label = mode === "limit"
    ? `${demo ? "Simulate" : "Place"} ${side} offer`
    : `${demo ? `Simulate ${side}` : verb} ${outcome}`;

  const submit = async () => {
    // Re-validate against the latest book right before sending.
    const fresh = resolveOffer(book, value, accountId).offer;
    if (mode === "take" && !fresh) return;
    const consumes = mode === "take" && fresh ? qty >= fresh.qty : false;
    const expiresAt = mode === "limit" && expiry !== "none" ? now + EXPIRY.find((e) => e[0] === expiry)![2] : undefined;
    const ok = await run((r) => (mode === "limit"
      ? adapter.createOffer({ marketId: m.id, outcome, side, price: pr.ok ? pr.value : 0n, qty, expiresAt }, r)
      : adapter.fillOffer(fresh!.id, qty, r)));
    if (ok) {
      setQtyS("");
      if (consumes) onChange({ offerId: null });
      showToast(demo ? (mode === "limit" ? "Demo limit offer placed" : side === "buy" ? "Demo trade completed" : "Demo sale completed") : "Confirmed");
    }
  };

  const primary = !connected
    ? { text: "Connect wallet", disabled: false, onClick: () => setConnectOpen(true) }
    : block ? { text: block, disabled: true, onClick: () => {} }
    : { text: busy ? "Working…" : label, disabled: busy, onClick: () => void submit() };

  const maxAction = mode === "take" && side === "buy" ? offer?.qty : side === "sell" ? held : undefined;
  const showMax = connected && accountStatus === "ready" && maxAction != null && maxAction > 0n;
  const balance = !connected ? null : accountStatus === "loading" ? "Loading balance…" : accountStatus === "error" ? "error"
    : side === "buy" ? `Available ${money(avail, sym)}` : `Available ${formatUnits(held, 0, 4)}`;
  const yesNo = (o: Outcome) => (o === "YES" ? "text-yes" : "text-no");
  const title = shortTitle(m.question);
  const hasQty = qty > 0n && total != null;

  return (
    <section aria-label="Trade" className="flex min-h-0 flex-col rounded-[18px] border border-[#252B33] bg-[#0B0F12] text-fg">
      {/* 1. toolbar */}
      <div className="flex h-[50px] shrink-0 items-center justify-between border-b border-[#252B33] px-4">
        <div role="radiogroup" aria-label="Buy or sell" className="flex gap-4">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={side === s} onClick={() => change({ side: s, offerId: null })}
              className={`text-[15px] font-semibold ${side === s ? "text-[#F3F5F7]" : "text-[#929AA5] hover:text-fg"}`}>{s === "buy" ? "Buy" : "Sell"}</button>
          ))}
        </div>
        <label className="relative flex items-center">
          <span className="sr-only">Order mode</span>
          <select value={mode} onChange={(e) => change({ mode: e.target.value as "take" | "limit" })}
            className="h-8 cursor-pointer appearance-none rounded-lg bg-transparent pl-2 pr-6 text-sm font-medium text-[#F3F5F7] hover:bg-white/10">
            <option value="take">Shares</option>
            <option value="limit">Limit</option>
          </select>
          <Icon name="caret" size={16} className="pointer-events-none absolute right-1 text-[#929AA5]" />
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        {/* 2. identity */}
        <p className="line-clamp-2 text-sm leading-snug text-[#F3F5F7]">{m.question}</p>
        <div className="flex items-center gap-2">
          <TopicIcon market={m} size={26} />
          <p className="min-w-0 flex-1 truncate text-[18px] font-semibold leading-tight" data-testid="position-label">
            {side === "sell" && <><span className={yesNo(outcome)}>{outcome}</span> · </>}{title}
          </p>
          {side === "sell" && (
            <div role="radiogroup" aria-label="Outcome" className="flex shrink-0 overflow-hidden rounded-lg border border-[#252B33]">
              {(["YES", "NO"] as const).map((o) => (
                <button key={o} type="button" role="radio" aria-checked={outcome === o} onClick={() => change({ outcome: o, offerId: null })}
                  className={`h-7 px-2 text-xs font-semibold ${outcome === o ? (o === "YES" ? "bg-yes text-[#04140C]" : "bg-no text-[#1F0609]") : "text-[#929AA5] hover:text-fg"}`}>{o}</button>
              ))}
            </div>
          )}
        </div>

        {/* 3. buy: joined outcome pills with independent quotes */}
        {side === "buy" && (
          <div className="flex items-center gap-3">
            <div role="radiogroup" aria-label="Outcome" className="inline-flex overflow-hidden rounded-lg">
              {(["YES", "NO"] as const).map((o) => {
                const on = outcome === o;
                const cls = on ? (o === "YES" ? "bg-yes text-[#04140C]" : "bg-no text-[#1F0609]") : "bg-[#14191E] text-[#929AA5] hover:text-fg";
                return (
                  <button key={o} type="button" role="radio" aria-checked={on} onClick={() => change({ outcome: o, offerId: null })}
                    className={`h-8 whitespace-nowrap px-3 text-sm font-semibold ${cls}`}>{o} {priceStr(ask(o))}</button>
                );
              })}
            </div>
            <span className="text-xs text-[#929AA5]">{sym} per share</span>
          </div>
        )}

        {/* 4. inputs */}
        {mode === "limit" && (
          <div>
            <label className={FIELD}>
              <span className="text-sm text-[#929AA5]">Limit price</span>
              <input id="limit-price" inputMode="decimal" value={priceS} placeholder="0.50" aria-invalid={!!priceS && !pr.ok} onChange={(e) => { setPriceS(e.target.value); edit(); }}
                className="min-w-0 flex-1 bg-transparent text-right text-lg font-semibold outline-none bare placeholder:text-[#4a525d]" />
              <span className="text-sm text-[#929AA5]">{sym}</span>
            </label>
            <p className="mt-1 text-xs text-[#929AA5]">Ask {priceStr(ask(outcome))} · Bid {priceStr(bid(outcome))} {sym}</p>
            {priceS && !pr.ok && <p className="mt-1 text-xs text-no" role="alert">{pr.error}</p>}
            {crossing && <p className="mt-1 text-xs text-[#f0c35a]">This price matches an existing offer, so it will rest instead of filling. Use Shares to trade now.</p>}
          </div>
        )}

        <div>
          <label className={FIELD}>
            <span className="text-sm text-[#929AA5]">Shares</span>
            {showMax && <button type="button" onClick={() => { setQtyS(formatUnits(maxAction!)); edit(); }} className="text-xs font-semibold text-brand hover:underline">Max</button>}
            <input id="qty" inputMode="decimal" value={qtyS} placeholder="0" aria-invalid={!!qtyS && !q.ok} onChange={(e) => { setQtyS(e.target.value); edit(); }}
              className="min-w-0 flex-1 bg-transparent text-right text-lg font-semibold outline-none bare placeholder:text-[#4a525d]" />
          </label>
          {qtyS && !q.ok && <p className="mt-1 text-xs text-no" role="alert">{q.error}</p>}

          {mode === "take" && (
            <div className="mt-1 text-xs text-[#929AA5]" data-testid="selected-offer">
              {gone && <p role="alert" className="mb-1 text-no">That offer is no longer available. Choose another.</p>}
              {offer ? (
                <p>{priceStr(offer.price)} {sym}/share · {formatUnits(offer.qty, 0, 4)} available
                  {candidates.length > 1 && <> · <button type="button" onClick={() => setChanging(!changing)} aria-expanded={changing} className="font-semibold text-brand hover:underline">Change</button></>}</p>
              ) : (
                <p>{gone ? "No offer selected" : side === "buy" ? "No offers to buy right now" : "No bids to sell into right now"}
                  {candidates.length > 0 && <> · <button type="button" onClick={() => setChanging(!changing)} className="font-semibold text-brand hover:underline">Choose</button></>}</p>
              )}
              {changing && (
                <ul className="mt-1 max-h-32 divide-y divide-[#252B33] overflow-y-auto rounded-lg border border-[#252B33]" aria-label="Choose an offer">
                  {candidates.map((o) => (
                    <li key={o.id}>
                      <button type="button" aria-pressed={offer?.id === o.id} onClick={() => { change({ offerId: o.id }); setChanging(false); }}
                        className={`flex min-h-9 w-full items-center justify-between px-3 text-sm hover:bg-white/10 ${offer?.id === o.id ? "text-brand" : "text-fg"}`}>
                        <span className="font-semibold">{priceStr(o.price)} {sym}</span><span className="text-[#929AA5]">{formatUnits(o.qty, 0, 4)} shares</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {mode === "limit" && (
          <label className={FIELD}>
            <span className="text-sm text-[#929AA5]">Expiration</span>
            <select value={expiry} onChange={(e) => { setExpiry(e.target.value as typeof expiry); edit(); }} aria-label="Expiration"
              className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent text-right text-base font-semibold outline-none bare">
              {EXPIRY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <Icon name="caret" size={16} className="pointer-events-none -ml-1 text-[#929AA5]" />
          </label>
        )}

        {connected && (
          <p className="text-xs text-[#929AA5]" data-testid="balance">
            {balance === "error"
              ? <span role="alert" className="text-no">Couldn’t load your balance. <button type="button" onClick={refresh} className="font-semibold underline">Retry</button></span>
              : <>{side === "buy" ? "Available collateral" : `Available ${outcome} shares`}: <b className="text-fg">{balance?.replace(/^Available /, "")}</b></>}
          </p>
        )}

        {/* 5. plain summary, only once there is a valid quantity */}
        {hasQty && (
          <div aria-label="Order summary" className="space-y-1.5 text-sm">
            {side === "buy" ? (
              <>
                <div className="flex items-baseline justify-between"><span className="text-[#929AA5]">{mode === "limit" ? "Cost if filled" : "Cost"}</span><span className="font-semibold">{money(total!, sym)}</span></div>
                <div className="flex items-baseline justify-between"><span className="text-[#929AA5]">Payout if {outcome} wins</span><span className={`text-lg font-semibold ${yesNo(outcome)}`}>{money(qty, sym)}</span></div>
              </>
            ) : (
              <div className="flex items-baseline justify-between"><span className="text-[#929AA5]">{mode === "limit" ? "You receive if filled" : "You receive"}</span><span className="text-lg font-semibold">{money(total!, sym)}</span></div>
            )}
            <details className="text-xs text-[#929AA5]">
              <summary className="cursor-pointer select-none hover:text-fg">Details</summary>
              <dl className="mt-1.5 space-y-1">
                <Row k="Price per share" v={unit == null ? "—" : `${priceStr(unit)} ${sym}`} />
                <Row k="Shares" v={formatUnits(qty, 0, 6)} />
                <Row k="Fees" v={`0 ${sym}`} />
                {mode === "limit" && <Row k={side === "buy" ? "Collateral reserved" : "Shares reserved"} v={side === "buy" ? money(total!, sym) : formatUnits(qty, 0, 6)} />}
              </dl>
            </details>
          </div>
        )}

        {wrongNetwork && <p role="alert" className="rounded-lg bg-no-bg/50 px-3 py-2 text-xs text-no">This wallet looks like a mainnet account but the app is set to testnet. Switch your wallet to testnet.</p>}
      </div>

      {/* 6. action sits on the same surface */}
      <div className="shrink-0 space-y-2 px-4 pb-4">
        <TransactionStatus tx={tx} demo={demo} />
        <button type="button" disabled={primary.disabled} onClick={primary.onClick}
          className="h-12 w-full rounded-full bg-[#00DC8D] text-base font-semibold text-[#04140C] transition-colors hover:bg-[#1be6a0] disabled:bg-[#14191E] disabled:text-[#929AA5]">{primary.text}</button>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><dt>{k}</dt><dd className="text-fg">{v}</dd></div>;
}
