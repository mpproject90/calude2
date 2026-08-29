/**
 * Fetch, validate, cache and report on real candles. This is the tool for
 * reviewing the data layer against live data before the backtest is built.
 *
 *   npm run data:fetch -- --symbol JUP --interval 1h --days 90
 *   npm run data:fetch -- --symbol JUP --interval 1h --days 179 --pool-address C8Gr...
 *   npm run data:fetch -- --symbol JUP --provider binance          # alternate, DECISIONS §18
 *
 * DEFAULT PROVIDER is GeckoTerminal (api.geckoterminal.com, free & keyless —
 * DECISIONS §18). It pulls the token's dominant pool against SOL directly:
 * real pool OHLC, no ratio synthesis, so DECISIONS §6's high/low-as-bounds
 * problem does not apply to this path. It also pulls an independent SOL/USDC
 * reference pool, still required by the regime and relative-strength filters
 * (DECISIONS §20). Requires outbound access to api.geckoterminal.com — no API
 * key. Needs the token's Solana mint address: pass `--address <mint>`, or add
 * the token to `config/default.yaml`'s `tokens[]` and it is looked up by
 * `--symbol`. **The free tier only serves the past 180 days** — a `--days`
 * value beyond that 401s (DECISIONS §29).
 *
 * POOL PINNING (DECISIONS §29/§30) — skip discovery and dominance comparison
 * entirely for a known-good pool:
 *   --pool-address <addr>      pins the traded token's pool for this run
 *   --sol-pool-address <addr>  pins the SOL/USD(C) reference pool
 * or set it once, reproducibly, in config: `tokens[].pinnedPoolAddress` and
 * `global.solReferencePoolAddress` — the CLI flag overrides the config value
 * when both are given. Pinning trades away this run's dominance-migration
 * check for a stable pool between runs and far fewer requests (no candidate
 * discovery/comparison), which is also what fixes the rate-limit-driven
 * pool-selection instability that caused real cache contamination (§29).
 *
 * `--provider binance` keeps the ORIGINAL path (DECISIONS §14): pulls
 * <SYMBOL>USDT and SOLUSDT and synthesizes <SYMBOL>/SOL, subject to DECISIONS
 * §6's high/low bounds. Binance is not regionally blocked for everyone, so it
 * stays available — just not the default. Requires outbound access to
 * api.binance.com instead.
 *
 * Neither provider has ever made a real request from inside this build — see
 * DECISIONS §14 and §18. This review is how both get verified: a raw sample
 * of the verbatim response is written alongside this build's parse of it, so
 * a shape mismatch can be diagnosed from actual data.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { openDb } from '../db/index.js';
import { createLogger } from '../util/logger.js';
import { formatErrorChain } from '../util/errorChain.js';
import { INTERVAL_MS, INTERVALS, type Candle, type Interval } from '../types/index.js';
import { CandleService } from '../data/index.js';
import { CandleRepository } from '../data/repository.js';
import { validateCandles } from '../data/validate.js';
import { detectSeriesIssues } from '../data/gaps.js';
import { BinanceCandleProvider, type RawSample as BinanceRawSample } from '../data/providers/binance.js';
import {
  GeckoTerminalCandleProvider, SOL_MINT, USDC_MINT,
  type PoolCandidate, type RateLimitEvent, type RawSample as GtRawSample,
} from '../data/providers/geckoterminal.js';
import { synthesizeRatioSeries, rangeWideningRatio } from '../data/synthesize.js';
import { selectDominantPool, type PoolDominanceResult, type PoolSeries } from '../data/poolSelection.js';
import { computeWickDiagnostics } from '../data/wickDiagnostics.js';

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
const interval = arg('interval', '1h') as Interval;
const days = Number(arg('days', '90'));
const dbPath = arg('db', 'data/candles.db');
const providerName = arg('provider', 'geckoterminal');
const rawSamplePath = arg('raw-sample', 'data/raw-sample.json');

if (!INTERVALS.includes(interval)) {
  throw new Error(`--interval must be one of ${INTERVALS.join(', ')}`);
}
if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
if (providerName !== 'geckoterminal' && providerName !== 'binance') {
  throw new Error(`--provider must be "geckoterminal" or "binance", got "${providerName}"`);
}

const step = INTERVAL_MS[interval];
const to = Math.floor(Date.now() / step) * step - step;   // last CLOSED bar
const from = to - Math.round(days * 86_400_000);

const log = createLogger('info');
const db = openDb(dbPath);

function pct(n: number): string { return `${(n * 100).toFixed(2)}%`; }
function fmt(n: number): string { return Number.isFinite(n) ? n.toFixed(2) : '∞'; }

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

function writeRawSample(samples: readonly unknown[], meta: Record<string, unknown>): void {
  if (samples.length === 0) {
    console.log('\nno raw sample captured (everything served from cache)');
    return;
  }
  mkdirSync(dirname(rawSamplePath), { recursive: true });
  writeFileSync(rawSamplePath, JSON.stringify({
    note: 'Verbatim provider response bodies (one per first request of each kind this run), ' +
          'plus this build\'s parse of row 0.',
    request: meta,
    samples,
  }, null, 2));
  console.log(`\nraw sample written to ${rawSamplePath}`);
}

// ---------------------------------------------------------------------------
// GeckoTerminal path (default) — DECISIONS §18, §19, §20, §23, §29, §30
// ---------------------------------------------------------------------------

interface LightConfig {
  readonly tokens?: readonly { symbol?: string; address?: string; pinnedPoolAddress?: string }[];
  readonly global?: { solReferencePoolAddress?: string };
}

function readLightConfig(): LightConfig {
  try {
    return parseYaml(readFileSync('config/default.yaml', 'utf8')) as LightConfig;
  } catch {
    return {};
  }
}

function resolveTokenAddress(sym: string, cfg: LightConfig): string {
  const explicit = flag('address');
  if (explicit !== undefined) return explicit;
  const entry = cfg.tokens?.find((t) => t.symbol === sym);
  if (entry?.address !== undefined) return entry.address;
  throw new Error(
    `no Solana mint address for "${sym}" — pass --address <mint>, or add it to ` +
    'config/default.yaml\'s tokens[] so it can be looked up by --symbol',
  );
}

/** CLI flag wins over config; both optional — null means "discover normally." */
function resolvePinnedTokenPool(sym: string, cfg: LightConfig): string | null {
  const explicit = flag('pool-address');
  if (explicit !== undefined) return explicit;
  return cfg.tokens?.find((t) => t.symbol === sym)?.pinnedPoolAddress ?? null;
}

function resolvePinnedSolPool(cfg: LightConfig): string | null {
  const explicit = flag('sol-pool-address');
  if (explicit !== undefined) return explicit;
  return cfg.global?.solReferencePoolAddress ?? null;
}

interface PoolResolution {
  readonly candles: readonly Candle[];
  readonly pool: string | null;
  readonly pinned: boolean;
  readonly candidates: readonly PoolCandidate[];
  readonly dominance: PoolDominanceResult | null;
}

async function resolvePoolSeries(
  label: string, tokenMint: string, pairedMint: string, gecko: GeckoTerminalCandleProvider,
  pinnedAddress: string | null,
): Promise<PoolResolution> {
  if (pinnedAddress !== null) {
    console.log(
      `\n${label}: PINNED to ${pinnedAddress} — pool discovery and dominance comparison ` +
      'SKIPPED for this run (DECISIONS §29/§30). Trading determinism and far fewer requests ' +
      'for the ability to notice a dominance shift.',
    );
    const candles = await gecko.getPoolOhlcv(pinnedAddress, interval, from, to);
    return { candles, pool: pinnedAddress, pinned: true, candidates: [], dominance: null };
  }

  const candidates = await gecko.searchPools(tokenMint, pairedMint);
  console.log(`\n${label} pool candidates: ${candidates.length}`);
  for (const c of candidates) {
    console.log(`  ${c.address}  dex=${c.dex}  createdAt=${c.createdAt ?? 'unknown'}  reserveUsdNow=${c.reserveUsd ?? 'unknown'}`);
  }
  if (candidates.length === 0) {
    throw new Error(`no ${label} pool found on GeckoTerminal — cannot proceed without a trading pair`);
  }

  // A single candidate's OHLCV fetch failing (e.g. an unresolved rate limit,
  // DECISIONS §24) should not sink the whole pull when other candidates
  // already succeeded — only fail closed if EVERY candidate fails.
  const series: PoolSeries[] = [];
  for (const c of candidates) {
    try {
      series.push({ address: c.address, candles: await gecko.getPoolOhlcv(c.address, interval, from, to) });
    } catch (err) {
      console.log(`  WARNING: ${c.address} (dex=${c.dex}) failed and is excluded from selection:`);
      console.log(`    ${formatErrorChain(err).split('\n').join('\n    ')}`);
    }
  }
  if (series.length === 0) {
    throw new Error(`all ${candidates.length} ${label} pool candidate(s) failed — cannot select a series`);
  }
  const dominance = selectDominantPool(series, interval);

  console.log(`${label} volume share by pool: ${JSON.stringify(dominance.volumeShareByPool)}`);
  if (dominance.migrated) {
    console.log(`${label} DOMINANCE MIGRATED mid-window:`);
    for (const p of dominance.dominancePeriods) {
      console.log(`  ${p.pool}  ${new Date(p.fromTimestamp).toISOString()} -> ${new Date(p.toTimestamp).toISOString()}`);
    }
    console.log(
      '  Using only the single highest-total-volume pool for the whole series (below) — the\n' +
      '  other pool\'s periods are NOT spliced in. Wherever the selected pool has no bars in\n' +
      '  those periods, that shows up as a gap, not a fabricated bar.',
    );
  }

  const winner = dominance.selected === null ? undefined : series.find((s) => s.address === dominance.selected);
  return { candles: winner?.candles ?? [], pool: dominance.selected, pinned: false, candidates, dominance };
}

function cacheAndReport(
  repo: CandleRepository, token: string, candles: readonly Candle[], provider: string, poolAddress: string,
): Candle[] {
  const { valid, rejected } = validateCandles(candles, interval);
  if (rejected.length > 0) {
    log.warn('rejected invalid candles', { token, count: rejected.length, reasons: [...new Set(rejected.map((r) => r.reason))] });
    repo.recordRejected(token, interval, rejected, poolAddress);
  }
  repo.upsertCandles(token, interval, valid, provider, poolAddress);
  repo.recordFetch(token, interval, from, to, provider, valid.length, poolAddress);

  const stored = repo.getCandles(token, interval, from, to, poolAddress);
  const issues = detectSeriesIssues(stored, interval);
  if (issues.gaps.length > 0) repo.recordGaps(token, interval, issues.gaps, poolAddress);

  report(token, stored, issues.gaps);
  console.log(`  rejected       ${repo.countRejected(token, interval, poolAddress)}`);
  return stored;
}

async function runGeckoTerminal(): Promise<void> {
  console.log(`Fetching ${symbol}/SOL and SOL/USDC from GeckoTerminal, ${interval}, ${days}d -> ${dbPath}`);
  console.log(
    '\nNOTE (schema v2, DECISIONS §29): the candle cache is keyed by (token, interval,\n' +
    'pool_address, timestamp) — two different pools\' candles for the same token/interval\n' +
    'coexist rather than one overwriting the other. --provider binance rows use pool_address\n' +
    '\'\' (not pool-based). Readers must know which pool_address they want; this CLI always does.',
  );

  const cfg = readLightConfig();
  const tokenAddress = resolveTokenAddress(symbol, cfg);
  const pinnedTokenPool = resolvePinnedTokenPool(symbol, cfg);
  const pinnedSolPool = resolvePinnedSolPool(cfg);
  const rawSamples: GtRawSample[] = [];
  const onRawSample = (s: GtRawSample): void => { rawSamples.push(s); };
  const onRateLimit = (e: RateLimitEvent): void => {
    console.log(
      `  rate limited (429), attempt ${e.attempt}/${e.maxAttempts}, ` +
      `Retry-After=${e.retryAfterHeader ?? '(not sent)'}, waiting ${e.waitMs}ms — ${e.url}`,
    );
  };

  const gecko = new GeckoTerminalCandleProvider({ onRawSample, onRateLimit });
  const geckoRef = new GeckoTerminalCandleProvider({ onRawSample, onRateLimit });

  // Tracked outside the try so the finally block can still write whatever raw
  // evidence and pool-selection metadata were captured even if the run fails
  // partway through (DECISIONS §24) — a failed run already spent real request
  // budget and should not also throw away the data it received for that cost.
  let tokenPool: string | null = null;
  let solPool: string | null = null;
  let tokenCandles: Candle[] = [];

  try {
    const tokenPull = await resolvePoolSeries(`${symbol}/SOL`, tokenAddress, SOL_MINT, gecko, pinnedTokenPool);
    tokenPool = tokenPull.pool;
    const solPull = await resolvePoolSeries('SOL/USDC', SOL_MINT, USDC_MINT, geckoRef, pinnedSolPool);
    solPool = solPull.pool;

    const repo = new CandleRepository(db);
    tokenCandles = cacheAndReport(repo, symbol, tokenPull.candles, 'geckoterminal', tokenPool ?? '');
    cacheAndReport(repo, 'SOL', solPull.candles, 'geckoterminal', solPool ?? '');

    console.log(`\n${symbol}/SOL selected pool: ${tokenPool ?? 'NONE — no pool traded in this window'}${tokenPull.pinned ? '  [PINNED — dominance comparison skipped]' : ''}`);
    console.log(`SOL/USDC selected pool: ${solPool ?? 'NONE — no pool traded in this window'}${solPull.pinned ? '  [PINNED — dominance comparison skipped]' : ''}`);

    const wick = computeWickDiagnostics(tokenCandles);
    console.log(`\n${symbol}/SOL wick/ATR diagnostics — the range-widening replacement (DECISIONS §23, §26):`);
    console.log(`  bars                          ${wick.bars}`);
    console.log(`  wick % of price p50/p90/p99/max   ${fmt(wick.wickToPricePct.p50)}% / ${fmt(wick.wickToPricePct.p90)}% / ${fmt(wick.wickToPricePct.p99)}% / ${fmt(wick.wickToPricePct.max)}%`);
    console.log(
      `  ATR-outlier bars (>${wick.atrOutlierMultiple}x ATR(14) outside the body)   ${wick.atrOutlierCount} of ` +
      `${wick.bars - wick.atrUnreliableCount} judged (${wick.atrUnreliableCount} still in ATR warm-up)`,
    );
    console.log(
      '\n  This is real pool OHLC, not synthesized — DECISIONS §6\'s high/low-BOUNDS problem does\n' +
      '  not apply here. A high outlier count instead means individual swaps (thin liquidity,\n' +
      '  one oversized trade) are producing phantom wicks that MFI\'s typical price and ATR\'s\n' +
      '  true range would treat as real. Review before trusting either on this token.',
    );
  } finally {
    writeRawSample(rawSamples, {
      symbol, interval, from, to, provider: 'geckoterminal', tokenPool, solPool,
      tokenPoolPinned: pinnedTokenPool !== null, solPoolPinned: pinnedSolPool !== null,
      parsedRow0: tokenCandles[0] ?? null,
      parsedRow0Iso: tokenCandles[0] === undefined ? null : new Date(tokenCandles[0].timestamp).toISOString(),
    });
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Binance path (alternate) — DECISIONS §6, §14, §18
// ---------------------------------------------------------------------------

async function runBinance(): Promise<void> {
  console.log(`Fetching ${symbol}USDT and SOLUSDT from Binance, ${interval}, ${days}d -> ${dbPath}`);

  let rawSample: BinanceRawSample | null = null;
  const provider = new BinanceCandleProvider({
    symbolMap: { [symbol]: `${symbol}USDT`, SOL: 'SOLUSDT' },
    onRawSample: (sample) => { rawSample = sample; },
  });
  const service = new CandleService({ provider, db, logger: log });

  const token = await service.getSeries(symbol, interval, from, to);
  const sol = await service.getSeries('SOL', interval, from, to);

  report(`${symbol}USDT`, token.candles, token.gaps);
  report('SOLUSDT', sol.candles, sol.gaps);

  const repo = service.repository;
  console.log(`\nrejected candles  ${symbol}: ${repo.countRejected(symbol, interval, '')}, ` +
              `SOL: ${repo.countRejected('SOL', interval, '')}`);

  const synth = synthesizeRatioSeries(token.candles, sol.candles);
  const synthIssues = detectSeriesIssues(synth.candles, interval);
  report(`${symbol}/SOL (synthesized)`, synth.candles, synthIssues.gaps);
  console.log(`  dropped        ${synth.unmatchedNumerator.length} unmatched ${symbol} bars, ` +
              `${synth.unmatchedDenominator.length} unmatched SOL bars`);
  console.log(`  range widening ${rangeWideningRatio(synth.candles).toFixed(2)}x vs |close-open|`);
  console.log(
    '\n  NOTE: synthesized open/close are EXACT (so RSI is exact). high/low are\n' +
    '  the widest possible BOUNDS, so ATR is biased high and MFI\'s typical price\n' +
    '  is approximate. Use the finest base timeframe you can to tighten them.',
  );

  if (rawSample !== null) {
    const sample: BinanceRawSample = rawSample;
    mkdirSync(dirname(rawSamplePath), { recursive: true });
    writeFileSync(rawSamplePath, JSON.stringify({
      note: 'Verbatim Binance klines response rows, with this build\'s parse of row 0.',
      request: { symbol: `${symbol}USDT`, interval, from, to },
      raw: sample,
      parsedRow0: token.candles[0] ?? null,
      parsedRow0Iso: token.candles[0] === undefined
        ? null : new Date(token.candles[0].timestamp).toISOString(),
    }, null, 2));
    console.log(`\nraw sample written to ${rawSamplePath}`);
  } else {
    console.log('\nno raw sample captured (everything served from cache)');
  }

  db.close();
}

const main = providerName === 'binance' ? runBinance : runGeckoTerminal;

main().catch((err: unknown) => {
  console.error(`\nFAILED\n  ${formatErrorChain(err)}`);
  process.exitCode = 1;
});
