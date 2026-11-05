import { Neardata, type NdBlock } from "../../src/indexer/neardata.js";

export const ev = (event: string, data: object, version = "1.0.0", standard = "nearodds_market") => "EVENT_JSON:" + JSON.stringify({ standard, version, event, data });
export type R = { id: string; executor?: string; status?: any; logs: string[] };
export const block = (height: number, receipts: R[], defaultExecutor = "mkt-a.test.testnet"): NdBlock => ({
  block: { header: { height, hash: `h${height}`, timestamp_nanosec: String(1_800_000_000_000_000_000n + BigInt(height) * 1_000_000_000n) } },
  shards: [{ shard_id: 0, receipt_execution_outcomes: receipts.map((r) => ({ execution_outcome: { id: r.id, block_hash: `h${height}`, outcome: { executor_id: r.executor ?? defaultExecutor, logs: r.logs, status: r.status ?? { SuccessValue: "" } } }, receipt: { predecessor_id: "x", receiver_id: r.executor ?? defaultExecutor, receipt_id: r.id }, tx_hash: "tx" + r.id })) }],
});
/** Link prev_height the way the chain does: each block points to the previous EXISTING block. */
export function link(chain: Map<number, NdBlock>, hidden: Set<number> = new Set()) {
  const hs = [...chain.keys()].sort((a, b) => a - b);
  hs.forEach((h, i) => { chain.get(h)!.block.header.prev_height = i ? hs[i - 1] : h - 1; });
  void hidden;
}
export function fakeNeardata(chain: Map<number, NdBlock>, tip: () => number, opts: { fail429?: number; down?: boolean; unavailable?: Set<number> } = {}) {
  let n429 = opts.fail429 ?? 0;
  const f = (async (url: string) => {
    if (opts.down) throw new Error("ECONNRESET");
    const path = new URL(url).pathname;
    if (path === "/v0/last_block/final") return new Response(JSON.stringify({ block: { header: { height: tip() } }, shards: [] }));
    const h = Number(path.split("/").pop());
    if (n429 > 0) { n429--; return new Response("slow down", { status: 429 }); }
    const b = chain.get(h);
    if (!b || opts.unavailable?.has(h)) return new Response("null", { status: 404 });
    return new Response(JSON.stringify(b));
  }) as unknown as typeof fetch;
  return new Neardata("http://nd.test", null, f, 6, 1);
}
