/**
 * Downsample a candle series to a coarser interval (e.g. 1h -> 4h), needed
 * because the regime filter (spec §6.5) reads SOL's trend on a HIGHER
 * timeframe than the token being traded — `regimeFilter.solMaTimeframe`
 * defaults to `4h` while a token typically trades on `1h`. The backtest
 * engine has only ever fetched SOL at the token's own interval, so this
 * builds the coarser series from what's already cached rather than requiring
 * a second fetch.
 *
 * A bucket is only emitted when it contains EXACTLY the expected number of
 * source bars — a partial bucket (the window's first or last, or one that
 * straddles a gap) is dropped rather than aggregated from incomplete data,
 * same principle as gaps.ts: never fabricate a bar from less than it claims
 * to represent.
 */
import type { Candle, Interval } from '../types/index.js';
import { INTERVAL_MS } from '../types/index.js';

export class AggregateError extends Error {}

export function aggregateCandles(
  candles: readonly Candle[],
  sourceInterval: Interval,
  targetInterval: Interval,
): Candle[] {
  const sourceMs = INTERVAL_MS[sourceInterval];
  const targetMs = INTERVAL_MS[targetInterval];
  if (targetMs % sourceMs !== 0) {
    throw new AggregateError(
      `cannot aggregate ${sourceInterval} into ${targetInterval} — not an exact multiple`,
    );
  }
  const barsPerBucket = targetMs / sourceMs;
  if (barsPerBucket === 1) return candles.slice();

  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const key = Math.floor(c.timestamp / targetMs) * targetMs;
    const group = buckets.get(key);
    if (group === undefined) buckets.set(key, [c]);
    else group.push(c);
  }

  const out: Candle[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(key)!.slice().sort((a, b) => a.timestamp - b.timestamp);
    if (group.length !== barsPerBucket) continue;   // incomplete bucket — never fabricated

    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const c of group) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }
    out.push({
      timestamp: key,
      open: group[0]!.open,
      close: group[group.length - 1]!.close,
      high, low, volume,
    });
  }
  return out;
}
