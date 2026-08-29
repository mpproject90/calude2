import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/types/index.js';
import { aggregateCandles, AggregateError } from '../src/data/aggregate.js';
import { regimeBucketIndices } from '../src/backtest/regimeAlignment.js';
import { runBacktest, type ClosedBacktestTrade } from '../src/backtest/engine.js';
import { computeSampleMetrics, computeBacktestMetrics } from '../src/backtest/metrics.js';
import { parseConfig } from '../src/config/load.js';
import type { Config, TokenConfig } from '../src/config/schema.js';
import { computeRsi } from '../src/indicators/rsi.js';
import { computeMfi } from '../src/indicators/mfi.js';
import { crossedUpThrough, wasOverboughtWithin } from '../src/rules/conditions.js';
import { detectGaps } from '../src/data/gaps.js';
import { sol } from '../src/util/amount.js';

const H = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % (4 * H));   // aligned to a 4h boundary

const bar = (i: number, over: Partial<Candle> = {}): Candle => ({
  timestamp: T0 + i * H, open: 10, high: 11, low: 9, close: 10.5, volume: 100, ...over,
});

describe('candle aggregation', () => {
  it('combines a full bucket of source bars into one coarser candle', () => {
    const src = [
      bar(0, { open: 10, high: 12, low: 9, close: 11, volume: 100 }),
      bar(1, { open: 11, high: 13, low: 10, close: 12, volume: 150 }),
      bar(2, { open: 12, high: 12.5, low: 8, close: 9, volume: 50 }),
      bar(3, { open: 9, high: 10, low: 8.5, close: 9.5, volume: 200 }),
    ];
    const out = aggregateCandles(src, '1h', '4h');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      timestamp: T0, open: 10, high: 13, low: 8, close: 9.5, volume: 500,
    });
  });

  it('drops an incomplete bucket rather than aggregating from less than it claims to represent', () => {
    // Only 3 of the 4 bars a bucket needs — bar at i=1 is missing (a gap).
    const src = [bar(0), bar(2), bar(3)];
    expect(aggregateCandles(src, '1h', '4h')).toHaveLength(0);
  });

  it('handles multiple buckets, dropping only the incomplete ones', () => {
    const src = [
      bar(0), bar(1), bar(2), bar(3),         // complete bucket 0
      bar(4), bar(5),                          // incomplete bucket 1 (missing 6, 7)
      bar(8), bar(9), bar(10), bar(11),        // complete bucket 2
    ];
    const out = aggregateCandles(src, '1h', '4h');
    expect(out).toHaveLength(2);
    expect(out[0]!.timestamp).toBe(T0);
    expect(out[1]!.timestamp).toBe(T0 + 8 * H);
  });

  it('returns the source series unchanged when source and target intervals match', () => {
    const src = [bar(0), bar(1)];
    expect(aggregateCandles(src, '1h', '1h')).toEqual(src);
  });

  it('refuses to aggregate into a target that is not an exact multiple of the source', () => {
    // 5m does not divide evenly into 15m's bars — refuse rather than guess.
    expect(() => aggregateCandles([bar(0)], '15m', '5m')).toThrow(AggregateError);
  });

  it('matches the real 90-day JUP/SOL fetch pattern: SOL (gapless) drops ~0 buckets, JUP (150 gaps) drops many', () => {
    // Regression guard for the exact real-data finding: aggregating a gapless
    // 1h series into 4h loses only boundary buckets, not gap-driven ones.
    const gaplessDay = Array.from({ length: 24 }, (_, i) => bar(i));
    expect(aggregateCandles(gaplessDay, '1h', '4h')).toHaveLength(6);

    const withOneGap = gaplessDay.filter((_, i) => i !== 5);   // drop hour 5 -> bucket 1 incomplete
    expect(aggregateCandles(withOneGap, '1h', '4h')).toHaveLength(5);
  });
});

describe('regime bucket alignment (look-ahead guard)', () => {
  const FOUR_H = 4 * H;
  const regimeBucket = (i: number): Candle => ({
    timestamp: T0 + i * FOUR_H, open: 10, high: 11, low: 9, close: 10.5, volume: 100,
  });

  it('assigns null before any regime bucket has closed', () => {
    const tokenBars = [bar(0), bar(1), bar(2), bar(3)];   // all inside the first, still-open 4h bucket
    const aggregated = [regimeBucket(0)];                 // this bucket covers T0..T0+4h, closes at T0+4h
    const idx = regimeBucketIndices(tokenBars, aggregated, FOUR_H);
    expect(idx).toEqual([null, null, null, null]);
  });

  it('only assigns a bucket once its own close time has passed, never the one still in progress', () => {
    const tokenBars = [bar(3), bar(4), bar(7), bar(8)];
    // bucket 0 covers [T0, T0+4h) and closes AT T0+4h; bucket 1 covers [T0+4h, T0+8h).
    const aggregated = [regimeBucket(0), regimeBucket(1)];
    const idx = regimeBucketIndices(tokenBars, aggregated, FOUR_H);
    // bar(3) = T0+3h: bucket 0 hasn't closed yet (closes at T0+4h) -> null
    expect(idx[0]).toBeNull();
    // bar(4) = T0+4h: bucket 0 has just closed -> index 0
    expect(idx[1]).toBe(0);
    // bar(7) = T0+7h: still bucket 0, bucket 1 closes at T0+8h -> index 0
    expect(idx[2]).toBe(0);
    // bar(8) = T0+8h: bucket 1 has just closed -> index 1
    expect(idx[3]).toBe(1);
  });

  it('carries the last closed bucket forward across a gap in the regime series', () => {
    const tokenBars = [bar(4), bar(12)];
    // Only bucket 0 exists (bucket 1 was dropped as incomplete, e.g. by a source gap).
    const aggregated = [regimeBucket(0)];
    const idx = regimeBucketIndices(tokenBars, aggregated, FOUR_H);
    expect(idx).toEqual([0, 0]);   // still the last one that actually closed, not fabricated
  });
});

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function buildConfig(globalOver: Record<string, unknown> = {}, tokenOver: Record<string, unknown> = {}): Config {
  return parseConfig({
    global: {
      indicatorWarmupMultiplier: 1,
      regimeFilter: { enabled: false },
      ...globalOver,
    },
    tokens: [{
      address: JUP, symbol: 'JUP', tier: 'A', timeframe: '1h', buyAmountSol: '1',
      rsi: { period: 2, oversold: 30, overbought: 70 },
      mfi: { period: 2, threshold: 90 },
      entry: { priorOverboughtWithinCandles: 50, minUnderperformanceVsSol: 0, relativeStrengthLookback: 3 },
      exit: { stopLossPct: 80, timeExitCandles: 3, rsiExitLevel: 99 },
      limits: { minViableBuyAmountSol: '0.01' },
      expectedMove: { atrPeriod: 2, atrMultiplier: 10 },
      ...tokenOver,
    }],
  });
}

/** A generously-ranged candle series so ATR/wicks are never degenerate. */
function series(closes: number[], baseTs = T0): Candle[] {
  return closes.map((c, i) => {
    const prev = closes[i - 1] ?? c;
    return {
      timestamp: baseTs + i * H,
      open: prev,
      high: Math.max(prev, c) * 1.05,
      low: Math.min(prev, c) * 0.95,
      close: c,
      volume: 1000,
    };
  });
}

function flatSol(n: number, baseTs = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: baseTs + i * H, open: 50, high: 50.5, low: 49.5, close: 50, volume: 1000,
  }));
}

describe('backtest engine', () => {
  // A textbook shape: pump (creates a prior-overbought RSI reading), dip below
  // oversold, then a clean cross back up. Deliberately NOT hand-derived —
  // the test below finds the real signal index using the SAME primitive
  // functions entry.ts uses, so this stays correct even if the exact bar
  // shifts with a fixture edit.
  const closes = [50, 65, 80, 95, 80, 65, 50, 45, 40, 35, 30, 34, 40, 45, 50, 50, 50, 50];
  const candles = series(closes);
  const solCandles = flatSol(closes.length);   // flat SOL/USD: solReturn is always 0
  const gaps = detectGaps(candles, '1h');

  const cfg = buildConfig();
  const token: TokenConfig = cfg.tokens[0]!;
  const global = cfg.global;

  const rsi = computeRsi(candles, { period: token.rsi.period, warmupMultiplier: global.indicatorWarmupMultiplier, gaps });
  const mfi = computeMfi(candles, { period: token.mfi.period, warmupMultiplier: global.indicatorWarmupMultiplier, gaps });
  let signalIndex = -1;
  for (let i = 1; i < candles.length; i++) {
    if (rsi[i]?.reliable !== true || mfi[i]?.reliable !== true) continue;
    if (!wasOverboughtWithin(rsi, i, token.entry.priorOverboughtWithinCandles, token.rsi.overbought)) continue;
    if (!crossedUpThrough(rsi, i, token.rsi.oversold)) continue;
    if (mfi[i]!.value >= token.mfi.threshold) continue;
    signalIndex = i;
    break;
  }

  it('the fixture actually produces a textbook signal (sanity check, not a strategy assertion)', () => {
    expect(signalIndex).toBeGreaterThan(0);
  });

  it("fills at the NEXT bar's open, never the signal bar's close", () => {
    const result = runBacktest({
      token, global, candles, solCandles, gaps, startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    const first = result.trades[0]!;
    expect(first.entryIndex).toBe(signalIndex + 1);
    expect(first.entryPrice).toBe(candles[signalIndex + 1]!.open);
    // Distinguishes "filled at the fill bar's OPEN" from "filled at its CLOSE"
    // — the fixture's own continuous-candle construction makes open[i+1] equal
    // close[i], so that comparison alone would be tautological, not a real check.
    expect(first.entryPrice).not.toBe(candles[signalIndex + 1]!.close);
  });

  it('exits via the time exit and computes gross/cost/net P&L exactly', () => {
    const result = runBacktest({
      token, global, candles, solCandles, gaps, startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('time');
    expect(trade.barsHeld).toBe(token.exit.timeExitCandles);

    const expectedGross = trade.sizeSol.toNumberUnsafe() * (trade.exitPrice / trade.entryPrice - 1);
    expect(trade.grossPnlSol.toNumberUnsafe()).toBeCloseTo(expectedGross, 6);

    const expectedCosts = trade.sizeSol.toNumberUnsafe() * (trade.costBreakdown.roundTripPct / 100);
    expect(trade.costsSol.toNumberUnsafe()).toBeCloseTo(expectedCosts, 6);
    expect(trade.netPnlSol.toNumberUnsafe()).toBeCloseTo(expectedGross - expectedCosts, 6);
  });

  it('tracks MFE as the real peak reached while the position was held', () => {
    const result = runBacktest({
      token, global, candles, solCandles, gaps, startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    const trade = result.trades[0]!;
    let peak = trade.entryPrice;
    for (let i = trade.entryIndex; i <= trade.exitIndex; i++) peak = Math.max(peak, candles[i]!.high);
    expect(trade.mfePct).toBeCloseTo((peak / trade.entryPrice - 1) * 100, 6);
  });

  it('updates the running balance by exactly the net P&L', () => {
    const result = runBacktest({
      token, global, candles, solCandles, gaps, startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    const totalNet = result.trades.reduce((s, t) => s + t.netPnlSol.toNumberUnsafe(), 0);
    expect(result.endingBalanceSol.toNumberUnsafe()).toBeCloseTo(10 + totalNet, 6);
  });

  it('marks the position-size cap as explicitly skipped, never silently, when no liquidity is supplied', () => {
    const result = runBacktest({
      token, global, candles, solCandles, gaps, startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    expect(result.poolLiquiditySolUsed).toBeNull();
    expect(result.rejectedSignals.some((r) => r.blockedBy === 'filter:position-size')).toBe(false);
  });

  it('counts indicator-unreliable blocks separately, bounded by total entry evaluations', () => {
    const result = runBacktest({
      token, global, candles, solCandles, gaps, startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    expect(result.entryEvaluations).toBeGreaterThan(0);
    expect(result.indicatorUnreliableBlocks).toBeGreaterThan(0);
    expect(result.indicatorUnreliableBlocks).toBeLessThanOrEqual(result.entryEvaluations);
  });

  it('splits indicator-unreliable blocks by reason: warm-up, then gap-in-series once a gap falls behind the window', () => {
    // 40 contiguous bars, then a real missing bar (index 15 omitted) — a gap,
    // not a flagged row. The real 90-day JUP fetch showed this reason split
    // matters far more than plain warm-up once gaps are dense (DECISIONS §27).
    const allCloses = Array.from({ length: 40 }, (_, i) => 50 + Math.sin(i / 3) * 10 + i);
    const full = series(allCloses);
    const withGap = full.filter((_, i) => i !== 15);
    const solFlat = flatSol(withGap.length);
    const gapsHere = detectGaps(withGap, '1h');
    expect(gapsHere).toHaveLength(1);

    const gapCfg = buildConfig({ indicatorWarmupMultiplier: 3 });   // warm-up = period(2) * 3 = 6
    const result = runBacktest({
      token: gapCfg.tokens[0]!, global: gapCfg.global, candles: withGap, solCandles: solFlat, gaps: gapsHere,
      startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    expect(result.indicatorUnreliableByReason['insufficient-warmup']).toBeGreaterThan(0);
    expect(result.indicatorUnreliableByReason['gap-in-series']).toBeGreaterThan(0);
    const total = Object.values(result.indicatorUnreliableByReason).reduce((s, n) => s + n, 0);
    expect(total).toBe(result.indicatorUnreliableBlocks);
  });

  it('force-closes a position still open at the series end as end_of_data, never counted as a real exit trigger', () => {
    const patientCfg = buildConfig({}, { exit: { stopLossPct: 80, timeExitCandles: 10_000, rsiExitLevel: 99 } });
    const result = runBacktest({
      token: patientCfg.tokens[0]!, global: patientCfg.global, candles, solCandles, gaps,
      startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    const last = result.trades[result.trades.length - 1]!;
    expect(last.exitReason).toBe('end_of_data');
    expect(last.exitIndex).toBe(candles.length - 1);
  });

  it('applies the position-size cap and reports its actual sizeSol when liquidity IS supplied', () => {
    // buyAmountSol=1 SOL; cap it hard with a tiny pool so sizing must shrink.
    const result = runBacktest({
      token, global, candles, solCandles, gaps, startingBalanceSol: sol('10'), poolLiquiditySol: 1,
    });
    expect(result.poolLiquiditySolUsed).toBe(1);
    if (result.trades.length > 0) {
      // maxPctOfPoolLiquidity defaults to 0.5% of a 1 SOL pool = 0.005 SOL, far below the 1 SOL request.
      expect(result.trades[0]!.sizeSol.toNumberUnsafe()).toBeLessThan(1);
    }
  });

  it('blocks entries via the regime filter when SOL sits below its own short MA, with no look-ahead', () => {
    const decliningSol: Candle[] = closes.map((_, i) => {
      const c = 100 - i;   // strictly declining -> always below a trailing 2-bar MA
      return { timestamp: T0 + i * H, open: c + 1, high: c + 1.5, low: c - 0.5, close: c, volume: 1000 };
    });
    const regimeCfg = buildConfig({ regimeFilter: { enabled: true, solMaPeriod: 2, solMaTimeframe: '1h' } });
    const result = runBacktest({
      token: regimeCfg.tokens[0]!, global: regimeCfg.global, candles, solCandles: decliningSol, gaps,
      startingBalanceSol: sol('10'), poolLiquiditySol: null,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.rejectedSignals.some((r) => r.blockedBy === 'filter:regime')).toBe(true);
  });
});

const flatCost = { dexFeePct: 0, slippagePct: 0, fixedFeePct: 0, roundTripPct: 0, slippageEstimated: true };

function trade(over: Partial<ClosedBacktestTrade> = {}): ClosedBacktestTrade {
  return {
    entryIndex: 0, entryTimestamp: T0, entryPrice: 100,
    exitIndex: 1, exitTimestamp: T0 + H, exitPrice: 100,
    exitReason: 'time', barsHeld: 1,
    sizeSol: sol('1'), grossPnlSol: sol('0'), costsSol: sol('0'), netPnlSol: sol('0'),
    mfePct: 0, costBreakdown: flatCost, entryChecks: [],
    ...over,
  };
}

function netTrade(net: number): ClosedBacktestTrade {
  return trade({ netPnlSol: sol(net.toString()), grossPnlSol: sol(net.toString()) });
}

describe('backtest metrics', () => {
  it('computes win rate, avg win/loss, profit factor and expectancy exactly', () => {
    const trades = [2, 4, -1, -3, 2].map(netTrade);
    const m = computeSampleMetrics(trades, 50);
    expect(m.winRate).toBeCloseTo(0.6, 10);
    expect(m.avgWinSol).toBeCloseTo(8 / 3, 10);
    expect(m.avgLossSol).toBeCloseTo(2, 10);
    expect(m.profitFactor).toBeCloseTo(2, 10);
    expect(m.expectancySol).toBeCloseTo(0.6 * (8 / 3) - 0.4 * 2, 10);
  });

  it('reports Infinity profit factor with wins and no losses, and 0 expectancy risk with no wins', () => {
    expect(computeSampleMetrics([1, 2].map(netTrade), 50).profitFactor).toBe(Infinity);
    expect(computeSampleMetrics([], 50).profitFactor).toBe(0);
    const allLosses = computeSampleMetrics([-1, -2].map(netTrade), 50);
    expect(allLosses.profitFactor).toBe(0);
    expect(allLosses.winRate).toBe(0);
  });

  it('computes max drawdown from the cumulative net P&L curve', () => {
    const trades = [5, -2, -3, 4, -1].map(netTrade);
    // cumulative: 5, 3, 0, 4, 3 — peak 5 throughout, worst drawdown at cum=0 -> 5
    expect(computeSampleMetrics(trades, 50).maxDrawdownSol).toBeCloseTo(5, 10);
  });

  it('finds the longest losing streak, not just the total loss count', () => {
    const trades = [-1, -1, 2, -1, -1, -1, 2].map(netTrade);
    expect(computeSampleMetrics(trades, 50).longestLosingStreak).toBe(3);
  });

  it('breaks down exit triggers by reason with count and average net P&L', () => {
    const trades = [
      trade({ exitReason: 'stop_loss', netPnlSol: sol('-1') }),
      trade({ exitReason: 'stop_loss', netPnlSol: sol('-3') }),
      trade({ exitReason: 'rsi_recovery', netPnlSol: sol('2') }),
    ];
    const m = computeSampleMetrics(trades, 50);
    const stopStat = m.exitTriggerBreakdown.find((s) => s.reason === 'stop_loss')!;
    expect(stopStat.count).toBe(2);
    expect(stopStat.avgNetPnlSol).toBeCloseTo(-2, 10);
    const rsiStat = m.exitTriggerBreakdown.find((s) => s.reason === 'rsi_recovery')!;
    expect(rsiStat.count).toBe(1);
    expect(rsiStat.avgNetPnlSol).toBeCloseTo(2, 10);
  });

  it('computes the MFE distribution across all trades, win or lose', () => {
    const trades = Array.from({ length: 10 }, (_, i) => trade({ mfePct: i + 1 }));   // 1..10
    const m = computeSampleMetrics(trades, 50);
    expect(m.mfeDistributionPct.p25).toBe(3);
    expect(m.mfeDistributionPct.p50).toBe(6);
    expect(m.mfeDistributionPct.p75).toBe(8);
    expect(m.mfeDistributionPct.p90).toBe(10);
    expect(m.mfeDistributionPct.max).toBe(10);
  });

  it('reports total costs as a percentage of total absolute gross P&L', () => {
    const trades = [
      trade({ grossPnlSol: sol('10'), costsSol: sol('1') }),
      trade({ grossPnlSol: sol('-5'), costsSol: sol('1') }),
    ];
    const m = computeSampleMetrics(trades, 50);
    expect(m.costs.totalCostsSol).toBeCloseTo(2, 10);
    expect(m.costs.totalGrossPnlSol).toBeCloseTo(5, 10);
    expect(m.costs.costsAsPctOfGrossAbs).toBeCloseTo((2 / 15) * 100, 10);
  });

  it('flags below the minimum trade count for a conclusive result', () => {
    expect(computeSampleMetrics([1, 2].map(netTrade), 50).belowMinimumSampleSize).toBe(true);
    expect(computeSampleMetrics(new Array(50).fill(0).map(() => netTrade(1)), 50).belowMinimumSampleSize).toBe(false);
  });

  it('splits chronologically into in-sample and out-of-sample, never re-sorting', () => {
    const trades = Array.from({ length: 10 }, (_, i) => trade({ entryTimestamp: T0 + i * H, entryIndex: i }));
    const m = computeBacktestMetrics(trades, [], 50, 0.3);
    expect(m.inSample.tradeCount).toBe(7);
    expect(m.outOfSample.tradeCount).toBe(3);
    expect(m.outOfSampleSplitTimestamp).toBe(T0 + 7 * H);
  });

  it('reports null for the split timestamp when there are no trades at all', () => {
    const m = computeBacktestMetrics([], [], 50, 0.3);
    expect(m.outOfSampleSplitTimestamp).toBeNull();
    expect(m.inSample.tradeCount).toBe(0);
  });

  it('tallies rejected signals by which check blocked them', () => {
    const rejected = [
      { blockedBy: 'indicators-reliable' }, { blockedBy: 'indicators-reliable' },
      { blockedBy: 'filter:regime' },
    ];
    const m = computeBacktestMetrics([], rejected, 50, 0.3);
    expect(m.rejectedByFilter['indicators-reliable']).toBe(2);
    expect(m.rejectedByFilter['filter:regime']).toBe(1);
  });
});
