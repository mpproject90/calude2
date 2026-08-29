/**
 * Wick/ATR diagnostics for REAL pool OHLCV (DECISIONS §23, reworked §26).
 *
 * `rangeWideningRatio()` in synthesize.ts quantified a specific, known
 * distortion: synthesizing JUP/SOL from two USDT legs produces high/low
 * BOUNDS, not observations. Pulling a pool's own OHLCV directly removes that
 * distortion entirely — but replaces it with a different one: a thin pool's
 * high/low can be a single wash trade or one oversized swap rather than a
 * representative price. That is real data, not a synthesis artifact, so it
 * cannot be caught the same way. This module is the replacement check.
 *
 * ORIGINAL FORMULA WAS WRONG (found on the operator's first real fetch,
 * DECISIONS §26): wick-to-BODY ratio — (upperWick + lowerWick) / |close -
 * open| — was built on the assumption that a small body meant MFI and ATR
 * would be corrupted. Neither indicator touches the body: ATR is true range
 * from high/low/prevClose, MFI's typical price is (H+L+C)/3. Worse, on real
 * data roughly a fifth of bars had a body of essentially zero (price ended
 * the hour where it started — normal, not a data-quality problem), and for
 * those the ratio divided by IEEE-754 rounding noise near zero, producing
 * ratios in the hundreds of millions for wicks that were, in absolute terms,
 * perfectly ordinary (0.3-2% of price). The diagnostic was measuring its own
 * arithmetic, not the data.
 *
 * Two signals now:
 *   - wick size AS A PERCENTAGE OF PRICE: (upperWick + lowerWick) / price *
 *     100, where price = (open + close) / 2. Never divides by something that
 *     is routinely near zero, so every bar gets a real, comparable number —
 *     no `Infinity` case to special-case.
 *   - ATR-outlier count: bars where the high or low sits more than
 *     `atrOutlierMultiple` × ATR(atrPeriod) outside [min(open,close),
 *     max(open,close)]. Unchanged — this was already the useful signal (1 of
 *     1875 judged bars on the first real token reviewed) and was never body-
 *     dependent to begin with.
 *
 * This never blocks anything — it is a report for the operator, the same
 * role range-widening played, not a filter.
 */
import type { Candle } from '../types/index.js';
import { computeAtr } from '../indicators/atr.js';

export interface WickToPriceStats {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
}

export interface WickDiagnostics {
  readonly bars: number;
  /** Total wick as a percentage of price, e.g. 2.5 = 2.5% of price. */
  readonly wickToPricePct: WickToPriceStats;
  readonly atrOutlierCount: number;
  readonly atrOutlierMultiple: number;
  /** Bars ATR could not judge yet (still in warm-up) — excluded from the outlier count. */
  readonly atrUnreliableCount: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

export function computeWickDiagnostics(
  candles: readonly Candle[],
  opts: { readonly atrPeriod?: number; readonly atrOutlierMultiple?: number } = {},
): WickDiagnostics {
  const atrPeriod = opts.atrPeriod ?? 14;
  const atrOutlierMultiple = opts.atrOutlierMultiple ?? 3;

  const pcts: number[] = [];
  for (const c of candles) {
    const upperWick = Math.max(0, c.high - Math.max(c.open, c.close));
    const lowerWick = Math.max(0, Math.min(c.open, c.close) - c.low);
    const wick = upperWick + lowerWick;
    const price = (c.open + c.close) / 2;
    pcts.push(price > 0 ? (wick / price) * 100 : 0);
  }
  const sorted = pcts.slice().sort((a, b) => a - b);

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
    wickToPricePct: {
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p99: percentile(sorted, 0.99),
      max: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
    },
    atrOutlierCount,
    atrOutlierMultiple,
    atrUnreliableCount,
  };
}
