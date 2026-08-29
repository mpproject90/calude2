/**
 * SOL-relative strength filter (spec §6.2).
 *
 * Solana alts run heavily correlated with SOL. When SOL dumps, everything hits
 * RSI < 30 at once and a naive bot opens N positions that are one leveraged bet
 * on SOL. Entry therefore requires the token to be oversold RELATIVE to SOL.
 *
 * Rule: (1 + tokenReturn) / (1 + solReturn) - 1 <= -minUnderperformanceVsSol
 * (decimal fraction; 0.05 = 5 percentage points of underperformance)
 *
 * FORMULA CHANGED (DECISIONS §20). Originally `tokenReturn - solReturn`, a
 * subtractive approximation. Now pulling the JUP/SOL pool directly (DECISIONS
 * §18) makes the exact figure available for free: the pool's own return over
 * the lookback window IS (1+tokenReturn)/(1+solReturn) - 1 by construction, so
 * there is no reason to keep the approximation now that the exact multiplicative
 * relative-return is no harder to compute. The two formulas agree exactly
 * whenever solReturn = 0 and diverge more as SOL's own move grows.
 *
 * SOL/USD is still fetched as an independent reference series — NOT made
 * redundant by trading on JUP/SOL directly (DECISIONS §20) — because
 * `regime.ts` needs SOL's own USD-denominated trend regardless of any token,
 * and because token/SOL returns are still logged separately below for the
 * deferred beta work (next paragraph).
 *
 * KNOWN LIMITATION — beta is ignored. A token that habitually moves ~1.4x SOL
 * will show percentage-point "underperformance" on any SOL drawdown purely from
 * its higher beta, so this filter will pass it for the wrong reason. The simple
 * version is deliberate: it is transparent and testable. Token and SOL returns
 * are reported separately on every evaluation so beta can be estimated from
 * backtest data and this revisited if discrimination proves poor.
 */
import { fail, pass, type FilterResult } from './types.js';

export interface RelativeStrengthInput {
  readonly tokenCloses: readonly number[];
  readonly solCloses: readonly number[];
  readonly lookback: number;
  readonly minUnderperformanceVsSol: number;
}

export function evaluateRelativeStrength(input: RelativeStrengthInput): FilterResult {
  const { tokenCloses, solCloses, lookback, minUnderperformanceVsSol } = input;

  // Fail closed on missing data (spec §1) — never assume a dislocation.
  if (tokenCloses.length <= lookback || solCloses.length <= lookback) {
    return fail('relative-strength', 'insufficient history for the lookback window', {
      tokenCandles: tokenCloses.length,
      solCandles: solCloses.length,
      lookback,
    });
  }

  const tokenNow = tokenCloses[tokenCloses.length - 1]!;
  const tokenThen = tokenCloses[tokenCloses.length - 1 - lookback]!;
  const solNow = solCloses[solCloses.length - 1]!;
  const solThen = solCloses[solCloses.length - 1 - lookback]!;

  if (tokenThen <= 0 || solThen <= 0) {
    return fail('relative-strength', 'non-positive reference price', { tokenThen, solThen });
  }

  const tokenReturn = tokenNow / tokenThen - 1;
  const solReturn = solNow / solThen - 1;
  // Exact multiplicative relative return, not the subtractive approximation —
  // see the header comment and DECISIONS §20.
  const differential = (tokenNow / tokenThen) / (solNow / solThen) - 1;

  const context = {
    tokenReturn,
    solReturn,
    differential,
    required: -minUnderperformanceVsSol,
    lookback,
  };

  if (differential <= -minUnderperformanceVsSol) {
    return pass('relative-strength', 'token is oversold relative to SOL', context);
  }
  return fail(
    'relative-strength',
    `underperformance ${(differential * 100).toFixed(2)}pp does not reach ` +
      `${(minUnderperformanceVsSol * 100).toFixed(2)}pp — correlation, not dislocation`,
    context,
  );
}
