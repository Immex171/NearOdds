/** Minimal JSON-RPC client. Distinguishes "the chain says no" from "we could not ask". */
export class RpcUnavailableError extends Error {
  constructor(msg: string, readonly cause_?: unknown) { super(msg); this.name = "RpcUnavailableError"; }
}
export class RpcError extends Error {
  constructor(readonly rpcName: string, readonly causeName: string | null, readonly data: unknown, msg: string) { super(msg); this.name = "RpcError"; }
}

export interface AccountInfo { exists: true; amount: string; locked: string; codeHash: string; storageUsage: number }
export type AccountLookup = AccountInfo | { exists: false };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RpcOptions { url: string; retries?: number; timeoutMs?: number; fetchImpl?: typeof fetch; backoffMs?: number }

export class Rpc {
  readonly url: string;
  private retries: number;
  private timeoutMs: number;
  private f: typeof fetch;
  private backoff: number;
  constructor(o: RpcOptions) {
    this.url = o.url; this.retries = o.retries ?? 4; this.timeoutMs = o.timeoutMs ?? 15000; this.f = o.fetchImpl ?? fetch; this.backoff = o.backoffMs ?? 400;
  }

  /** Single attempt. Network failures, timeouts, 5xx/429 -> RpcUnavailableError. Protocol errors -> RpcError. */
  async once<T = any>(method: string, params: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(this.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "x", method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) { throw new RpcUnavailableError(`rpc ${method} unreachable: ${(e as Error).message}`, e); }
    if (res.status === 429 || res.status >= 500) throw new RpcUnavailableError(`rpc ${method} http ${res.status}`);
    let body: any;
    try { body = await res.json(); } catch (e) { throw new RpcUnavailableError(`rpc ${method} bad body`, e); }
    if (body.error) {
      const name = body.error.name as string | undefined;
      const causeName = body.error.cause?.name ?? null;
      // Node-side transient conditions are availability problems, not answers.
      if (causeName === "TIMEOUT_ERROR" || causeName === "UNAVAILABLE_SHARD" || causeName === "NOT_SYNCED_YET" || causeName === "INTERNAL_ERROR" || name === "INTERNAL_ERROR")
        throw new RpcUnavailableError(`rpc ${method}: ${causeName ?? name}`);
      throw new RpcError(name ?? "UNKNOWN", causeName, body.error.data ?? body.error.cause, `rpc ${method}: ${body.error.data ?? causeName ?? body.error.message}`);
    }
    return body.result as T;
  }

  /** Bounded retries; ONLY for read operations (never for signing/broadcast decisions). */
  async read<T = any>(method: string, params: unknown): Promise<T> {
    let last: unknown;
    for (let i = 0; i <= this.retries; i++) {
      try { return await this.once<T>(method, params); }
      catch (e) { if (!(e instanceof RpcUnavailableError)) throw e; last = e; if (i < this.retries) await sleep(this.backoff * 2 ** i); }
    }
    throw last;
  }

  /** Explicit UNKNOWN_ACCOUNT -> {exists:false}; any unavailability throws. */
  async viewAccount(accountId: string, block: { finality: "final" } | { block_id: number } = { finality: "final" }): Promise<AccountLookup> {
    try {
      const r = await this.read("query", { request_type: "view_account", account_id: accountId, ...block });
      return { exists: true, amount: r.amount, locked: r.locked, codeHash: r.code_hash, storageUsage: r.storage_usage };
    } catch (e) {
      if (e instanceof RpcError && (e.causeName === "UNKNOWN_ACCOUNT")) return { exists: false };
      throw e;
    }
  }

  async callView<T = unknown>(contract: string, method: string, args: unknown = {}, block: { finality: "final" } | { block_id: number } = { finality: "final" }): Promise<T> {
    const r = await this.read("query", {
      request_type: "call_function", account_id: contract, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), ...block,
    });
    if (r.error) throw new RpcError("CONTRACT", null, r.error, `view ${contract}.${method}: ${r.error}`);
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  async finalBlock(): Promise<{ height: number; hash: string; timestampNs: string }> {
    const b = await this.read("block", { finality: "final" });
    return { height: b.header.height, hash: b.header.hash, timestampNs: String(b.header.timestamp_nanosec) };
  }

  async accessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; permission: unknown } | null> {
    try {
      const r = await this.read("query", { request_type: "view_access_key", account_id: accountId, public_key: publicKey, finality: "final" });
      return { nonce: BigInt(r.nonce), permission: r.permission };
    } catch (e) {
      if (e instanceof RpcError && (e.causeName === "UNKNOWN_ACCESS_KEY" || e.causeName === "UNKNOWN_ACCOUNT")) return null;
      throw e;
    }
  }

  async accessKeyList(accountId: string): Promise<{ publicKey: string; nonce: bigint; permission: unknown }[]> {
    const r = await this.read("query", { request_type: "view_access_key_list", account_id: accountId, finality: "final" });
    return r.keys.map((k: any) => ({ publicKey: k.public_key, nonce: BigInt(k.access_key.nonce), permission: k.access_key.permission }));
  }
}
