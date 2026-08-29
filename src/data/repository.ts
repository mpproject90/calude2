/**
 * Candle cache (spec §4): "Cache all fetched candles in SQLite, keyed by
 * (token, interval, timestamp). Never re-fetch what you have."
 *
 * Keyed by (token, interval, POOL ADDRESS, timestamp) as of schema v2
 * (DECISIONS §29) — GeckoTerminal pool selection is not stable run-to-run
 * (rate-limit-driven candidate exclusion can hand a re-fetch a different
 * pool than last time), and the original (token, interval, timestamp) key
 * let one pool's candles silently overwrite another's for every overlapping
 * timestamp. `poolAddress` is required on every call, not optional-with-a-
 * default, so a caller must say which series it means; pass `''` for a
 * non-pool-based provider (Binance has exchange symbols, not pools).
 *
 * The fetch log is what makes "never re-fetch what you have" possible.
 * Because empty candles are simply absent from some providers, a missing row
 * cannot distinguish "no trading" from "never asked". The log records which
 * RANGES were requested, so coverage is a fact rather than an inference.
 */
import type { Db } from '../db/index.js';
import { INTERVAL_MS, type Candle, type CandleGap, type Interval } from '../types/index.js';
import type { InvalidCandle } from './validate.js';

export interface FetchedRange {
  readonly from: number;
  readonly to: number;
  readonly provider: string;
  readonly rowCount: number;
}

export class CandleRepository {
  constructor(private readonly db: Db) {}

  upsertCandles(
    token: string, interval: Interval, candles: readonly Candle[], provider: string, poolAddress: string,
  ): number {
    if (candles.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO candles
         (token, interval, pool_address, timestamp, open, high, low, close, volume, provider, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(token, interval, pool_address, timestamp) DO UPDATE SET
         open=excluded.open, high=excluded.high, low=excluded.low,
         close=excluded.close, volume=excluded.volume,
         provider=excluded.provider, fetched_at=excluded.fetched_at`,
    );
    const now = Date.now();
    const run = this.db.transaction((rows: readonly Candle[]) => {
      for (const c of rows) {
        stmt.run(token, interval, poolAddress, c.timestamp, c.open, c.high, c.low, c.close,
                 c.volume, provider, now);
      }
    });
    run(candles);
    return candles.length;
  }

  getCandles(token: string, interval: Interval, from: number, to: number, poolAddress: string): Candle[] {
    return this.db
      .prepare<[string, string, string, number, number], Candle>(
        `SELECT timestamp, open, high, low, close, volume FROM candles
         WHERE token = ? AND interval = ? AND pool_address = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(token, interval, poolAddress, from, to);
  }

  /** Every distinct pool address cached for this token/interval, most recently fetched first. */
  cachedPools(token: string, interval: Interval): { poolAddress: string; lastFetchedAt: number }[] {
    return this.db
      .prepare<[string, string], { poolAddress: string; lastFetchedAt: number }>(
        `SELECT pool_address AS "poolAddress", MAX(fetched_at) AS "lastFetchedAt"
         FROM candles WHERE token = ? AND interval = ?
         GROUP BY pool_address ORDER BY lastFetchedAt DESC`,
      )
      .all(token, interval);
  }

  recordFetch(
    token: string, interval: Interval, from: number, to: number,
    provider: string, rowCount: number, poolAddress: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO candle_fetch_log
           (token, interval, pool_address, from_ts, to_ts, provider, fetched_at, row_count)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(token, interval, poolAddress, from, to, provider, Date.now(), rowCount);
  }

  getFetchedRanges(token: string, interval: Interval, poolAddress: string): FetchedRange[] {
    return this.db
      .prepare<[string, string, string], { from: number; to: number; provider: string; rowCount: number }>(
        `SELECT from_ts AS "from", to_ts AS "to", provider, row_count AS "rowCount"
         FROM candle_fetch_log WHERE token = ? AND interval = ? AND pool_address = ?
         ORDER BY from_ts ASC`,
      )
      .all(token, interval, poolAddress);
  }

  /**
   * Sub-ranges of [from, to] not covered by any previous fetch. This is what
   * keeps us from re-requesting data we already hold.
   */
  missingRanges(
    token: string, interval: Interval, from: number, to: number, poolAddress: string,
  ): { from: number; to: number }[] {
    const step = INTERVAL_MS[interval];
    const covered = this.getFetchedRanges(token, interval, poolAddress)
      .map((r) => ({ from: r.from, to: r.to }))
      .filter((r) => r.to >= from && r.from <= to)
      .sort((a, b) => a.from - b.from);

    const missing: { from: number; to: number }[] = [];
    let cursor = from;
    for (const range of covered) {
      if (range.from > cursor) {
        missing.push({ from: cursor, to: Math.min(range.from - step, to) });
      }
      cursor = Math.max(cursor, range.to + step);
      if (cursor > to) break;
    }
    if (cursor <= to) missing.push({ from: cursor, to });
    return missing.filter((r) => r.from <= r.to);
  }

  recordGaps(token: string, interval: Interval, gaps: readonly CandleGap[], poolAddress: string): void {
    if (gaps.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO candle_gaps
         (token, interval, pool_address, after_ts, before_ts, missing_bars, detected_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(token, interval, pool_address, after_ts) DO UPDATE SET
         before_ts=excluded.before_ts, missing_bars=excluded.missing_bars,
         detected_at=excluded.detected_at`,
    );
    const now = Date.now();
    const run = this.db.transaction((rows: readonly CandleGap[]) => {
      for (const g of rows) {
        stmt.run(token, interval, poolAddress, g.afterTimestamp, g.beforeTimestamp, g.missingBars, now);
      }
    });
    run(gaps);
  }

  getGaps(token: string, interval: Interval, poolAddress: string): CandleGap[] {
    return this.db
      .prepare<[string, string, string], { afterTimestamp: number; beforeTimestamp: number; missingBars: number }>(
        `SELECT after_ts AS "afterTimestamp", before_ts AS "beforeTimestamp",
                missing_bars AS "missingBars"
         FROM candle_gaps WHERE token = ? AND interval = ? AND pool_address = ? ORDER BY after_ts ASC`,
      )
      .all(token, interval, poolAddress);
  }

  recordRejected(token: string, interval: Interval, rejected: readonly InvalidCandle[], poolAddress: string): void {
    if (rejected.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO rejected_candles
         (token, interval, pool_address, timestamp, reason, payload, rejected_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const now = Date.now();
    const run = this.db.transaction((rows: readonly InvalidCandle[]) => {
      for (const r of rows) {
        const ts = (r.raw as Candle | undefined)?.timestamp ?? 0;
        stmt.run(token, interval, poolAddress, ts, `${r.reason}: ${r.detail}`, JSON.stringify(r.raw), now);
      }
    });
    run(rejected);
  }

  countRejected(token: string, interval: Interval, poolAddress: string): number {
    return this.db
      .prepare<[string, string, string], { c: number }>(
        'SELECT COUNT(*) AS c FROM rejected_candles WHERE token = ? AND interval = ? AND pool_address = ?',
      )
      .get(token, interval, poolAddress)!.c;
  }
}
