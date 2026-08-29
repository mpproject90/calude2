/**
 * CEX base-rate study (DECISIONS §33) — pull years of Binance bulk-archive
 * history for SOL and a fixed list of Solana tokens, synthesize each
 * TOKEN/SOL ratio series, and run the same entry funnel `data:screen` uses
 * to report the pooled RSI-cross-up event count across full history. No
 * backtest, no trades, no parameter tuning — a baseline read of "is there
 * even a usable sample" before any sweep is designed.
 *
 *   npm run data:cex-study
 *   npm run data:cex-study -- --tokens JUP,JTO,PYTH,WIF,BONK,RAY,ORCA --interval 1h
 *
 * WHY THIS DATA IS IN SCOPE DESPITE DECISIONS §6 REJECTING USDT SYNTHESIS AS
 * A DEFAULT: close is EXACT under ratio synthesis (close_ratio = close_num /
 * close_den, same instant on both sides), and RSI is built from closes alone
 * — §31/§32 both found the RSI cross-up itself, not MFI or relative-strength,
 * is what's rare. high/low stay BOUNDS, so MFI and ATR stay approximate here,
 * same as `--provider binance` in `fetch-data.ts`. This is a base-rate study,
 * not final validation — see DECISIONS §33 for the full reasoning, and every
 * report from this script repeats the caveat rather than assuming it's read.
 *
 * Writes to a SEPARATE database (`data/binance-vision.db` by default, not
 * `data/candles.db`) — this is study data, not the DEX-sourced series the
 * rest of the pipeline reviews, and keeping them apart means neither can be
 * mistaken for the other later.
 */
import { openDb } from '../db/index.js';
import { CandleRepository } from '../data/repository.js';
import { validateCandles } from '../data/validate.js';
import { detectSeriesIssues } from '../data/gaps.js';
import { INTERVAL_MS, INTERVALS, type Candle, type Interval } from '../types/index.js';
import { BinanceHistoricalCandleProvider, type MonthFetchedEvent } from '../data/providers/binanceHistorical.js';
import { synthesizeRatioSeries } from '../data/synthesize.js';
import { computeEntryFunnel, type CrossUpEvent } from '../backtest/funnel.js';
import { parseConfig } from '../config/load.js';
import { formatErrorChain } from '../util/errorChain.js';

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
const cacheDir = arg('cache-dir', 'data/binance-vision-cache');
const tokensArg = arg('tokens', 'JUP,JTO,PYTH,WIF,BONK,RAY,ORCA');

if (!INTERVALS.includes(interval)) throw new Error(`--interval must be one of ${INTERVALS.join(', ')}`);

// Real, independently-verified Solana mints (same addresses used for the
// DECISIONS §32 screen) — parseConfig only checks base58 shape, but using
// the real mints keeps this config meaningful rather than a placeholder.
const MINTS: Readonly<Record<string, string>> = {
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
};

const symbols = tokensArg.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
for (const s of symbols) {
  if (MINTS[s] === undefined) {
    throw new Error(`no known Solana mint for "${s}" — add it to MINTS in cex-study.ts, or drop it from --tokens`);
  }
}

const symbolMap: Record<string, string> = { SOL: 'SOLUSDT' };
for (const s of symbols) symbolMap[s] = `${s}USDT`;

const step = INTERVAL_MS[interval];

function pct(n: number): string { return `${(n * 100).toFixed(2)}%`; }

/** [from, to] spanning every published month for this symbol, oldest to last-complete. */
async function fullListedRange(
  provider: BinanceHistoricalCandleProvider, binanceSymbol: string,
): Promise<{ from: number; to: number; firstMonth: string; lastMonth: string }> {
  const months = await provider.discoverAvailableMonths(binanceSymbol, interval);
  const firstMonth = months[0]!;
  const lastMonth = months[months.length - 1]!;
  const [fy, fm] = firstMonth.split('-').map(Number) as [number, number];
  const [ly, lm] = lastMonth.split('-').map(Number) as [number, number];
  const from = Date.UTC(fy, fm - 1, 1);
  const to = Date.UTC(ly, lm, 1) - step;   // last bar of the last complete month
  return { from, to, firstMonth, lastMonth };
}

function cacheOnly(
  repo: CandleRepository, token: string, candles: readonly Candle[], from: number, to: number,
): Candle[] {
  const { valid, rejected } = validateCandles(candles, interval);
  if (rejected.length > 0) repo.recordRejected(token, interval, rejected, '');
  repo.upsertCandles(token, interval, valid, 'binance-historical', '');
  repo.recordFetch(token, interval, from, to, 'binance-historical', valid.length, '');
  const stored = repo.getCandles(token, interval, from, to, '');
  const issues = detectSeriesIssues(stored, interval);
  if (issues.gaps.length > 0) repo.recordGaps(token, interval, issues.gaps, '');
  return stored;
}

function screenTokenConfig(symbol: string) {
  return parseConfig({
    global: {},
    tokens: [{
      address: MINTS[symbol]!, symbol, tier: 'A', timeframe: interval, buyAmountSol: '0.5',
      rsi: { period: 14, oversold: 30, overbought: 70 },
      mfi: { period: 14, threshold: 30 },
      entry: { priorOverboughtWithinCandles: 50, minUnderperformanceVsSol: 0.05, relativeStrengthLookback: 24 },
      exit: { stopLossPct: 15, timeExitCandles: 48, rsiExitLevel: 70 },
      limits: { minViableBuyAmountSol: '0.05' },
    }],
  });
}

interface StudyRow {
  readonly symbol: string;
  readonly historyDays: number;
  readonly listingStart: string;
  readonly bars: number;
  readonly expected: number;
  readonly gaps: number;
  readonly missingBars: number;
  readonly droppedNoSolCounterpart: number;
  readonly counts: ReturnType<typeof computeEntryFunnel>['counts'];
  readonly crossUpEvents: readonly CrossUpEvent[];
}

async function main(): Promise<void> {
  console.log(
    'CEX base-rate study (DECISIONS §33) — Binance bulk archives, synthesized TOKEN/SOL ratio.\n' +
    'CAVEATS, true for every number below:\n' +
    '  - MFI and ATR are APPROXIMATE (synthesized high/low are bounds, not observations).\n' +
    '  - RSI and the cross-up count ARE exact (built from close alone, which IS exact under ratio synthesis).\n' +
    '  - CEX (Binance) price differs from the DEX price the strategy would actually trade at.\n' +
    '  - Only Binance-listed tokens are covered here — this is a base-rate STUDY, not a validation run.\n',
  );

  const db = openDb(dbPath);
  const repo = new CandleRepository(db);
  const onMonthFetched = (e: MonthFetchedEvent): void => {
    if (!e.cached) process.stdout.write('.');   // one dot per real download; cache hits are silent
  };
  const provider = new BinanceHistoricalCandleProvider({ symbolMap, cacheDir, onMonthFetched });

  console.log(`Fetching SOLUSDT (reference), full listed history...`);
  const solRange = await fullListedRange(provider, 'SOLUSDT');
  const solRaw = await provider.getCandles('SOL', interval, solRange.from, solRange.to);
  process.stdout.write('\n');
  const solCandles = cacheOnly(repo, 'SOL', solRaw, solRange.from, solRange.to);
  const solExpected = Math.floor((solRange.to - solRange.from) / step) + 1;
  const solIssues = detectSeriesIssues(solCandles, interval);
  console.log(
    `SOLUSDT: ${solRange.firstMonth} -> ${solRange.lastMonth}  ` +
    `bars ${solCandles.length}/${solExpected} (${pct(solCandles.length / solExpected)})  ` +
    `gaps ${solIssues.gaps.length}\n`,
  );
  if (solIssues.gaps.length / solExpected > 0.005) {
    console.log(
      `  WARNING: SOL/USDT coverage is not essentially gapless (${pct(solIssues.gaps.length / solExpected)} ` +
      'of bars gapped) — CEX data was expected to be near-100%; review before trusting anything downstream.\n',
    );
  }

  const rows: StudyRow[] = [];

  for (const symbol of symbols) {
    console.log(`--- ${symbol} ---`);
    const binanceSymbol = symbolMap[symbol]!;
    let range: { from: number; to: number; firstMonth: string; lastMonth: string };
    try {
      range = await fullListedRange(provider, binanceSymbol);
    } catch (err) {
      console.log(`  FAILED to discover listing: ${formatErrorChain(err)}\n`);
      continue;
    }
    const rawUsdt = await provider.getCandles(symbol, interval, range.from, range.to);
    process.stdout.write('\n');

    const synth = synthesizeRatioSeries(rawUsdt, solCandles);
    const stored = cacheOnly(repo, symbol, synth.candles, range.from, range.to);
    const expected = Math.floor((range.to - range.from) / step) + 1;
    const issues = detectSeriesIssues(stored, interval);
    const historyDays = (range.to - range.from) / 86_400_000;

    console.log(
      `  listed        ${range.firstMonth} -> ${range.lastMonth}  (${historyDays.toFixed(0)} days)`,
    );
    console.log(
      `  bars          ${stored.length}/${expected} (${pct(stored.length / expected)})  gaps ${issues.gaps.length}`,
    );
    console.log(
      `  dropped       ${synth.unmatchedNumerator.length} ${symbol} bars with no SOL counterpart ` +
      `(expected: SOL's own history is longer than ${symbol}'s in most cases)`,
    );
    if (issues.gaps.length / expected > 0.005) {
      console.log(
        `  WARNING: not essentially gapless (${pct(issues.gaps.length / expected)} of bars gapped) — ` +
        'review before trusting this token\'s funnel counts.',
      );
    }

    const cfg = screenTokenConfig(symbol);
    const funnel = computeEntryFunnel(stored, solCandles, cfg.tokens[0]!, cfg.global);
    console.log(
      `  reliable ${funnel.counts.reliable} -> priorOB ${funnel.counts.priorOverbought} -> crossUp ` +
      `${funnel.counts.rsiCrossUp} -> mfiConfirm ${funnel.counts.mfiConfirms} -> relStrength ` +
      `${funnel.counts.relativeStrengthPasses} -> regime ${funnel.counts.regimePasses}\n`,
    );

    rows.push({
      symbol, historyDays, listingStart: new Date(range.from).toISOString(),
      bars: stored.length, expected, gaps: issues.gaps.length,
      missingBars: issues.gaps.reduce((n, g) => n + g.missingBars, 0),
      droppedNoSolCounterpart: synth.unmatchedNumerator.length,
      counts: funnel.counts, crossUpEvents: funnel.crossUpEvents,
    });
  }
  db.close();

  console.log('=== SUMMARY ===');
  console.log('symbol   history(d)  listingStart          coverage    gaps  reliable  priorOB  crossUp  mfiConfirm  relStrength  regime');
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(8)} ${r.historyDays.toFixed(0).padStart(10)}  ${r.listingStart.slice(0, 10).padEnd(21)}` +
      `${pct(r.bars / r.expected).padStart(8)}  ${String(r.gaps).padStart(4)}  ` +
      `${String(r.counts.reliable).padStart(8)}  ${String(r.counts.priorOverbought).padStart(7)}  ` +
      `${String(r.counts.rsiCrossUp).padStart(7)}  ${String(r.counts.mfiConfirms).padStart(10)}  ` +
      `${String(r.counts.relativeStrengthPasses).padStart(12)}  ${String(r.counts.regimePasses).padStart(6)}`,
    );
  }

  const totalCrossUps = rows.reduce((n, r) => n + r.crossUpEvents.length, 0);
  console.log(`\n=== POOLED TOTAL: ${totalCrossUps} cross-up events across ${rows.length} tokens, full listed history ===`);
  if (totalCrossUps < 50) {
    console.log(
      `\n  Pooled count is UNDER 50. Per the operator's own threshold: this is not enough to run a\n` +
      '  backtest that could conclude anything about expectancy. Reporting the count, not proceeding.',
    );
  } else {
    console.log(`\n  Pooled count clears the 50-event threshold — a sweep can be designed against this sample.`);
  }

  const pooled = rows.flatMap((r) => r.crossUpEvents.map((e) => ({ symbol: r.symbol, ...e })));
  const byDay = new Map<string, { symbol: string }[]>();
  for (const e of pooled) {
    const day = new Date(e.timestamp).toISOString().slice(0, 10);
    const arr = byDay.get(day);
    if (arr === undefined) byDay.set(day, [{ symbol: e.symbol }]);
    else arr.push({ symbol: e.symbol });
  }
  console.log(`\ndistinct days with at least one cross-up: ${byDay.size} (${pooled.length} events total)`);
  const byToken = new Map<string, number>();
  for (const e of pooled) byToken.set(e.symbol, (byToken.get(e.symbol) ?? 0) + 1);
  console.log('events by token:', [...byToken.entries()].map(([s, n]) => `${s}=${n}`).join(', '));

  const daysSorted = [...byDay.entries()].sort(([, a], [, b]) => b.length - a.length);
  const multiEventDays = daysSorted.filter(([, evs]) => evs.length > 1);
  const eventsOnMultiDays = multiEventDays.reduce((n, [, evs]) => n + evs.length, 0);
  console.log(
    `days with MORE THAN ONE cross-up event: ${multiEventDays.length} ` +
    `(accounting for ${eventsOnMultiDays}/${pooled.length} events, ${pct(eventsOnMultiDays / pooled.length)})`,
  );
  if (daysSorted.length > 0) {
    const top10 = daysSorted.slice(0, 10).reduce((s, [, evs]) => s + evs.length, 0);
    console.log(`top 10 busiest days account for ${top10}/${pooled.length} events (${pct(top10 / pooled.length)})`);
    console.log('busiest days:');
    for (const [day, evs] of daysSorted.slice(0, 10)) {
      console.log(`  ${day} (${evs.length}): ${evs.map((e) => e.symbol).join(', ')}`);
    }
  }
  console.log(
    `\n  ${pooled.length} events on ${byDay.size} distinct days: the effective independent sample for\n` +
    `  judging expectancy is bounded above by the distinct-day count, not the raw event count, to the\n` +
    '  extent multiple tokens fire on the same day for the same reason (a shared SOL move). The busiest-\n' +
    '  days list above is what to check before trusting any per-trade statistic computed from this pool.',
  );
}

main().catch((err: unknown) => {
  console.error(`\nFAILED\n  ${formatErrorChain(err)}`);
  process.exitCode = 1;
});
