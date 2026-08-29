import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Candle, CandleGap } from '../src/types/index.js';
import { computeRsi, RSI_FLAT } from '../src/indicators/rsi.js';
import { computeMfi } from '../src/indicators/mfi.js';
import { computeAtr, trueRange, expectedMoveFromAtr } from '../src/indicators/atr.js';
import { buildReliabilityMask, wilderSmooth, DEFAULT_WARMUP_MULTIPLIER } from '../src/indicators/core.js';

interface Reference {
  candles: Candle[];
  rsi14: (number | null)[];
  mfi14: (number | null)[];
  atr14: (number | null)[];
}
const ref = JSON.parse(
  readFileSync('test/fixtures/reference.json', 'utf8'),
) as Reference;

/** Build a synthetic series long enough to clear a period*7 warm-up. */
function series(closes: number[], volume = 1000): Candle[] {
  return closes.map((c, i) => ({
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: i === 0 ? c : closes[i - 1]!,
    high: Math.max(i === 0 ? c : closes[i - 1]!, c) + 0.5,
    low: Math.min(i === 0 ? c : closes[i - 1]!, c) - 0.5,
    close: c,
    volume,
  }));
}

describe('RSI', () => {
  it('matches the exact hand-verified Wilder seed', () => {
    // Over the first 14 changes of the reference series:
    //   gains  = 334 cents = $3.34 → avgGain = 3.34/14 = 167/700
    //   losses = 140 cents = $1.40 → avgLoss = 1.40/14 = 1/10
    //   RS  = 167/70
    //   RSI = 100 - 100/(1 + 167/70) = 16700/237
    // Computed with exact rational arithmetic, no rounding at any step.
    const EXACT = 16700 / 237;
    const out = computeRsi(ref.candles, { period: 14, warmupMultiplier: 1 });
    expect(out[14]!.value).toBeCloseTo(EXACT, 10);
    expect(EXACT).toBeCloseTo(70.4641350211, 9);
  });

  it('matches an independent implementation across the whole series', () => {
    const out = computeRsi(ref.candles, { period: 14, warmupMultiplier: 1 });
    ref.rsi14.forEach((expected, i) => {
      if (expected === null) return;
      expect(out[i]!.value).toBeCloseTo(expected, 8);
    });
  });

  it('handles a flat series without producing NaN', () => {
    const out = computeRsi(series(new Array(60).fill(100)), {
      period: 14,
      warmupMultiplier: 1,
    });
    for (const v of out) {
      expect(Number.isNaN(v.value)).toBe(false);
      expect(Number.isFinite(v.value)).toBe(true);
    }
    expect(out[40]!.value).toBe(RSI_FLAT);
  });

  it('returns 100 for monotonic gains and 0 for monotonic losses', () => {
    const up = computeRsi(series(Array.from({ length: 40 }, (_, i) => 100 + i)), {
      period: 14, warmupMultiplier: 1,
    });
    const down = computeRsi(series(Array.from({ length: 40 }, (_, i) => 100 - i)), {
      period: 14, warmupMultiplier: 1,
    });
    expect(up[30]!.value).toBe(100);
    expect(down[30]!.value).toBe(0);
  });

  it('never emits a bare number — every result carries a reliability flag', () => {
    const out = computeRsi(ref.candles, { period: 14 });
    for (const v of out) {
      expect(typeof v.value).toBe('number');
      expect(typeof v.reliable).toBe('boolean');
      if (!v.reliable) expect(v.reason).toBeDefined();
    }
  });

  it('withholds reliability until period * 7 candles', () => {
    const closes = Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const out = computeRsi(series(closes), { period: 14, warmupMultiplier: 7 });
    // warm-up is 98 candles, so index 96 is still cold and 97 is the first warm one
    expect(out[96]!.reliable).toBe(false);
    expect(out[96]!.reason).toBe('insufficient-warmup');
    expect(out[97]!.reliable).toBe(true);
  });

  it('refuses to trust values computed across a gap', () => {
    const closes = Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const candles = series(closes);
    const gaps: CandleGap[] = [{
      afterTimestamp: candles[109]!.timestamp,
      beforeTimestamp: candles[110]!.timestamp,
      missingBars: 20,
    }];
    const out = computeRsi(candles, { period: 14, warmupMultiplier: 7, gaps });
    // the bar before the gap is unaffected
    expect(out[109]!.reliable).toBe(true);
    // the bar at the gap, and everything within a warm-up behind it, is not
    expect(out[110]!.reliable).toBe(false);
    expect(out[110]!.reason).toBe('gap-in-series');
    expect(out[120]!.reliable).toBe(false);
    // contamination persists for a full warm-up (98 bars), so it covers the
    // rest of this 140-bar series rather than clearing after one bar
    expect(out[139]!.reliable).toBe(false);
    expect(out[139]!.reason).toBe('gap-in-series');
  });

  it('rejects a nonsense period', () => {
    expect(() => computeRsi(ref.candles, { period: 1 })).toThrow();
    expect(() => computeRsi(ref.candles, { period: 2.5 })).toThrow();
  });

  it('returns an empty result for an empty series', () => {
    expect(computeRsi([], { period: 14 })).toHaveLength(0);
  });
});

describe('MFI', () => {
  it('matches an independent implementation', () => {
    const out = computeMfi(ref.candles, { period: 14, warmupMultiplier: 1 });
    ref.mfi14.forEach((expected, i) => {
      if (expected === null) return;
      expect(out[i]!.value).toBeCloseTo(expected, 8);
    });
  });

  it('handles zero volume without NaN', () => {
    const out = computeMfi(series(new Array(60).fill(100), 0), {
      period: 14, warmupMultiplier: 1,
    });
    for (const v of out) expect(Number.isFinite(v.value)).toBe(true);
  });

  it('handles a flat typical price without NaN', () => {
    const out = computeMfi(series(new Array(60).fill(100)), {
      period: 14, warmupMultiplier: 1,
    });
    expect(out[40]!.value).toBe(50);
  });

  it('is gated by the same warm-up rule as RSI', () => {
    const closes = Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const out = computeMfi(series(closes), { period: 14, warmupMultiplier: 7 });
    expect(out[96]!.reliable).toBe(false);
    expect(out[97]!.reliable).toBe(true);
  });
});

describe('ATR', () => {
  it('computes true range including gap-adjusted ranges', () => {
    const prev: Candle = { timestamp: 0, open: 10, high: 11, low: 9, close: 10, volume: 1 };
    // plain intrabar range
    expect(trueRange({ ...prev, high: 12, low: 10 }, undefined)).toBe(2);
    // gap up: high - prevClose dominates
    expect(trueRange({ ...prev, high: 15, low: 14, close: 14.5 }, prev)).toBe(5);
    // gap down: |low - prevClose| dominates
    expect(trueRange({ ...prev, high: 6, low: 5, close: 5.5 }, prev)).toBe(5);
  });

  it('matches an independent implementation', () => {
    const out = computeAtr(ref.candles, { period: 14, warmupMultiplier: 1 });
    ref.atr14.forEach((expected, i) => {
      if (expected === null) return;
      expect(out[i]!.value).toBeCloseTo(expected, 8);
    });
  });

  it('derives an expected move as a fraction of price', () => {
    const atr = { value: 2, reliable: true as const };
    const move = expectedMoveFromAtr(atr, 100, 2.0);
    expect(move.value).toBeCloseTo(0.04, 10);
    expect(move.reliable).toBe(true);
  });

  it('propagates unreliability into the expected move', () => {
    const cold = { value: 2, reliable: false as const, reason: 'insufficient-warmup' as const };
    expect(expectedMoveFromAtr(cold, 100, 2.0).reliable).toBe(false);
  });

  it('refuses a non-positive price rather than dividing by zero', () => {
    const atr = { value: 2, reliable: true as const };
    expect(expectedMoveFromAtr(atr, 0, 2.0).reliable).toBe(false);
    expect(expectedMoveFromAtr(atr, -5, 2.0).reason).toBe('invalid-input');
  });
});

describe('warm-up mask', () => {
  it('seeds Wilder smoothing with an SMA', () => {
    const out = wilderSmooth([1, 2, 3, 4], 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(1.5);            // SMA seed
    expect(out[2]).toBe((1.5 * 1 + 3) / 2);
    expect(out[3]).toBe((2.25 * 1 + 4) / 2);
  });

  it('returns all-null when shorter than the period', () => {
    expect(wilderSmooth([1, 2], 5).every((v) => v === null)).toBe(true);
  });

  it('marks the whole warm-up window unreliable', () => {
    const mask = buildReliabilityMask(series(new Array(30).fill(100)), {
      period: 2, warmupMultiplier: 7,
    });
    expect(mask[12]).toBe('insufficient-warmup');
    expect(mask[13]).toBeNull();
  });

  it('rounds a fractional multiplier UP to a whole bar, never down', () => {
    // period=2, multiplier=4.5 -> warmup=9 (ceil of 9 exactly) vs period=2,
    // multiplier=4 -> warmup=8. Distinguishing the two catches a floor/round
    // regression, not just a ceil-of-an-exact-integer no-op.
    const c = series(new Array(20).fill(100));
    const exact = buildReliabilityMask(c, { period: 2, warmupMultiplier: 4.5 });
    expect(exact[7]).toBe('insufficient-warmup');   // index 7 = 8th bar, < 9
    expect(exact[8]).toBeNull();                     // index 8 = 9th bar, >= 9

    // period=3, multiplier=4.5 -> raw 13.5, must round UP to 14, not down to 13.
    const fractional = buildReliabilityMask(c, { period: 3, warmupMultiplier: 4.5 });
    expect(fractional[12]).toBe('insufficient-warmup');   // 13th bar, < 14
    expect(fractional[13]).toBeNull();                     // 14th bar, >= 14
  });

  it('defaults to a 63-bar (period 14 × 4.5) shadow — the 1% Wilder-decay budget (DECISIONS §28)', () => {
    expect(DEFAULT_WARMUP_MULTIPLIER).toBe(4.5);
    const c = series(new Array(70).fill(100));
    const mask = buildReliabilityMask(c, { period: 14 });   // no warmupMultiplier -> default
    expect(mask[61]).toBe('insufficient-warmup');   // 62nd bar, < 63
    expect(mask[62]).toBeNull();                      // 63rd bar, >= 63
  });
});
