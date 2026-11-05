import type { AccountState, Holding, Market, Position, WalletBalance } from "./types";

/** This market's own deposit bucket. Demo has one pooled bucket ("*"). Never sums across markets. */
export function holdingOf(a: AccountState | null | undefined, m: Pick<Market, "id"> | null | undefined): Holding | null {
  if (!a || !m) return null;
  return a.holdings.find((h) => h.marketRef === m.id) ?? a.holdings.find((h) => h.marketRef === "*") ?? null;
}

/** The wallet balance of the token THIS market uses. Counted once per token, not once per market. */
export function walletOf(a: AccountState | null | undefined, m: Pick<Market, "contract"> | null | undefined): WalletBalance | null {
  if (!a) return null;
  const id = m?.contract?.tokenId;
  return (id ? a.wallets.find((w) => w.tokenId === id) : a.wallets[0]) ?? null;
}

export const positionsOf = (a: AccountState | null | undefined, m: Pick<Market, "id"> | null | undefined): Position[] =>
  a && m ? a.positions.filter((p) => p.marketId === m.id) : [];
