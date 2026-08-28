import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index.js';
import type { Candle } from '../src/types/index.js';
import { validateCandle, validateCandles } from '../src/data/validate.js';
import { detectSeriesIssues, detectGaps, totalMissingBars } from '../src/data/gaps.js';
import { CandleRepository } from '../src/data/repository.js';
import {
  BinanceCandleProvider, BinanceProviderError, BinanceRateLimitError, type FetchFn,
} from '../src/data/providers/binance.js';
import {
  synthesizeRatioSeries, rangeWideningRatio, assertSameInterval, SynthesisError,
} from '../src/data/synthesize.js';

const H = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H);   // aligned to the hour

const bar = (i: number, over: Partial<Candle> = {}): Candle => ({
  timestamp: T0 + i * H, open: 10, high: 11, low: 9, close: 10.5, volume: 100, ...over,
});

describe('candle validation', () => {
  it('accepts a well-formed candle', () => {
    expect(validateCandle(bar(0), '1h').ok).toBe(true);
  });

  it('rejects high below max(open, close)', () => {
    const r = validateCandle(bar(0, { open: 10, close: 12, high: 11 }), '1h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('high-below-open-or-close');
  });

  it('rejects low above min(open, close)', () => {
    // high must clear max(open, close) so the LOW check is the one that fires
    const r = validateCandle(bar(0, { open: 10, close: 12, high: 13, low: 11 }), '1h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('low-above-open-or-close');
  });

  it('rejects high below low', () => {
    const r = validateCandle(bar(0, { high: 5, low: 8, open: 6, close: 6 }), '1h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('high-below-low');
  });

  it('rejects negative volume', () => {
    const r = validateCandle(bar(0, { volume: -1 }), '1h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('negative-volume');
  });

  it('rejects non-finite values — the NaN a bad parse produces', () => {
    const r = validateCandle(bar(0, { close: Number.NaN }), '1h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('non-finite-value');
  });

  it('rejects zero and negative prices', () => {
    expect(validateCandle(bar(0, { low: 0, open: 0.5, close: 0.5 }), '1h').ok).toBe(false);
  });

  it('rejects a timestamp not aligned to the interval', () => {
    const r = validateCandle(bar(0, { timestamp: T0 + 137 }), '1h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp-misaligned');
  });

  it('accepts zero volume — a real, quiet bar', () => {
    expect(validateCandle(bar(0, { volume: 0 }), '1h').ok).toBe(true);
  });

  it('partitions a batch into valid and rejected', () => {
    const { valid, rejected } = validateCandles(
      [bar(0), bar(1, { volume: -5 }), bar(2)], '1h',
    );
    expect(valid).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });
});

describe('gap detection', () => {
  it('finds no gaps in a contiguous series', () => {
    expect(detectGaps([bar(0), bar(1), bar(2)], '1h')).toHaveLength(0);
  });

  it('finds a gap and counts the missing bars', () => {
    const gaps = detectGaps([bar(0), bar(1), bar(5)], '1h');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.missingBars).toBe(3);          // bars 2, 3, 4
    expect(gaps[0]!.afterTimestamp).toBe(T0 + H);
    expect(gaps[0]!.beforeTimestamp).toBe(T0 + 5 * H);
  });

  it('never interpolates — it only reports', () => {
    const input = [bar(0), bar(10)];
    const gaps = detectGaps(input, '1h');
    expect(input).toHaveLength(2);                 // untouched
    expect(totalMissingBars(gaps)).toBe(9);
  });

  it('detects duplicates and out-of-order bars separately from gaps', () => {
    const issues = detectSeriesIssues([bar(0), bar(0), bar(2), bar(1)], '1h');
    expect(issues.duplicates).toContain(T0);
    expect(issues.outOfOrder).toContain(T0 + H);
  });

  it('handles an empty or single-bar series', () => {
    expect(detectGaps([], '1h')).toHaveLength(0);
    expect(detectGaps([bar(0)], '1h')).toHaveLength(0);
  });
});

describe('candle repository', () => {
  const setup = () => {
    const db = openDb(':memory:');
    return { db, repo: new CandleRepository(db) };
  };

  it('stores and reads back a range', () => {
    const { db, repo } = setup();
    repo.upsertCandles('JUP', '1h', [bar(0), bar(1), bar(2)], 'test');
    expect(repo.getCandles('JUP', '1h', T0, T0 + 2 * H)).toHaveLength(3);
    expect(repo.getCandles('JUP', '1h', T0 + H, T0 + H)).toHaveLength(1);
    db.close();
  });

  it('is idempotent on re-insert — no duplicate rows', () => {
    const { db, repo } = setup();
    repo.upsertCandles('JUP', '1h', [bar(0)], 'test');
    repo.upsertCandles('JUP', '1h', [bar(0, { close: 99 })], 'test2');
    const rows = repo.getCandles('JUP', '1h', T0, T0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.close).toBe(99);         // latest write wins
    db.close();
  });

  it('keeps tokens and intervals separate', () => {
    const { db, repo } = setup();
    repo.upsertCandles('JUP', '1h', [bar(0)], 'test');
    repo.upsertCandles('SOL', '1h', [bar(0)], 'test');
    repo.upsertCandles('JUP', '4h', [bar(0)], 'test');
    expect(repo.getCandles('JUP', '1h', T0, T0)).toHaveLength(1);
    expect(repo.getCandles('SOL', '1h', T0, T0)).toHaveLength(1);
    db.close();
  });

  it('reports the whole window as missing before any fetch', () => {
    const { db, repo } = setup();
    const missing = repo.missingRanges('JUP', '1h', T0, T0 + 10 * H);
    expect(missing).toEqual([{ from: T0, to: T0 + 10 * H }]);
    db.close();
  });

  it('reports nothing missing once the window has been fetched', () => {
    const { db, repo } = setup();
    repo.recordFetch('JUP', '1h', T0, T0 + 10 * H, 'test', 11);
    expect(repo.missingRanges('JUP', '1h', T0, T0 + 10 * H)).toHaveLength(0);
    db.close();
  });

  it('reports only the uncovered remainder — so nothing is re-fetched', () => {
    const { db, repo } = setup();
    repo.recordFetch('JUP', '1h', T0, T0 + 5 * H, 'test', 6);
    const missing = repo.missingRanges('JUP', '1h', T0, T0 + 10 * H);
    expect(missing).toEqual([{ from: T0 + 6 * H, to: T0 + 10 * H }]);
    db.close();
  });

  it('finds a hole between two fetched ranges', () => {
    const { db, repo } = setup();
    repo.recordFetch('JUP', '1h', T0, T0 + 2 * H, 'test', 3);
    repo.recordFetch('JUP', '1h', T0 + 8 * H, T0 + 10 * H, 'test', 3);
    const missing = repo.missingRanges('JUP', '1h', T0, T0 + 10 * H);
    expect(missing).toEqual([{ from: T0 + 3 * H, to: T0 + 7 * H }]);
    db.close();
  });

  it('persists gaps and rejected candles for later inspection', () => {
    const { db, repo } = setup();
    repo.recordGaps('JUP', '1h', detectGaps([bar(0), bar(4)], '1h'));
    expect(repo.getGaps('JUP', '1h')).toHaveLength(1);
    const { rejected } = validateCandles([bar(0, { volume: -1 })], '1h');
    repo.recordRejected('JUP', '1h', rejected);
    expect(repo.countRejected('JUP', '1h')).toBe(1);
    db.close();
  });
});

describe('Binance provider', () => {
  const row = (i: number, close = 10.5) =>
    [T0 + i * H, '10.0', '11.0', '9.0', String(close), '100.0', T0 + i * H + H - 1, '0', 0, '0', '0', '0'];

  const mockFetch = (
    pages: unknown[][], statuses: number[] = [],
  ): { fetchFn: FetchFn; calls: string[] } => {
    const calls: string[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      const status = statuses[n] ?? 200;
      const body = pages[n] ?? [];
      n++;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h: string) => (h === 'Retry-After' ? '1' : null) },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };
    return { fetchFn, calls };
  };

  const provider = (fetchFn: FetchFn, over = {}) =>
    new BinanceCandleProvider({
      symbolMap: { JUP: 'JUPUSDT', SOL: 'SOLUSDT' },
      fetchFn, sleepFn: async () => {}, ...over,
    });

  it('declares which intervals it supports', () => {
    const p = provider(mockFetch([]).fetchFn);
    expect(p.supports('1h')).toBe(true);
    expect(p.supports('4h')).toBe(true);
    expect(p.supports('1m')).toBe(true);
  });

  it('maps a token to its Binance symbol and puts it in the URL', async () => {
    const { fetchFn, calls } = mockFetch([[row(0)]]);
    await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H);
    expect(calls[0]).toContain('symbol=JUPUSDT');
    expect(calls[0]).toContain('interval=1h');
  });

  it('throws for an unmapped token rather than guessing', () => {
    const p = provider(mockFetch([]).fetchFn);
    expect(() => p.symbolFor('WIF')).toThrow(BinanceProviderError);
  });

  it('parses string prices into numbers', async () => {
    const { fetchFn } = mockFetch([[row(0, 12.25)]]);
    const out = await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H);
    expect(out[0]).toEqual({
      timestamp: T0, open: 10, high: 11, low: 9, close: 12.25, volume: 100,
    });
  });

  it('paginates until a partial page arrives', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(i));
    const tail = [row(1000), row(1001)];
    const { fetchFn, calls } = mockFetch([full, tail]);
    const out = await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + 2000 * H);
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(1002);
  });

  it('stops when the exchange returns nothing', async () => {
    const { fetchFn, calls } = mockFetch([[]]);
    const out = await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + 5000 * H);
    expect(out).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('excludes rows outside the requested window', async () => {
    const { fetchFn } = mockFetch([[row(0), row(1), row(2)]]);
    const out = await provider(fetchFn).getCandles('JUP', '1h', T0 + H, T0 + H);
    expect(out).toHaveLength(1);
    expect(out[0]!.timestamp).toBe(T0 + H);
  });

  it('backs off on 429 and then succeeds', async () => {
    const { fetchFn, calls } = mockFetch([[], [row(0)]], [429, 200]);
    const out = await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H);
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(1);
  });

  it('gives up rather than risk escalating an IP ban', async () => {
    const { fetchFn } = mockFetch([[], [], [], []], [418, 418, 418, 418]);
    await expect(provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H))
      .rejects.toThrow(BinanceRateLimitError);
  });

  it('throws on a non-array body rather than treating an error as data', async () => {
    const { fetchFn } = mockFetch([{ code: -1121, msg: 'Invalid symbol.' } as never]);
    await expect(provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H))
      .rejects.toThrow(/non-array body/);
  });

  it('throws on a malformed row', async () => {
    const { fetchFn } = mockFetch([[[T0, '1']]]);
    await expect(provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H))
      .rejects.toThrow(/malformed kline row/);
  });

  it('captures the first raw response verbatim, once', async () => {
    const samples: unknown[] = [];
    const full = Array.from({ length: 1000 }, (_, i) => row(i));
    const { fetchFn } = mockFetch([full, [row(1000)]]);
    const p = provider(fetchFn, { onRawSample: (s: unknown) => samples.push(s) });
    await p.getCandles('JUP', '1h', T0, T0 + 2000 * H);
    expect(samples).toHaveLength(1);                       // once, not per page
    const sample = samples[0] as { url: string; rowCount: number; firstRows: unknown[] };
    expect(sample.url).toContain('symbol=JUPUSDT');
    expect(sample.rowCount).toBe(1000);
    expect(sample.firstRows).toHaveLength(3);
    expect(sample.firstRows[0]).toEqual(row(0));           // verbatim, unparsed
  });

  it('surfaces a non-OK HTTP status', async () => {
    const { fetchFn } = mockFetch([[]], [500]);
    await expect(provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H))
      .rejects.toThrow(/returned 500/);
  });
});

describe('ratio synthesis', () => {
  const num = (i: number, o: number, h: number, l: number, c: number): Candle =>
    ({ timestamp: T0 + i * H, open: o, high: h, low: l, close: c, volume: 100 });

  it('computes open and close EXACTLY', () => {
    const r = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11)],
      [num(0, 2, 2.5, 1.6, 2.2)],
    );
    expect(r.candles[0]!.open).toBeCloseTo(5, 12);       // 10/2
    expect(r.candles[0]!.close).toBeCloseTo(5, 12);      // 11/2.2
  });

  it('emits high and low as the widest possible BOUNDS', () => {
    const r = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11)],
      [num(0, 2, 2.5, 1.6, 2.2)],
    );
    expect(r.candles[0]!.high).toBeCloseTo(12 / 1.6, 12);   // high_num / low_den
    expect(r.candles[0]!.low).toBeCloseTo(8 / 2.5, 12);     // low_num / high_den
    expect(r.highLowApproximated).toBe(true);
  });

  it('produces a valid candle — bounds cannot invert the OHLC invariants', () => {
    const r = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11)],
      [num(0, 2, 2.5, 1.6, 2.2)],
    );
    expect(validateCandle(r.candles[0]!, '1h').ok).toBe(true);
  });

  it('drops unmatched bars rather than carrying values forward', () => {
    const r = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11), num(1, 10, 12, 8, 11), num(2, 10, 12, 8, 11)],
      [num(0, 2, 2.5, 1.6, 2.2), num(2, 2, 2.5, 1.6, 2.2)],
    );
    expect(r.candles).toHaveLength(2);
    expect(r.unmatchedNumerator).toEqual([T0 + H]);
  });

  it('reports denominator bars with no numerator counterpart', () => {
    const r = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11)],
      [num(0, 2, 2.5, 1.6, 2.2), num(1, 2, 2.5, 1.6, 2.2)],
    );
    expect(r.unmatchedDenominator).toEqual([T0 + H]);
  });

  it('drops a bar with a non-positive denominator instead of dividing by zero', () => {
    const r = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11)],
      [{ timestamp: T0, open: 0, high: 1, low: 0, close: 1, volume: 1 }],
    );
    expect(r.candles).toHaveLength(0);
    expect(r.unmatchedNumerator).toEqual([T0]);
  });

  it('carries base-asset volume through unchanged', () => {
    const r = synthesizeRatioSeries(
      [{ ...num(0, 10, 12, 8, 11), volume: 4242 }],
      [num(0, 2, 2.5, 1.6, 2.2)],
    );
    expect(r.candles[0]!.volume).toBe(4242);
  });

  it('quantifies how much the bounds widened the range', () => {
    const r = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11)], [num(0, 2, 2.5, 1.6, 2.2)],
    );
    expect(rangeWideningRatio(r.candles)).toBeGreaterThan(1);
    // a denominator with no intrabar range leaves the numerator's range intact
    const tight = synthesizeRatioSeries(
      [num(0, 10, 12, 8, 11)], [{ timestamp: T0, open: 2, high: 2, low: 2, close: 2, volume: 1 }],
    );
    expect(tight.candles[0]!.high).toBeCloseTo(6, 12);
    expect(tight.candles[0]!.low).toBeCloseTo(4, 12);
  });

  it('refuses to synthesize across mismatched intervals', () => {
    expect(() => assertSameInterval('1h', '4h')).toThrow(SynthesisError);
    expect(() => assertSameInterval('1h', '1h')).not.toThrow();
  });
});
