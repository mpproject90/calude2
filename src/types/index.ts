/**
 * Core domain types. Shared by backtest, paper and live so that strategy code
 * is provably identical across all three modes (spec §10: "if the backtest and
 * live bot can disagree, the backtest is worthless").
 */

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

/** Interval duration in milliseconds. Used for gap detection. */
export const INTERVAL_MS: Readonly<Record<Interval, number>> = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
});

/**
 * A single OHLCV bar. `timestamp` is the bar's OPEN time in epoch milliseconds,
 * UTC-aligned to the interval boundary. Prices are quote-currency floats —
 * acceptable for indicator math. On-chain token amounts must NOT use this type;
 * see util/amount.ts for the integer representation.
 */
export interface Candle {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Indicator output. Never a bare number — spec §5 requires callers to be unable
 * to use a value without seeing whether it is trustworthy. The rules engine
 * refuses to trade on `reliable: false` with no override path.
 */
export interface IndicatorValue {
  readonly value: number;
  readonly reliable: boolean;
  /** Why the value is unreliable. Absent when reliable. */
  readonly reason?: UnreliableReason;
}

export type UnreliableReason =
  | 'insufficient-warmup'
  | 'gap-in-series'
  | 'invalid-input';

export type Tier = 'A' | 'B';

export type Mode = 'backtest' | 'paper' | 'live';

/** A detected discontinuity in a candle series. Never silently interpolated. */
export interface CandleGap {
  readonly afterTimestamp: number;
  readonly beforeTimestamp: number;
  readonly missingBars: number;
}

export interface CandleSeries {
  readonly token: string;
  readonly interval: Interval;
  readonly candles: readonly Candle[];
  readonly gaps: readonly CandleGap[];
}

/**
 * Provider abstraction (spec §4). Implementations must not cache internally —
 * caching is the repository's job so that provider swaps keep one cache.
 */
export interface CandleProvider {
  readonly name: string;
  /** Which intervals this provider can actually serve. */
  supports(interval: Interval): boolean;
  getCandles(
    token: string,
    interval: Interval,
    from: number,
    to: number,
  ): Promise<Candle[]>;
}
