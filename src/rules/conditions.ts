/**
 * Primitive entry conditions (spec §7). Kept separate from the entry rule so
 * each can be tested against synthetic series in isolation.
 */
import type { Candle, IndicatorValue } from '../types/index.js';

/**
 * §7.2 — RSI crossing UP through the oversold level.
 *
 * Deliberately the cross up, never the drop below: buying the drop is
 * knife-catching, buying the turn is mean reversion. Requires the previous bar
 * strictly below the level and the current bar at or above it.
 */
export function crossedUpThrough(
  series: readonly IndicatorValue[],
  index: number,
  level: number,
): boolean {
  if (index < 1) return false;
  const prev = series[index - 1];
  const cur = series[index];
  if (prev === undefined || cur === undefined) return false;
  return prev.value < level && cur.value >= level;
}

export function crossedDownThrough(
  series: readonly IndicatorValue[],
  index: number,
  level: number,
): boolean {
  if (index < 1) return false;
  const prev = series[index - 1];
  const cur = series[index];
  if (prev === undefined || cur === undefined) return false;
  return prev.value > level && cur.value <= level;
}

/**
 * §7.1 — was RSI overbought within the last N candles?
 *
 * We are buying a dip from a pump, not a token in permanent decline. The window
 * looks strictly BEFORE the current bar: the pump must precede the dip.
 */
export function wasOverboughtWithin(
  series: readonly IndicatorValue[],
  index: number,
  withinCandles: number,
  overbought: number,
): boolean {
  const start = Math.max(0, index - withinCandles);
  for (let i = start; i < index; i++) {
    const v = series[i];
    if (v !== undefined && v.value > overbought) return true;
  }
  return false;
}

/**
 * §7.4 — bullish divergence: price makes a lower low while RSI makes a higher
 * low. Optional; when the config flag is set it becomes a REQUIRED condition.
 *
 * Implementation is deliberately simple and explainable: compare the lowest
 * close (and the RSI at that bar) in the recent half of the lookback window
 * against the older half. A more sophisticated pivot-detection scheme would be
 * harder to test and to reason about when it misfires.
 */
export function hasBullishDivergence(
  candles: readonly Candle[],
  rsi: readonly IndicatorValue[],
  index: number,
  lookback: number,
): boolean {
  const half = Math.floor(lookback / 2);
  if (half < 2 || index - lookback + 1 < 0) return false;

  const lowestIn = (from: number, to: number): { price: number; rsi: number } | null => {
    let bestPrice = Infinity;
    let bestRsi = Number.NaN;
    for (let i = from; i <= to; i++) {
      const c = candles[i];
      const r = rsi[i];
      if (c === undefined || r === undefined) continue;
      if (c.low < bestPrice) {
        bestPrice = c.low;
        bestRsi = r.value;
      }
    }
    return Number.isFinite(bestPrice) ? { price: bestPrice, rsi: bestRsi } : null;
  };

  const older = lowestIn(index - lookback + 1, index - half);
  const recent = lowestIn(index - half + 1, index);
  if (older === null || recent === null) return false;

  return recent.price < older.price && recent.rsi > older.rsi;
}
