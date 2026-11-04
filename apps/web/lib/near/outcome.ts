/** A wallet "success" is not proof every receipt succeeded: scan all receipt outcomes. */
interface Outcome {
  transaction_outcome?: { id?: string };
  transaction?: { hash?: string };
  receipts_outcome?: Array<{ outcome?: { status?: unknown } }>;
  status?: unknown;
}

export function txHash(o: unknown): string | undefined {
  const x = o as Outcome;
  return x?.transaction_outcome?.id ?? x?.transaction?.hash;
}

export function assertAllReceiptsOk(o: unknown) {
  const x = o as Outcome;
  const bad = [x?.status, ...(x?.receipts_outcome ?? []).map((r) => r.outcome?.status)].find(
    (s) => s && typeof s === "object" && "Failure" in (s as object),
  );
  if (bad) {
    const text = JSON.stringify(bad);
    const m = /Smart contract panicked: ([^"\\]+)/.exec(text);
    throw new Error(m ? m[1] : "A receipt in this transaction failed on-chain");
  }
}
