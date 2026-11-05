/**
 * FastNEAR Neardata client (https://docs.fastnear.com/neardata). Testnet host: testnet.neardata.xyz.
 * Verified 2026-11-05: testnet blocks served without authentication; `/v0/block/{h}` is finalized data, skipped heights return null/404.
 * Optional API key is sent as `Authorization: Bearer` when configured.
 */
export class NeardataUnavailableError extends Error { constructor(m: string) { super(m); this.name = "NeardataUnavailableError"; } }

export interface NdReceipt { execution_outcome: { id: string; block_hash: string; outcome: { executor_id: string; logs: string[]; status: any } }; receipt: { predecessor_id: string; receiver_id: string; receipt_id: string }; tx_hash?: string }
export interface NdBlock { block: { header: { height: number; hash: string; timestamp_nanosec: string | number } }; shards: { shard_id: number; receipt_execution_outcomes?: NdReceipt[] }[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Neardata {
  constructor(private base: string, private apiKey: string | null = null, private f: typeof fetch = fetch, private retries = 8) {}
  private headers(): Record<string, string> { return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}; }

  private async get(path: string): Promise<Response> {
    let last = "";
    for (let i = 0; i <= this.retries; i++) {
      try {
        const r = await this.f(this.base + path, { headers: this.headers(), redirect: "follow", signal: AbortSignal.timeout(20000) });
        if (r.status === 401 || r.status === 403) throw new NeardataUnavailableError(`neardata auth required (${r.status}): set NEARDATA_API_KEY`);
        if (r.status === 429 || r.status >= 500) { last = `http ${r.status}`; await sleep(Math.min(15000, 1000 * 2 ** i) + Math.random() * 500); continue; }
        return r;
      } catch (e) {
        if (e instanceof NeardataUnavailableError) throw e;
        last = (e as Error).message; await sleep(500 * 2 ** i);
      }
    }
    throw new NeardataUnavailableError(`neardata unavailable: ${last}`);
  }

  async finalHeight(): Promise<number> {
    const r = await this.get("/v0/last_block/final");
    if (!r.ok) throw new NeardataUnavailableError(`neardata last_block/final http ${r.status}`);
    const j = (await r.json()) as NdBlock;
    return j.block.header.height;
  }

  /** null when the height was skipped (no block) */
  async block(height: number): Promise<NdBlock | null> {
    const r = await this.get(`/v0/block/${height}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new NeardataUnavailableError(`neardata block ${height} http ${r.status}`);
    const j = await r.json();
    return j ? (j as NdBlock) : null;
  }
}
