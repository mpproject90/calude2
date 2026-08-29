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
import {
  GeckoTerminalCandleProvider, GeckoTerminalProviderError, GeckoTerminalRateLimitError,
  type FetchFn as GtFetchFn,
} from '../src/data/providers/geckoterminal.js';
import {
  DexPaprikaCandleProvider, DexPaprikaProviderError, type FetchFn as PaprikaFetchFn,
} from '../src/data/providers/dexpaprika.js';
import { selectDominantPool, type PoolSeries } from '../src/data/poolSelection.js';
import { computeWickDiagnostics } from '../src/data/wickDiagnostics.js';

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

  it('wraps a raw network failure with the URL and preserves the cause chain', async () => {
    // The bug found this session: Node's fetch throws `TypeError: fetch failed`
    // for a TLS/DNS/connection failure, with the real reason only in `.cause`.
    const inner = new Error('certificate for wrong domain');
    const fetchFn: FetchFn = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: inner }); };
    const err = await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BinanceProviderError);
    expect((err as Error).message).toContain('network request failed for');
    expect((err as Error).message).toContain('symbol=JUPUSDT');
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    expect(((err as Error & { cause?: Error }).cause as Error).cause).toBe(inner);
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

describe('GeckoTerminal provider', () => {
  const gtRow = (i: number, close = 10.5): (number | string)[] =>
    [(T0 + i * H) / 1000, 10.0, 11.0, 9.0, close, 100.0];

  const ohlcvBody = (rows: (number | string)[][]): unknown =>
    ({ data: { attributes: { ohlcv_list: rows } } });

  const mockFetch = (
    pages: unknown[], statuses: number[] = [],
  ): { fetchFn: GtFetchFn; calls: string[] } => {
    const calls: string[] = [];
    let n = 0;
    const fetchFn: GtFetchFn = async (url) => {
      calls.push(url);
      const status = statuses[n] ?? 200;
      const body = pages[n] ?? { data: [] };
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

  const provider = (fetchFn: GtFetchFn, over = {}) =>
    new GeckoTerminalCandleProvider({ fetchFn, sleepFn: async () => {}, ...over });

  it('declares which intervals it supports — every project Interval maps to a timeframe/aggregate', () => {
    const p = provider(mockFetch([]).fetchFn);
    for (const i of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) expect(p.supports(i)).toBe(true);
  });

  it('throws for a token with no pool resolved rather than guessing', async () => {
    const p = provider(mockFetch([]).fetchFn);
    await expect(p.getCandles('JUP', '1h', T0, T0 + H)).rejects.toThrow(GeckoTerminalProviderError);
  });

  it('requests the pool-native price via currency=token&token=base', async () => {
    const { fetchFn, calls } = mockFetch([ohlcvBody([gtRow(0)])]);
    const p = provider(fetchFn, { poolMap: { JUP: 'poolAddr123' } });
    await p.getPoolOhlcv('poolAddr123', '1h', T0, T0 + H);
    expect(calls[0]).toContain('pools/poolAddr123/ohlcv/hour');
    expect(calls[0]).toContain('currency=token');
    expect(calls[0]).toContain('token=base');
  });

  it('parses OHLCV rows, converting seconds to milliseconds', async () => {
    const { fetchFn } = mockFetch([ohlcvBody([gtRow(0, 12.25)])]);
    const out = await provider(fetchFn).getPoolOhlcv('pool', '1h', T0, T0 + H);
    expect(out[0]).toEqual({ timestamp: T0, open: 10, high: 11, low: 9, close: 12.25, volume: 100 });
  });

  it('paginates backward across pages regardless of within-page order, dedupes at the seam', async () => {
    const from = T0;
    const to = T0 + 1999 * H;
    const page1 = Array.from({ length: 1000 }, (_, i) => gtRow(1000 + i));   // newest 1000
    const page2 = Array.from({ length: 1000 }, (_, i) => gtRow(i));          // oldest 1000
    const { fetchFn, calls } = mockFetch([ohlcvBody(page1), ohlcvBody(page2)]);
    const out = await provider(fetchFn).getPoolOhlcv('pool', '1h', from, to);
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(2000);
    expect(out[0]!.timestamp).toBe(T0);
    expect(out[out.length - 1]!.timestamp).toBe(to);
  });

  it('excludes rows outside the requested window', async () => {
    const { fetchFn } = mockFetch([ohlcvBody([gtRow(0), gtRow(1), gtRow(2)])]);
    const out = await provider(fetchFn).getPoolOhlcv('pool', '1h', T0 + H, T0 + H);
    expect(out).toHaveLength(1);
    expect(out[0]!.timestamp).toBe(T0 + H);
  });

  it('stops when the pool has nothing to return', async () => {
    const { fetchFn, calls } = mockFetch([{ data: { attributes: { ohlcv_list: [] } } }]);
    const out = await provider(fetchFn).getPoolOhlcv('pool', '1h', T0, T0 + 5000 * H);
    expect(out).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('backs off on 429 and then succeeds', async () => {
    const { fetchFn, calls } = mockFetch(
      [{ data: { attributes: { ohlcv_list: [] } } }, ohlcvBody([gtRow(0)])], [429, 200],
    );
    const out = await provider(fetchFn).getPoolOhlcv('pool', '1h', T0, T0 + H);
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(1);
  });

  it('gives up after exhausting retries on repeated 429s', async () => {
    const { fetchFn } = mockFetch(
      [{}, {}, {}, {}], [429, 429, 429, 429],
    );
    await expect(provider(fetchFn).getPoolOhlcv('pool', '1h', T0, T0 + H))
      .rejects.toThrow(GeckoTerminalRateLimitError);
  });

  it('throws with the raw body attached when the OHLCV shape does not match the model', async () => {
    const { fetchFn } = mockFetch([{ data: { attributes: {} } }]);
    const err: unknown = await provider(fetchFn).getPoolOhlcv('pool', '1h', T0, T0 + H)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeckoTerminalProviderError);
    expect((err as Error).message).toMatch(/ohlcv_list/);
    expect((err as Error & { cause?: unknown }).cause).toEqual({ data: { attributes: {} } });
  });

  it('wraps a raw network failure with the URL and preserves the cause', async () => {
    const inner = new Error('certificate for wrong domain');
    const fetchFn: GtFetchFn = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: inner }); };
    const err: unknown = await provider(fetchFn).getPoolOhlcv('pool', '1h', T0, T0 + H)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeckoTerminalProviderError);
    expect((err as Error).message).toContain('network request failed for');
    expect(((err as Error & { cause?: Error }).cause as Error).cause).toBe(inner);
  });

  it('finds pools for a token filtered to a specific pair, and parses pool fields', async () => {
    const body = {
      data: [
        {
          attributes: { address: 'poolSol', pool_created_at: '2024-01-01T00:00:00Z', reserve_in_usd: '500000' },
          relationships: {
            base_token: { data: { id: 'solana_JUPMINT' } },
            quote_token: { data: { id: 'solana_SOLMINT' } },
            dex: { data: { id: 'raydium' } },
          },
        },
        {
          attributes: { address: 'poolUsdc', reserve_in_usd: '1000' },
          relationships: {
            base_token: { data: { id: 'solana_JUPMINT' } },
            quote_token: { data: { id: 'solana_USDCMINT' } },
            dex: { data: { id: 'meteora' } },
          },
        },
      ],
    };
    const { fetchFn, calls } = mockFetch([body]);
    const candidates = await provider(fetchFn).searchPools('JUPMINT', 'SOLMINT');
    expect(calls[0]).toContain('tokens/JUPMINT/pools');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      address: 'poolSol', dex: 'raydium', createdAt: '2024-01-01T00:00:00Z',
      reserveUsd: 500000, baseTokenAddress: 'JUPMINT', quoteTokenAddress: 'SOLMINT',
    });
  });

  it('throws with the raw entry attached when a pool entry is missing required fields', async () => {
    const body = { data: [{ attributes: {}, relationships: {} }] };
    const { fetchFn } = mockFetch([body]);
    await expect(provider(fetchFn).searchPools('JUPMINT', 'SOLMINT')).rejects.toThrow(GeckoTerminalProviderError);
  });

  it('setPool resolves getCandles to the chosen pool', async () => {
    const { fetchFn, calls } = mockFetch([ohlcvBody([gtRow(0)])]);
    const p = provider(fetchFn);
    p.setPool('JUP', 'chosenPool');
    await p.getCandles('JUP', '1h', T0, T0 + H);
    expect(calls[0]).toContain('pools/chosenPool/ohlcv');
  });
});

describe('DexPaprika provider (alternate, not wired into the default fetch path)', () => {
  const row = (i: number, close = 10.5) => ({
    time_open: new Date(T0 + i * H).toISOString(),
    time_close: new Date(T0 + i * H + H - 1).toISOString(),
    open: 10, high: 11, low: 9, close, volume: 100,
  });

  const mockFetch = (
    pages: unknown[][], statuses: number[] = [],
  ): { fetchFn: PaprikaFetchFn; calls: string[] } => {
    const calls: string[] = [];
    let n = 0;
    const fetchFn: PaprikaFetchFn = async (url) => {
      calls.push(url);
      const status = statuses[n] ?? 200;
      const body = pages[n] ?? [];
      n++;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };
    return { fetchFn, calls };
  };

  const provider = (fetchFn: PaprikaFetchFn, over = {}) =>
    new DexPaprikaCandleProvider({ fetchFn, sleepFn: async () => {}, poolMap: { JUP: 'poolAddr' }, ...over });

  it('does not claim to support 4h — this API does not offer it', () => {
    const p = provider(mockFetch([]).fetchFn);
    expect(p.supports('4h')).toBe(false);
    expect(p.supports('1h')).toBe(true);
  });

  it('parses ISO time_open into an epoch-ms timestamp', async () => {
    const { fetchFn } = mockFetch([[row(0, 12.25)]]);
    const out = await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H);
    expect(out[0]).toEqual({ timestamp: T0, open: 10, high: 11, low: 9, close: 12.25, volume: 100 });
  });

  it('throws for an unresolved token rather than guessing', async () => {
    const p = new DexPaprikaCandleProvider({ fetchFn: mockFetch([]).fetchFn });
    await expect(p.getCandles('WIF', '1h', T0, T0 + H)).rejects.toThrow(DexPaprikaProviderError);
  });

  it('throws on a non-array body rather than treating an error as data', async () => {
    const { fetchFn } = mockFetch([{ error: 'not found' } as never]);
    await expect(provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H)).rejects.toThrow(/not an array/);
  });

  it('wraps a raw network failure with the URL and preserves the cause', async () => {
    const inner = new Error('certificate for wrong domain');
    const fetchFn: PaprikaFetchFn = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: inner }); };
    const err: unknown = await provider(fetchFn).getCandles('JUP', '1h', T0, T0 + H).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DexPaprikaProviderError);
    expect((err as Error).message).toContain('network request failed for');
    expect(((err as Error & { cause?: Error }).cause as Error).cause).toBe(inner);
  });
});

describe('pool selection', () => {
  const vol = (i: number, v: number): Candle => ({ ...bar(i), volume: v });

  it('selects the single pool with the highest total volume', () => {
    const series: PoolSeries[] = [
      { address: 'small', candles: [vol(0, 10), vol(1, 10)] },
      { address: 'big', candles: [vol(0, 500), vol(1, 500)] },
    ];
    const r = selectDominantPool(series, '1h');
    expect(r.selected).toBe('big');
    expect(r.volumeShareByPool['big']).toBeCloseTo(500 / 510, 6);
    expect(r.migrated).toBe(false);
  });

  it('reports coverage per pool, including a pool that only covers part of the window', () => {
    const series: PoolSeries[] = [
      { address: 'early', candles: [vol(0, 100), vol(1, 100)] },
      { address: 'late', candles: [vol(2, 200), vol(3, 200)] },
    ];
    const r = selectDominantPool(series, '1h');
    expect(r.coverageByPool['early']).toEqual({ firstTimestamp: T0, lastTimestamp: T0 + H, bars: 2 });
    expect(r.coverageByPool['late']).toEqual({ firstTimestamp: T0 + 2 * H, lastTimestamp: T0 + 3 * H, bars: 2 });
    // "late" wins on total volume even though it doesn't cover the early bars —
    // those bars become a genuine gap once the selected pool's series is used,
    // never backfilled from "early".
    expect(r.selected).toBe('late');
  });

  it('flags migration when the locally-dominant pool changes mid-window, without resolving it', () => {
    const series: PoolSeries[] = [
      { address: 'A', candles: [vol(0, 500), vol(1, 500), vol(2, 10), vol(3, 10)] },
      { address: 'B', candles: [vol(0, 10), vol(1, 10), vol(2, 500), vol(3, 500)] },
    ];
    const r = selectDominantPool(series, '1h');
    expect(r.migrated).toBe(true);
    expect(r.dominancePeriods.map((p) => p.pool)).toEqual(['A', 'B']);
  });

  it('breaks ties by input order, deterministically', () => {
    const series: PoolSeries[] = [
      { address: 'first', candles: [vol(0, 100)] },
      { address: 'second', candles: [vol(0, 100)] },
    ];
    const r = selectDominantPool(series, '1h');
    expect(r.selected).toBe('first');
  });

  it('selects nothing when no pool ever traded', () => {
    const series: PoolSeries[] = [{ address: 'dead', candles: [] }];
    const r = selectDominantPool(series, '1h');
    expect(r.selected).toBeNull();
  });
});

describe('wick/ATR diagnostics — the replacement for range-widening on real pool data', () => {
  it('reports one bar counted, regardless of shape', () => {
    const d = computeWickDiagnostics([
      { timestamp: T0, open: 10, high: 10, low: 9, close: 9, volume: 100 },
    ]);
    expect(d.bars).toBe(1);
  });

  it('flags an all-wick (zero-body) bar as an infinite ratio rather than clipping it', () => {
    const d = computeWickDiagnostics([
      { timestamp: T0, open: 10, high: 12, low: 8, close: 10, volume: 100 },
    ]);
    expect(d.wickToBody.infiniteCount).toBe(1);
    expect(d.wickToBody.max).toBe(Infinity);
  });

  it('reports zero wick-to-body ratio for a body-filling bar with no excursion', () => {
    const d = computeWickDiagnostics([
      { timestamp: T0, open: 10, high: 11, low: 10, close: 11, volume: 100 },
    ]);
    expect(d.wickToBody.p50).toBe(0);
    expect(d.wickToBody.infiniteCount).toBe(0);
  });

  it('flags a bar whose wick sits far outside its own recent ATR as an outlier', () => {
    // 120 quiet bars (well past the period*7=98 ATR warm-up), then one bar
    // with a high far beyond anything the recent true range would predict.
    const quiet: Candle[] = Array.from({ length: 120 }, (_, i) => ({
      timestamp: T0 + i * H, open: 10, high: 10.2, low: 9.8, close: 10, volume: 100,
    }));
    const spike: Candle = { timestamp: T0 + 120 * H, open: 10, high: 50, low: 9.8, close: 10.1, volume: 100 };
    const d = computeWickDiagnostics([...quiet, spike], { atrPeriod: 14 });
    expect(d.atrOutlierCount).toBe(1);
  });

  it('excludes bars still in ATR warm-up from the outlier count rather than misjudging them', () => {
    const short: Candle[] = Array.from({ length: 5 }, (_, i) => ({
      timestamp: T0 + i * H, open: 10, high: 30, low: 1, close: 10, volume: 100,
    }));
    const d = computeWickDiagnostics(short, { atrPeriod: 14 });
    expect(d.atrOutlierCount).toBe(0);
    expect(d.atrUnreliableCount).toBe(5);
  });
});
