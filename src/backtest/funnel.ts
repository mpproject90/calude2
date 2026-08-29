/**
 * Entry-condition funnel (DECISIONS §32) — how many bars clear each entry
 * condition in order, without running a backtest. Built after the operator
 * asked for the exact same reasoning `runBacktest` already does for entries
 * (`rules/conditions.js`, `filters/relativeStrength.js`, `filters/regime.js`)
 * to be exposed as a standalone measurement, so `data:screen` can report
 * which tokens are even worth a full fetch before committing to one.
 *
 * No duplicated logic: this calls the exact same primitives the engine uses,
 * in the exact same order (`indicators-reliable` → `prior-overbought` →
 * `rsi-cross-up` → `mfi-confirmation` → `relative-strength` → `regime`) —
 * spec §7, DECISIONS §20/§27.
 */
import type { Candle, Interval } from '../types/index.js';
import type { GlobalConfig, TokenConfig } from '../config/schema.js';
import { computeRsi } from '../indicators/rsi.js';
import { computeMfi } from '../indicators/mfi.js';
import { crossedUpThrough, wasOverboughtWithin } from '../rules/conditions.js';
import { evaluateRelativeStrength } from '../filters/relativeStrength.js';
import { evaluateRegime } from '../filters/regime.js';
import { aggregateCandles } from '../data/aggregate.js';
import { regimeBucketIndices } from './regimeAlignment.js';
import { INTERVAL_MS } from '../types/index.js';
import { detectSeriesIssues } from '../data/gaps.js';

export interface FunnelCounts {
  readonly reliable: number;
  readonly priorOverbought: number;
  readonly rsiCrossUp: number;
  readonly mfiConfirms: number;
  readonly relativeStrengthPasses: number;
  readonly regimePasses: number;
}

export interface CrossUpEvent {
  readonly index: number;
  readonly timestamp: number;
  readonly mfiConfirms: boolean;
  /** null when the SOL reference or lookback window was unavailable at this bar. */
  readonly tokenReturn: number | null;
  readonly solReturn: number | null;
  readonly differential: number | null;
  readonly relativeStrengthPasses: boolean | null;
}

export interface FunnelResult {
  readonly bars: number;
  readonly gaps: number;
  readonly counts: FunnelCounts;
  /** Every bar that reached RSI-cross-up (after clearing prior-overbought) — the funnel's thin point. */
  readonly crossUpEvents: readonly CrossUpEvent[];
  readonly longestReliableStretch: number;
}

/**
 * `candles` is the token's own SOL-quoted pool series; `solCandles` is the
 * independent SOL/USD(C) reference (DECISIONS §20) — MUST be a genuinely
 * different asset from `candles`' token, or relative-strength's differential
 * is exactly 0 on every bar by construction (self-comparison), which would
 * look like a real "always fails" finding but is a tautology, not data. This
 * function does not guard against that call shape — the caller (a token
 * screened against SOL) must not pass SOL as both arguments.
 */
export function computeEntryFunnel(
  candles: readonly Candle[], solCandles: readonly Candle[], token: TokenConfig, global: GlobalConfig,
): FunnelResult {
  const interval: Interval = token.timeframe;
  const gaps = detectSeriesIssues(candles, interval).gaps;
  const rsi = computeRsi(candles, { period: token.rsi.period, warmupMultiplier: global.indicatorWarmupMultiplier, gaps });
  const mfi = computeMfi(candles, { period: token.mfi.period, warmupMultiplier: global.indicatorWarmupMultiplier, gaps });

  const solCloseByTs = new Map<number, number>();
  for (const c of solCandles) solCloseByTs.set(c.timestamp, c.close);
  const alignedSol: (number | null)[] = candles.map((c) => solCloseByTs.get(c.timestamp) ?? null);

  const regimeTimeframe = global.regimeFilter.solMaTimeframe;
  const aggregatedSol = aggregateCandles(solCandles, interval, regimeTimeframe);
  const aggregatedSolCloses = aggregatedSol.map((c) => c.close);
  const bucketIdx = regimeBucketIndices(candles, aggregatedSol, INTERVAL_MS[regimeTimeframe]);

  const lookback = token.entry.relativeStrengthLookback;
  const minUnderperf = token.entry.minUnderperformanceVsSol;

  let reliable = 0, priorOverbought = 0, rsiCrossUp = 0, mfiConfirms = 0, relativeStrengthPasses = 0, regimePasses = 0;
  const crossUpEvents: CrossUpEvent[] = [];

  let reliableStreak = 0, longestReliableStretch = 0;

  for (let i = 1; i < candles.length; i++) {
    const bothReliable = rsi[i]!.reliable && mfi[i]!.reliable;
    if (bothReliable) { reliableStreak++; longestReliableStretch = Math.max(longestReliableStretch, reliableStreak); }
    else reliableStreak = 0;
    if (!bothReliable) continue;
    reliable++;

    if (!wasOverboughtWithin(rsi, i, token.entry.priorOverboughtWithinCandles, token.rsi.overbought)) continue;
    priorOverbought++;

    if (!crossedUpThrough(rsi, i, token.rsi.oversold)) continue;
    rsiCrossUp++;

    const confirms = mfi[i]!.value < token.mfi.threshold;
    if (confirms) mfiConfirms++;

    // Relative strength, computed for EVERY cross-up (not gated on MFI) so
    // the distribution has more than the rare fully-confirmed bar to show —
    // same derivation runBacktest uses (DECISIONS §27): tokenCloses is a
    // derived JUP/USD-equivalent close so tokenReturn/solReturn stay real for
    // logging, and the differential reduces exactly to the token/SOL series'
    // own ratio return regardless of SOL's absolute price.
    let tokenReturn: number | null = null, solReturn: number | null = null, differential: number | null = null;
    let rsPass: boolean | null = null;
    if (i >= lookback) {
      const solThen = alignedSol[i - lookback];
      const solNow = alignedSol[i];
      if (solThen !== null && solThen !== undefined && solNow !== null && solNow !== undefined && solThen > 0) {
        const tokenThen = candles[i - lookback]!.close * solThen;
        const tokenNow = candles[i]!.close * solNow;
        const tokenCloses = new Array(lookback + 1).fill(tokenThen) as number[];
        tokenCloses[lookback] = tokenNow;
        const solCloses = new Array(lookback + 1).fill(solThen) as number[];
        solCloses[lookback] = solNow;
        const rs = evaluateRelativeStrength({ tokenCloses, solCloses, lookback, minUnderperformanceVsSol: minUnderperf });
        tokenReturn = rs.context['tokenReturn'] as number;
        solReturn = rs.context['solReturn'] as number;
        differential = rs.context['differential'] as number;
        rsPass = rs.pass;
      }
    }
    crossUpEvents.push({ index: i, timestamp: candles[i]!.timestamp, mfiConfirms: confirms, tokenReturn, solReturn, differential, relativeStrengthPasses: rsPass });

    // Strict sequential funnel count — matches entry.ts's real check order.
    if (!confirms) continue;
    if (rsPass !== true) continue;
    relativeStrengthPasses++;

    const bIdx = bucketIdx[i] ?? null;
    const regimeCloses = bIdx === null ? [] : aggregatedSolCloses.slice(0, bIdx + 1);
    const regimeResult = evaluateRegime({ enabled: global.regimeFilter.enabled, solCloses: regimeCloses, maPeriod: global.regimeFilter.solMaPeriod });
    if (!regimeResult.pass) continue;
    regimePasses++;
  }

  return {
    bars: candles.length, gaps: gaps.length,
    counts: { reliable, priorOverbought, rsiCrossUp, mfiConfirms, relativeStrengthPasses, regimePasses },
    crossUpEvents, longestReliableStretch,
  };
}
