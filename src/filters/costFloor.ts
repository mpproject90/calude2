/**
 * Cost floor (spec §6.3). Every trade must clear the real round-trip cost by a
 * configured multiple, or the signal is worthless however good it looks.
 *
 * The expected move is NOT a hand-set constant. It is derived from volatility:
 *   expectedMove = atrMultiplier * ATR(period) / price
 * This is a bootstrap. After phase 1, the median Maximum Favorable Excursion per
 * token — measured from real signals — replaces it.
 *
 * SLIPPAGE MODEL: price impact is approximated as positionValue / poolLiquidity
 * on each leg. This is a linear approximation to constant-product impact and is
 * only reasonable while position size stays small relative to the pool, which
 * §6.4 enforces separately (default 0.5%, hard ceiling 1%). When pool liquidity
 * is unknown — as it is for historical backtests without liquidity data — the
 * configured fallback is used and the result is marked estimated, per §10.
 */
import type { IndicatorValue } from '../types/index.js';
import { fail, pass, type FilterResult } from './types.js';

export interface CostFloorInput {
  /** Expected favourable move, as a decimal fraction (0.04 = 4%). */
  readonly expectedMove: IndicatorValue;
  readonly positionValueSol: number;
  readonly poolLiquiditySol: number | null;
  readonly dexFeePct: number;
  readonly priorityFeeSol: number;
  readonly jitoTipSol: number;
  readonly minTargetToCostRatio: number;
  readonly fallbackSlippagePct: number;
}

export interface CostBreakdown {
  readonly dexFeePct: number;
  readonly slippagePct: number;
  readonly fixedFeePct: number;
  readonly roundTripPct: number;
  readonly slippageEstimated: boolean;
}

export function estimateRoundTripCost(input: CostFloorInput): CostBreakdown {
  const { positionValueSol, poolLiquiditySol, dexFeePct, priorityFeeSol,
          jitoTipSol, fallbackSlippagePct } = input;

  // Both legs pay the DEX fee.
  const dex = dexFeePct * 2;

  const estimated = poolLiquiditySol === null || poolLiquiditySol <= 0;
  const perLegSlippagePct = estimated
    ? fallbackSlippagePct
    : (positionValueSol / poolLiquiditySol) * 100;
  const slippage = perLegSlippagePct * 2;

  // Priority fee and tip are paid on each leg, and are flat SOL costs, so they
  // matter more the smaller the position.
  const fixedSol = (priorityFeeSol + jitoTipSol) * 2;
  const fixed = positionValueSol > 0 ? (fixedSol / positionValueSol) * 100 : Infinity;

  return {
    dexFeePct: dex,
    slippagePct: slippage,
    fixedFeePct: fixed,
    roundTripPct: dex + slippage + fixed,
    slippageEstimated: estimated,
  };
}

export function evaluateCostFloor(input: CostFloorInput): FilterResult {
  const { expectedMove, minTargetToCostRatio } = input;

  if (!expectedMove.reliable) {
    return fail('cost-floor', 'expected move is not reliable — refusing to trade', {
      reason: expectedMove.reason ?? 'unknown',
    });
  }

  const cost = estimateRoundTripCost(input);
  const targetPct = expectedMove.value * 100;
  const requiredPct = cost.roundTripPct * minTargetToCostRatio;

  const context = {
    expectedMovePct: targetPct,
    roundTripCostPct: cost.roundTripPct,
    dexFeePct: cost.dexFeePct,
    slippagePct: cost.slippagePct,
    fixedFeePct: cost.fixedFeePct,
    requiredPct,
    ratio: cost.roundTripPct > 0 ? targetPct / cost.roundTripPct : Infinity,
    slippageEstimated: cost.slippageEstimated,
  };

  if (!Number.isFinite(cost.roundTripPct)) {
    return fail('cost-floor', 'round-trip cost is not finite', context);
  }
  if (targetPct >= requiredPct) {
    return pass('cost-floor', 'expected move clears the cost floor', context);
  }
  return fail(
    'cost-floor',
    `expected move ${targetPct.toFixed(2)}% does not clear ${minTargetToCostRatio}x ` +
      `round-trip cost of ${cost.roundTripPct.toFixed(2)}% (needs ${requiredPct.toFixed(2)}%)`,
    context,
  );
}
