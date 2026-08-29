/**
 * Backtest engine (spec §10, phase 1 step 6). Replays historical candles
 * through the EXACT SAME indicator, filter and rules code the live bot uses
 * — every call below is to the same functions `test/rules.test.ts` and
 * `test/filters.test.ts` already verify against synthetic series. No
 * duplicated strategy logic here; this module only sequences those calls
 * bar by bar and does the bookkeeping (fills, costs, P&L, trade records).
 *
 * FILLS: a signal evaluated on bar i's CLOSE fills at bar i+1's OPEN, never
 * at the signal bar's own close — look-ahead bias is the most common way a
 * backtest lies (spec §10). Stops/trailing are already intrabar in exit.ts;
 * this engine does not re-implement that, it just calls evaluateExit.
 *
 * WHAT THIS BACKTEST CANNOT EVALUATE, AND WHY (both documented, not silently
 * skipped — DECISIONS §27):
 *
 *   - `tier-gates` (spec §6.1) is a WATCHLIST gate — is this token even
 *     liquid/aged enough to trade — not a per-bar signal. It is not called
 *     here; the operator manually configuring a token as `tier: A` already
 *     represents that decision, same as rules.test.ts's convention (its
 *     example filter sets never include tier-gates either).
 *   - Historical POOL LIQUIDITY does not exist from the free data source
 *     used (DECISIONS §19). `positionSize.ts`'s §6.4 cap fails closed
 *     without it by design — correct for live/paper, but would zero out
 *     every trade in a backtest and silently look like "the strategy never
 *     found a signal" rather than "we don't have this number." Pass
 *     `poolLiquiditySol` as a CONSTANT snapshot (e.g. the pool's current
 *     `reserveUsd` converted to SOL) to evaluate the cap approximately, or
 *     `null` to skip it — in which case every bar's position-size check is
 *     replaced with an explicit PASS carrying that reason, so it shows up in
 *     the report rather than vanishing. cost-floor's slippage estimate
 *     already has a graceful fallback for `poolLiquiditySol: null`
 *     (`fallbackSlippagePct`) and needs no special-casing here.
 */
import type { Candle, CandleGap, Interval } from '../types/index.js';
import { INTERVAL_MS } from '../types/index.js';
import type { GlobalConfig, TokenConfig } from '../config/schema.js';
import { computeRsi } from '../indicators/rsi.js';
import { computeMfi } from '../indicators/mfi.js';
import { computeAtr, expectedMoveFromAtr } from '../indicators/atr.js';
import { evaluateEntry, type ConditionResult } from '../rules/entry.js';
import {
  evaluateExit, stopLossPriceFor, type ExitReason, type OpenPosition,
} from '../rules/exit.js';
import { checkPortfolioLimits, type ClosedTrade } from '../rules/portfolio.js';
import { evaluateRelativeStrength } from '../filters/relativeStrength.js';
import { evaluateCostFloor, estimateRoundTripCost, type CostBreakdown } from '../filters/costFloor.js';
import { evaluatePositionSize } from '../filters/positionSize.js';
import { evaluateRegime } from '../filters/regime.js';
import { pass, type FilterResult } from '../filters/types.js';
import { TokenAmount, SOL_DECIMALS } from '../util/amount.js';
import { aggregateCandles } from '../data/aggregate.js';
import { regimeBucketIndices } from './regimeAlignment.js';

export type BacktestExitReason = ExitReason | 'end_of_data';

export interface ClosedBacktestTrade {
  readonly entryIndex: number;
  readonly entryTimestamp: number;
  readonly entryPrice: number;
  readonly exitIndex: number;
  readonly exitTimestamp: number;
  readonly exitPrice: number;
  readonly exitReason: BacktestExitReason;
  readonly barsHeld: number;
  readonly sizeSol: TokenAmount;
  readonly grossPnlSol: TokenAmount;
  readonly costsSol: TokenAmount;
  readonly netPnlSol: TokenAmount;
  /** (peak price reached while held / entry price - 1) * 100 — DECISIONS §4. */
  readonly mfePct: number;
  readonly costBreakdown: CostBreakdown;
  readonly entryChecks: readonly ConditionResult[];
}

export interface RejectedSignal {
  readonly index: number;
  readonly timestamp: number;
  /** The FIRST failing check's name — same convention as `rejected_signals.filter` in schema.sql. */
  readonly blockedBy: string;
}

export interface BacktestInput {
  readonly token: TokenConfig;
  readonly global: GlobalConfig;
  /** The traded series (already SOL-quoted — a GeckoTerminal pool series or a Binance synthesis). */
  readonly candles: readonly Candle[];
  /** SOL/USD(C) reference series, same interval as `candles` — DECISIONS §20. */
  readonly solCandles: readonly Candle[];
  readonly gaps: readonly CandleGap[];
  readonly startingBalanceSol: TokenAmount;
  /** Constant liquidity snapshot in SOL, or null to skip the §6.4 cap — see header comment. */
  readonly poolLiquiditySol: number | null;
}

export interface BacktestResult {
  readonly trades: readonly ClosedBacktestTrade[];
  readonly rejectedSignals: readonly RejectedSignal[];
  /** Bars where the engine was flat and looking for a signal. */
  readonly entryEvaluations: number;
  /** Of those, how many were blocked specifically because RSI/MFI were not `reliable`. */
  readonly indicatorUnreliableBlocks: number;
  /**
   * Of `indicatorUnreliableBlocks`, split by WHY — this can differ hugely from
   * the naive "period * warmupMultiplier" expectation. Priority when a bar's
   * RSI and MFI disagree on reason: `gap-in-series` is reported over
   * `insufficient-warmup`, since it is the more specific, actionable finding
   * (a gap invalidates a full trailing warm-up window behind it, not one bar
   * — indicators/core.ts). A dense gap series can make this dwarf plain
   * warm-up as the dominant cause; see DECISIONS §27.
   */
  readonly indicatorUnreliableByReason: Readonly<Record<string, number>>;
  readonly startingBalanceSol: TokenAmount;
  readonly endingBalanceSol: TokenAmount;
  readonly poolLiquiditySolUsed: number | null;
}

function solFromNumber(n: number): TokenAmount {
  const safe = Number.isFinite(n) ? n : 0;
  return TokenAmount.fromDecimalString(safe.toFixed(SOL_DECIMALS), SOL_DECIMALS);
}

interface PendingEntry {
  readonly checks: readonly ConditionResult[];
  readonly sizeSol: TokenAmount;
}

interface OpenBacktestPosition {
  readonly rulesPosition: OpenPosition;
  readonly sizeSol: TokenAmount;
  readonly costBreakdown: CostBreakdown;
  readonly entryTimestamp: number;
  readonly entryChecks: readonly ConditionResult[];
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const { token, global, candles, solCandles, gaps, startingBalanceSol, poolLiquiditySol } = input;

  const rsi = computeRsi(candles, { period: token.rsi.period, warmupMultiplier: global.indicatorWarmupMultiplier, gaps });
  const mfi = computeMfi(candles, { period: token.mfi.period, warmupMultiplier: global.indicatorWarmupMultiplier, gaps });
  const atr = computeAtr(candles, { period: token.expectedMove.atrPeriod, warmupMultiplier: global.indicatorWarmupMultiplier, gaps });

  // SOL/USD closes at the SAME timestamp as each token bar — used to derive an
  // exact JUP/USD-equivalent close (candles.close * solClose) so the relative-
  // strength filter can log real tokenReturn/solReturn (DECISIONS §20), not a
  // placeholder. A missing timestamp (the two series can have different gaps)
  // fails that bar closed via the filter's own "insufficient history" path,
  // triggered by passing it an array shorter than its lookback below.
  const solCloseByTimestamp = new Map<number, number>();
  for (const c of solCandles) solCloseByTimestamp.set(c.timestamp, c.close);
  const alignedSolCloses: (number | null)[] = candles.map((c) => solCloseByTimestamp.get(c.timestamp) ?? null);

  function relStrengthCloses(i: number, lookback: number): { tokenCloses: number[]; solCloses: number[] } {
    if (i < lookback) return { tokenCloses: [], solCloses: [] };
    const solThen = alignedSolCloses[i - lookback];
    const solNow = alignedSolCloses[i];
    if (solThen === null || solNow === null || solThen === undefined || solNow === undefined || solThen <= 0) {
      return { tokenCloses: [], solCloses: [] };
    }
    const tokenThen = candles[i - lookback]!.close * solThen;
    const tokenNow = candles[i]!.close * solNow;
    const tokenCloses = new Array(lookback + 1).fill(tokenThen) as number[];
    tokenCloses[lookback] = tokenNow;
    const solClosesArr = new Array(lookback + 1).fill(solThen) as number[];
    solClosesArr[lookback] = solNow;
    return { tokenCloses, solCloses: solClosesArr };
  }

  // Regime: SOL's own trend on a HIGHER timeframe (spec §6.5), aggregated from
  // the SOL reference series (not the token series — see DECISIONS §25/§27).
  const regimeTimeframe: Interval = global.regimeFilter.solMaTimeframe;
  const aggregatedSol = aggregateCandles(solCandles, token.timeframe, regimeTimeframe);
  const aggregatedSolCloses = aggregatedSol.map((c) => c.close);
  const bucketIdx = regimeBucketIndices(candles, aggregatedSol, INTERVAL_MS[regimeTimeframe]);

  const requestedSol = TokenAmount.fromDecimalString(token.buyAmountSol, SOL_DECIMALS);
  const minViableSol = TokenAmount.fromDecimalString(token.limits.minViableBuyAmountSol, SOL_DECIMALS);
  const priorityFeeSol = Number(global.costFloor.priorityFeeSol);
  const jitoTipSol = Number(global.costFloor.jitoTipSol);

  let balance = startingBalanceSol;
  let position: OpenBacktestPosition | null = null;
  let pendingEntry: PendingEntry | null = null;
  const trades: ClosedBacktestTrade[] = [];
  const rejectedSignals: RejectedSignal[] = [];
  let entryEvaluations = 0;
  let indicatorUnreliableBlocks = 0;
  const indicatorUnreliableByReason: Record<string, number> = {};

  const recentClosedForPortfolio = (): ClosedTrade[] =>
    trades.map((t) => ({ token: token.symbol, closedAt: t.exitTimestamp, closedIndex: t.exitIndex, realizedPnlSol: t.netPnlSol }));

  function closeTrade(exitIndex: number, exitTimestamp: number, exitPrice: number, exitReason: BacktestExitReason, peakPrice: number): void {
    if (position === null) return;
    const grossPnlSol = solFromNumber(position.sizeSol.toNumberUnsafe() * (exitPrice / position.rulesPosition.entryPrice - 1));
    const costsSol = solFromNumber(position.sizeSol.toNumberUnsafe() * (position.costBreakdown.roundTripPct / 100));
    const netPnlSol = grossPnlSol.sub(costsSol);
    balance = balance.add(netPnlSol);
    trades.push({
      entryIndex: position.rulesPosition.entryIndex, entryTimestamp: position.entryTimestamp,
      entryPrice: position.rulesPosition.entryPrice,
      exitIndex, exitTimestamp, exitPrice, exitReason,
      barsHeld: exitIndex - position.rulesPosition.entryIndex,
      sizeSol: position.sizeSol, grossPnlSol, costsSol, netPnlSol,
      mfePct: (peakPrice / position.rulesPosition.entryPrice - 1) * 100,
      costBreakdown: position.costBreakdown, entryChecks: position.entryChecks,
    });
    position = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;

    // 1. Fill a pending entry at THIS bar's OPEN — the signal was evaluated on
    //    the PREVIOUS bar's close. Sizing was already decided at signal time.
    if (pendingEntry !== null && position === null) {
      const entryPrice = candle.open;
      const costBreakdown = estimateRoundTripCost({
        // expectedMove/minTargetToCostRatio are part of CostFloorInput but not
        // read by estimateRoundTripCost itself (only by evaluateCostFloor's
        // pass/fail decision) — placeholders, unused here.
        expectedMove: { value: 0, reliable: true }, minTargetToCostRatio: global.costFloor.minTargetToCostRatio,
        positionValueSol: pendingEntry.sizeSol.toNumberUnsafe(),
        poolLiquiditySol,
        dexFeePct: global.costFloor.dexFeePct,
        priorityFeeSol, jitoTipSol,
        fallbackSlippagePct: global.costFloor.fallbackSlippagePct,
      });
      position = {
        rulesPosition: {
          entryPrice, entryIndex: i, peakPrice: entryPrice, trailingArmed: false,
          stopLossPrice: stopLossPriceFor(entryPrice, token.exit.stopLossPct),
        },
        sizeSol: pendingEntry.sizeSol, costBreakdown,
        entryTimestamp: candle.timestamp, entryChecks: pendingEntry.checks,
      };
      pendingEntry = null;
    }

    // 2. Evaluate exit for an already-open position — never the same bar it filled on.
    if (position !== null && i > position.rulesPosition.entryIndex) {
      const exitDecision = evaluateExit({
        candles, index: i, rsi, token, position: position.rulesPosition,
        exitSlippagePct: global.exitSlippagePct,
      });
      if (exitDecision.exit && exitDecision.fillPrice !== null && exitDecision.reason !== null) {
        closeTrade(i, candle.timestamp, exitDecision.fillPrice, exitDecision.reason, exitDecision.nextPosition.peakPrice);
      } else {
        position = { ...position, rulesPosition: exitDecision.nextPosition };
      }
    }

    // 3. Look for a new signal only while flat and nothing already pending.
    if (position === null && pendingEntry === null) {
      entryEvaluations++;

      const expectedMove = expectedMoveFromAtr(atr[i]!, candle.close, token.expectedMove.atrMultiplier);
      const { tokenCloses, solCloses } = relStrengthCloses(i, token.entry.relativeStrengthLookback);
      const relStrength = evaluateRelativeStrength({
        tokenCloses, solCloses, lookback: token.entry.relativeStrengthLookback,
        minUnderperformanceVsSol: token.entry.minUnderperformanceVsSol,
      });
      const costFloor = evaluateCostFloor({
        expectedMove, positionValueSol: requestedSol.toNumberUnsafe(), poolLiquiditySol,
        dexFeePct: global.costFloor.dexFeePct, priorityFeeSol, jitoTipSol,
        minTargetToCostRatio: global.costFloor.minTargetToCostRatio,
        fallbackSlippagePct: global.costFloor.fallbackSlippagePct,
      });
      const positionSizeFilter: FilterResult & { sizeSol: TokenAmount | null } = poolLiquiditySol === null
        ? { ...pass('position-size', 'not evaluated — no pool liquidity supplied for this backtest run'), sizeSol: requestedSol }
        : evaluatePositionSize({
            requestedSol, poolLiquiditySol,
            maxPctOfPoolLiquidity: token.limits.maxPctOfPoolLiquidity, minViableSol,
          });
      const bIdx = bucketIdx[i] ?? null;
      const regimeCloses = bIdx === null ? [] : aggregatedSolCloses.slice(0, bIdx + 1);
      const regimeResult = evaluateRegime({
        enabled: global.regimeFilter.enabled, solCloses: regimeCloses, maPeriod: global.regimeFilter.solMaPeriod,
      });
      const portfolioResults = checkPortfolioLimits({
        state: { openPositions: [], walletBalanceSol: balance, recentClosed: recentClosedForPortfolio() },
        limits: {
          maxConcurrentPositions: global.maxConcurrentPositions,
          dailyLossLimitPct: global.dailyLossLimitPct,
          maxDeployedCapitalPct: global.maxDeployedCapitalPct,
          maxAllocationPerTokenPct: global.maxAllocationPerTokenPct,
          cooldownCandlesAfterLoss: token.limits.cooldownCandlesAfterLoss,
        },
        token: token.symbol, proposedSizeSol: requestedSol, nowMs: candle.timestamp, currentIndex: i,
      });

      const filters: FilterResult[] = [relStrength, costFloor, positionSizeFilter, regimeResult, ...portfolioResults];
      const entryDecision = evaluateEntry({ candles, index: i, rsi, mfi, token, filters });

      if (entryDecision.enter) {
        pendingEntry = { checks: entryDecision.checks, sizeSol: positionSizeFilter.sizeSol ?? requestedSol };
      } else if (entryDecision.blockedBy !== null) {
        rejectedSignals.push({ index: i, timestamp: candle.timestamp, blockedBy: entryDecision.blockedBy.name });
        if (entryDecision.blockedBy.name === 'indicators-reliable') {
          indicatorUnreliableBlocks++;
          const rsiReason = rsi[i]!.reason;
          const mfiReason = mfi[i]!.reason;
          const reason = rsiReason === 'gap-in-series' || mfiReason === 'gap-in-series'
            ? 'gap-in-series'
            : (rsiReason ?? mfiReason ?? 'unknown');
          indicatorUnreliableByReason[reason] = (indicatorUnreliableByReason[reason] ?? 0) + 1;
        }
      }
    }
  }

  // A position still open when the data runs out is force-closed at the last
  // close so the books balance — reported with its own reason, never counted
  // among the real exit triggers (spec §10's breakdown is stop/time/RSI/trailing).
  if (position !== null) {
    const last = candles[candles.length - 1]!;
    const p: OpenBacktestPosition = position;
    closeTrade(candles.length - 1, last.timestamp, last.close, 'end_of_data', p.rulesPosition.peakPrice);
  }

  return {
    trades, rejectedSignals, entryEvaluations, indicatorUnreliableBlocks, indicatorUnreliableByReason,
    startingBalanceSol, endingBalanceSol: balance, poolLiquiditySolUsed: poolLiquiditySol,
  };
}
