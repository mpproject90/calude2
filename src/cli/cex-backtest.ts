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
import { computeSampleMetrics, type SampleMetrics } from '../backtest/metrics.js';
import { decluster } from '../backtest/decluster.js';
import { sol } from '../util/amount.js';
import { formatErrorChain } from '../util/errorChain.js';
import type { Interval } from '../types/index.js';
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
