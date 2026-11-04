/** Environment-driven chain configuration. Nothing is hardcoded. */
export const config = {
  network: (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet",
  marketContractId: process.env.NEXT_PUBLIC_MARKET_CONTRACT_ID ?? "",
  tokenContractId: process.env.NEXT_PUBLIC_TOKEN_CONTRACT_ID ?? "",
  marketId: process.env.NEXT_PUBLIC_MARKET_ID ?? "",
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.near.org",
  faucetNote: process.env.NEXT_PUBLIC_FAUCET_NOTE ?? "",
};

export const liveConfigured = Boolean(config.marketContractId && config.tokenContractId && config.marketId);
export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
