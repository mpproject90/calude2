/**
 * Synthesized ratio series, e.g. JUP/SOL = (JUP/USDT) ÷ (SOL/USDT).
 *
 * WHY: P&L is denominated in SOL — SOL is spent and SOL is received. So the
 * series the strategy must run on is JUP/SOL, not JUP/USDT. A JUP/USDT drawdown
 * that is purely a SOL drawdown is not a dislocation, and testing on USDT
 * candles would manufacture exactly those false entries. Synthesizing the ratio
 * also means the SOL exposure nets out by construction, with no separate SOL leg
 * to model.
 *
 * ACCURACY — read before trusting anything derived from this series:
 *
 *   close  EXACT.  close_ratio = close_num / close_den; both are the same
 *                  instant, so the quotient is the true ratio at that instant.
 *                  RSI is built from closes alone, so RSI on a synthesized
 *                  series is exact.
 *
 *   open   EXACT.  Same argument at the bar's opening instant.
 *
 *   high   BOUND.  The true intrabar maximum of num/den is unknowable from OHLC
 *   low    BOUND.  alone: it depends on WHEN each extreme occurred within the
 *                  bar, which OHLC does not record. We emit the widest
 *                  mathematically possible range —
 *                      high = high_num / low_den
 *                      low  = low_num  / high_den
 *                  — which brackets the truth but is wider than it. These are
 *                  bounds, not observations.
 *
 * CONSEQUENCES:
 *   - ATR on a synthesized series is biased HIGH, because true range is
 *     computed from the widened high/low. The cost-floor gate derives its
 *     expected move from ATR, so it will be optimistic about the available
 *     move. Treat cost-floor decisions on synthesized series as approximate.
 *   - MFI uses typical price (H+L+C)/3, so it inherits the widening. This is
 *     why MFI is confirmation only and never a standalone trigger (spec §7.3).
 *   - Use the finest base timeframe available and aggregate upward: the shorter
 *     the bar, the less time for the extremes to diverge, and the tighter the
 *     bounds. A 1h ratio synthesized from 1m bars is far more faithful than one
 *     synthesized from 1h bars.
 *
 * If the widening turns out to be material in testing, MFI's role should be
 * reconsidered rather than papered over.
 */
import type { Candle, Interval } from '../types/index.js';

export interface SynthesisResult {
  readonly candles: Candle[];
  /** Bars present in one series but not the other, and so dropped. */
  readonly unmatchedNumerator: number[];
  readonly unmatchedDenominator: number[];
  /** True for every synthesized series — high/low are bounds, not observations. */
  readonly highLowApproximated: true;
}

export class SynthesisError extends Error {}

/**
 * Build numerator/denominator, aligned strictly by timestamp. A bar with no
 * counterpart on the other side is DROPPED, never carried forward or
 * interpolated: a fabricated ratio bar is indistinguishable downstream from a
 * real one. Dropped timestamps are reported so the caller can record them as
 * gaps.
 */
export function synthesizeRatioSeries(
  numerator: readonly Candle[],
  denominator: readonly Candle[],
): SynthesisResult {
  const den = new Map<number, Candle>();
  for (const c of denominator) den.set(c.timestamp, c);
  const num = new Map<number, Candle>();
  for (const c of numerator) num.set(c.timestamp, c);

  const candles: Candle[] = [];
  const unmatchedNumerator: number[] = [];

  for (const n of numerator) {
    const d = den.get(n.timestamp);
    if (d === undefined) {
      unmatchedNumerator.push(n.timestamp);
      continue;
    }
    if (d.open <= 0 || d.high <= 0 || d.low <= 0 || d.close <= 0) {
      unmatchedNumerator.push(n.timestamp);
      continue;
    }
    candles.push({
      timestamp: n.timestamp,
      open: n.open / d.open,                 // exact
      close: n.close / d.close,              // exact
      high: n.high / d.low,                  // upper bound
      low: n.low / d.high,                   // lower bound
      // Base-asset volume carries over unchanged: the quantity of the numerator
      // token traded is the same fact regardless of what it is quoted in.
      volume: n.volume,
    });
  }

  const unmatchedDenominator: number[] = [];
  for (const d of denominator) {
    if (!num.has(d.timestamp)) unmatchedDenominator.push(d.timestamp);
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  return { candles, unmatchedNumerator, unmatchedDenominator, highLowApproximated: true };
}

/**
 * How much wider the synthesized range is than the range implied by open and
 * close alone. A diagnostic for deciding whether the approximation is material
 * enough to change MFI's role.
 */
export function rangeWideningRatio(candles: readonly Candle[]): number {
  let widened = 0;
  let baseline = 0;
  for (const c of candles) {
    widened += c.high - c.low;
    baseline += Math.abs(c.close - c.open);
  }
  return baseline === 0 ? Infinity : widened / baseline;
}

/** Guard: the same interval on both sides, or the alignment is meaningless. */
export function assertSameInterval(a: Interval, b: Interval): void {
  if (a !== b) {
    throw new SynthesisError(
      `cannot synthesize a ratio across different intervals: ${a} vs ${b}`,
    );
  }
}
