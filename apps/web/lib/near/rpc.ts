import { config } from "../config";

export class RpcError extends Error {
  constructor(message: string, readonly name_?: string) { super(message); }
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nearodds", method, params }),
  });
  if (!res.ok) throw new RpcError(`RPC error ${res.status}`);
  const j = await res.json();
  if (j.error) throw new RpcError(typeof j.error.data === "string" ? j.error.data : j.error.message ?? "RPC call failed", j.error.cause?.name ?? j.error.name);
  if (j.result?.error) throw new RpcError(j.result.error);
  return j.result as T;
}

/** Height of the latest final block. Pin multi-page reads to one height so they are consistent. */
export async function finalBlockHeight(): Promise<number> {
  const b = await rpc<{ header: { height: number } }>("block", { finality: "final" });
  return b.header.height;
}

export async function view<T>(contractId: string, method: string, args: object = {}, blockHeight?: number): Promise<T> {
  const result = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    ...(blockHeight == null ? { finality: "final" } : { block_id: blockHeight }),
    account_id: contractId, method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}

/** Native NEAR balance (yoctoNEAR) of an account; 0n if the account does not exist yet. */
export async function nativeBalance(accountId: string): Promise<bigint> {
  try {
    const a = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId });
    return BigInt(a.amount);
  } catch (e) {
    if (e instanceof RpcError && /does not exist|UnknownAccount/i.test(`${e.message} ${e.name_ ?? ""}`)) return 0n;
    throw e;
  }
}

/** Executed outcome of a transaction, waiting for FINAL finality. Returns null while the network does not know it yet. */
export async function txStatus(hash: string, signerId: string): Promise<unknown | null> {
  try {
    return await rpc<unknown>("tx", { tx_hash: hash, sender_account_id: signerId, wait_until: "FINAL" });
  } catch (e) {
    if (e instanceof RpcError && /timeout|UNKNOWN_TRANSACTION|doesn't exist|not found|not.*known/i.test(`${e.message} ${e.name_ ?? ""}`)) return null;
    throw e;
  }
}
