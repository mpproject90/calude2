/**
 * Tier A universe gates (spec §6.1): liquidity, volume and age floors.
 * All are hard requirements; missing data fails closed.
 */
import { fail, pass, type FilterResult } from './types.js';
import type { TierAGates } from '../config/schema.js';

export interface TokenMetrics {
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly ageDays: number | null;
}

export function evaluateTierGates(m: TokenMetrics, gates: TierAGates): FilterResult {
  const context = {
    liquidityUsd: m.liquidityUsd,
    volume24hUsd: m.volume24hUsd,
    ageDays: m.ageDays,
    minLiquidityUsd: gates.minLiquidityUsd,
    minVolume24hUsd: gates.minVolume24hUsd,
    minAgeDays: gates.minAgeDays,
  };

  if (m.liquidityUsd === null || m.volume24hUsd === null || m.ageDays === null) {
    return fail('tier-gates', 'missing token metrics — failing closed', context);
  }
  if (m.liquidityUsd < gates.minLiquidityUsd) {
    return fail('tier-gates', `liquidity ${m.liquidityUsd} below ${gates.minLiquidityUsd}`, context);
  }
  if (m.volume24hUsd < gates.minVolume24hUsd) {
    return fail('tier-gates', `24h volume ${m.volume24hUsd} below ${gates.minVolume24hUsd}`, context);
  }
  if (m.ageDays < gates.minAgeDays) {
    return fail('tier-gates', `age ${m.ageDays}d below ${gates.minAgeDays}d`, context);
  }
  return pass('tier-gates', 'tier gates satisfied', context);
}
