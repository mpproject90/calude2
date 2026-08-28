/**
 * Candle validation (spec §4). Every candle is checked before it reaches the
 * cache; anything that fails is rejected and logged, never silently repaired.
 * A bad candle that slips through produces a wrong indicator value, which is a
 * silent and expensive class of bug.
 */
import { INTERVAL_MS, type Candle, type Interval } from '../types/index.js';

export type RejectionReason =
  | 'non-finite-value'
  | 'high-below-open-or-close'
  | 'low-above-open-or-close'
  | 'high-below-low'
  | 'negative-volume'
  | 'negative-price'
  | 'timestamp-not-integer'
  | 'timestamp-misaligned';

export interface ValidCandle { readonly ok: true; readonly candle: Candle }
export interface InvalidCandle {
  readonly ok: false;
  readonly reason: RejectionReason;
  readonly detail: string;
  readonly raw: unknown;
}
export type ValidationResult = ValidCandle | InvalidCandle;

const reject = (reason: RejectionReason, detail: string, raw: unknown): InvalidCandle =>
  ({ ok: false, reason, detail, raw });

export function validateCandle(candle: Candle, interval: Interval): ValidationResult {
  const { timestamp, open, high, low, close, volume } = candle;

  for (const [name, v] of Object.entries({ timestamp, open, high, low, close, volume })) {
    if (!Number.isFinite(v)) {
      return reject('non-finite-value', `${name} is ${String(v)}`, candle);
    }
  }
  if (!Number.isInteger(timestamp)) {
    return reject('timestamp-not-integer', `timestamp ${timestamp} is not an integer`, candle);
  }
  // Bars must sit on interval boundaries, or gap detection and cache keys break.
  if (timestamp % INTERVAL_MS[interval] !== 0) {
    return reject('timestamp-misaligned',
      `timestamp ${timestamp} is not aligned to the ${interval} boundary`, candle);
  }
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    return reject('negative-price', 'a price is zero or negative', candle);
  }
  if (volume < 0) {
    return reject('negative-volume', `volume ${volume} is negative`, candle);
  }
  if (high < low) {
    return reject('high-below-low', `high ${high} < low ${low}`, candle);
  }
  if (high < Math.max(open, close)) {
    return reject('high-below-open-or-close',
      `high ${high} < max(open ${open}, close ${close})`, candle);
  }
  if (low > Math.min(open, close)) {
    return reject('low-above-open-or-close',
      `low ${low} > min(open ${open}, close ${close})`, candle);
  }
  return { ok: true, candle };
}

export interface ValidationSummary {
  readonly valid: Candle[];
  readonly rejected: InvalidCandle[];
}

export function validateCandles(
  candles: readonly Candle[],
  interval: Interval,
): ValidationSummary {
  const valid: Candle[] = [];
  const rejected: InvalidCandle[] = [];
  for (const c of candles) {
    const r = validateCandle(c, interval);
    if (r.ok) valid.push(r.candle);
    else rejected.push(r);
  }
  return { valid, rejected };
}
