"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ONE, formatUnits, tryParseUnits } from "@/lib/amounts";
import { holdingOf, positionsOf, walletOf } from "@/lib/account";
import { useApp, useDeployment, useMarketAccount } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { marketLabel, money, priceStr } from "@/lib/format";
import { exactCost, parsePrice, parseQuantity, resolveOffer, takeCandidates, type TicketValue } from "@/lib/trading";
import type { Market, Offer, Outcome } from "@/lib/types";
import { TransactionStatus } from "../account/TransactionStatus";
import { Icon } from "../ui/Icon";
import { TopicIcon } from "../ui/bits";
import { SettlementPanel } from "./SettlementPanel";

const C = { bg: "bg-[#1C2027]", line: "border-[#2B3039]", mute: "text-[#969DA8]", field: "bg-[#15181E]" };
const EXPIRY = [["none", "No expiry", 0], ["1h", "1 hour", 3_600_000], ["24h", "24 hours", 86_400_000], ["7d", "7 days", 7 * 86_400_000]] as const;
const WHOLE = ONE; // 1 whole share / collateral unit in base units

/** Compact ticket. Controlled by the page so the order book, ticket and portfolio agree on outcome, side and selected offer.
 *  Market mode = fill one specific executable offer (the best, or the one the user picked). Limit mode = rest a new offer. */
export function TradeTicket(props: { m: Market; book: Offer[]; value: TicketValue; onChange: (p: Partial<TicketValue>) => void; onManage?: () => void }) {
  // Which screen to show is decided by the contract's market status, not by the clock.
  return props.m.status === "open" ? <OpenTicket {...props} /> : <SettlementPanel m={props.m} onManage={props.onManage} />;
}

function OpenTicket({ m, book, value, onChange }: { m: Market; book: Offer[]; value: TicketValue; onChange: (p: Partial<TicketValue>) => void }) {
  const { adapter, accountId, session, setConnectOpen, showToast, wrongNetwork, refresh, now } = useApp();
  // Everything below is scoped to THIS market's contract: its limits, token, deposit bucket and verification.
  const { account, error: accountErr } = useMarketAccount(m);
  const { deployment, retry } = useDeployment(m);
  const accountStatus = !accountId ? "none" : accountErr && !account ? "error" : account ? "ready" : "loading";
  const router = useRouter();
  const { side, outcome, mode } = value;
  const L = m.limits;
  const floorLot = (v: bigint) => (v / L.lot) * L.lot;
  const [qtyS, setQtyS] = useState("");
  const [amountS, setAmountS] = useState("");
  const [priceS, setPriceS] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number][0]>("none");
  const [changing, setChanging] = useState(false);
  const { tx, run, reset, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = m.token.symbol;
  const caps = adapter.capabilities;
  const edit = () => { if (tx.phase !== "idle") reset(); };
  const change = (p: Partial<TicketValue>) => { onChange(p); edit(); };

  const connected = session.kind !== "none";
  const holding = holdingOf(account, m);
  const wallet = walletOf(account, m);
  const held = positionsOf(account, m).find((p) => p.outcome === outcome)?.qty ?? 0n; // available, unreserved
  const avail = holding?.available ?? 0n;
  const maxOffers = holding?.maxOpenOffers ?? L.maxOpenOffers;
  const { offer, gone, candidates } = resolveOffer(book, value, accountId);

  // Executable quotes per outcome and side, each from its own book. Never derived from one another.
  const quote = (o: Outcome) => takeCandidates(book, o, side, accountId)[0]?.price ?? null;

  const isMarketBuy = mode === "take" && side === "buy";
  const pr = parsePrice(priceS, L);
  const amount = tryParseUnits(amountS);
  // Market buy: spend a budget on the bound offer. Shares = floor(budget / price) rounded down to the lot.
  const marketShares = isMarketBuy && offer && amount.ok ? floorLot((amount.value * ONE) / offer.price) : 0n;
  const q = isMarketBuy ? { ok: true as const, value: marketShares } : parseQuantity(qtyS, { min: mode === "limit" ? L.minOrder : undefined, limits: L });
  const qty = q.ok ? q.value : 0n;
  const unit = mode === "take" ? offer?.price ?? null : pr.ok ? pr.value : null;
  const total = unit != null && qty > 0n ? exactCost(unit, qty) : null;
  const crossing = mode === "limit" && pr.ok && candidates.length > 0 && (side === "buy" ? pr.value >= candidates[0].price : pr.value <= candidates[0].price);

  const live = adapter.id === "near";
  const needsSetup = live && !!account && (holding?.registered === false || wallet?.tokenRegistered === false);
  let block: string | null = null;
  if (m.status !== "open") block = "Market closed";
  else if (!connected) block = null; // a disconnected visitor is simply asked to connect; verification matters once there is a wallet
  else if (live && deployment.state === "error") block = "Trading unavailable";
  else if (live && deployment.state !== "ok") block = "Verifying deployment…";
  else if (wrongNetwork) block = "Wrong network";
  else if (!caps.trading) block = "Trading unavailable";
  else if (accountStatus === "loading") block = "Loading balance…";
  else if (accountStatus === "error") block = "Balance unavailable";
  else if (needsSetup) block = null; // handled below: the button sends the user to account setup
  else if (mode === "take" && gone) block = "Offer no longer available";
  else if (mode === "take" && !offer) block = "No available offers";
  else if (mode === "limit" && !pr.ok) block = priceS ? pr.error : "Enter a price";
  else if (isMarketBuy && !amountS) block = "Enter an amount";
  else if (isMarketBuy && !amount.ok) block = amount.error;
  else if (isMarketBuy && amount.ok && amount.value === 0n) block = "Enter an amount";
  else if (isMarketBuy && marketShares === 0n) block = "Amount too small";
  else if (isMarketBuy && offer && marketShares > offer.qty) block = `Exceeds liquidity (max ${money((offer.qty * offer.price) / ONE, sym)})`;
  else if (!isMarketBuy && !q.ok) block = qtyS ? q.error : "Enter an amount";
  else if (mode === "take" && offer && qty > offer.qty) block = `Only ${formatUnits(offer.qty, 0, 4)} shares available`;
  else if (mode === "limit" && account && account.offers.length >= maxOffers) block = `Open-offer limit reached (${maxOffers})`;
  else if (total == null) block = "Invalid price or quantity";
  else if (side === "buy" && total > avail) block = "Insufficient balance";
  else if (side === "sell" && qty > held) block = "Insufficient shares";

  const label = mode === "limit" ? `${demo ? "Simulate" : "Place"} ${side} offer` : `${demo ? `Simulate ${side}` : side === "buy" ? "Buy" : "Sell"} ${outcome}`;

  const submit = async () => {
    const fresh = resolveOffer(book, value, accountId).offer; // revalidate against the latest book
    if (mode === "take" && !fresh) return;
    const consumes = mode === "take" && fresh ? qty >= fresh.qty : false;
    const expiresAt = mode === "limit" && expiry !== "none" ? now + EXPIRY.find((e) => e[0] === expiry)![2] : undefined;
    const ok = await run((r) => (mode === "limit"
      ? adapter.createOffer(m, { marketId: m.id, outcome, side, price: pr.ok ? pr.value : 0n, qty, expiresAt }, r)
      : adapter.fillOffer(m, fresh!, qty, r)));
    if (ok) {
      setQtyS(""); setAmountS("");
      if (consumes) onChange({ offerId: null });
      showToast(demo ? (mode === "limit" ? "Demo limit offer placed" : side === "buy" ? "Demo trade completed" : "Demo sale completed") : "Confirmed");
    }
  };

  const primary = !connected && !block
    ? { text: "Connect wallet", disabled: false, onClick: () => setConnectOpen(true) }
    : connected && needsSetup && !block
    ? { text: "Set up account to trade", disabled: false, onClick: () => router.push("/funds") }
    : block ? { text: block, disabled: true, onClick: () => {} }
    : { text: busy ? "Working…" : label, disabled: busy, onClick: () => void submit() };

  // ---- shortcuts ----
  const stepPrice = (dir: 1 | -1) => {
    const base = pr.ok ? pr.value : quote(outcome) ?? 500_000n;
    const next = base + BigInt(dir) * L.tick;
    setPriceS(formatUnits(next < L.minPrice ? L.minPrice : next > L.maxPrice ? L.maxPrice : next, 2, 2)); edit();
  };
  const addShares = (whole: number) => {
    const cur = q.ok ? qty : 0n;
    const next = cur + BigInt(whole) * WHOLE;
    setQtyS(formatUnits(next < 0n ? 0n : next)); edit();
  };
  const sellCap = mode === "take" && offer ? (held < offer.qty ? held : offer.qty) : held; // holdings and the bound quote
  const pct = (p: number) => { setQtyS(formatUnits(floorLot((sellCap * BigInt(p)) / 100n))); edit(); };
  const addBudget = (n: number) => {
    const cur = amount.ok ? amount.value : 0n;
    setAmountS(formatUnits(cur + BigInt(n) * WHOLE)); edit();
  };

  const yesNo = (o: Outcome) => (o === "YES" ? "text-yes" : "text-no");
  const hasResult = qty > 0n && total != null;
  const chip = `rounded-md px-2 py-1 text-xs font-semibold ${C.mute} hover:bg-white/10 hover:text-fg`;
  const bigInput = "min-w-0 flex-1 bg-transparent text-right text-[32px] font-semibold leading-none outline-none bare placeholder:text-[#4b525c]";

  return (
    <section aria-label="Trade" className={`flex min-h-0 flex-col rounded-2xl border ${C.line} ${C.bg} text-[#F3F5F7]`}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {/* 1. market identity */}
        <div className="flex items-center gap-3 pb-4">
          <TopicIcon market={m} size={48} />
          <div className="min-w-0 flex-1">
            <p className={`truncate text-sm ${C.mute}`} title={m.question}>{m.question}</p>
            <p className="truncate text-base font-bold" data-testid="identity-label">{marketLabel(m.question)} · <span className={yesNo(outcome)}>{outcome}</span></p>
          </div>
        </div>

        {/* 2. navigation row */}
        <div className={`flex items-end justify-between border-t ${C.line} pt-3`}>
          <div role="radiogroup" aria-label="Buy or sell" className="flex gap-5">
            {(["buy", "sell"] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={side === s} onClick={() => change({ side: s, offerId: null })}
                className={`relative pb-2 text-[15px] font-semibold ${side === s ? "text-[#F3F5F7]" : `${C.mute} hover:text-fg`}`}>
                {s === "buy" ? "Buy" : "Sell"}
                {side === s && <span aria-hidden className="absolute bottom-0 left-0 h-0.5 w-5 rounded bg-white" />}
              </button>
            ))}
          </div>
          <label className="relative mb-1 flex items-center">
            <span className="sr-only">Order mode</span>
            <select value={mode} onChange={(e) => change({ mode: e.target.value as "take" | "limit" })}
              className="h-8 cursor-pointer appearance-none rounded-lg bg-transparent pl-2 pr-6 text-sm font-medium text-[#F3F5F7] hover:bg-white/10">
              <option value="take">Market</option>
              <option value="limit">Limit</option>
            </select>
            <Icon name="caret" size={16} className={`pointer-events-none absolute right-1 ${C.mute}`} />
          </label>
        </div>
        <div className={`mb-4 border-b ${C.line}`} />

        <div className="space-y-4">
          {/* 3. YES / NO quote buttons (both sides) */}
          <div role="radiogroup" aria-label="Outcome" className="grid grid-cols-2 gap-3">
            {(["YES", "NO"] as const).map((o) => {
              const on = outcome === o;
              const p = quote(o);
              const cls = on ? (o === "YES" ? "bg-[#1f9d63] text-white" : "bg-[#d9505f] text-white") : `bg-[#15181E] border ${C.line} ${C.mute} hover:text-fg`;
              return (
                <button key={o} type="button" role="radio" aria-checked={on} onClick={() => change({ outcome: o, offerId: null })}
                  className={`h-12 rounded-lg text-[15px] font-semibold ${cls}`}>{o} {p == null ? "—" : `${priceStr(p)} ${sym}`}</button>
              );
            })}
          </div>

          {/* 4. inputs */}
          {mode === "limit" && (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className={`text-sm ${C.mute}`}>Limit price</span>
                <div className={`flex h-10 items-center rounded-lg ${C.field} focus-within:ring-1 focus-within:ring-brand`}>
                  <button type="button" aria-label={`Decrease price by ${formatUnits(L.tick, 2, 6)}`} onClick={() => stepPrice(-1)} className={`h-10 w-9 text-lg ${C.mute} hover:text-fg`}>−</button>
                  <input id="limit-price" inputMode="decimal" value={priceS} placeholder="0.50" aria-label="Limit price" aria-invalid={!!priceS && !pr.ok} onChange={(e) => { setPriceS(e.target.value); edit(); }}
                    className="bare w-16 bg-transparent text-center text-base font-semibold outline-none placeholder:text-[#4b525c]" />
                  <button type="button" aria-label={`Increase price by ${formatUnits(L.tick, 2, 6)}`} onClick={() => stepPrice(1)} className={`h-10 w-9 text-lg ${C.mute} hover:text-fg`}>+</button>
                </div>
              </div>
              {priceS && !pr.ok && <p className="-mt-2 text-right text-xs text-no" role="alert">{pr.error}</p>}
              {crossing && <p className="-mt-2 text-right text-xs text-[#f0c35a]">This price matches an existing offer, so it will rest instead of filling. Use Market to trade now.</p>}
            </>
          )}

          {isMarketBuy ? (
            <div>
              <label className="flex items-center gap-3 py-1">
                <span className={`text-sm ${C.mute}`}>Amount</span>
                <input id="amount" inputMode="decimal" value={amountS} placeholder="0" aria-label={`Amount in ${sym}`} aria-invalid={!!amountS && !amount.ok} onChange={(e) => { setAmountS(e.target.value); edit(); }} className={bigInput} />
                <span className={`self-end pb-1 text-sm ${C.mute}`}>{sym}</span>
              </label>
              <div className="mt-1 flex justify-end gap-1">
                {[1, 5, 10, 100].map((n) => <button key={n} type="button" onClick={() => addBudget(n)} className={chip}>+{n}</button>)}
                <button type="button" onClick={() => { const cap = offer ? (offer.qty * offer.price) / ONE : avail; setAmountS(formatUnits(avail < cap ? avail : cap)); edit(); }} className={chip}>Max</button>
              </div>
              {amountS && !amount.ok && <p className="mt-1 text-right text-xs text-no" role="alert">{amount.error}</p>}
            </div>
          ) : (
            <div>
              <label className="flex items-center gap-3 py-1">
                <span className={`text-sm ${C.mute}`}>Shares</span>
                <input id="qty" inputMode="decimal" value={qtyS} placeholder="0" aria-label="Shares" aria-invalid={!!qtyS && !q.ok} onChange={(e) => { setQtyS(e.target.value); edit(); }}
                  className={mode === "limit" ? "bare min-w-0 flex-1 bg-transparent text-right text-xl font-semibold outline-none placeholder:text-[#4b525c]" : bigInput} />
              </label>
              <div className="mt-1 flex justify-end gap-1">
                {side === "buy"
                  ? <>
                      {[-100, -10, 10, 100].map((n) => <button key={n} type="button" onClick={() => addShares(n)} className={chip}>{n > 0 ? `+${n}` : `−${-n}`}</button>)}
                      <button type="button" onClick={() => { const p = pr.ok ? pr.value : null; if (p) { setQtyS(formatUnits(floorLot((avail * ONE) / p))); edit(); } }} disabled={!pr.ok} className={chip}>Max</button>
                    </>
                  : [25, 50, 75, 100].map((n) => <button key={n} type="button" onClick={() => pct(n)} className={chip}>{n === 100 ? "Max" : `${n}%`}</button>)}
              </div>
              {qtyS && !q.ok && <p className="mt-1 text-right text-xs text-no" role="alert">{q.error}</p>}
            </div>
          )}

          {/* secondary line: bound offer (Market mode) */}
          {mode === "take" && (
            <div className={`text-xs ${C.mute}`} data-testid="selected-offer">
              {gone && <p role="alert" className="mb-1 text-no">That offer is no longer available. Choose another.</p>}
              {offer ? (
                <p>{priceStr(offer.price)} {sym}/share · {formatUnits(offer.qty, 0, 4)} available
                  {candidates.length > 1 && <> · <button type="button" onClick={() => setChanging(!changing)} aria-expanded={changing} className="font-semibold text-[#8da0ff] hover:underline">Change</button></>}</p>
              ) : (
                <p>{gone ? "No offer selected" : side === "buy" ? "No offers to buy right now" : "No bids to sell into right now"}
                  {candidates.length > 0 && <> · <button type="button" onClick={() => setChanging(!changing)} className="font-semibold text-[#8da0ff] hover:underline">Choose</button></>}</p>
              )}
              {changing && (
                <ul className={`mt-1 max-h-32 divide-y divide-[#2B3039] overflow-y-auto rounded-lg border ${C.line}`} aria-label="Choose an offer">
                  {candidates.map((o) => (
                    <li key={o.id}>
                      <button type="button" aria-pressed={offer?.id === o.id} onClick={() => { change({ offerId: o.id }); setChanging(false); }}
                        className={`flex min-h-9 w-full items-center justify-between px-3 text-sm hover:bg-white/10 ${offer?.id === o.id ? "text-[#8da0ff]" : "text-fg"}`}>
                        <span className="font-semibold">{priceStr(o.price)} {sym}</span><span className={C.mute}>{formatUnits(o.qty, 0, 4)} shares</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {connected && (
            <p className={`text-xs ${C.mute}`} data-testid="balance">
              {accountStatus === "loading" ? "Loading balance…"
                : accountStatus === "error" ? <span role="alert" className="text-no">Couldn’t load your balance. <button type="button" onClick={refresh} className="font-semibold underline">Retry</button></span>
                : side === "buy" ? <>Available collateral: <b className="text-fg">{money(avail, sym)}</b></> : <>Available {outcome} shares: <b className="text-fg">{formatUnits(held, 0, 4)}</b></>}
            </p>
          )}

          {/* 5. footer summary: plain rows on the ticket surface */}
          {(mode === "limit" || hasResult) && (
            <div aria-label="Order summary" className={`space-y-2 border-t ${C.line} pt-3 text-sm`}>
              {mode === "limit" && (
                <label className="flex items-center justify-between">
                  <span className={C.mute}>Expires</span>
                  <span className="relative flex items-center">
                    <select value={expiry} onChange={(e) => { setExpiry(e.target.value as typeof expiry); edit(); }} aria-label="Expires"
                      className="cursor-pointer appearance-none bg-transparent pr-5 text-right font-semibold outline-none bare">
                      {EXPIRY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <Icon name="caret" size={16} className={`pointer-events-none absolute right-0 ${C.mute}`} />
                  </span>
                </label>
              )}
              {hasResult && (side === "buy" ? (
                <>
                  {isMarketBuy
                    ? <div className="flex justify-between"><span className={C.mute}>Est. shares</span><span className="font-semibold">{formatUnits(qty, 0, 4)}</span></div>
                    : <div className="flex justify-between"><span className={C.mute}>Total</span><span className="font-semibold text-[#8da0ff]">{money(total!, sym)}</span></div>}
                  <div className="flex items-baseline justify-between"><span className={C.mute}>Payout if {outcome} wins</span><span className="text-lg font-semibold text-yes">{money(qty, sym)}</span></div>
                </>
              ) : (
                <div className="flex items-baseline justify-between"><span className={C.mute}>You’ll receive</span><span className="text-lg font-semibold">{money(total!, sym)}</span></div>
              ))}
              {hasResult && (
                <details className={`text-xs ${C.mute}`}>
                  <summary className="cursor-pointer select-none hover:text-fg">Details</summary>
                  <dl className="mt-1.5 space-y-1">
                    <Row k="Price per share" v={unit == null ? "—" : `${priceStr(unit)} ${sym}`} />
                    <Row k="Shares" v={formatUnits(qty, 0, 6)} />
                    {isMarketBuy && <Row k="Cost" v={money(total!, sym)} />}
                    <Row k="Fees" v={`0 ${sym}`} />
                    {mode === "limit" && <Row k={side === "buy" ? "Collateral reserved" : "Shares reserved"} v={side === "buy" ? money(total!, sym) : formatUnits(qty, 0, 6)} />}
                  </dl>
                </details>
              )}
            </div>
          )}

          {needsSetup && <p role="status" className="rounded-lg bg-[#15181E] px-3 py-2 text-xs text-[#969DA8]" data-testid="setup-needed">Before trading in this market you must register {holding?.registered === false ? "with its contract" : ""}{holding?.registered === false && wallet?.tokenRegistered === false ? " and " : ""}{wallet?.tokenRegistered === false ? `with the ${sym} token` : ""}, then deposit collateral into it. These steps are on the Funds page.</p>}
          {live && deployment.state === "error" && <p role="alert" className="rounded-lg bg-no-bg/50 px-3 py-2 text-xs text-no" data-testid="deployment-error">This market failed verification, so wallet actions are off: {deployment.problems.join(" ")} <button type="button" className="font-semibold underline" onClick={retry}>Check again</button></p>}
          {live && m.chain === "unavailable" && <p className={`text-xs ${C.mute}`} data-testid="chain-unavailable">The contract could not be read just now, so the status shown comes from the indexer. Wallet actions re-check the contract before signing.</p>}
          {wrongNetwork && <p role="alert" className="rounded-lg bg-no-bg/50 px-3 py-2 text-xs text-no">This wallet looks like a mainnet account but the app is set to testnet. Switch your wallet to testnet.</p>}
          <TransactionStatus tx={tx} demo={demo} />
          <button type="button" disabled={primary.disabled} onClick={primary.onClick}
            className="h-12 w-full rounded-lg bg-[#3E5DFF] text-base font-semibold text-white transition-colors hover:bg-[#5470ff] disabled:bg-[#2B3039] disabled:text-[#969DA8]">{primary.text}</button>
        </div>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><dt>{k}</dt><dd className="text-fg">{v}</dd></div>;
}
