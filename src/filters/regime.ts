/**
 * Regime filter (spec §6.5). A global gate that blocks NEW entries when
 * conditions are hostile. Open positions continue to be managed normally — this
 * filter never forces an exit.
 *
 * Deliberately simple to start: SOL's own price versus its N-period moving
 * average on a higher timeframe. Every state change is logged, and the
 * backtest counts entries it blocked, so its contribution is measurable rather
 * than assumed.
 */
import { fail, pass, type FilterResult } from './types.js';

export interface RegimeInput {
  readonly enabled: boolean;
  readonly solCloses: readonly number[];
  readonly maPeriod: number;
}

export function simpleMovingAverage(values: readonly number[], period: number): number | null {
  if (period < 1 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!;
  return sum / period;
}

export function evaluateRegime(input: RegimeInput): FilterResult {
  const { enabled, solCloses, maPeriod } = input;

  if (!enabled) {
    return pass('regime', 'regime filter disabled', { enabled: false });
  }

  const ma = simpleMovingAverage(solCloses, maPeriod);
  if (ma === null) {
    // Fail closed: not enough history to judge the regime means no new entries.
    return fail('regime', 'insufficient SOL history to establish the regime', {
      solCandles: solCloses.length,
      maPeriod,
    });
  }

  const solPrice = solCloses[solCloses.length - 1]!;
  const context = { solPrice, ma, maPeriod, deviationPct: (solPrice / ma - 1) * 100 };

  return solPrice > ma
    ? pass('regime', 'SOL is above its moving average — entries allowed', context)
    : fail('regime', 'SOL is below its moving average — new entries blocked', context);
}
