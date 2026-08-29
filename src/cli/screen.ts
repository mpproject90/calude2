/**
 * Screen a list of tokens cheaply — coverage, gaps, longest reliable stretch,
 * and the entry-condition funnel counts, for EVERY token in one run, with NO
 * backtest and no trades (DECISIONS §32). Built so the operator can see which
 * candidates are even testable before committing a full `data:fetch` +
 * `backtest` run to any one of them.
 *
 *   npm run data:screen -- --tokens "JTO:jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL,BONK:Dez...,..."
 *   npm run data:screen -- --tokens "..." --interval 1h --days 179
 *
 * CHEAP BY DESIGN: each token's pool is picked by current `reserveUsd`
 * (`resolveCheapestPool`), not the rigorous multi-candidate volume-dominance
 * comparison `data:fetch` does — one discovery request plus one pool's
 * pagination per token, not every candidate's. This is explicitly NOT the
 * pool a real fetch should trust (no dominance-migration check); it exists
 * to answer "is this token worth a rigorous fetch," not to produce data a
 * backtest should run on. The SOL/USD(C) reference is fetched ONCE and
 * shared across every token — pinned via `global.solReferencePoolAddress`
 * in config or `--sol-pool-address`, same as `data:fetch`.
 *
 * Every token still gets cached (schema v2, keyed by pool_address) so a
 * screened token that looks promising can go straight to `backtest` without
 * re-fetching — screen and fetch write to the same cache shape.
 */
import { openDb } from '../db/index.js';
import { CandleRepository } from '../data/repository.js';
import { validateCandles } from '../data/validate.js';
import { detectSeriesIssues } from '../data/gaps.js';
import { INTERVAL_MS, INTERVALS, type Candle, type Interval } from '../types/index.js';
import { GeckoTerminalCandleProvider, SOL_MINT, USDC_MINT, type RateLimitEvent } from '../data/providers/geckoterminal.js';
import { resolvePoolSeries, resolveCheapestPool } from '../data/poolResolution.js';
import { computeEntryFunnel, type CrossUpEvent } from '../backtest/funnel.js';
import { parseConfig } from '../config/load.js';
import { formatErrorChain } from '../util/errorChain.js';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

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

const tokensArg = arg('tokens');
const interval = arg('interval', '1h') as Interval;
const days = Number(arg('days', '179'));
const dbPath = arg('db', 'data/candles.db');

if (!INTERVALS.includes(interval)) throw new Error(`--interval must be one of ${INTERVALS.join(', ')}`);
if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');

interface TokenSpec { readonly symbol: string; readonly address: string }
const tokens: TokenSpec[] = tokensArg.split(',').map((pair) => {
  const [symbol, address] = pair.split(':');
  if (symbol === undefined || address === undefined) {
    throw new Error(`--tokens entry "${pair}" is not SYMBOL:MINT_ADDRESS`);
  }
  return { symbol: symbol.toUpperCase(), address };
});

const step = INTERVAL_MS[interval];
const to = Math.floor(Date.now() / step) * step - step;
const from = to - Math.round(days * 86_400_000);

function pct(n: number): string { return `${(n * 100).toFixed(2)}%`; }

function resolvePinnedSolPool(): string | null {
  const explicit = flag('sol-pool-address');
  if (explicit !== undefined) return explicit;
  try {
    const cfg = parseYaml(readFileSync('config/default.yaml', 'utf8')) as { global?: { solReferencePoolAddress?: string } };
    return cfg.global?.solReferencePoolAddress ?? null;
  } catch {
    return null;
  }
}

/** Screening-only TokenConfig: default RSI/MFI/entry parameters, this token's real mint. */
function screenTokenConfig(spec: TokenSpec) {
  return parseConfig({
    global: {},
    tokens: [{
      address: spec.address, symbol: spec.symbol, tier: 'A', timeframe: interval, buyAmountSol: '0.5',
      rsi: { period: 14, oversold: 30, overbought: 70 },
      mfi: { period: 14, threshold: 30 },
      entry: { priorOverboughtWithinCandles: 50, minUnderperformanceVsSol: 0.05, relativeStrengthLookback: 24 },
      exit: { stopLossPct: 15, timeExitCandles: 48, rsiExitLevel: 70 },
      limits: { minViableBuyAmountSol: '0.05' },
    }],
  });
}

function cacheOnly(repo: CandleRepository, token: string, candles: readonly Candle[], provider: string, poolAddress: string): Candle[] {
  const { valid, rejected } = validateCandles(candles, interval);
  if (rejected.length > 0) repo.recordRejected(token, interval, rejected, poolAddress);
  repo.upsertCandles(token, interval, valid, provider, poolAddress);
  repo.recordFetch(token, interval, from, to, provider, valid.length, poolAddress);
  const stored = repo.getCandles(token, interval, from, to, poolAddress);
  const issues = detectSeriesIssues(stored, interval);
  if (issues.gaps.length > 0) repo.recordGaps(token, interval, issues.gaps, poolAddress);
  return stored;
}

interface ScreenRow {
  readonly symbol: string;
  readonly pool: string | null;
  readonly bars: number;
  readonly expected: number;
  readonly gaps: number;
  readonly longestReliableStretch: number;
  readonly counts: ReturnType<typeof computeEntryFunnel>['counts'];
  readonly crossUpEvents: readonly CrossUpEvent[];
  readonly error: string | null;
}

async function main(): Promise<void> {
  console.log(`Screening ${tokens.length} tokens vs SOL, ${interval}, ${days}d — coverage/gaps/funnel only, no backtest.\n`);

  const pinnedSolPool = resolvePinnedSolPool();
  const onRateLimit = (e: RateLimitEvent): void => {
    console.log(`  rate limited (429), attempt ${e.attempt}/${e.maxAttempts}, waiting ${e.waitMs}ms`);
  };
  const geckoRef = new GeckoTerminalCandleProvider({ onRateLimit });
  const solPull = await resolvePoolSeries('SOL/USDC (shared reference)', SOL_MINT, USDC_MINT, geckoRef, pinnedSolPool, interval, from, to);
  console.log(`SOL/USDC reference pool: ${solPull.pool ?? 'NONE'}${solPull.pinned ? '  [PINNED]' : ''}\n`);
  if (solPull.candles.length === 0) {
    throw new Error('SOL/USDC reference series is empty — cannot screen anything without it');
  }

  const db = openDb(dbPath);
  const repo = new CandleRepository(db);
  const solCandles = cacheOnly(repo, 'SOL', solPull.candles, 'geckoterminal', solPull.pool ?? '');

  const rows: ScreenRow[] = [];
  const expected = Math.floor((to - from) / step) + 1;

  for (const spec of tokens) {
    console.log(`--- ${spec.symbol} (${spec.address}) ---`);
    const gecko = new GeckoTerminalCandleProvider({ onRateLimit });
    try {
      const pull = await resolveCheapestPool(spec.symbol, spec.address, SOL_MINT, gecko, interval, from, to);
      const stored = cacheOnly(repo, spec.symbol, pull.candles, 'geckoterminal', pull.pool ?? '');
      const cfg = screenTokenConfig(spec);
      const funnel = computeEntryFunnel(stored, solCandles, cfg.tokens[0]!, cfg.global);
      rows.push({
        symbol: spec.symbol, pool: pull.pool, bars: stored.length, expected,
        gaps: funnel.gaps, longestReliableStretch: funnel.longestReliableStretch,
        counts: funnel.counts, crossUpEvents: funnel.crossUpEvents, error: null,
      });
      console.log(
        `  bars ${stored.length}/${expected} (${pct(stored.length / expected)})  gaps ${funnel.gaps}  ` +
        `longest reliable stretch ${funnel.longestReliableStretch}`,
      );
      console.log(
        `  reliable ${funnel.counts.reliable} -> priorOB ${funnel.counts.priorOverbought} -> crossUp ` +
        `${funnel.counts.rsiCrossUp} -> mfiConfirm ${funnel.counts.mfiConfirms} -> relStrength ` +
        `${funnel.counts.relativeStrengthPasses} -> regime ${funnel.counts.regimePasses}`,
      );
    } catch (err) {
      rows.push({
        symbol: spec.symbol, pool: null, bars: 0, expected, gaps: 0, longestReliableStretch: 0,
        counts: { reliable: 0, priorOverbought: 0, rsiCrossUp: 0, mfiConfirms: 0, relativeStrengthPasses: 0, regimePasses: 0 },
        crossUpEvents: [], error: formatErrorChain(err),
      });
      console.log(`  FAILED: ${formatErrorChain(err)}`);
    }
  }
  db.close();

  console.log('\n=== SUMMARY ===');
  console.log('symbol   coverage    gaps  longestStretch  reliable  priorOB  crossUp  mfiConfirm  relStrength  regime');
  for (const r of rows) {
    if (r.error !== null) { console.log(`${r.symbol.padEnd(8)} FAILED: ${r.error.split('\n')[0]}`); continue; }
    console.log(
      `${r.symbol.padEnd(8)} ${pct(r.bars / r.expected).padStart(8)}  ${String(r.gaps).padStart(4)}  ` +
      `${String(r.longestReliableStretch).padStart(14)}  ${String(r.counts.reliable).padStart(8)}  ` +
      `${String(r.counts.priorOverbought).padStart(7)}  ${String(r.counts.rsiCrossUp).padStart(7)}  ` +
      `${String(r.counts.mfiConfirms).padStart(10)}  ${String(r.counts.relativeStrengthPasses).padStart(12)}  ` +
      `${String(r.counts.regimePasses).padStart(6)}`,
    );
  }

  // Pooled cross-up clustering (operator's explicit risk check): pooling
  // across correlated tokens is NOT the same as more independent samples —
  // if events cluster on the same days, the effective sample is much smaller
  // than the raw count.
  const pooled = rows.flatMap((r) => r.crossUpEvents.map((e) => ({ symbol: r.symbol, ...e })));
  console.log(`\n=== POOLED CROSS-UP CLUSTERING (${pooled.length} events across ${rows.length} tokens) ===`);
  const byDay = new Map<string, { symbol: string; timestamp: number }[]>();
  for (const e of pooled) {
    const day = new Date(e.timestamp).toISOString().slice(0, 10);
    const arr = byDay.get(day);
    if (arr === undefined) byDay.set(day, [{ symbol: e.symbol, timestamp: e.timestamp }]);
    else arr.push({ symbol: e.symbol, timestamp: e.timestamp });
  }
  const daysSorted = [...byDay.entries()].sort(([, a], [, b]) => b.length - a.length);
  console.log(`distinct days with at least one cross-up: ${byDay.size} (${pooled.length} events total)`);
  if (pooled.length > 0) {
    const top3 = daysSorted.slice(0, 3).reduce((s, [, evs]) => s + evs.length, 0);
    console.log(`top 3 busiest days account for ${top3}/${pooled.length} events (${pct(top3 / pooled.length)})`);
    console.log('busiest days:');
    for (const [day, evs] of daysSorted.slice(0, 5)) {
      console.log(`  ${day}: ${evs.map((e) => e.symbol).join(', ')}`);
    }
    if (byDay.size <= pooled.length / 2) {
      console.log(
        '\n  NOTE: multiple events share days — consistent with a shared SOL-driven move rather\n' +
        '  than independent, token-specific dislocations. The effective sample size for judging\n' +
        '  expectancy is closer to the distinct-day count than the raw event count.',
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(`\nFAILED\n  ${formatErrorChain(err)}`);
  process.exitCode = 1;
});
