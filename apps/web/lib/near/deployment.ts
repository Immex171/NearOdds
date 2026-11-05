import type { ConfigView, MarketView } from "@nearodds/types";
import { DECIMALS } from "../amounts";
import type { ContractRef } from "../types";
import { view } from "./rpc";

export interface TokenMeta { name: string; symbol: string; decimals: number }
export interface LiveSettings { cfg: ConfigView; token: TokenMeta; market: MarketView; tokenStorageMin: bigint }

export const SCHEMA_VERSION = 3;

/** Pure comparison so the agreement rules are unit-tested. Returns human-readable problems; empty = consistent. */
/** What the backend API claims about a market. The chain must agree before any wallet action is enabled. */
export interface MarketClaim { token: { symbol: string; decimals: number }; trading: ConfigView["trading"]; question: string; cutoffNs: string }

export function checkAgreement(input: {
  marketAccount: string; tokenAccount: string; marketId: string;
  cfg: ConfigView; meta: TokenMeta; market: MarketView; claim?: MarketClaim;
}): string[] {
  const { cfg, meta, market } = input;
  const p: string[] = [];
  if (cfg.schema_version !== SCHEMA_VERSION) p.push(`The contract reports schema ${cfg.schema_version}; this app supports ${SCHEMA_VERSION}.`);
  if (cfg.collateral_token_id !== input.tokenAccount) p.push(`The market's collateral token is ${cfg.collateral_token_id}, but the app is configured for ${input.tokenAccount}.`);
  if (cfg.market_id !== input.marketId) p.push(`The contract serves market ${cfg.market_id}, but the app is configured for ${input.marketId}.`);
  if (market.market_id !== input.marketId) p.push(`get_market returned ${market.market_id}, expected ${input.marketId}.`);
  if (market.collateral_token_id !== cfg.collateral_token_id) p.push("get_market and get_config disagree about the collateral token.");
  if (market.resolver_id !== cfg.resolver_id) p.push("get_market and get_config disagree about the resolver.");
  if (meta.decimals !== cfg.decimals) p.push(`The token has ${meta.decimals} decimals but the market is configured for ${cfg.decimals}.`);
  if (cfg.decimals !== DECIMALS) p.push(`This app handles ${DECIMALS}-decimal amounts; the contract uses ${cfg.decimals}.`);
  if (cfg.trading.price_scale !== "1000000") p.push(`Unsupported price scale ${cfg.trading.price_scale}.`);
  if (!meta.symbol) p.push("The token reports no symbol.");
  const c = input.claim;
  if (c) {
    if (c.token.symbol !== meta.symbol || c.token.decimals !== meta.decimals) p.push(`The API lists the token as ${c.token.symbol} (${c.token.decimals} decimals) but the token contract reports ${meta.symbol} (${meta.decimals}).`);
    if (c.question !== market.question) p.push("The market question on the contract differs from the one the API lists.");
    if (c.cutoffNs !== market.split_cutoff_ns) p.push("The trading cutoff on the contract differs from the one the API lists.");
    for (const k of Object.keys(cfg.trading) as (keyof ConfigView["trading"])[]) {
      if (String(c.trading[k]) !== String(cfg.trading[k])) p.push(`Trading parameter ${k} differs between the API (${c.trading[k]}) and the contract (${cfg.trading[k]}).`);
    }
  }
  return p;
}

export class DeploymentError extends Error {
  constructor(readonly problems: string[]) { super(problems.join(" ")); }
}

const cache = new Map<string, Promise<LiveSettings>>();
export const contractKey = (c: ContractRef) => `${c.contractId}|${c.marketId}|${c.tokenId}`;
export const clearDeploymentCache = () => cache.clear();

/**
 * Reads get_config, get_market and ft_metadata of ONE market contract and verifies they agree with each other and
 * with the API's claim. Cached per (contract, market id, token). Rejects with DeploymentError.
 */
export function verifyDeployment(c: ContractRef, claim?: MarketClaim, force = false): Promise<LiveSettings> {
  const key = contractKey(c);
  if (force || !cache.has(key)) {
    const p = (async () => {
      let cfg: ConfigView, meta: TokenMeta, market: MarketView, bounds: { min: string };
      try {
        [cfg, meta, market, bounds] = await Promise.all([
          view<ConfigView>(c.contractId, "get_config"),
          view<TokenMeta>(c.tokenId, "ft_metadata"),
          view<MarketView>(c.contractId, "get_market", { market_id: c.marketId }),
          view<{ min: string }>(c.tokenId, "storage_balance_bounds"),
        ]);
      } catch (e) {
        throw new DeploymentError([`Could not read the contracts of this market: ${e instanceof Error ? e.message : String(e)}`]);
      }
      const problems = checkAgreement({ marketAccount: c.contractId, tokenAccount: c.tokenId, marketId: c.marketId, cfg, meta, market, claim });
      if (problems.length) throw new DeploymentError(problems);
      return { cfg, token: meta, market, tokenStorageMin: BigInt(bounds.min) };
    })();
    cache.set(key, p);
    p.catch(() => { if (cache.get(key) === p) cache.delete(key); }); // allow retry after a failure
  }
  return cache.get(key)!;
}
