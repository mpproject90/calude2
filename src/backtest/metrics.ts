/**
 * Summary statistics from a completed backtest run (spec §10's "Output
 * metrics" list). Pure functions over `ClosedBacktestTrade[]` — no I/O, no
 * knowledge of how the trades were produced, so these are testable against
 * hand-built trade lists independent of the engine itself.
 */
import type { ClosedBacktestTrade } from './engine.js';

export interface ExitTriggerStat {
  readonly reason: string;
  readonly count: number;
  readonly avgNetPnlSol: number;
}

export interface MfeDistribution {
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly max: number;
}

export interface CostSummary {
  readonly totalCostsSol: number;
  readonly totalGrossPnlSol: number;
  /** Total costs as a percentage of total ABSOLUTE gross P&L — a "cost drag" figure. */
  readonly costsAsPctOfGrossAbs: number;
}

export interface SampleMetrics {
  readonly tradeCount: number;
  readonly winRate: number;
  readonly avgWinSol: number;
  readonly avgLossSol: number;
  /** sum(wins) / sum(|losses|). Infinity if there are wins and no losses; 0 if no wins. */
  readonly profitFactor: number;
  /** (winRate * avgWin) - (lossRate * avgLoss), per spec §10 the HEADLINE number, not win rate. */
  readonly expectancySol: number;
  readonly maxDrawdownSol: number;
  readonly longestLosingStreak: number;
  readonly exitTriggerBreakdown: readonly ExitTriggerStat[];
  readonly mfeDistributionPct: MfeDistribution;
  readonly costs: CostSummary;
  /** spec §10: fewer than the configured minimum is not conclusive. */
  readonly belowMinimumSampleSize: boolean;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

export function computeSampleMetrics(
  trades: readonly ClosedBacktestTrade[],
  minTradesForConclusion: number,
): SampleMetrics {
  const nets = trades.map((t) => t.netPnlSol.toNumberUnsafe());
  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n < 0);

  const sumWins = wins.reduce((s, v) => s + v, 0);
  const sumLossesAbs = -losses.reduce((s, v) => s + v, 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const lossRate = trades.length > 0 ? losses.length / trades.length : 0;
  const avgWinSol = wins.length > 0 ? sumWins / wins.length : 0;
  const avgLossSol = losses.length > 0 ? sumLossesAbs / losses.length : 0;

  let maxDrawdownSol = 0;
  let peak = 0;
  let cumulative = 0;
  for (const n of nets) {
    cumulative += n;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdownSol) maxDrawdownSol = drawdown;
  }

  let longestLosingStreak = 0;
  let currentStreak = 0;
  for (const n of nets) {
    if (n < 0) { currentStreak++; if (currentStreak > longestLosingStreak) longestLosingStreak = currentStreak; }
    else currentStreak = 0;
  }

  const byReason = new Map<string, number[]>();
  for (const t of trades) {
    const key = t.exitReason;
    const arr = byReason.get(key);
    const net = t.netPnlSol.toNumberUnsafe();
    if (arr === undefined) byReason.set(key, [net]);
    else arr.push(net);
  }
  const exitTriggerBreakdown: ExitTriggerStat[] = [...byReason.entries()]
    .map(([reason, ns]) => ({ reason, count: ns.length, avgNetPnlSol: mean(ns) }))
    .sort((a, b) => b.count - a.count);

  const mfeSorted = trades.map((t) => t.mfePct).sort((a, b) => a - b);

  const totalCostsSol = trades.reduce((s, t) => s + t.costsSol.toNumberUnsafe(), 0);
  const totalGrossPnlSol = trades.reduce((s, t) => s + t.grossPnlSol.toNumberUnsafe(), 0);
  const sumGrossAbs = trades.reduce((s, t) => s + Math.abs(t.grossPnlSol.toNumberUnsafe()), 0);

  return {
    tradeCount: trades.length,
    winRate, avgWinSol, avgLossSol,
    profitFactor: sumLossesAbs > 0 ? sumWins / sumLossesAbs : (sumWins > 0 ? Infinity : 0),
    expectancySol: winRate * avgWinSol - lossRate * avgLossSol,
    maxDrawdownSol, longestLosingStreak, exitTriggerBreakdown,
    mfeDistributionPct: {
      p25: percentile(mfeSorted, 0.25), p50: percentile(mfeSorted, 0.5),
      p75: percentile(mfeSorted, 0.75), p90: percentile(mfeSorted, 0.9),
      max: mfeSorted.length > 0 ? mfeSorted[mfeSorted.length - 1]! : 0,
    },
    costs: {
      totalCostsSol, totalGrossPnlSol,
      costsAsPctOfGrossAbs: sumGrossAbs > 0 ? (totalCostsSol / sumGrossAbs) * 100 : 0,
    },
    belowMinimumSampleSize: trades.length < minTradesForConclusion,
  };
}

export interface BacktestMetrics {
  readonly inSample: SampleMetrics;
  readonly outOfSample: SampleMetrics;
  readonly combined: SampleMetrics;
  /** Entry timestamp of the first out-of-sample trade, or null if there isn't one. */
  readonly outOfSampleSplitTimestamp: number | null;
  readonly rejectedByFilter: Readonly<Record<string, number>>;
}

/**
 * Splits trades chronologically — the first `(1 - outOfSampleFraction)` trades
 * are in-sample, the rest out-of-sample, never used for tuning (spec §10).
 * Trades already arrive in chronological order from the engine (bars are
 * processed in order), so this is a straight index split, not a re-sort.
 */
export function computeBacktestMetrics(
  trades: readonly ClosedBacktestTrade[],
  rejectedSignals: readonly { readonly blockedBy: string }[],
  minTradesForConclusion: number,
  outOfSampleFraction: number,
): BacktestMetrics {
  const splitAt = Math.floor(trades.length * (1 - outOfSampleFraction));
  const inSampleTrades = trades.slice(0, splitAt);
  const outOfSampleTrades = trades.slice(splitAt);

  const rejectedByFilter: Record<string, number> = {};
  for (const r of rejectedSignals) rejectedByFilter[r.blockedBy] = (rejectedByFilter[r.blockedBy] ?? 0) + 1;

  return {
    inSample: computeSampleMetrics(inSampleTrades, minTradesForConclusion),
    outOfSample: computeSampleMetrics(outOfSampleTrades, minTradesForConclusion),
    combined: computeSampleMetrics(trades, minTradesForConclusion),
    outOfSampleSplitTimestamp: outOfSampleTrades[0]?.entryTimestamp ?? null,
    rejectedByFilter,
  };
}
