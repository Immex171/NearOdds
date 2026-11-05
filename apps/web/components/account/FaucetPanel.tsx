"use client";
import { formatUnits } from "@/lib/amounts";
import { useApp } from "@/lib/app-context";
import { useFaucet } from "@/lib/faucet";
import type { Market } from "@/lib/types";
import { Btn } from "../ui/bits";

const fmtSecs = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

/** Test-token faucet. Distinct from native NEAR, which pays for fees and storage and is NOT provided here. */
export function FaucetPanel({ m, ownerHint }: { m: Market; ownerHint?: string }) {
  const { accountId, auth, signIn, refresh, session } = useApp();
  const signed = auth.state === "signed-in";
  const { state, stateError, claim, request, reset } = useFaucet({ accountId: session.kind === "wallet" ? accountId : null, signedIn: signed, onMinted: refresh });
  const sym = m.token.symbol;
  const amount = state ? `${formatUnits(BigInt(state.amountPerClaim), 0, m.token.decimals)} ${sym}` : "";
  const wrongToken = !!state?.tokenId && state.tokenId !== m.contract?.tokenId;
  const busy = claim.phase === "submitting" || claim.phase === "queued";
  const note = "Test tokens have no value. This does not send NEAR: fees and storage deposits need testnet NEAR from elsewhere.";

  let body: React.ReactNode;
  if (stateError && !state) body = <p role="alert" className="text-no" data-testid="faucet-unavailable">The faucet status could not be loaded: {stateError}</p>;
  else if (!state) body = <p className="text-mute">Checking the faucet…</p>;
  else if (!state.enabled) {
    body = (
      <div data-testid="faucet-disabled">
        <p><b className="text-fg">The faucet is turned off.</b> {state.disabledReason}</p>
        <p className="mt-1">{sym} can still be minted by hand by the token owner{ownerHint ? ` (${ownerHint})` : ""}: ask the operator to run <code className="rounded bg-page px-1">scripts/testnet-mint.sh</code> for <b className="text-fg">{accountId}</b>.</p>
      </div>
    );
  } else if (wrongToken) {
    body = <p data-testid="faucet-wrong-token">This faucet mints <b className="text-fg">{state.tokenId}</b>, which is not the token of the selected market ({m.contract?.tokenId}). Pick a market that uses it to fund that balance.</p>;
  } else {
    body = (
      <div className="space-y-2">
        <p>Claim <b className="text-fg">{amount}</b> of free test collateral. Limits: {formatUnits(BigInt(state.limits.perAccount), 0, m.token.decimals)} {sym} per account, one claim per {fmtSecs(state.limits.cooldownSeconds)}.</p>
        {!signed ? (
          <div>
            <p className="text-mute">Sign in with your wallet (a free signature, no transaction) to claim.</p>
            <Btn className="mt-2" onClick={() => void signIn()} disabled={auth.state === "signing"}>{auth.state === "signing" ? "Waiting for wallet…" : "Sign in with wallet"}</Btn>
            {auth.state === "error" && <p role="alert" className="mt-1 text-xs text-no">{auth.message}</p>}
          </div>
        ) : (
          <>
            {claim.phase === "queued" && (
              <p role="status" data-testid="faucet-queued" className="rounded-lg border border-[#e8913a]/50 bg-[#e8913a]/10 px-3 py-2">
                <b>Queued, not funded yet.</b> The mint has been requested but your wallet has not received any {sym}. This page updates when it finishes. Request id: <code>{claim.claimId}</code>
              </p>
            )}
            {claim.phase === "minted" && <p role="status" data-testid="faucet-minted" className="rounded-lg border border-yes/40 bg-yes-bg/40 px-3 py-2"><b>Minted {formatUnits(BigInt(claim.amount || state.amountPerClaim), 0, m.token.decimals)} {sym}.</b> Your wallet balance has been refreshed.</p>}
            {claim.phase === "failed" && <p role="alert" data-testid="faucet-failed" className="rounded-lg border border-no/40 bg-no-bg/40 px-3 py-2 text-no"><b>The mint failed.</b> {claim.message}</p>}
            {claim.phase === "refused" && <p role="alert" data-testid={`faucet-${claim.kind}`} className="rounded-lg border border-[#e8913a]/40 bg-[#e8913a]/10 px-3 py-2 text-[#f3b36b]">{claim.message}</p>}
            {claim.phase === "retry" && <p role="status" data-testid="faucet-retry" className="rounded-lg border border-[#e8913a]/40 bg-[#e8913a]/10 px-3 py-2 text-[#f3b36b]">{claim.message}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Btn disabled={busy} onClick={() => void request()} data-testid="faucet-claim">
                {claim.phase === "submitting" ? "Requesting…" : claim.phase === "queued" ? "Minting…" : claim.phase === "retry" ? "Retry the same request" : `Claim ${amount}`}
              </Btn>
              {(claim.phase === "minted" || claim.phase === "failed" || claim.phase === "refused") && <button type="button" onClick={reset} className="text-xs text-mute underline">Dismiss</button>}
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <section aria-label="Test-token faucet" className="rounded-[14px] border border-line bg-card p-4" data-testid="faucet">
      <h2 className="text-lg font-semibold">Get {sym} test tokens</h2>
      <div className="mt-2 text-sm text-mute">{body}</div>
      <p className="mt-3 text-xs text-mute">{note}{state?.notice ? "" : ""}</p>
    </section>
  );
}
