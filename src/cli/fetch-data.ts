/**
 * Fetch, validate, cache and report on real candles. This is the tool for
 * reviewing the data layer against live data before the backtest is built.
 *
 *   npm run data:fetch -- --symbol JUP --interval 1h --days 90
 *   npm run data:fetch -- --symbol JTO --interval 4h --days 365 --db data/candles.db
 *
 * Pulls <SYMBOL>USDT and SOLUSDT, synthesizes <SYMBOL>/SOL, and reports coverage,
 * gaps, rejections and how much the synthesis widened the intrabar range.
 * Requires only outbound access to api.binance.com — no API key, no cloud
 * services, nothing environment-specific.
 */
import { openDb } from '../db/index.js';
import { createLogger } from '../util/logger.js';
import { INTERVAL_MS, INTERVALS, type Interval } from '../types/index.js';
import { CandleService } from '../data/index.js';
import { BinanceCandleProvider } from '../data/providers/binance.js';
import { synthesizeRatioSeries, rangeWideningRatio } from '../data/synthesize.js';
import { detectSeriesIssues } from '../data/gaps.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required argument --${name}`);
  }
  return v;
}

const symbol = arg('symbol').toUpperCase();
const interval = arg('interval', '1h') as Interval;
const days = Number(arg('days', '90'));
const dbPath = arg('db', 'data/candles.db');

if (!INTERVALS.includes(interval)) {
  throw new Error(`--interval must be one of ${INTERVALS.join(', ')}`);
}
if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');

const step = INTERVAL_MS[interval];
const to = Math.floor(Date.now() / step) * step - step;   // last CLOSED bar
const from = to - Math.round(days * 86_400_000);

const log = createLogger('info');
const db = openDb(dbPath);

const provider = new BinanceCandleProvider({
  symbolMap: { [symbol]: `${symbol}USDT`, SOL: 'SOLUSDT' },
});
const service = new CandleService({ provider, db, logger: log });

function pct(n: number): string { return `${(n * 100).toFixed(2)}%`; }

function report(name: string, candles: readonly { timestamp: number }[], gaps: readonly { missingBars: number }[]): void {
  const expected = Math.floor((to - from) / step) + 1;
  const missing = gaps.reduce((n, g) => n + g.missingBars, 0);
  console.log(`\n${name}`);
  console.log(`  bars           ${candles.length} of ~${expected} expected (${pct(candles.length / expected)})`);
  if (candles.length > 0) {
    console.log(`  first          ${new Date(candles[0]!.timestamp).toISOString()}`);
    console.log(`  last           ${new Date(candles[candles.length - 1]!.timestamp).toISOString()}`);
  }
  console.log(`  gaps           ${gaps.length} (${missing} bars missing)`);
}

const main = async (): Promise<void> => {
  console.log(`Fetching ${symbol}USDT and SOLUSDT, ${interval}, ${days}d -> ${dbPath}`);

  const token = await service.getSeries(symbol, interval, from, to);
  const sol = await service.getSeries('SOL', interval, from, to);

  report(`${symbol}USDT`, token.candles, token.gaps);
  report('SOLUSDT', sol.candles, sol.gaps);

  const repo = service.repository;
  console.log(`\nrejected candles  ${symbol}: ${repo.countRejected(symbol, interval)}, ` +
              `SOL: ${repo.countRejected('SOL', interval)}`);

  // The series the strategy actually runs on.
  const synth = synthesizeRatioSeries(token.candles, sol.candles);
  const synthIssues = detectSeriesIssues(synth.candles, interval);
  report(`${symbol}/SOL (synthesized)`, synth.candles, synthIssues.gaps);
  console.log(`  dropped        ${synth.unmatchedNumerator.length} unmatched ${symbol} bars, ` +
              `${synth.unmatchedDenominator.length} unmatched SOL bars`);
  console.log(`  range widening ${rangeWideningRatio(synth.candles).toFixed(2)}x vs |close-open|`);
  console.log(
    `\n  NOTE: synthesized open/close are EXACT (so RSI is exact). high/low are\n` +
    `  the widest possible BOUNDS, so ATR is biased high and MFI's typical price\n` +
    `  is approximate. Use the finest base timeframe you can to tighten them.`,
  );

  db.close();
};

main().catch((err: unknown) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
