/**
 * Pool selection for on-chain candle providers (DECISIONS §19).
 *
 * A token can trade on several pools against the same quote asset (e.g. a
 * JUP/SOL pool on Raydium and a separate one on Meteora), and which pool is
 * dominant can shift partway through the history we care about. Two options
 * were rejected:
 *
 *   - Pick "whatever has the most liquidity right now" and pull its full
 *     history. Wrong when that pool didn't exist, or was thin, for part of
 *     the window.
 *   - Silently splice multiple pools into one continuous series. This is the
 *     same failure mode `gaps.ts` already refuses for missing bars: a
 *     stitched series is indistinguishable downstream from a real one, but
 *     isn't.
 *
 * Instead: pick the single pool with the highest time-weighted dominance
 * over the requested window and use ONLY that pool's candles. Wherever that
 * pool has no data (didn't exist yet, or went quiet), the result is a
 * genuine gap — reported via the existing `CandleGap` machinery, never
 * backfilled from a different pool. If dominance visibly shifted to another
 * pool for a meaningful stretch, that is reported as a fact for the operator
 * to review, not resolved automatically.
 *
 * DEVIATION FROM "LIQUIDITY": the free GeckoTerminal/DexPaprika surfaces
 * expose a pool's CURRENT reserve/liquidity but no historical liquidity time
 * series, so "time-weighted liquidity" as literally specified is not
 * obtainable without a paid data source. This uses TRADED VOLUME per bar as
 * the dominance signal instead — it is available historically (every OHLCV
 * bar carries it) and arguably measures the thing we actually care about
 * more directly than TVL does: where real price discovery happened, not
 * where capital was merely parked. Flagged explicitly rather than silently
 * relabelling liquidity as volume.
 */
import type { Candle, Interval } from '../types/index.js';

/**
 * Granularity for the "locally dominant pool" walk, independent of the
 * candle interval. FOUND BY RUNNING THIS AGAINST REAL DATA (DECISIONS §25):
 * comparing raw per-BAR volume between two consistently active pools (a
 * 51%/34% split, in the case that surfaced this) flips the "leader" almost
 * every bar — 881 reported "dominance periods" over a 90-day 1h window, none
 * of them a real migration. Bucketing to a day smooths that noise while still
 * catching a genuine multi-day shift in where trading happens.
 */
const DOMINANCE_BUCKET_MS = 24 * 60 * 60 * 1000;

export interface PoolSeries {
  readonly address: string;
  readonly candles: readonly Candle[];
}

export interface DominancePeriod {
  readonly pool: string;
  readonly fromTimestamp: number;
  readonly toTimestamp: number;
}

export interface PoolCoverage {
  readonly firstTimestamp: number;
  readonly lastTimestamp: number;
  readonly bars: number;
}

export interface PoolDominanceResult {
  /** The pool to use as the single source of truth, or null if none traded at all. */
  readonly selected: string | null;
  /** Each pool's share of total traded volume across the window, 0..1. */
  readonly volumeShareByPool: Readonly<Record<string, number>>;
  readonly coverageByPool: Readonly<Record<string, PoolCoverage>>;
  /** True when the day-bucketed dominant pool changed at least once across the window. */
  readonly migrated: boolean;
  /** Contiguous stretches of days during which each pool led on volume. */
  readonly dominancePeriods: readonly DominancePeriod[];
}

/**
 * Selects the pool with the highest total traded volume across the window as
 * the series to use, and separately reports whether the LOCALLY dominant pool
 * (by day-bucketed volume — see `DOMINANCE_BUCKET_MS`) ever changed — i.e.
 * whether trading activity visibly migrated — without acting on that fact.
 *
 * Ties (including "nobody traded this bucket") are broken by input order, so
 * the result is deterministic given the same input.
 */
export function selectDominantPool(
  series: readonly PoolSeries[],
  _interval: Interval,
): PoolDominanceResult {
  const volumeShareByPool: Record<string, number> = {};
  const coverageByPool: Record<string, PoolCoverage> = {};
  const totalVolumeByPool: Record<string, number> = {};
  let grandTotal = 0;

  for (const s of series) {
    let total = 0;
    for (const c of s.candles) total += Math.max(0, c.volume);
    totalVolumeByPool[s.address] = total;
    grandTotal += total;
    if (s.candles.length > 0) {
      coverageByPool[s.address] = {
        firstTimestamp: s.candles[0]!.timestamp,
        lastTimestamp: s.candles[s.candles.length - 1]!.timestamp,
        bars: s.candles.length,
      };
    }
  }

  for (const s of series) {
    volumeShareByPool[s.address] = grandTotal > 0 ? (totalVolumeByPool[s.address] ?? 0) / grandTotal : 0;
  }

  // Bucket every pool's bars into day-sized buckets (independent of the
  // candle interval) and compare TOTAL volume per bucket, not per bar — see
  // the DOMINANCE_BUCKET_MS comment above for why per-bar comparison is
  // wrong. Each bucket also tracks the real min/max bar timestamp it
  // contains, so a reported period's boundaries are actual observed bars,
  // never a fabricated bucket edge.
  interface Bucket {
    volumeByPool: Map<string, number>;
    minTimestamp: number;
    maxTimestamp: number;
  }
  const buckets = new Map<number, Bucket>();
  for (const s of series) {
    for (const c of s.candles) {
      const key = Math.floor(c.timestamp / DOMINANCE_BUCKET_MS);
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { volumeByPool: new Map(), minTimestamp: c.timestamp, maxTimestamp: c.timestamp };
        buckets.set(key, bucket);
      } else {
        if (c.timestamp < bucket.minTimestamp) bucket.minTimestamp = c.timestamp;
        if (c.timestamp > bucket.maxTimestamp) bucket.maxTimestamp = c.timestamp;
      }
      bucket.volumeByPool.set(s.address, (bucket.volumeByPool.get(s.address) ?? 0) + Math.max(0, c.volume));
    }
  }
  const orderedBucketKeys = [...buckets.keys()].sort((a, b) => a - b);

  const dominancePeriods: DominancePeriod[] = [];
  let currentPool: string | null = null;
  let periodStart: number | null = null;
  let periodEnd: number | null = null;

  for (const key of orderedBucketKeys) {
    const bucket = buckets.get(key)!;
    let leader: string | null = null;
    let leaderVolume = -1;
    for (const s of series) {
      const v = bucket.volumeByPool.get(s.address) ?? 0;
      if (v > leaderVolume) {
        leaderVolume = v;
        leader = s.address;
      }
    }
    if (leader !== currentPool) {
      if (currentPool !== null && periodStart !== null && periodEnd !== null) {
        dominancePeriods.push({ pool: currentPool, fromTimestamp: periodStart, toTimestamp: periodEnd });
      }
      currentPool = leader;
      periodStart = bucket.minTimestamp;
    }
    periodEnd = bucket.maxTimestamp;
  }
  if (currentPool !== null && periodStart !== null && periodEnd !== null) {
    dominancePeriods.push({ pool: currentPool, fromTimestamp: periodStart, toTimestamp: periodEnd });
  }

  const selected = series
    .slice()
    .sort((a, b) => (totalVolumeByPool[b.address] ?? 0) - (totalVolumeByPool[a.address] ?? 0))[0];
  const selectedAddress = selected !== undefined && (totalVolumeByPool[selected.address] ?? 0) > 0
    ? selected.address
    : null;

  return {
    selected: selectedAddress,
    volumeShareByPool,
    coverageByPool,
    migrated: new Set(dominancePeriods.map((p) => p.pool)).size > 1,
    dominancePeriods,
  };
}
