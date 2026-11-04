"use client";
/** The only module that imports the wallet connector. */
import { config } from "./config";

type Connector = import("@hot-labs/near-connect").NearConnector;
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
    try {
      const c = await get();
      const w = await c.wallet();
      const a = await w.getAccounts();
      set(a[0]?.accountId ?? null);
    } catch { /* no saved session */ }
  },
  async connect() { const c = await get(); await c.connect(); },
  async disconnect() { const c = await get(); await c.disconnect(); set(null); },
  async call(receiverId: string, methodName: string, args: object, deposit: string, gas: string) {
    const c = await get();
    const w = await c.wallet();
    return w.signAndSendTransaction({
      receiverId,
      actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }],
    });
  },
};
