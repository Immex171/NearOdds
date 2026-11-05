/** Transactions the app sent whose final result it could not confirm. They stay tied to their hash and are only ever re-READ. */
export interface PendingTx { hash: string; signer: string; label: string; marketRef: string | null; at: number }

const KEY = "nearodds:pending-tx:v1";
const subs = new Set<() => void>();
let memory: PendingTx[] = [];

function read(): PendingTx[] {
  try { const v = localStorage.getItem(KEY); return v ? (JSON.parse(v) as PendingTx[]) : memory; } catch { return memory; }
}
function write(list: PendingTx[]) {
  memory = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: kept in memory for this tab */ }
  subs.forEach((f) => f());
}

export const pendingTxs = {
  list: (signer?: string | null) => read().filter((p) => !signer || p.signer === signer),
  add(p: PendingTx) { const cur = read(); if (!cur.some((x) => x.hash === p.hash)) write([...cur, p]); },
  remove(hash: string) { write(read().filter((p) => p.hash !== hash)); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};
