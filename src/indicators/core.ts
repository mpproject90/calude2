/**
 * Shared indicator machinery: warm-up gating and gap awareness (spec §5).
 *
 * Every indicator returns one IndicatorValue per input candle, so results are
 * always index-aligned with the series they came from. Values inside the
 * warm-up window, or too soon after a gap, carry `reliable: false`. The rules
 * engine refuses to act on those, with no override path.
 */
import type { Candle, CandleGap, IndicatorValue, UnreliableReason } from '../types/index.js';

export const DEFAULT_WARMUP_MULTIPLIER = 7;

export interface IndicatorOptions {
  readonly period: number;
  /**
   * Candles required before a value is trusted, as a multiple of the period.
   * Wilder smoothing is an EMA: it never fully "completes", it converges. At
   * period*7 the seed's weight is (1 - 1/14)^84 ≈ 0.2% for period 14, which is
   * below the noise floor of the price data itself.
   */
  readonly warmupMultiplier?: number;
  /** Gaps in the series. Values spanning a gap are flagged unreliable. */
  readonly gaps?: readonly CandleGap[];
}

export function unreliable(value: number, reason: UnreliableReason): IndicatorValue {
  return { value, reliable: false, reason };
}

export function reliable(value: number): IndicatorValue {
  return { value, reliable: true };
}

/**
 * Index of the first candle at or after each gap, so we know where a series
 * discontinuity lands in array terms.
 */
function gapIndices(candles: readonly Candle[], gaps: readonly CandleGap[]): number[] {
  const out: number[] = [];
  for (const gap of gaps) {
    const idx = candles.findIndex((c) => c.timestamp >= gap.beforeTimestamp);
    if (idx > 0) out.push(idx);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Decides, for every index, whether a value there may be trusted. A value is
 * reliable only when BOTH hold:
 *   - at least period*warmupMultiplier candles precede it, and
 *   - no gap falls within that same warm-up window behind it.
 *
 * A gap does not merely invalidate the bar after it: Wilder smoothing carries
 * the pre-gap state forward, so the contamination persists for a full warm-up.
 */
export function buildReliabilityMask(
  candles: readonly Candle[],
  opts: IndicatorOptions,
): (UnreliableReason | null)[] {
  const mult = opts.warmupMultiplier ?? DEFAULT_WARMUP_MULTIPLIER;
  const warmup = opts.period * mult;
  const gaps = gapIndices(candles, opts.gaps ?? []);
  const mask: (UnreliableReason | null)[] = new Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i++) {
    if (i + 1 < warmup) {
      mask[i] = 'insufficient-warmup';
      continue;
    }
    const windowStart = i + 1 - warmup;
    if (gaps.some((g) => g > windowStart && g <= i)) {
      mask[i] = 'gap-in-series';
    }
  }
  return mask;
}

/** Wilder's smoothing (an EMA with alpha = 1/period), seeded with an SMA. */
export function wilderSmooth(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export function assertValidPeriod(period: number, len: number): void {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error(`indicator period must be an integer >= 2, got ${period}`);
  }
  if (len < 0) throw new Error('negative series length');
}
