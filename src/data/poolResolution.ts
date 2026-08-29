/**
 * Resolve which GeckoTerminal pool's candles to use for a token/paired-asset
 * series — shared by `data:fetch` (rigorous, dominance-based) and
 * `data:screen` (cheap, reserve-based) so the logic isn't duplicated between
 * the two CLIs. DECISIONS §29/§30/§32.
 */
import type { Candle, Interval } from '../types/index.js';
import {
  GeckoTerminalCandleProvider, type PoolCandidate,
} from './providers/geckoterminal.js';
import { selectDominantPool, type PoolDominanceResult, type PoolSeries } from './poolSelection.js';
import { formatErrorChain } from '../util/errorChain.js';

export interface PoolResolution {
  readonly candles: readonly Candle[];
  readonly pool: string | null;
  readonly pinned: boolean;
  readonly candidates: readonly PoolCandidate[];
  readonly dominance: PoolDominanceResult | null;
}

export type Logger = (msg: string) => void;
const defaultLog: Logger = (msg) => console.log(msg);

/**
 * Rigorous resolution: discover every candidate, fetch each one's FULL
 * OHLCV, and pick the highest-total-volume pool (DECISIONS §19) — or skip
 * all of that and fetch a pinned pool directly (DECISIONS §29/§30). This is
 * the `data:fetch` path; expensive in requests (every candidate's full
 * pagination), which is exactly what makes pinning worth it under the free
 * tier's rate limit.
 */
export async function resolvePoolSeries(
  label: string, tokenMint: string, pairedMint: string, gecko: GeckoTerminalCandleProvider,
  pinnedAddress: string | null, interval: Interval, from: number, to: number, log: Logger = defaultLog,
): Promise<PoolResolution> {
  if (pinnedAddress !== null) {
    log(
      `\n${label}: PINNED to ${pinnedAddress} — pool discovery and dominance comparison ` +
      'SKIPPED for this run (DECISIONS §29/§30). Trading determinism and far fewer requests ' +
      'for the ability to notice a dominance shift.',
    );
    const candles = await gecko.getPoolOhlcv(pinnedAddress, interval, from, to);
    return { candles, pool: pinnedAddress, pinned: true, candidates: [], dominance: null };
  }

  const candidates = await gecko.searchPools(tokenMint, pairedMint);
  log(`\n${label} pool candidates: ${candidates.length}`);
  for (const c of candidates) {
    log(`  ${c.address}  dex=${c.dex}  createdAt=${c.createdAt ?? 'unknown'}  reserveUsdNow=${c.reserveUsd ?? 'unknown'}`);
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
      log(`  WARNING: ${c.address} (dex=${c.dex}) failed and is excluded from selection:`);
      log(`    ${formatErrorChain(err).split('\n').join('\n    ')}`);
    }
  }
  if (series.length === 0) {
    throw new Error(`all ${candidates.length} ${label} pool candidate(s) failed — cannot select a series`);
  }
  const dominance = selectDominantPool(series, interval);

  log(`${label} volume share by pool: ${JSON.stringify(dominance.volumeShareByPool)}`);
  if (dominance.migrated) {
    log(`${label} DOMINANCE MIGRATED mid-window:`);
    for (const p of dominance.dominancePeriods) {
      log(`  ${p.pool}  ${new Date(p.fromTimestamp).toISOString()} -> ${new Date(p.toTimestamp).toISOString()}`);
    }
    log(
      '  Using only the single highest-total-volume pool for the whole series (below) — the\n' +
      '  other pool\'s periods are NOT spliced in. Wherever the selected pool has no bars in\n' +
      '  those periods, that shows up as a gap, not a fabricated bar.',
    );
  }

  const winner = dominance.selected === null ? undefined : series.find((s) => s.address === dominance.selected);
  return { candles: winner?.candles ?? [], pool: dominance.selected, pinned: false, candidates, dominance };
}

/**
 * Cheap resolution for `data:screen` (DECISIONS §32): discover candidates,
 * pick the one with the highest CURRENT `reserveUsd` (a snapshot, not a
 * historical volume comparison — deliberately not the rigorous path above),
 * and fetch OHLCV for ONLY that one pool. One discovery request plus one
 * pool's pagination, instead of every candidate's full pagination — the
 * point of a screen is to be cheap enough to run across many tokens.
 *
 * This is NOT a substitute for `resolvePoolSeries`/pinning before a real
 * `data:fetch` — it has no dominance-migration check and current reserve
 * size is not the same claim as historical volume dominance. It exists to
 * answer "is this token even worth a rigorous fetch," not to produce the
 * series a backtest should trust.
 */
export async function resolveCheapestPool(
  label: string, tokenMint: string, pairedMint: string, gecko: GeckoTerminalCandleProvider,
  interval: Interval, from: number, to: number, log: Logger = defaultLog,
): Promise<PoolResolution> {
  const candidates = await gecko.searchPools(tokenMint, pairedMint);
  if (candidates.length === 0) {
    throw new Error(`no ${label} pool found on GeckoTerminal — cannot proceed without a trading pair`);
  }
  const ranked = candidates.slice().sort((a, b) => (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1));
  const chosen = ranked[0]!;
  log(
    `${label}: ${candidates.length} candidates, chose ${chosen.address} (dex=${chosen.dex}, ` +
    `reserveUsdNow=${chosen.reserveUsd ?? 'unknown'}, createdAt=${chosen.createdAt ?? 'unknown'}) ` +
    'by current reserve size — no dominance/migration check (DECISIONS §32).',
  );
  const candles = await gecko.getPoolOhlcv(chosen.address, interval, from, to);
  return { candles, pool: chosen.address, pinned: false, candidates, dominance: null };
}
