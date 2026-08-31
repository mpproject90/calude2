import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.js';
import {
  computeGaps, fmtDuration, fmtPct, fmtPrice, esc, splitIntoSegments, type LogTick,
} from '../src/cli/statusPageHelpers.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function tick(offsetMs: number, kind: LogTick['kind'] = 'price', price: number | null = 1): LogTick {
  return { timestamp: T0 + offsetMs, symbol: 'JUP', kind, price: kind === 'price' ? price : null };
}

describe('computeGaps (DECISIONS §43) — largest gaps first, real deltas only', () => {
  it('finds no gaps when every delta is within the threshold', () => {
    const ticks = [tick(0), tick(30_000), tick(60_000), tick(90_000)];
    expect(computeGaps(ticks, 90_000)).toHaveLength(0);
  });

  it('flags a single gap exceeding the threshold, with exact start/end/duration', () => {
    const ticks = [tick(0), tick(30_000), tick(30_000 + 20 * MIN)];
    const gaps = computeGaps(ticks, 90_000);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({ startTs: T0 + 30_000, endTs: T0 + 30_000 + 20 * MIN, durationMs: 20 * MIN });
  });

  it('sorts multiple gaps largest-first, not chronologically', () => {
    const ticks = [
      tick(0),
      tick(10 * MIN),        // 10min gap
      tick(10 * MIN + 60_000),
      tick(10 * MIN + 60_000 + 2 * HOUR),   // 2h gap — should sort ABOVE the earlier 10min one
    ];
    const gaps = computeGaps(ticks, 90_000);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]!.durationMs).toBe(2 * HOUR);
    expect(gaps[1]!.durationMs).toBe(10 * MIN);
  });

  it('does not require the input to already be sorted', () => {
    const ticks = [tick(30_000), tick(0), tick(30_000 + 20 * MIN)];
    const gaps = computeGaps(ticks, 90_000);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.startTs).toBe(T0 + 30_000);
  });

  it('a delta exactly AT the threshold is not a gap — boundary is exclusive', () => {
    const ticks = [tick(0), tick(90_000)];
    expect(computeGaps(ticks, 90_000)).toHaveLength(0);
    const ticksOver = [tick(0), tick(90_001)];
    expect(computeGaps(ticksOver, 90_000)).toHaveLength(1);
  });

  it('the real overnight case: two known gaps produce two entries, correctly ordered', () => {
    // last good tick, then a 4h26m gap, then an 18h48m gap, then recovery
    const ticks = [
      tick(0),
      tick(4 * HOUR + 26 * MIN + 51_000),
      tick(4 * HOUR + 26 * MIN + 51_000 + 18 * HOUR + 48 * MIN + 29_000),
    ];
    const gaps = computeGaps(ticks, 90_000);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]!.durationMs).toBeGreaterThan(gaps[1]!.durationMs);
    expect(gaps[0]!.durationMs).toBe(18 * HOUR + 48 * MIN + 29_000);
    expect(gaps[1]!.durationMs).toBe(4 * HOUR + 26 * MIN + 51_000);
  });
});

describe('splitIntoSegments (DECISIONS §43) — chart line breaks across real gaps only', () => {
  it('returns one segment when there are no gaps', () => {
    const ticks = [tick(0), tick(30_000), tick(60_000)];
    const segments = splitIntoSegments(ticks, 90_000);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(3);
  });

  it('splits into two segments across one gap, with all points accounted for', () => {
    const ticks = [tick(0), tick(30_000), tick(30_000 + 20 * MIN), tick(30_000 + 20 * MIN + 30_000)];
    const segments = splitIntoSegments(ticks, 90_000);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(2);
    const totalPoints = segments.reduce((n, s) => n + s.length, 0);
    expect(totalPoints).toBe(ticks.length);   // no point silently dropped
  });

  it('returns an empty array for an empty input, not a crash', () => {
    expect(splitIntoSegments([], 90_000)).toEqual([]);
  });

  it('a single tick produces a single one-element segment', () => {
    const segments = splitIntoSegments([tick(0)], 90_000);
    expect(segments).toEqual([[tick(0)]]);
  });
});

describe('fmtDuration (DECISIONS §43)', () => {
  it('formats minutes only when under an hour', () => {
    expect(fmtDuration(5 * MIN)).toBe('5m');
  });

  it('formats hours and minutes, omitting days when under 24h', () => {
    expect(fmtDuration(23 * HOUR + 16 * MIN + 30_000)).toBe('23h 16m');
  });

  it('formats days, hours, and minutes for multi-day durations', () => {
    expect(fmtDuration(1 * 24 * HOUR + 22 * HOUR + 3 * MIN)).toBe('1d 22h 3m');
  });

  it('clamps a negative duration to "0s" rather than printing something like "-1d"', () => {
    expect(fmtDuration(-5000)).toBe('0s');
  });

  it('zero duration formats as "0m"', () => {
    expect(fmtDuration(0)).toBe('0m');
  });
});

describe('fmtPct / fmtPrice / esc (DECISIONS §43)', () => {
  it('fmtPct always shows a sign, even for exactly zero', () => {
    expect(fmtPct(0)).toBe('+0.00%');
    expect(fmtPct(-0.6)).toBe('-0.60%');
    expect(fmtPct(12.345)).toBe('+12.35%');
  });

  it('fmtPrice fixes 8 decimal places, matching this project\'s price precision elsewhere', () => {
    expect(fmtPrice(0.002034025462703672)).toBe('0.00203403');
    expect(fmtPrice(1)).toBe('1.00000000');
  });

  it('esc escapes HTML-significant characters so log/detail text can never break page structure or inject markup', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(esc('a & b "quoted"')).toBe('a &amp; b &quot;quoted&quot;');
  });
});

describe('better-sqlite3 readonly:true (DECISIONS §43) — the actual safety property, not just documentation trust', () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a readonly connection can SELECT from an existing schema-initialized db', () => {
    dir = mkdtempSync(join(tmpdir(), 'statuspage-readonly-'));
    const dbPath = join(dir, 'test.db');
    const writable = openDb(dbPath);
    writable.close();

    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
    const row = readonly.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    expect(row).toBeDefined();
    readonly.close();
  });

  it('a readonly connection throws on INSERT rather than silently succeeding — the property this whole tool depends on', () => {
    dir = mkdtempSync(join(tmpdir(), 'statuspage-readonly-'));
    const dbPath = join(dir, 'test.db');
    const writable = openDb(dbPath);
    writable.close();

    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
    expect(() => {
      readonly.prepare(
        "INSERT INTO paper_events (symbol, kind, detail, occurred_at) VALUES ('JUP', 'restart', 'should never land', 0)",
      ).run();
    }).toThrow(/readonly|read-only/i);
    readonly.close();
  });

  it('a readonly connection throws opening a path that does not exist, rather than creating one', () => {
    dir = mkdtempSync(join(tmpdir(), 'statuspage-readonly-'));
    const dbPath = join(dir, 'does-not-exist.db');
    expect(() => new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 })).toThrow();
  });
});
