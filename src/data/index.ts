/**
 * Data layer entry point: fetch → validate → detect gaps → cache, with the
 * cache consulted first so nothing is re-fetched.
 */
import type { Db } from '../db/index.js';
import type { Candle, CandleProvider, CandleSeries, Interval } from '../types/index.js';
import type { Logger } from '../util/logger.js';
import { CandleRepository } from './repository.js';
import { detectSeriesIssues } from './gaps.js';
import { validateCandles } from './validate.js';

export { CandleRepository } from './repository.js';
export * from './validate.js';
export * from './gaps.js';
export * from './synthesize.js';
export * from './providers/binance.js';

export interface CandleServiceOptions {
  readonly provider: CandleProvider;
  readonly db: Db;
  readonly logger: Logger;
}

export class CandleService {
  private readonly repo: CandleRepository;

  constructor(private readonly opts: CandleServiceOptions) {
    this.repo = new CandleRepository(opts.db);
  }

  /**
   * Return the series for [from, to], fetching only the ranges not already
   * cached. Gaps are detected, recorded and returned alongside the candles so
   * the indicator layer can refuse to trust values that span one.
   */
  async getSeries(
    token: string, interval: Interval, from: number, to: number,
  ): Promise<CandleSeries> {
    const { provider, logger } = this.opts;
    const log = logger.child({ token, interval, provider: provider.name });

    if (!provider.supports(interval)) {
      throw new Error(`provider ${provider.name} does not support interval ${interval}`);
    }

    for (const range of this.repo.missingRanges(token, interval, from, to)) {
      log.info('fetching uncached range', { from: range.from, to: range.to });
      const raw = await provider.getCandles(token, interval, range.from, range.to);

      const { valid, rejected } = validateCandles(raw, interval);
      if (rejected.length > 0) {
        log.warn('rejected invalid candles', {
          count: rejected.length,
          reasons: [...new Set(rejected.map((r) => r.reason))],
        });
        this.repo.recordRejected(token, interval, rejected);
      }

      this.repo.upsertCandles(token, interval, valid, provider.name);
      this.repo.recordFetch(token, interval, range.from, range.to, provider.name, valid.length);
    }

    const candles = this.repo.getCandles(token, interval, from, to);
    const issues = detectSeriesIssues(candles, interval);

    if (issues.gaps.length > 0) {
      log.warn('gaps detected in candle series — not interpolated', {
        gapCount: issues.gaps.length,
        missingBars: issues.gaps.reduce((n, g) => n + g.missingBars, 0),
      });
      this.repo.recordGaps(token, interval, issues.gaps);
    }
    if (issues.duplicates.length > 0 || issues.outOfOrder.length > 0) {
      log.error('candle series is malformed', {
        duplicates: issues.duplicates.length,
        outOfOrder: issues.outOfOrder.length,
      });
    }

    return { token, interval, candles, gaps: issues.gaps };
  }

  cached(token: string, interval: Interval, from: number, to: number): Candle[] {
    return this.repo.getCandles(token, interval, from, to);
  }

  get repository(): CandleRepository {
    return this.repo;
  }
}
