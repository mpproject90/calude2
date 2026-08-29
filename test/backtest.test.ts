import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/types/index.js';
import { aggregateCandles, AggregateError } from '../src/data/aggregate.js';
import { regimeBucketIndices } from '../src/backtest/regimeAlignment.js';

const H = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % (4 * H));   // aligned to a 4h boundary

const bar = (i: number, over: Partial<Candle> = {}): Candle => ({
  timestamp: T0 + i * H, open: 10, high: 11, low: 9, close: 10.5, volume: 100, ...over,
});

describe('candle aggregation', () => {
  it('combines a full bucket of source bars into one coarser candle', () => {
    const src = [
      bar(0, { open: 10, high: 12, low: 9, close: 11, volume: 100 }),
      bar(1, { open: 11, high: 13, low: 10, close: 12, volume: 150 }),
      bar(2, { open: 12, high: 12.5, low: 8, close: 9, volume: 50 }),
      bar(3, { open: 9, high: 10, low: 8.5, close: 9.5, volume: 200 }),
    ];
    const out = aggregateCandles(src, '1h', '4h');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      timestamp: T0, open: 10, high: 13, low: 8, close: 9.5, volume: 500,
    });
  });

  it('drops an incomplete bucket rather than aggregating from less than it claims to represent', () => {
    // Only 3 of the 4 bars a bucket needs — bar at i=1 is missing (a gap).
    const src = [bar(0), bar(2), bar(3)];
    expect(aggregateCandles(src, '1h', '4h')).toHaveLength(0);
  });

  it('handles multiple buckets, dropping only the incomplete ones', () => {
    const src = [
      bar(0), bar(1), bar(2), bar(3),         // complete bucket 0
      bar(4), bar(5),                          // incomplete bucket 1 (missing 6, 7)
      bar(8), bar(9), bar(10), bar(11),        // complete bucket 2
    ];
    const out = aggregateCandles(src, '1h', '4h');
    expect(out).toHaveLength(2);
    expect(out[0]!.timestamp).toBe(T0);
    expect(out[1]!.timestamp).toBe(T0 + 8 * H);
  });

  it('returns the source series unchanged when source and target intervals match', () => {
    const src = [bar(0), bar(1)];
    expect(aggregateCandles(src, '1h', '1h')).toEqual(src);
  });

  it('refuses to aggregate into a target that is not an exact multiple of the source', () => {
    // 5m does not divide evenly into 15m's bars — refuse rather than guess.
    expect(() => aggregateCandles([bar(0)], '15m', '5m')).toThrow(AggregateError);
  });

  it('matches the real 90-day JUP/SOL fetch pattern: SOL (gapless) drops ~0 buckets, JUP (150 gaps) drops many', () => {
    // Regression guard for the exact real-data finding: aggregating a gapless
    // 1h series into 4h loses only boundary buckets, not gap-driven ones.
    const gaplessDay = Array.from({ length: 24 }, (_, i) => bar(i));
    expect(aggregateCandles(gaplessDay, '1h', '4h')).toHaveLength(6);

    const withOneGap = gaplessDay.filter((_, i) => i !== 5);   // drop hour 5 -> bucket 1 incomplete
    expect(aggregateCandles(withOneGap, '1h', '4h')).toHaveLength(5);
  });
});

describe('regime bucket alignment (look-ahead guard)', () => {
  const FOUR_H = 4 * H;
  const regimeBucket = (i: number): Candle => ({
    timestamp: T0 + i * FOUR_H, open: 10, high: 11, low: 9, close: 10.5, volume: 100,
  });

  it('assigns null before any regime bucket has closed', () => {
    const tokenBars = [bar(0), bar(1), bar(2), bar(3)];   // all inside the first, still-open 4h bucket
    const aggregated = [regimeBucket(0)];                 // this bucket covers T0..T0+4h, closes at T0+4h
    const idx = regimeBucketIndices(tokenBars, aggregated, FOUR_H);
    expect(idx).toEqual([null, null, null, null]);
  });

  it('only assigns a bucket once its own close time has passed, never the one still in progress', () => {
    const tokenBars = [bar(3), bar(4), bar(7), bar(8)];
    // bucket 0 covers [T0, T0+4h) and closes AT T0+4h; bucket 1 covers [T0+4h, T0+8h).
    const aggregated = [regimeBucket(0), regimeBucket(1)];
    const idx = regimeBucketIndices(tokenBars, aggregated, FOUR_H);
    // bar(3) = T0+3h: bucket 0 hasn't closed yet (closes at T0+4h) -> null
    expect(idx[0]).toBeNull();
    // bar(4) = T0+4h: bucket 0 has just closed -> index 0
    expect(idx[1]).toBe(0);
    // bar(7) = T0+7h: still bucket 0, bucket 1 closes at T0+8h -> index 0
    expect(idx[2]).toBe(0);
    // bar(8) = T0+8h: bucket 1 has just closed -> index 1
    expect(idx[3]).toBe(1);
  });

  it('carries the last closed bucket forward across a gap in the regime series', () => {
    const tokenBars = [bar(4), bar(12)];
    // Only bucket 0 exists (bucket 1 was dropped as incomplete, e.g. by a source gap).
    const aggregated = [regimeBucket(0)];
    const idx = regimeBucketIndices(tokenBars, aggregated, FOUR_H);
    expect(idx).toEqual([0, 0]);   // still the last one that actually closed, not fabricated
  });
});
