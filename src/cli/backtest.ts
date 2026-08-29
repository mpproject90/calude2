/**
 * Run the backtest engine (spec §10) against candles already fetched by
 * `npm run data:fetch` and cached in SQLite. Prints the report; does not
 * persist trades to the `positions` table — a backtest is a stateless,
 * one-shot replay, unlike paper/live which need crash-recoverable state.
 * DECISIONS §27 records this as a deliberate scope decision, not an
 * oversight; the schema is ready for it if repeated-run comparison is
 * needed later.
 *
 *   npm run backtest -- --symbol JUP
 *   npm run backtest -- --symbol JUP --pool-liquidity-sol 9200
 *   npm run backtest -- --symbol JUP --out-of-sample-pct 0.3 --starting-balance 10
 *
 * Requires candles already cached for both the token and SOL at the same
 * interval (run `npm run data:fetch` first). Reads the FULL cached range for
 * each — this does not itself fetch anything or touch the network.
 */
import { openDb } from '../db/index.js';
import { CandleRepository } from '../data/repository.js';
import { detectSeriesIssues } from '../data/gaps.js';
import { loadConfig, ConfigError } from '../config/load.js';
import { runBacktest } from '../backtest/engine.js';
import { computeBacktestMetrics, type SampleMetrics } from '../backtest/metrics.js';
import { sol } from '../util/amount.js';
import { formatErrorChain } from '../util/errorChain.js';
import type { Interval } from '../types/index.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required argument --${name}`);
  }
  return v;
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const symbol = arg('symbol').toUpperCase();
const configPath = arg('config', 'config/default.yaml');
const dbPath = arg('db', 'data/candles.db');
const outOfSampleFraction = Number(arg('out-of-sample-pct', '0.3'));
const startingBalance = arg('starting-balance', '10');
const poolLiquidityArg = flag('pool-liquidity-sol');
const poolLiquiditySol = poolLiquidityArg === undefined ? null : Number(poolLiquidityArg);

if (!Number.isFinite(outOfSampleFraction) || outOfSampleFraction < 0 || outOfSampleFraction >= 1) {
  throw new Error('--out-of-sample-pct must be a number in [0, 1)');
}
if (poolLiquidityArg !== undefined && (!Number.isFinite(poolLiquiditySol) || poolLiquiditySol! <= 0)) {
  throw new Error('--pool-liquidity-sol must be a positive number');
}

/**
 * Which pool's cached candles to read (schema v2, DECISIONS §29). An explicit
 * --pool-address/--sol-pool-address always wins; otherwise the most recently
 * fetched pool for this token/interval is used, with a note if more than one
 * is cached — a real possibility now that pool selection can vary run to run.
 */
function resolvePoolAddress(repo: CandleRepository, token: string, interval: Interval, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const pools = repo.cachedPools(token, interval);
  if (pools.length === 0) return '';   // no cache yet; the empty-candles check right after reports this clearly
  if (pools.length > 1) {
    console.log(
      `NOTE: ${pools.length} different pools are cached for ${token}/${interval} — using the most ` +
      `recently fetched (${pools[0]!.poolAddress || '(non-pool provider)'}). Pass --pool-address/` +
      '--sol-pool-address to pick a specific one.',
    );
  }
  return pools[0]!.poolAddress;
}

function pct(n: number): string { return `${(n * 100).toFixed(2)}%`; }
function sig(n: number, digits = 4): string { return Number.isFinite(n) ? n.toFixed(digits) : (n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN'); }

function printSample(label: string, m: SampleMetrics): void {
  console.log(`\n${label}`);
  console.log(`  trades              ${m.tradeCount}${m.belowMinimumSampleSize ? '  *** BELOW MINIMUM SAMPLE SIZE — not conclusive ***' : ''}`);
  if (m.tradeCount === 0) return;
  console.log(`  expectancy (SOL)    ${sig(m.expectancySol)}  <- headline number, not win rate`);
  console.log(`  win rate            ${pct(m.winRate)}`);
  console.log(`  avg win / avg loss  ${sig(m.avgWinSol)} / ${sig(m.avgLossSol)} SOL`);
  console.log(`  profit factor       ${sig(m.profitFactor, 2)}`);
  console.log(`  max drawdown        ${sig(m.maxDrawdownSol)} SOL`);
  console.log(`  longest losing streak  ${m.longestLosingStreak}`);
  console.log(`  costs               ${sig(m.costs.totalCostsSol)} SOL total, ${sig(m.costs.costsAsPctOfGrossAbs, 2)}% of gross P&L`);
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
  const token = cfg.tokens.find((t) => t.symbol === symbol);
  if (token === undefined) {
    throw new Error(`no token "${symbol}" in ${configPath} — add it to tokens[] first`);
  }
  const interval: Interval = token.timeframe;

  const db = openDb(dbPath);
  const repo = new CandleRepository(db);

  const poolAddress = resolvePoolAddress(repo, symbol, interval, flag('pool-address'));
  const solPoolAddress = resolvePoolAddress(repo, 'SOL', interval, flag('sol-pool-address'));

  const wideOpen = { from: 0, to: Date.now() };
  const candles = repo.getCandles(symbol, interval, wideOpen.from, wideOpen.to, poolAddress);
  const solCandles = repo.getCandles('SOL', interval, wideOpen.from, wideOpen.to, solPoolAddress);
  db.close();

  if (candles.length === 0) {
    throw new Error(`no cached ${symbol} candles at ${interval}${poolAddress ? ` for pool ${poolAddress}` : ''} in ${dbPath} — run "npm run data:fetch" first`);
  }
  if (solCandles.length === 0) {
    throw new Error(`no cached SOL candles at ${interval}${solPoolAddress ? ` for pool ${solPoolAddress}` : ''} in ${dbPath} — the regime and relative-strength filters need it`);
  }
  console.log(`Pool: ${poolAddress || '(non-pool provider)'}   SOL reference pool: ${solPoolAddress || '(non-pool provider)'}`);

  const gaps = detectSeriesIssues(candles, interval).gaps;

  console.log(`Backtesting ${symbol} (${interval}), ${candles.length} candles, ${gaps.length} gaps in the traded series.`);
  console.log(
    poolLiquiditySol === null
      ? 'Pool liquidity: NOT SUPPLIED — the §6.4 position-size cap is not evaluated this run (pass ' +
        '--pool-liquidity-sol <SOL amount> to enable it; see the pool candidates printed by data:fetch ' +
        'for a current reserveUsd snapshot to convert).'
      : `Pool liquidity: ${poolLiquiditySol} SOL (constant snapshot for the whole window — DECISIONS §27).`,
  );

  const result = runBacktest({
    token, global: cfg.global, candles, solCandles, gaps,
    startingBalanceSol: sol(startingBalance), poolLiquiditySol,
  });

  console.log(`\nentry evaluations               ${result.entryEvaluations}`);
  console.log(
    `blocked by unreliable indicators ${result.indicatorUnreliableBlocks} ` +
    `(${result.entryEvaluations > 0 ? pct(result.indicatorUnreliableBlocks / result.entryEvaluations) : '0.00%'} of evaluations)`,
  );
  for (const [reason, count] of Object.entries(result.indicatorUnreliableByReason).sort(([, a], [, b]) => b - a)) {
    console.log(`  - ${reason.padEnd(20)} ${count}`);
  }
  if ((result.indicatorUnreliableByReason['gap-in-series'] ?? 0) > 0) {
    console.log(
      `  NOTE: a gap invalidates a full trailing warm-up window BEHIND it, not just the bar\n` +
      `  after it (indicators/core.ts) — with ${gaps.length} gaps in this series, that shadow can\n` +
      `  cover far more of the series than initial warm-up alone. This is fail-closed working as\n` +
      `  designed, not a bug; a dominant gap-in-series count here means the strategy had very\n` +
      `  little gap-free runway to ever find a signal on this exact series.`,
    );
  }
  console.log(`starting balance                ${result.startingBalanceSol.toString()} SOL`);
  console.log(`ending balance                  ${result.endingBalanceSol.toString()} SOL`);

  const metrics = computeBacktestMetrics(result.trades, result.rejectedSignals, cfg.global.minTradesForConclusion, outOfSampleFraction);

  console.log('\nrejected signals by check:');
  for (const [name, count] of Object.entries(metrics.rejectedByFilter).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${name.padEnd(28)} ${count}`);
  }

  printSample('COMBINED (all trades)', metrics.combined);
  printSample('IN-SAMPLE', metrics.inSample);
  printSample('OUT-OF-SAMPLE (never used for tuning)', metrics.outOfSample);
  if (metrics.outOfSampleSplitTimestamp !== null) {
    console.log(`\nout-of-sample split at ${new Date(metrics.outOfSampleSplitTimestamp).toISOString()}`);
  }

  console.log(
    '\nNOTE: report the numbers above and their limitations; do not conclude the strategy is\n' +
    'profitable or not on the assistant\'s own judgment (CLAUDE.md hard rule) — that call is\n' +
    'the operator\'s, informed by trade count, the out-of-sample split, and total costs paid.',
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
