"use client";
import Link from "next/link";
import { formatUnits } from "@/lib/amounts";
import { useAdapterData, useApp } from "@/lib/app-context";
import { useTx } from "@/lib/hooks";
import { cutoffLabel, dateTimeUtc, money } from "@/lib/format";
import type { Market } from "@/lib/types";
import { TransactionStatus } from "../account/TransactionStatus";
import { Badge, Btn, TopicIcon } from "../ui/bits";

const C = { bg: "bg-[#1C2027]", line: "border-[#2B3039]", mute: "text-[#969DA8]" };

/** Replaces the trade form once trading has ended. Driven by get_market().status, never by the clock. */
export function SettlementPanel({ m, onManage }: { m: Market; onManage?: () => void }) {
  const { adapter, account, accountId, session, setConnectOpen, showToast, refresh } = useApp();
  const { tx, run, busy } = useTx();
  const demo = adapter.id === "demo";
  const sym = adapter.symbol;
  const resolved = m.status === "resolved";
  const when = demo ? dateTimeUtc(m.closesAt) : cutoffLabel(m.closesAt);
  const preview = useAdapterData((a) => (resolved && accountId ? a.redeemPreview(m.id, accountId) : Promise.resolve(null)), [m.id, resolved, accountId]);
  const p = preview.data;
  const mergeOpen = m.flags?.mergeOpen ?? !resolved;

  const redeem = async () => {
    const ok = await run((r) => adapter.redeem(m.id, r));
    if (ok) { showToast(demo ? "Demo redemption completed" : "Redeemed"); refresh(); }
  };

  return (
    <section aria-label="Trade" className={`flex min-h-0 flex-col rounded-2xl border ${C.line} ${C.bg} text-[#F3F5F7]`}>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        <div className="flex items-center gap-3">
          <TopicIcon market={m} size={48} />
          <div className="min-w-0 flex-1">
            <p className={`truncate text-sm ${C.mute}`} title={m.question}>{m.question}</p>
            <p className="text-base font-bold" data-testid="settlement-title">{resolved ? `Resolved ${m.resolution.outcome}` : "Trading has ended"}</p>
          </div>
        </div>

        {!resolved ? (
          <div className="space-y-3 text-sm" data-testid="awaiting-panel">
            <Badge tone="warn">Awaiting resolution</Badge>
            <p>Trading closed at <b>{when}</b>. The market now waits for its resolver ({m.resolution.resolver}) to record the result.</p>
            <ul className={`list-disc space-y-1 pl-5 ${C.mute}`}>
              <li>New offers and fills are closed.</li>
              <li>You can still cancel your open offers and withdraw available collateral.</li>
              <li>{mergeOpen ? "You can still combine equal YES + NO shares back into collateral." : "Combining shares is closed."}</li>
              <li>After the result is recorded, winning shares can be redeemed here.</li>
            </ul>
            {onManage && mergeOpen && <Btn variant="outline" className="w-full" onClick={onManage}>Combine YES + NO shares</Btn>}
          </div>
        ) : (
          <div className="space-y-3 text-sm" data-testid="resolved-panel">
            <div className="flex items-center gap-2"><Badge tone={m.resolution.outcome === "YES" ? "yes" : "no"}>{m.resolution.outcome} won</Badge><span className={C.mute}>Final. It cannot be changed.</span></div>
            {m.resolution.note && <p className={C.mute}>{m.resolution.note}</p>}
            {!accountId ? (
              <Btn className="w-full" onClick={() => setConnectOpen(true)}>Connect wallet to redeem</Btn>
            ) : preview.loading || !account ? <div className="skeleton h-24" /> : preview.error ? (
              <p role="alert" className="text-no">Couldn’t load your redemption preview: {preview.error}</p>
            ) : p && p.redeemable ? (
              <dl className="space-y-1.5 rounded-xl bg-[#15181E] p-3" aria-label="Redemption preview">
                <Row k={`Winning ${p.outcome} shares`} v={formatUnits(p.winningShares, 0, 6)} />
                <Row k="Losing shares (worth 0)" v={formatUnits(p.losingShares, 0, 6)} />
                <Row k="Winning payout" v={money(p.payout, sym)} strong />
                {(p.releasedCollateral > 0n || p.offersToRelease > 0) && <Row k={`Released from ${p.offersToRelease} open offer${p.offersToRelease === 1 ? "" : "s"} (not payout)`} v={`${money(p.releasedCollateral, sym)}${p.releasedShares > 0n ? ` + ${formatUnits(p.releasedShares, 0, 6)} shares` : ""}`} />}
                <Row k="Available balance after" v={money(p.availableAfter, sym)} />
              </dl>
            ) : <p className={C.mute}>You have nothing to redeem on this market{p?.outcome ? "" : "."}</p>}

            {accountId && p?.redeemable && (
              <>
                <TransactionStatus tx={tx} demo={demo} />
                <Btn className="min-h-12 w-full" disabled={busy || (session.kind === "wallet" && account?.registered === false)} onClick={() => void redeem()}>
                  {busy ? "Working…" : demo ? "Simulate redeem" : "Redeem"}
                </Btn>
              </>
            )}
            <div className={`rounded-xl border ${C.line} p-3 text-xs ${C.mute}`}>
              <p><b className="text-fg">Two steps.</b> <b>1. Redeem</b> turns your resolved shares into available collateral <i>inside NearOdds</i>; no tokens move. <b>2. Withdraw</b> sends available collateral to your wallet and settles asynchronously. {accountId && <Link href="/funds" className="font-semibold text-[#8da0ff] hover:underline">Go to Funds</Link>}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className="flex justify-between gap-3"><dt className={C.mute}>{k}</dt><dd className={strong ? "font-semibold text-yes" : "font-medium"}>{v}</dd></div>;
}
