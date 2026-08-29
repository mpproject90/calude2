/**
 * Event declustering (DECISIONS §35) — collapse events that fall within a
 * rolling window of each other into one cluster, so a pooled event count
 * across correlated tokens isn't quoted as if every event were independent.
 *
 * Built after the CEX study (§34) found real cross-token clustering in the
 * pooled RSI-cross-up events: on the busiest days, several different tokens
 * fired together, consistent with one shared SOL-wide move being counted
 * once per token rather than once per underlying episode.
 *
 * METHOD — CHAIN declustering, not fixed bins: events are sorted by time and
 * a new event joins the current cluster if it falls within `windowMs` of the
 * MOST RECENT event already in that cluster (not the cluster's first event).
 * This means a cluster's total span can exceed the window if events keep
 * arriving inside it — a "rolling" window that follows the stream, the
 * standard approach for this kind of runs-based declustering (e.g. seismic
 * aftershock declustering). A fixed-bin alternative (events within `windowMs`
 * of the cluster's FIRST event only) would systematically split a cluster
 * that runs slightly over one bin into two — chaining avoids that artifact.
 */

export interface ClusterableEvent {
  readonly timestamp: number;
  readonly token: string;
}

export interface Cluster<E extends ClusterableEvent = ClusterableEvent> {
  readonly events: readonly E[];
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly distinctTokens: number;
}

/** Chain-declusters `events` into clusters no two adjacent members of which are more than `windowMs` apart. */
export function decluster<E extends ClusterableEvent>(events: readonly E[], windowMs: number): Cluster<E>[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const clusters: Cluster<E>[] = [];
  let current: E[] = [];

  for (const e of sorted) {
    if (current.length === 0) {
      current = [e];
      continue;
    }
    const last = current[current.length - 1]!;
    if (e.timestamp - last.timestamp <= windowMs) {
      current.push(e);
    } else {
      clusters.push(toCluster(current));
      current = [e];
    }
  }
  if (current.length > 0) clusters.push(toCluster(current));
  return clusters;
}

function toCluster<E extends ClusterableEvent>(events: E[]): Cluster<E> {
  return {
    events,
    startTimestamp: events[0]!.timestamp,
    endTimestamp: events[events.length - 1]!.timestamp,
    distinctTokens: new Set(events.map((e) => e.token)).size,
  };
}

export interface DeclusterSummary {
  readonly windowDays: number;
  readonly rawEventCount: number;
  /** Effective sample size after declustering — the number of clusters. */
  readonly effectiveCount: number;
  /** Clusters spanning 3 or more distinct tokens — the direct measure of shared-driver contamination. */
  readonly threePlusTokenClusters: number;
}

const DAY_MS = 86_400_000;

/** Runs `decluster` at each window (in days) and summarizes the result. */
export function declusterAtWindows<E extends ClusterableEvent>(
  events: readonly E[], windowDays: readonly number[],
): DeclusterSummary[] {
  return windowDays.map((windowDays_) => {
    const clusters = decluster(events, windowDays_ * DAY_MS);
    return {
      windowDays: windowDays_,
      rawEventCount: events.length,
      effectiveCount: clusters.length,
      threePlusTokenClusters: clusters.filter((c) => c.distinctTokens >= 3).length,
    };
  });
}
