"use client";
import { useApp } from "@/lib/app-context";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/bits";

export function Overlays() {
  const { connectOpen, setConnectOpen, helpOpen, setHelpOpen, useDemoAccount, connectWallet, liveConfigured, toast, adapter } = useApp();
  return (
    <>
      <Modal open={connectOpen} onClose={() => setConnectOpen(false)} title="Connect wallet">
        <div className="space-y-3">
          <button onClick={useDemoAccount} className="w-full rounded-xl border border-line bg-elev p-4 text-left hover:border-brand">
            <p className="font-semibold">Use demo account</p>
            <p className="mt-1 text-mute">Demo mode: sample markets, a simulated 1,000 TEST wallet and a few positions. Nothing is real and nothing touches a blockchain.</p>
          </button>
          <button disabled={!liveConfigured} onClick={() => void connectWallet()} className="w-full rounded-xl border border-line p-4 text-left hover:border-brand disabled:cursor-not-allowed disabled:opacity-60">
            <p className="font-semibold">Connect NEAR wallet (testnet)</p>
            <p className="mt-1 text-mute">
              {liveConfigured ? "The deployed testnet market. You need a little testnet NEAR for fees and tNOC test collateral (no monetary value). Every transaction is approved in your wallet."
                : "Not configured. Run `pnpm deployment:sync` to derive the contract IDs from deployments/testnet-demo.json (see .env.example)."}
            </p>
          </button>
        </div>
      </Modal>
      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="How NearOdds works" wide>
        <div className="space-y-4 text-[14px] leading-relaxed text-mute">
          <p><b className="text-fg">Every market is a yes/no question.</b> A YES share pays 1 collateral token if the event happens; a NO share pays 1 if it does not. Prices between 0 and 1 are the market’s implied probabilities.</p>
          <p><b className="text-fg">Complete sets.</b> 1 collateral token can always be split into 1 YES + 1 NO share, and 1 YES + 1 NO can be merged back into 1 token. This is what keeps every share fully backed.</p>
          <p><b className="text-fg">Offers.</b> You trade by taking an existing offer or placing your own limit offer that waits for a counterparty. Each outcome has its own order book.</p>
          <p><b className="text-fg">Settlement.</b> After trading closes, a named resolver publishes the outcome using the source in the market’s rules. Winning shares redeem for 1 token each; losing shares are worth 0.</p>
          <p className="rounded-lg bg-elev p-3 text-xs">Currently running on <b className="text-fg">{adapter.id === "demo" ? "demo data" : "the NEAR testnet contract"}</b>. {adapter.id === "demo" ? "All prices, offers and balances are simulated." : "Prices come from real offers on the contract. Price history, volume and activity are unavailable until an indexer exists."} Test tokens have no monetary value.</p>
        </div>
        <Btn className="mt-4 w-full" onClick={() => setHelpOpen(false)}>Got it</Btn>
      </Modal>
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex justify-center px-4 md:bottom-6">
        {toast && <div className="pointer-events-auto rounded-xl border border-line bg-elev px-4 py-2.5 text-sm shadow-xl">{toast}</div>}
      </div>
    </>
  );
}
