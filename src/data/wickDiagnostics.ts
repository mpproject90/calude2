/**
 * Wick/ATR diagnostics for REAL pool OHLCV (DECISIONS §23).
 *
 * `rangeWideningRatio()` in synthesize.ts quantified a specific, known
 * distortion: synthesizing JUP/SOL from two USDT legs produces high/low
 * BOUNDS, not observations. Pulling a pool's own OHLCV directly removes that
 * distortion entirely — but replaces it with a different one: a thin pool's
 * high/low can be a single wash trade or one oversized swap rather than a
 * representative price. That is real data, not a synthesis artifact, so it
 * cannot be caught the same way. This module is the replacement check.
 *
 * Two signals, both cheap to compute from a candle series alone:
 *   - wick-to-body ratio: (upperWick + lowerWick) / |close - open|, per bar.
 *     A body-less bar with real range reports Infinity — that IS the signal
 *     (all range, no direction), not something to clip away.
 *   - ATR-outlier count: bars where the high or low sits more than
 *     `atrOutlierMultiple` × ATR(atrPeriod) outside [min(open,close),
 *     max(open,close)]. A high multiple of the bar's own recent typical
 *     range sitting outside the body is the concrete symptom of a phantom
 *     wick feeding MFI's typical price and ATR's true range.
 *
 * This never blocks anything — it is a report for the operator, the same
 * role range-widening played, not a filter.
 */
import type { Candle } from '../types/index.js';
import { computeAtr } from '../indicators/atr.js';

export interface WickToBodyStats {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  /** Bars with zero body but nonzero range — an all-wick candle. */
  readonly infiniteCount: number;
}

export interface WickDiagnostics {
  readonly bars: number;
  readonly wickToBody: WickToBodyStats;
  readonly atrOutlierCount: number;
  readonly atrOutlierMultiple: number;
  /** Bars ATR could not judge yet (still in warm-up) — excluded from the outlier count. */
  readonly atrUnreliableCount: number;
}

function percentile(sortedFinite: readonly number[], p: number): number {
  if (sortedFinite.length === 0) return 0;
  const idx = Math.min(sortedFinite.length - 1, Math.floor(p * sortedFinite.length));
  return sortedFinite[idx]!;
}

export function computeWickDiagnostics(
  candles: readonly Candle[],
  opts: { readonly atrPeriod?: number; readonly atrOutlierMultiple?: number } = {},
): WickDiagnostics {
  const atrPeriod = opts.atrPeriod ?? 14;
  const atrOutlierMultiple = opts.atrOutlierMultiple ?? 3;

  const ratios: number[] = [];
  let infiniteCount = 0;
  for (const c of candles) {
    const body = Math.abs(c.close - c.open);
    const upperWick = Math.max(0, c.high - Math.max(c.open, c.close));
    const lowerWick = Math.max(0, Math.min(c.open, c.close) - c.low);
    const wick = upperWick + lowerWick;
    if (body === 0) {
      if (wick > 0) infiniteCount++;
      ratios.push(wick > 0 ? Infinity : 0);
    } else {
      ratios.push(wick / body);
    }
  }
  const finiteSorted = ratios.filter((r) => Number.isFinite(r)).sort((a, b) => a - b);
  // Infinity always ranks last regardless of percentile, once enough infinite
  // bars exist to push the percentile index past the finite tail.
  const withInfSorted = [...finiteSorted, ...new Array(infiniteCount).fill(Infinity)];

  const atr = candles.length >= atrPeriod
    ? computeAtr(candles, { period: atrPeriod })
    : candles.map(() => ({ value: 0, reliable: false as const, reason: 'insufficient-warmup' as const }));

  let atrOutlierCount = 0;
  let atrUnreliableCount = 0;
  for (let i = 0; i < candles.length; i++) {
    const a = atr[i]!;
    if (!a.reliable) {
      atrUnreliableCount++;
      continue;
    }
    const c = candles[i]!;
    const bodyHigh = Math.max(c.open, c.close);
    const bodyLow = Math.min(c.open, c.close);
    const excursion = Math.max(c.high - bodyHigh, bodyLow - c.low, 0);
    if (excursion > atrOutlierMultiple * a.value) atrOutlierCount++;
  }

  return {
    bars: candles.length,
    wickToBody: {
      p50: percentile(withInfSorted, 0.5),
      p90: percentile(withInfSorted, 0.9),
      p99: percentile(withInfSorted, 0.99),
      max: withInfSorted.length > 0 ? withInfSorted[withInfSorted.length - 1]! : 0,
      infiniteCount,
    },
    atrOutlierCount,
    atrOutlierMultiple,
    atrUnreliableCount,
  };
}
