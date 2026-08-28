/**
 * Relative Strength Index, Wilder's original formulation.
 *
 * Written from the definition rather than pulled from a library: an indicator
 * bug is silent and expensive, and a hand-verified implementation is one we can
 * unit-test against published reference values.
 */
import type { Candle, IndicatorValue } from '../types/index.js';
import {
  assertValidPeriod, buildReliabilityMask, reliable, unreliable,
  wilderSmooth, type IndicatorOptions,
} from './core.js';

/**
 * Value used when the window contains no price movement at all (avgGain and
 * avgLoss both zero). RS is 0/0 there — genuinely undefined, not merely
 * infinite. 50 is the neutral reading: a flat market is neither overbought nor
 * oversold. The alternative conventions (0 or 100) would both imply an extreme
 * that a flat series plainly is not, and either would fire a threshold.
 */
export const RSI_FLAT = 50;

export function computeRsi(
  candles: readonly Candle[],
  opts: IndicatorOptions,
): IndicatorValue[] {
  const { period } = opts;
  assertValidPeriod(period, candles.length);

  const mask = buildReliabilityMask(candles, opts);
  const out: IndicatorValue[] = new Array(candles.length);

  if (candles.length === 0) return out;

  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // Wilder seeds from the first `period` CHANGES, which live at indices 1..period.
  const avgGain = wilderSmooth(gains.slice(1), period);
  const avgLoss = wilderSmooth(losses.slice(1), period);

  for (let i = 0; i < candles.length; i++) {
    const g = i === 0 ? null : avgGain[i - 1];
    const l = i === 0 ? null : avgLoss[i - 1];

    if (g === null || l === null || g === undefined || l === undefined) {
      out[i] = unreliable(RSI_FLAT, 'insufficient-warmup');
      continue;
    }

    let value: number;
    if (l === 0 && g === 0) {
      value = RSI_FLAT;                 // flat series — no division attempted
    } else if (l === 0) {
      value = 100;                      // only gains
    } else if (g === 0) {
      value = 0;                        // only losses
    } else {
      value = 100 - 100 / (1 + g / l);
    }

    if (!Number.isFinite(value)) {
      out[i] = unreliable(RSI_FLAT, 'invalid-input');
      continue;
    }

    const reason = mask[i] ?? null;
    out[i] = reason === null ? reliable(value) : unreliable(value, reason);
  }

  return out;
}
