/**
 * Average True Range, Wilder smoothing.
 *
 * Used by the cost-floor gate to derive an expected move per token rather than
 * relying on a hand-set constant: expectedMove = atrMultiplier * ATR / price.
 * This is a bootstrap. Once phase 1 produces a Maximum Favorable Excursion
 * distribution, the median MFE per token replaces it.
 */
import type { Candle, IndicatorValue } from '../types/index.js';
import { assertValidPeriod, buildReliabilityMask, reliable, unreliable, wilderSmooth, type IndicatorOptions } from './core.js';

export function trueRange(current: Candle, previous: Candle | undefined): number {
  if (previous === undefined) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

export function computeAtr(
  candles: readonly Candle[],
  opts: IndicatorOptions,
): IndicatorValue[] {
  const { period } = opts;
  assertValidPeriod(period, candles.length);

  const mask = buildReliabilityMask(candles, opts);
  const out: IndicatorValue[] = new Array(candles.length);
  if (candles.length === 0) return out;

  const tr = candles.map((c, i) => trueRange(c, i === 0 ? undefined : candles[i - 1]!));
  const smoothed = wilderSmooth(tr, period);

  for (let i = 0; i < candles.length; i++) {
    const v = smoothed[i];
    if (v === null || v === undefined) {
      out[i] = unreliable(0, 'insufficient-warmup');
      continue;
    }
    if (!Number.isFinite(v) || v < 0) {
      out[i] = unreliable(0, 'invalid-input');
      continue;
    }
    const reason = mask[i] ?? null;
    out[i] = reason === null ? reliable(v) : unreliable(v, reason);
  }
  return out;
}

/**
 * ATR as a fraction of price — the bootstrap expected move for the cost floor.
 * Returns unreliable when ATR is unreliable or price is non-positive.
 */
export function expectedMoveFromAtr(
  atr: IndicatorValue,
  price: number,
  atrMultiplier: number,
): IndicatorValue {
  if (!Number.isFinite(price) || price <= 0) {
    return unreliable(0, 'invalid-input');
  }
  const value = (atrMultiplier * atr.value) / price;
  if (!Number.isFinite(value)) return unreliable(0, 'invalid-input');
  return atr.reliable
    ? reliable(value)
    : unreliable(value, atr.reason ?? 'insufficient-warmup');
}
