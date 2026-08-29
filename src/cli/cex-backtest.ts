/**
 * Baseline backtest on the CEX study's pooled series (DECISIONS §36) — the
 * same strategy code (`runBacktest`), same current-settings config as every
 * other run in this project, against years of Binance-derived TOKEN/SOL
 * history (§33/§34) instead of the 180-day-capped DEX series. NO parameter
 * tuning happens here — this is the baseline to compare a later sweep
 * against, per operator direction. NO in-sample/out-of-sample split either:
 * that is reserved for the calendar-based split (first ~3.5y in-sample,
 * last ~1.5y out-of-sample) the operator specified for when the sweep is
 * actually built — invoking a different split now would make that split
 * awkward to introduce cleanly later, so this run reports the FULL period
 * only.
 *
 *   npm run data:cex-backtest
 *   npm run data:cex-backtest -- --tokens JUP,JTO,PYTH,WIF,BONK,RAY,ORCA
 *
 * CAVEATS — every number in this report inherits them:
 *   - Fills are modelled from Binance (CEX) prices, not a real Solana DEX
 *     fill — optimistic relative to what Jupiter would actually have given,
 *     which has its own price impact beyond the modelled slippage below.
 *   - Costs ARE modelled as on-chain execution (DEX fee + priority fee +
 *     Jito tip + slippage), not CEX trading fees — same `costFloor` config
 *     used everywhere else in this project (config/default.yaml). But
 *     slippage uses the FALLBACK figure, not real historical pool depth,
 *     because there is no DEX pool behind this CEX-derived series.
 *   - MFI and ATR remain approximate on synthesized series (DECISIONS §6) —
 *     this matters more here than in the funnel-only reports, because ATR
 *     feeds the cost-floor filter's expected-move estimate, which actually
 *     gates entries in this run (the funnel measurements before this did
 *     not exercise cost-floor at all).
 *   - Sample size is quoted BOTH raw and declustered (DECISIONS §35's
 *     2-day window, applied here to actual trade entries) — the raw trade
 *     count overstates independence for the same cross-token-correlation
 *     reason the 356 pooled cross-ups did.
 */
import { openDb } from '../db/index.js';
import { CandleRepository } from '../data/repository.js';
import { detectSeriesIssues } from '../data/gaps.js';
import { loadConfig, ConfigError } from '../config/load.js';
import type { TokenConfig } from '../config/schema.js';
import { runBacktest, type ClosedBacktestTrade } from '../backtest/engine.js';
import { computeSampleMetrics, withZeroCosts, type SampleMetrics } from '../backtest/metrics.js';
import { decluster } from '../backtest/decluster.js';
import { replayExit, mfeWithinBars, type ExitVariant } from '../backtest/exitReplay.js';
import { computeRsi } from '../indicators/rsi.js';
import { sol } from '../util/amount.js';
import { formatErrorChain } from '../util/errorChain.js';
import type { Candle, IndicatorValue, Interval } from '../types/index.js';
import { CEX_STUDY_MINTS, CEX_STUDY_DEFAULT_TOKENS } from './cexStudyTokens.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required argument --${name}`);
  }
  return v;
}

const interval = arg('interval', '1h') as Interval;
const dbPath = arg('db', 'data/binance-vision.db');
const configPath = arg('config', 'config/default.yaml');
const startingBalance = arg('starting-balance', '10');
const tokensArg = arg('tokens', CEX_STUDY_DEFAULT_TOKENS);
const DECLUSTER_WINDOW_DAYS = 2;   // DECISIONS §35's chosen window

const symbols = tokensArg.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
for (const s of symbols) {
  if (CEX_STUDY_MINTS[s] === undefined) {
    throw new Error(`no known Solana mint for "${s}" — add it to CEX_STUDY_MINTS in cexStudyTokens.ts`);
  }
}

function pct(n: number): string { return `${(n * 100).toFixed(2)}%`; }
function sig(n: number, digits = 4): string { return Number.isFinite(n) ? n.toFixed(digits) : (n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN'); }

function printSample(label: string, m: SampleMetrics, effectiveN: number | null = null): void {
  console.log(`\n${label}`);
  const nLine = effectiveN === null
    ? `  trades              ${m.tradeCount}`
    : `  trades              ${m.tradeCount} raw  /  ${effectiveN} effective (declustered, ${DECLUSTER_WINDOW_DAYS}d window) <- quote THIS one`;
  console.log(`${nLine}${m.belowMinimumSampleSize ? '  *** BELOW MINIMUM SAMPLE SIZE — not conclusive ***' : ''}`);
  if (m.tradeCount === 0) return;
  console.log(`  expectancy (SOL)    ${sig(m.expectancySol)}  <- headline number, not win rate`);
  console.log(`  win rate            ${pct(m.winRate)}`);
  console.log(`  avg win / avg loss  ${sig(m.avgWinSol)} / ${sig(m.avgLossSol)} SOL`);
  console.log(`  profit factor       ${sig(m.profitFactor, 2)}`);
  console.log(`  max drawdown        ${sig(m.maxDrawdownSol)} SOL`);
  console.log(`  longest losing streak  ${m.longestLosingStreak}`);
  console.log(`  costs               ${sig(m.costs.totalCostsSol)} SOL total, ${sig(m.costs.costsAsPctOfGrossAbs, 2)}% of gross |P&L|`);
  console.log('  exit trigger breakdown:');
  for (const s of m.exitTriggerBreakdown) {
    console.log(`    ${s.reason.padEnd(14)} count=${s.count}  avg net P&L=${sig(s.avgNetPnlSol)} SOL`);
  }
  console.log(
    `  MFE distribution (% favorable move reached, win or lose)  ` +
    `p25=${sig(m.mfeDistributionPct.p25, 2)}  p50=${sig(m.mfeDistributionPct.p50, 2)}  ` +
    `p75=${sig(m.mfeDistributionPct.p75, 2)}  p90=${sig(m.mfeDistributionPct.p90, 2)}  ` +
    `max=${sig(m.mfeDistributionPct.max, 2)}`,
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig(configPath);
  const template = cfg.tokens.find((t) => t.symbol === 'JUP');
  if (template === undefined) {
    throw new Error(`${configPath} has no "JUP" token entry to use as the current-settings template`);
  }

  console.log(
    'CEX baseline backtest (DECISIONS §36) — years of Binance-derived TOKEN/SOL history, current\n' +
    'settings, no parameter tuning, no in-sample/out-of-sample split (reserved for the calendar\n' +
    'split to be built later). CAVEATS, true for every number below:\n' +
    '  - Fills are modelled from Binance (CEX) prices — optimistic vs a real Jupiter/DEX fill.\n' +
    '  - Costs ARE on-chain (DEX fee + priority fee + Jito tip + slippage), not CEX fees — but\n' +
    '    slippage uses the configured FALLBACK figure, not real historical DEX pool depth.\n' +
    '  - MFI and ATR stay approximate on this synthesized series; ATR feeds the cost-floor filter\n' +
    '    that actually gates entries in this run.\n' +
    '  - Sample size is quoted both raw and declustered — quote the declustered number.\n',
  );

  const db = openDb(dbPath);
  const repo = new CandleRepository(db);
  const wideOpen = { from: 0, to: Date.now() };
  const solCandles = repo.getCandles('SOL', interval, wideOpen.from, wideOpen.to, '');
  if (solCandles.length === 0) {
    throw new Error(`no cached SOL candles in ${dbPath} — run "npm run data:cex-study" first`);
  }

  const allTrades: ClosedBacktestTrade[] = [];
  const tradeSymbol = new Map<ClosedBacktestTrade, string>();
  const pooledRejections: Record<string, number> = {};
  const tokenData = new Map<string, { candles: Candle[]; rsi: IndicatorValue[]; tokenCfg: TokenConfig }>();

  for (const symbol of symbols) {
    const candles = repo.getCandles(symbol, interval, wideOpen.from, wideOpen.to, '');
    if (candles.length === 0) {
      console.log(`--- ${symbol}: no cached candles, skipped (run data:cex-study first) ---\n`);
      continue;
    }
    const gaps = detectSeriesIssues(candles, interval).gaps;

    // Same entry/rsi/mfi/exit/limits config as every token in this project
    // (config/default.yaml's JUP entry, the only one defined) — only address/
    // symbol/timeframe change. No parameter is tuned per token or overall.
    const tokenCfg: TokenConfig = {
      ...template, address: CEX_STUDY_MINTS[symbol]!, symbol, timeframe: interval, pinnedPoolAddress: undefined,
    };
    const rsi = computeRsi(candles, { period: tokenCfg.rsi.period, warmupMultiplier: cfg.global.indicatorWarmupMultiplier, gaps });
    tokenData.set(symbol, { candles: [...candles], rsi, tokenCfg });

    const result = runBacktest({
      token: tokenCfg, global: cfg.global, candles, solCandles, gaps,
      startingBalanceSol: sol(startingBalance), poolLiquiditySol: null,
    });
    for (const t of result.trades) tradeSymbol.set(t, symbol);
    allTrades.push(...result.trades);
    const rejByFilter: Record<string, number> = {};
    for (const r of result.rejectedSignals) {
      rejByFilter[r.blockedBy] = (rejByFilter[r.blockedBy] ?? 0) + 1;
      pooledRejections[r.blockedBy] = (pooledRejections[r.blockedBy] ?? 0) + 1;
    }

    console.log(`--- ${symbol} ---`);
    console.log(
      `  entry evaluations ${result.entryEvaluations}, rejected: ` +
      Object.entries(rejByFilter).sort(([, a], [, b]) => b - a).map(([k, v]) => `${k}=${v}`).join(', '),
    );
    printSample(symbol, computeSampleMetrics(result.trades, cfg.global.minTradesForConclusion));
  }
  db.close();

  allTrades.sort((a, b) => a.entryTimestamp - b.entryTimestamp);
  const pooledMetrics = computeSampleMetrics(allTrades, cfg.global.minTradesForConclusion);
  const declusterEvents = allTrades.map((t) => ({
    token: tradeSymbol.get(t)!, timestamp: t.entryTimestamp,
  }));
  const effectiveClusters = decluster(declusterEvents, DECLUSTER_WINDOW_DAYS * 86_400_000);

  console.log('\n=== POOLED (all 7 tokens, current settings, full history) ===');
  console.log(
    '  pooled rejections by filter: ' +
    Object.entries(pooledRejections).sort(([, a], [, b]) => b - a).map(([k, v]) => `${k}=${v}`).join(', '),
  );
  printSample('POOLED', pooledMetrics, effectiveClusters.length);

  console.log(
    `\nNOTE: ${allTrades.length} raw pooled trades decluster to ${effectiveClusters.length} effective\n` +
    `independent episodes at the ${DECLUSTER_WINDOW_DAYS}-day window (DECISIONS §35) — quote\n` +
    'the effective number as the sample size, not the raw trade count, for the same cross-token\n' +
    'correlation reason the 356-cross-up pool needed declustering.',
  );

  // --- Zero-cost isolation (DECISIONS §37) — SAME trades, SAME exits, costs
  // stripped from the P&L calc only. Answers "is there gross edge at all,"
  // separately from "do costs eat it" — re-running with a zeroed cost-floor
  // config was rejected (see metrics.ts's withZeroCosts doc): a looser floor
  // can only admit MORE trades, never exclude any of these 10, so it would
  // silently change the population being measured instead of isolating costs.
  console.log('\n=== ZERO-COST ISOLATION (DECISIONS §37) — same trades, same exits, gross P&L only ===');
  const grossOnlyTrades = withZeroCosts(allTrades);
  const grossOnlyMetrics = computeSampleMetrics(grossOnlyTrades, cfg.global.minTradesForConclusion);
  printSample('POOLED, ZERO COST', grossOnlyMetrics, effectiveClusters.length);
  console.log(
    `\n  costed pooled expectancy:     ${sig(pooledMetrics.expectancySol)} SOL\n` +
    `  zero-cost pooled expectancy:  ${sig(grossOnlyMetrics.expectancySol)} SOL\n` +
    `  costed pooled win rate:       ${pct(pooledMetrics.winRate)}\n` +
    `  zero-cost pooled win rate:    ${pct(grossOnlyMetrics.winRate)}`,
  );
  if (grossOnlyMetrics.expectancySol <= 0) {
    console.log(
      '\n  Zero-cost expectancy is NOT positive: removing every cost still leaves this trade set\n' +
      '  unprofitable. No amount of cheaper execution fixes that — the entries+exits themselves\n' +
      '  are the problem, not the toll booth. (Still N=7 effective — not conclusive, just what\n' +
      '  this specific baseline sample shows.)',
    );
  } else {
    console.log(
      '\n  Zero-cost expectancy IS positive: the gross moves in this trade set were real. The costed\n' +
      '  baseline\'s loss is (at least partly) an execution-cost problem, not an entry-signal\n' +
      '  problem — different fixes apply (longer holds, bigger targets, cheaper venues), not\n' +
      '  necessarily different entry/exit rules. (Still N=7 effective — not conclusive.)',
    );
  }

  // --- Per-trade detail (DECISIONS §37) — is the time exit cutting profitable
  // trades short, or was MFE never there to cut short?
  console.log('\n=== PER-TRADE DETAIL — MFE and bars held, all 10 trades ===');
  console.log('token    entry (UTC)          barsHeld  exitReason  MFE%     grossPnL    netPnL   costs%ofPos');
  for (const t of allTrades) {
    const symbol = tradeSymbol.get(t)!;
    const gross = t.grossPnlSol.toNumberUnsafe();
    const net = t.netPnlSol.toNumberUnsafe();
    console.log(
      `${symbol.padEnd(8)} ${new Date(t.entryTimestamp).toISOString().slice(0, 16).replace('T', ' ')}  ` +
      `${String(t.barsHeld).padStart(8)}  ${t.exitReason.padEnd(10)}  ${sig(t.mfePct, 2).padStart(6)}  ` +
      `${sig(gross, 4).padStart(10)}  ${sig(net, 4).padStart(8)}  ${sig(t.costBreakdown.roundTripPct, 2).padStart(6)}%`,
    );
  }
  const timeExits = allTrades.filter((t) => t.exitReason === 'time');
  if (timeExits.length > 0) {
    const avgMfeAtTimeExit = timeExits.reduce((s, t) => s + t.mfePct, 0) / timeExits.length;
    const avgBarsAtTimeExit = timeExits.reduce((s, t) => s + t.barsHeld, 0) / timeExits.length;
    const timeExitTemplate = cfg.tokens.find((t2) => t2.symbol === 'JUP')!.exit.timeExitCandles;
    console.log(
      `\n  ${timeExits.length} of ${allTrades.length} trades exited on TIME (${timeExitTemplate}-candle limit).\n` +
      `  Average MFE among them: ${sig(avgMfeAtTimeExit, 2)}%. Average bars held: ${sig(avgBarsAtTimeExit, 1)}` +
      ` of ${timeExitTemplate} allowed.\n` +
      (avgMfeAtTimeExit > 2
        ? '  MFE was meaningfully above zero when time forced these out — worth checking whether the\n' +
          '  time exit or RSI-recovery level (70) is cutting off moves that were still developing.'
        : '  MFE stayed close to zero through the time exit — these entries simply were not followed\n' +
          '  by a favorable move, not a case of a good trade cut short.'),
    );
  }

  // --- MFE decay by holding period (DECISIONS §38) — did most of the
  // favorable move already show up by bar 24, or did it keep growing through
  // bar 48? Only meaningful for trades that actually reached both marks —
  // the 2 stop-loss trades are flagged N/A rather than extrapolated past
  // their real exit (that would be a different, unasked question: "what if
  // the stop hadn't fired").
  console.log('\n=== MFE DECAY: 24-candle mark vs 48-candle mark ===');
  console.log('token    barsHeld  MFE@24%   MFE@48%   fraction(24/48)');
  const decayRatios: number[] = [];
  for (const t of allTrades) {
    const symbol = tradeSymbol.get(t)!;
    const data = tokenData.get(symbol)!;
    if (t.barsHeld < 24) {
      console.log(`${symbol.padEnd(8)} ${String(t.barsHeld).padStart(8)}  stopped before the 24-candle mark (final MFE ${sig(t.mfePct, 2)}%) — N/A`);
      continue;
    }
    const mfe24 = mfeWithinBars(data.candles, t.entryIndex, t.entryPrice, 24);
    if (t.barsHeld < 48) {
      console.log(
        `${symbol.padEnd(8)} ${String(t.barsHeld).padStart(8)}  ${sig(mfe24, 2).padStart(7)}   ` +
        `stopped before the 48-candle mark (final MFE ${sig(t.mfePct, 2)}%) — N/A`,
      );
      continue;
    }
    const mfe48 = mfeWithinBars(data.candles, t.entryIndex, t.entryPrice, 48);
    const fraction = mfe48 > 0 ? mfe24 / mfe48 : NaN;
    if (Number.isFinite(fraction)) decayRatios.push(fraction);
    console.log(
      `${symbol.padEnd(8)} ${String(t.barsHeld).padStart(8)}  ${sig(mfe24, 2).padStart(7)}   ${sig(mfe48, 2).padStart(7)}   ` +
      `${Number.isFinite(fraction) ? pct(fraction) : 'N/A'}`,
    );
  }
  if (decayRatios.length > 0) {
    const avgRatio = decayRatios.reduce((s, r) => s + r, 0) / decayRatios.length;
    const sortedRatios = [...decayRatios].sort((a, b) => a - b);
    const medianRatio = sortedRatios[Math.floor(sortedRatios.length / 2)]!;
    console.log(
      `\n  Across the ${decayRatios.length} trades reaching both marks: average MFE@24/MFE@48 = ${pct(avgRatio)}, ` +
      `median = ${pct(medianRatio)}.`,
    );
    console.log(
      avgRatio > 0.85
        ? '  Most of the favorable move was already visible by bar 24 — the back half of the 48-candle\n' +
          '  window mostly did not add MFE. Independent of any trailing-stop question, the time exit\n' +
          '  itself may simply be longer than the move needs.'
        : '  MFE kept growing meaningfully into the back half of the window — a shorter time exit alone\n' +
          '  would have cut off real upside, not just noise.',
    );
  }

  // --- Exit variant replay (DECISIONS §38) — SAME 10 entries (verified below,
  // not assumed), alternative exit rules only. No entry logic re-run: see
  // exitReplay.ts's header for why re-running the whole engine per variant
  // was rejected (a different exit timing can silently change which trades
  // exist). Costs re-use each trade's real entry-time cost basis unchanged —
  // only the exit price/reason varies by variant.
  const EXIT_VARIANTS: ExitVariant[] = [
    { label: 'control (current rules)', stopLossPct: 15, timeExitCandles: 48, rsiExitLevel: 70,
      trailing: { enabled: false, activateAtPct: 20, trailPct: 10 }, takeProfitPct: null },
    { label: 'trailing +3%/-2%', stopLossPct: 15, timeExitCandles: 48, rsiExitLevel: 70,
      trailing: { enabled: true, activateAtPct: 3, trailPct: 2 }, takeProfitPct: null },
    { label: 'trailing +5%/-3%', stopLossPct: 15, timeExitCandles: 48, rsiExitLevel: 70,
      trailing: { enabled: true, activateAtPct: 5, trailPct: 3 }, takeProfitPct: null },
    { label: 'take-profit +5%', stopLossPct: 15, timeExitCandles: 48, rsiExitLevel: 70,
      trailing: { enabled: false, activateAtPct: 20, trailPct: 10 }, takeProfitPct: 5 },
    { label: 'take-profit +8%', stopLossPct: 15, timeExitCandles: 48, rsiExitLevel: 70,
      trailing: { enabled: false, activateAtPct: 20, trailPct: 10 }, takeProfitPct: 8 },
  ];

  function quickStats(nets: readonly number[]): { expectancy: number; winRate: number; profitFactor: number } {
    const wins = nets.filter((n) => n > 0);
    const losses = nets.filter((n) => n < 0);
    const sumWins = wins.reduce((s, v) => s + v, 0);
    const sumLossAbs = -losses.reduce((s, v) => s + v, 0);
    const winRate = nets.length > 0 ? wins.length / nets.length : 0;
    const lossRate = nets.length > 0 ? losses.length / nets.length : 0;
    const avgWin = wins.length > 0 ? sumWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? sumLossAbs / losses.length : 0;
    return {
      expectancy: winRate * avgWin - lossRate * avgLoss, winRate,
      profitFactor: sumLossAbs > 0 ? sumWins / sumLossAbs : (sumWins > 0 ? Infinity : 0),
    };
  }

  console.log('\n=== EXIT VARIANT COMPARISON (DECISIONS §38) — SAME 10 entries, alternative exits only ===');
  console.log(
    '  CURVE-FITTING WARNING: choosing among exits tested on the SAME 10 trades (7 effective)\n' +
    '  overfits by construction. This is NOT a validation and no variant is recommended below.\n' +
    '  It answers a weaker question only: does ANY reasonable exit turn this positive, or does\n' +
    '  none? None -> the entry has no edge, stop here. Several -> worth a proper sweep with\n' +
    '  out-of-sample validation; this diagnostic is only what would justify spending that effort.\n',
  );
  console.log(
    'variant                    costed exp   zero-cost exp  costed win%  zero-cost win%   costed PF  zero-cost PF',
  );

  let positiveCostedCount = 0;
  let positiveZeroCostCount = 0;
  for (const variant of EXIT_VARIANTS) {
    const replayed = allTrades.map((t) => {
      const symbol = tradeSymbol.get(t)!;
      const data = tokenData.get(symbol)!;
      const r = replayExit(data.candles, data.rsi, t.entryIndex, t.entryPrice, data.tokenCfg, variant, cfg.global.exitSlippagePct);
      const grossPnlSol = t.sizeSol.toNumberUnsafe() * (r.grossPnlPct / 100);
      const costsSol = t.costsSol.toNumberUnsafe();   // unchanged entry-time cost basis
      return { grossPnlSol, netPnlSol: grossPnlSol - costsSol, exitReason: r.exitReason, replay: r, original: t };
    });

    if (variant.label.startsWith('control')) {
      const mismatches = replayed.filter((x) =>
        x.replay.exitIndex !== x.original.exitIndex || x.replay.exitReason !== x.original.exitReason ||
        Math.abs(x.replay.exitPrice - x.original.exitPrice) > 1e-6,
      );
      console.log(
        `  [control self-check: ${replayed.length - mismatches.length}/${replayed.length} trades reproduce the ` +
        `original exactly${mismatches.length > 0 ? ' — MISMATCH: do not trust this comparison' : ' — OK'}]`,
      );
    }

    const costed = quickStats(replayed.map((x) => x.netPnlSol));
    const zeroCost = quickStats(replayed.map((x) => x.grossPnlSol));
    if (!variant.label.startsWith('control')) {
      if (costed.expectancy > 0) positiveCostedCount++;
      if (zeroCost.expectancy > 0) positiveZeroCostCount++;
    }
    const reasons = new Map<string, number>();
    for (const x of replayed) reasons.set(x.exitReason, (reasons.get(x.exitReason) ?? 0) + 1);

    console.log(
      `${variant.label.padEnd(27)} ${sig(costed.expectancy).padStart(8)}    ${sig(zeroCost.expectancy).padStart(11)}    ` +
      `${pct(costed.winRate).padStart(8)}    ${pct(zeroCost.winRate).padStart(11)}     ` +
      `${sig(costed.profitFactor, 2).padStart(8)}   ${sig(zeroCost.profitFactor, 2).padStart(8)}`,
    );
    console.log(`    exit reasons: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  console.log(
    `\n  ${positiveZeroCostCount} of 4 alternative exits produced positive ZERO-COST expectancy; ` +
    `${positiveCostedCount} of 4 produced positive COSTED expectancy.\n` +
    '  This is a count, not a verdict — restated per the curve-fitting warning above: none positive\n' +
    '  is decisive (no edge, stop). Several positive means a proper out-of-sample sweep is\n' +
    '  justified, not that any specific variant here is validated.',
  );

  console.log(
    '\nNOTE (CLAUDE.md hard rule): report the numbers above and their limitations; do not conclude\n' +
    'the strategy is profitable or not — that call is the operator\'s, informed by trade count\n' +
    '(raw AND declustered), the absence of an out-of-sample split in this baseline, and total costs paid.',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\nFAILED\n  ${err.message}`);
  } else {
    console.error(`\nFAILED\n  ${formatErrorChain(err)}`);
  }
  process.exitCode = 1;
});
