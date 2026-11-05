"use client";
/** The only module that imports the wallet connector. */
import { config } from "./config";

type Connector = import("@hot-labs/near-connect").NearConnector;

/**
 * Browser-test seam. Compiled in ONLY when the build sets NEXT_PUBLIC_E2E_WALLET=1 (the bundler removes this branch
 * otherwise), so a normal build can never be driven by a page-injected fake wallet.
 */
export interface E2EWallet {
  accountId: string | null;
  signAndSendTransaction(p: { receiverId: string; actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[] }): Promise<unknown>;
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<{ accountId: string; publicKey: string; signature: string }>;
}
const e2e = (): E2EWallet | undefined =>
  process.env.NEXT_PUBLIC_E2E_WALLET === "1" ? (window as unknown as { __e2eWallet?: E2EWallet }).__e2eWallet : undefined;

let connector: Connector | null = null;
const listeners = new Set<(accountId: string | null) => void>();
let current: string | null = null;

async function get(): Promise<Connector> {
  if (connector) return connector;
  const { NearConnector } = await import("@hot-labs/near-connect");
  connector = new NearConnector({ network: config.network });
  connector.on("wallet:signIn", (t) => set(t.accounts[0]?.accountId ?? null));
  connector.on("wallet:signOut", () => set(null));
  return connector;
}

function set(id: string | null) { current = id; listeners.forEach((f) => f(id)); }

export const wallet = {
  account: () => current,
  subscribe(cb: (id: string | null) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  async restore() {
    const t = e2e();
    if (t) { set(t.accountId); return; }
    try {
      const c = await get();
      const w = await c.wallet();
      const a = await w.getAccounts();
      set(a[0]?.accountId ?? null);
    } catch { /* no saved session */ }
  },
  async connect() {
    const t = e2e();
    if (t) { set(t.accountId); return; }
    const c = await get(); await c.connect();
  },
  async disconnect() {
    if (e2e()) { set(null); return; }
    const c = await get(); await c.disconnect(); set(null);
  },
  async call(receiverId: string, methodName: string, args: object, deposit: string, gas: string) {
    const params = { receiverId, actions: [{ type: "FunctionCall" as const, params: { methodName, args, gas, deposit } }] };
    const t = e2e();
    if (t) return t.signAndSendTransaction(params);
    const c = await get();
    const w = await c.wallet();
    return w.signAndSendTransaction(params);
  },
  /** NEP-413 message signing for backend sign-in. */
  async signMessage(message: string, recipient: string, nonce: Uint8Array) {
    const t = e2e();
    if (t) return t.signMessage({ message, recipient, nonce });
    const c = await get();
    const w = await c.wallet();
    return w.signMessage({ message, recipient, nonce });
  },
};
