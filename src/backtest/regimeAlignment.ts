/**
 * Look-ahead-free alignment between a token's own timeframe and the regime
 * filter's higher timeframe (spec §6.5 default 4h; the token typically trades
 * 1h). For each token bar, finds the last REGIME bucket that had fully
 * CLOSED at or before that bar's timestamp — never a bucket still in
 * progress, which would leak future information into the decision exactly
 * the way filling at the signal candle's close (rather than the next open)
 * does for entries (spec §10).
 */
import type { Candle } from '../types/index.js';

/**
 * `aggregated` and `tokenCandles` must both be sorted ascending by timestamp
 * (true of every candle series produced by this codebase). Returns, per
 * token bar, the index into `aggregated` of the last bucket closed by that
 * bar's timestamp, or `null` if no regime bucket has closed yet.
 */
export function regimeBucketIndices(
  tokenCandles: readonly Candle[],
  aggregated: readonly Candle[],
  regimeBucketMs: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(tokenCandles.length).fill(null);
  let j = -1;
  for (let i = 0; i < tokenCandles.length; i++) {
    const t = tokenCandles[i]!.timestamp;
    while (j + 1 < aggregated.length && aggregated[j + 1]!.timestamp + regimeBucketMs <= t) {
      j++;
    }
    out[i] = j >= 0 ? j : null;
  }
  return out;
}
