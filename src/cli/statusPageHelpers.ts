/**
 * Pure, side-effect-free helpers for statusPage.ts (DECISIONS §43) — split
 * out specifically so they're unit-testable. statusPage.ts itself runs
 * top-level (open db, read files, write output) the moment it's imported,
 * like every other CLI entrypoint in this codebase — importing it from a
 * test would trigger all of that. These functions do none of it.
 */

export interface LogTick {
  readonly timestamp: number;
  readonly symbol: string;
  readonly kind: 'price' | 'error' | 'stale';
  readonly price: number | null;
}

export interface Gap {
  readonly startTs: number;
  readonly endTs: number;
  readonly durationMs: number;
}

/** Largest gaps first. A "gap" is any consecutive-tick delta exceeding `thresholdMs`. */
export function computeGaps(ticks: readonly LogTick[], thresholdMs: number): Gap[] {
  const sorted = [...ticks].sort((a, b) => a.timestamp - b.timestamp);
  const gaps: Gap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i]!.timestamp - sorted[i - 1]!.timestamp;
    if (dt > thresholdMs) gaps.push({ startTs: sorted[i - 1]!.timestamp, endTs: sorted[i]!.timestamp, durationMs: dt });
  }
  return gaps.sort((a, b) => b.durationMs - a.durationMs);
}

/** `1d 22h 3m` style — days/hours omitted when zero, minutes always shown. Negative durations clamp to `0s` rather than printing something nonsensical like "-1d". */
export function fmtDuration(ms: number): string {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export function fmtPct(p: number): string {
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

export function fmtPrice(p: number): string {
  return p.toFixed(8);
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Splits a time-ordered series of price ticks into segments wherever a
 * gap exceeds `thresholdMs` — used so the chart draws a visible BREAK
 * across a blind streak instead of one continuous line implying data that
 * doesn't exist. Assumes `ticks` is already sorted ascending by timestamp
 * (the caller controls that; this stays a pure array-partition, no sort of
 * its own, so it can't silently reorder a caller's already-sorted input).
 */
export function splitIntoSegments<T extends { timestamp: number }>(ticks: readonly T[], thresholdMs: number): T[][] {
  if (ticks.length === 0) return [];
  const segments: T[][] = [];
  let current: T[] = [ticks[0]!];
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i]!.timestamp - ticks[i - 1]!.timestamp > thresholdMs) {
      segments.push(current);
      current = [];
    }
    current.push(ticks[i]!);
  }
  segments.push(current);
  return segments;
}
