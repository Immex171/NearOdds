import { config } from "../config";

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nearodds", method, params }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(j.result?.error ?? j.error?.data ?? "RPC call failed");
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
