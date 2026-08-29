/**
 * Live price feed for paper trading (DECISIONS §41). AMM pools don't have a
 * discrete order book, so "current price" is the latest observed trade —
 * the most recent 1-minute bar's close from the same `getPoolOhlcv` method
 * `data:fetch`/`data:screen` already use for historical candles (no new
 * endpoint, no duplicated HTTP logic). The "ask" the operator asked fills
 * to be modelled at is derived from this observed price plus the existing
 * cost-floor slippage model — see `simulator.ts`; this module only answers
 * "what is the price right now, and how old is that answer."
 *
 * STALENESS (operator-specified — treat a stale feed the same way the
 * indicator reliability mask treats a gap: refuse to act, log loudly). A
 * price observation older than `staleAfterMs` must not be acted on — a stop
 * evaluated against a 20-minute-old price is worse than no stop at all.
 */
import type { Candle, Interval } from '../types/index.js';

export interface PriceObservation {
  readonly price: number;
  readonly timestamp: number;
}

export interface PriceFeed {
  getPrice(poolAddress: string): Promise<PriceObservation>;
}

export class PriceFeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PriceFeedError';
  }
}

export interface PoolOhlcvSource {
  getPoolOhlcv(poolAddress: string, interval: Interval, from: number, to: number): Promise<Candle[]>;
}

/** True when there is no observation yet, or the most recent one is older than `staleAfterMs`. */
export function isStale(
  observation: PriceObservation | null, nowMs: number, staleAfterMs: number,
): boolean {
  if (observation === null) return true;
  return nowMs - observation.timestamp > staleAfterMs;
}

const LOOKBACK_MS = 5 * 60_000;   // wide enough that one missed poll doesn't manufacture a false "empty window"
const FEED_INTERVAL: Interval = '1m';

export class GeckoTerminalPriceFeed implements PriceFeed {
  constructor(private readonly source: PoolOhlcvSource, private readonly now: () => number = () => Date.now()) {}

  async getPrice(poolAddress: string): Promise<PriceObservation> {
    const to = this.now();
    const from = to - LOOKBACK_MS;
    let candles: Candle[];
    try {
      candles = await this.source.getPoolOhlcv(poolAddress, FEED_INTERVAL, from, to);
    } catch (err) {
      throw new PriceFeedError(`price feed request failed for pool ${poolAddress}`, { cause: err });
    }
    if (candles.length === 0) {
      throw new PriceFeedError(
        `no trades in the last ${LOOKBACK_MS / 60_000} minutes for pool ${poolAddress} — ` +
        'cannot determine a current price',
      );
    }
    const latest = candles[candles.length - 1]!;
    return { price: latest.close, timestamp: latest.timestamp };
  }
}
