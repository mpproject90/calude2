/**
 * Position sizing cap (spec §6.4). Size may never exceed a configured share of
 * pool liquidity — this caps slippage mechanically rather than hoping for it.
 * If the configured buy amount breaches the cap it is REDUCED to the cap; if the
 * reduced size falls below the minimum viable amount the trade is skipped.
 *
 * Market data (pool liquidity, prices) is float by nature, so the cap is
 * computed in floats. The moment a size is decided it becomes an exact integer
 * lamport amount and stays one — no float ever touches the amount again.
 */
import { TokenAmount, SOL_DECIMALS } from '../util/amount.js';
import { fail, pass, type FilterResult } from './types.js';

export interface PositionSizeInput {
  readonly requestedSol: TokenAmount;
  readonly poolLiquiditySol: number | null;
  readonly maxPctOfPoolLiquidity: number;
  readonly minViableSol: TokenAmount;
}

export interface PositionSizeResult extends FilterResult {
  /** The size to actually use. Null when the trade must be skipped. */
  readonly sizeSol: TokenAmount | null;
}

function solFromNumber(n: number): TokenAmount {
  // Truncate rather than round: a sizing cap must never be exceeded by a
  // rounding step.
  const truncated = Math.floor(n * 10 ** SOL_DECIMALS) / 10 ** SOL_DECIMALS;
  return TokenAmount.fromDecimalString(truncated.toFixed(SOL_DECIMALS), SOL_DECIMALS);
}

export function evaluatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { requestedSol, poolLiquiditySol, maxPctOfPoolLiquidity, minViableSol } = input;

  // Fail closed: without liquidity data we cannot bound slippage, so we do not trade.
  if (poolLiquiditySol === null || !Number.isFinite(poolLiquiditySol) || poolLiquiditySol <= 0) {
    return {
      ...fail('position-size', 'pool liquidity unknown — cannot bound slippage', {
        requestedSol: requestedSol.toString(),
      }),
      sizeSol: null,
    };
  }

  const capSol = solFromNumber((poolLiquiditySol * maxPctOfPoolLiquidity) / 100);
  const capped = requestedSol.gt(capSol);
  const sized = capped ? capSol : requestedSol;

  const context = {
    requestedSol: requestedSol.toString(),
    poolLiquiditySol,
    maxPctOfPoolLiquidity,
    capSol: capSol.toString(),
    sizedSol: sized.toString(),
    wasCapped: capped,
  };

  if (sized.lt(minViableSol) || sized.isZero()) {
    return {
      ...fail(
        'position-size',
        `capped size ${sized.toString()} SOL is below the minimum viable ` +
          `${minViableSol.toString()} SOL — skipping`,
        context,
      ),
      sizeSol: null,
    };
  }

  return {
    ...pass(
      'position-size',
      capped ? 'size reduced to the pool-liquidity cap' : 'requested size is within the cap',
      context,
    ),
    sizeSol: sized,
  };
}
