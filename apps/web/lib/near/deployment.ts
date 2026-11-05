import type { ConfigView, MarketView } from "@nearodds/types";
import { DECIMALS } from "../amounts";
import { config } from "../config";
import { view } from "./rpc";

export interface TokenMeta { name: string; symbol: string; decimals: number }
export interface LiveSettings { cfg: ConfigView; token: TokenMeta; market: MarketView; tokenStorageMin: bigint }

export const SCHEMA_VERSION = 3;

/** Pure comparison so the agreement rules are unit-tested. Returns human-readable problems; empty = consistent. */
export function checkAgreement(input: {
  marketAccount: string; tokenAccount: string; marketId: string;
  cfg: ConfigView; meta: TokenMeta; market: MarketView;
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
  return p;
}

export class DeploymentError extends Error {
  constructor(readonly problems: string[]) { super(problems.join(" ")); }
}

let cached: Promise<LiveSettings> | null = null;
/** Reads get_config, get_market and ft_metadata once per page load and verifies they agree. Rejects with DeploymentError. */
export function verifyDeployment(force = false): Promise<LiveSettings> {
  if (force || !cached) {
    cached = (async () => {
      let cfg: ConfigView, meta: TokenMeta, market: MarketView, bounds: { min: string };
      try {
        [cfg, meta, market, bounds] = await Promise.all([
          view<ConfigView>(config.marketContractId, "get_config"),
          view<TokenMeta>(config.tokenContractId, "ft_metadata"),
          view<MarketView>(config.marketContractId, "get_market", { market_id: config.marketId }),
          view<{ min: string }>(config.tokenContractId, "storage_balance_bounds"),
        ]);
      } catch (e) {
        throw new DeploymentError([`Could not read the deployed contracts: ${e instanceof Error ? e.message : String(e)}`]);
      }
      const problems = checkAgreement({ marketAccount: config.marketContractId, tokenAccount: config.tokenContractId, marketId: config.marketId, cfg, meta, market });
      if (problems.length) throw new DeploymentError(problems);
      return { cfg, token: meta, market, tokenStorageMin: BigInt(bounds.min) };
    })();
    cached.catch(() => { cached = null; }); // allow retry after a failure
  }
  return cached;
}
