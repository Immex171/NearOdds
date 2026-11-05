/**
 * Public chain configuration. In this repo it is derived from deployments/testnet-demo.json by
 * scripts/sync-deployment.mjs (run automatically before dev and build); nothing is hardcoded here.
 */
export const config = {
  network: (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet",
  marketContractId: process.env.NEXT_PUBLIC_MARKET_CONTRACT_ID ?? "",
  tokenContractId: process.env.NEXT_PUBLIC_TOKEN_CONTRACT_ID ?? "",
  marketId: process.env.NEXT_PUBLIC_MARKET_ID ?? "",
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://test.rpc.fastnear.com",
};

export const liveConfigured = Boolean(config.marketContractId && config.tokenContractId && config.marketId);
export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string) => `https://testnet.nearblocks.io/address/${id}`;
