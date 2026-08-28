/**
 * Gap detection (spec §4). Gaps are detected and logged, never interpolated —
 * a fabricated candle is indistinguishable from a real one downstream, and the
 * indicator built on it would look perfectly healthy.
 *
 * Note that on-chain sources (Birdeye, GeckoTerminal) omit empty candles
 * entirely rather than returning zero-volume bars, so absence of a row is not
 * evidence of absence of trading. That is exactly why gaps are recorded as
 * first-class data rather than inferred at read time.
 */
import { INTERVAL_MS, type Candle, type CandleGap, type Interval } from '../types/index.js';

export interface SeriesIssues {
  readonly gaps: CandleGap[];
  readonly duplicates: number[];
  readonly outOfOrder: number[];
}

export function detectSeriesIssues(
  candles: readonly Candle[],
  interval: Interval,
): SeriesIssues {
  const step = INTERVAL_MS[interval];
  const gaps: CandleGap[] = [];
  const duplicates: number[] = [];
  const outOfOrder: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    const delta = cur.timestamp - prev.timestamp;

    if (delta === 0) {
      duplicates.push(cur.timestamp);
      continue;
    }
    if (delta < 0) {
      outOfOrder.push(cur.timestamp);
      continue;
    }
    if (delta > step) {
      const missing = Math.round(delta / step) - 1;
      gaps.push({
        afterTimestamp: prev.timestamp,
        beforeTimestamp: cur.timestamp,
        missingBars: missing,
      });
    }
  }

  return { gaps, duplicates, outOfOrder };
}

export function detectGaps(candles: readonly Candle[], interval: Interval): CandleGap[] {
  return detectSeriesIssues(candles, interval).gaps;
}

/** Total bars missing across all gaps — a one-number health measure for a series. */
export function totalMissingBars(gaps: readonly CandleGap[]): number {
  return gaps.reduce((n, g) => n + g.missingBars, 0);
}
