/**
 * Money Flow Index — a volume-weighted RSI analogue.
 *
 * Unlike RSI, MFI uses a simple rolling sum over the period rather than Wilder
 * smoothing, so it converges immediately. It still respects the same warm-up
 * gate: the rules engine treats RSI and MFI as one signal, and mixing a warm
 * indicator with a cold one would let an untrustworthy RSI ride in on a
 * trustworthy MFI.
 *
 * NOTE ON SYNTHESIZED SERIES: MFI is built on typical price (H+L+C)/3. On a
 * ratio series (e.g. JUP/SOL derived from two USDT series) the high and low are
 * approximations, so MFI there is approximate too — see data/synthesize.ts.
 * Callers on synthesized series must treat MFI as confirmation only, which is
 * the role spec §7.3 already assigns it.
 */
import type { Candle, IndicatorValue } from '../types/index.js';
import { assertValidPeriod, buildReliabilityMask, reliable, unreliable, type IndicatorOptions } from './core.js';

export const MFI_FLAT = 50;

export function typicalPrice(c: Candle): number {
  return (c.high + c.low + c.close) / 3;
}

export function computeMfi(
  candles: readonly Candle[],
  opts: IndicatorOptions,
): IndicatorValue[] {
  const { period } = opts;
  assertValidPeriod(period, candles.length);

  const mask = buildReliabilityMask(candles, opts);
  const out: IndicatorValue[] = new Array(candles.length);
  if (candles.length === 0) return out;

  const tp = candles.map(typicalPrice);
  const posFlow: number[] = [0];
  const negFlow: number[] = [0];

  for (let i = 1; i < candles.length; i++) {
    const rawFlow = tp[i]! * candles[i]!.volume;
    const prev = tp[i - 1]!;
    // An unchanged typical price contributes to neither side, per the definition.
    posFlow.push(tp[i]! > prev ? rawFlow : 0);
    negFlow.push(tp[i]! < prev ? rawFlow : 0);
  }

  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      out[i] = unreliable(MFI_FLAT, 'insufficient-warmup');
      continue;
    }

    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      pos += posFlow[j]!;
      neg += negFlow[j]!;
    }

    let value: number;
    if (pos === 0 && neg === 0) {
      value = MFI_FLAT;                 // no flow either way
    } else if (neg === 0) {
      value = 100;
    } else if (pos === 0) {
      value = 0;
    } else {
      value = 100 - 100 / (1 + pos / neg);
    }

    if (!Number.isFinite(value)) {
      out[i] = unreliable(MFI_FLAT, 'invalid-input');
      continue;
    }

    const reason = mask[i] ?? null;
    out[i] = reason === null ? reliable(value) : unreliable(value, reason);
  }

  return out;
}
