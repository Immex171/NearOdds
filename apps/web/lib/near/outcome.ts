import { txStatus } from "./rpc";

/** A wallet "success" is not proof every receipt succeeded: scan all receipt outcomes. */
export interface FinalOutcome {
  final_execution_status?: string;
  transaction_outcome?: { id?: string };
  transaction?: { hash?: string };
  receipts_outcome?: Array<{ outcome?: { status?: unknown } }>;
  status?: unknown;
}

export function txHash(o: unknown): string | undefined {
  const x = o as FinalOutcome;
  return x?.transaction_outcome?.id ?? x?.transaction?.hash;
}

/** Throws the contract's panic text (or a generic message) when the transaction or any of its receipts failed. */
export function assertAllReceiptsOk(o: unknown) {
  const x = o as FinalOutcome;
  const bad = [x?.status, ...(x?.receipts_outcome ?? []).map((r) => r.outcome?.status)].find(
    (s) => s && typeof s === "object" && "Failure" in (s as object),
  );
  if (bad) {
    const text = JSON.stringify(bad);
    const m = /Smart contract panicked: ([^"\\]+)/.exec(text);
    throw new Error(m ? m[1] : "A receipt in this transaction failed on-chain");
  }
}

/** The transaction's final return value (JSON), e.g. a FillResult, or the used amount of ft_transfer_call. */
export function successValue<T = unknown>(o: unknown): T | undefined {
  const s = (o as FinalOutcome)?.status as { SuccessValue?: string } | undefined;
  if (!s || typeof s.SuccessValue !== "string" || s.SuccessValue === "") return undefined;
  try { return JSON.parse(atob(s.SuccessValue)) as T; } catch { return undefined; }
}

const FINAL = new Set(["FINAL", "EXECUTED_OPTIMISTIC", "EXECUTED"]);
/** True when the outcome carries every receipt result (so it can be trusted as complete). */
export const isComplete = (o: unknown) => {
  const x = o as FinalOutcome;
  return Boolean(x && x.status && (x.final_execution_status == null || x.final_execution_status === "FINAL" || FINAL.has(x.final_execution_status)) && x.receipts_outcome);
};

/** The network has not reported a final result yet. The transaction may still succeed: never resend, keep tracking the hash. */
export class UnconfirmedError extends Error {
  constructor(readonly hash: string) { super("The network has not reported the final result of this transaction yet. Do not resend it: it is still being tracked by its hash."); this.name = "UnconfirmedError"; }
}

/**
 * Resolves the executed outcome of a transaction from the chain itself (not from what the wallet reports).
 * Keeps asking until the network returns a FINAL outcome or `timeoutMs` passes; never resubmits anything.
 */
export async function awaitFinalOutcome(hash: string, signerId: string, timeoutMs = 90_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<FinalOutcome> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const o = (await txStatus(hash, signerId)) as FinalOutcome | null;
    if (o && isComplete(o)) return o;
    if (Date.now() > end) throw new UnconfirmedError(hash);
    await sleep(1500);
  }
}
