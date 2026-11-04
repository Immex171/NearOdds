import { config } from "../config";

export async function view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "nearodds", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: method,
        args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(j.result?.error ?? j.error?.data ?? "RPC call failed");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}
