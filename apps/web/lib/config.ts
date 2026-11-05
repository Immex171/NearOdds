/**
 * Public configuration. Markets are NOT configured here any more: the backend registry lists every market contract
 * (including keeper-created ones) and each response carries its own contract, market id and token.
 */
export const config = {
  network: (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet",
  /** NearOdds backend origin (docs/backend.md). Empty = live mode off, demo only. */
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, ""),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://test.rpc.fastnear.com",
};

export const liveConfigured = Boolean(config.apiUrl);
export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string) => `https://testnet.nearblocks.io/address/${id}`;
