/**
 * Paper-trading persistence (DECISIONS §41, schema v3). Every SOL amount
 * here is stored as (raw bigint TEXT, decimals INTEGER) — never REAL — per
 * spec §2.5. One `size_decimals` column per row covers every TokenAmount
 * field in that row: everything in this system is SOL-denominated, so a
 * single shared decimals value is not a simplification that loses
 * anything, just fewer redundant columns.
 *
 * `openPosition`/`updatePosition`/`closePosition` mutate the resumable
 * state; `recordFill` and `recordEvent` are append-only, immutable audit
 * records — "this is the record I'll be reading."
 */
import type { Db } from '../db/index.js';
import { TokenAmount } from '../util/amount.js';
import type { LadderExitConfig } from '../config/schema.js';

export interface PersistedPaperPosition {
  readonly id: string;
  readonly symbol: string;
  readonly address: string;
  readonly poolAddress: string;
  readonly entryPrice: number;
  readonly entryTimestamp: number;
  readonly originalSizeSol: TokenAmount;
  readonly remainingSizeSol: TokenAmount;
  readonly filledTrancheCount: number;
  readonly peakPrice: number;
  readonly trailingArmed: boolean;
  readonly stopLossPrice: number;
  readonly ladderConfig: LadderExitConfig;
}

export interface OpenPositionInput {
  readonly id: string;
  readonly symbol: string;
  readonly address: string;
  readonly poolAddress: string;
  readonly entryPrice: number;
  readonly entryTimestamp: number;
  readonly originalSizeSol: TokenAmount;
  readonly peakPrice: number;
  readonly stopLossPrice: number;
  readonly ladderConfig: LadderExitConfig;
}

export interface UpdatePositionInput {
  readonly remainingSizeSol: TokenAmount;
  readonly filledTrancheCount: number;
  readonly peakPrice: number;
  readonly trailingArmed: boolean;
}

export type FillKind = 'entry' | 'take_profit' | 'trailing' | 'stop_loss' | 'time';

export interface RecordFillInput {
  readonly positionId: string;
  readonly kind: FillKind;
  readonly trancheIndex: number | null;
  readonly triggerPrice: number;
  readonly fillPrice: number;
  readonly sizeSol: TokenAmount;
  readonly grossPnlSol: TokenAmount | null;
  readonly dexFeeSol: TokenAmount;
  readonly fixedFeeSol: TokenAmount;
  readonly netPnlSol: TokenAmount | null;
  readonly positionSnapshot: unknown;
  readonly filledAt: number;
}

export type EventKind = 'stale_feed' | 'feed_error' | 'restart' | 'resume' | 'entry_skipped';

export interface RecordEventInput {
  readonly symbol: string | null;
  readonly kind: EventKind;
  readonly detail: string;
  readonly occurredAt: number;
}

export type FeedTickOutcome = 'usable' | 'stale' | 'error';

export interface FeedStats {
  readonly symbol: string;
  readonly usableCount: number;
  readonly staleCount: number;
  readonly errorCount: number;
  /** null when the feed is not currently in a blind streak. */
  readonly blindStreakStartedAt: number | null;
  readonly longestBlindStreakMs: number;
  readonly longestBlindStreakEndedAt: number | null;
  readonly lastTickAt: number | null;
}

function amountOrNull(a: TokenAmount | null): string | null {
  return a === null ? null : a.raw.toString();
}

export class PaperStore {
  constructor(private readonly db: Db) {}

  openPosition(input: OpenPositionInput): void {
    this.db.prepare(
      `INSERT INTO paper_positions
         (id, symbol, address, pool_address, status, entry_price, entry_timestamp,
          original_size_raw, remaining_size_raw, size_decimals, filled_tranche_count,
          peak_price, trailing_armed, stop_loss_price, ladder_config, created_at, updated_at)
       VALUES (?,?,?,?,'open',?,?,?,?,?,0,?,0,?,?,?,?)`,
    ).run(
      input.id, input.symbol, input.address, input.poolAddress, input.entryPrice, input.entryTimestamp,
      input.originalSizeSol.raw.toString(), input.originalSizeSol.raw.toString(), input.originalSizeSol.decimals,
      input.peakPrice, input.stopLossPrice, JSON.stringify(input.ladderConfig), input.entryTimestamp, input.entryTimestamp,
    );
  }

  updatePosition(id: string, input: UpdatePositionInput, updatedAt: number): void {
    this.db.prepare(
      `UPDATE paper_positions SET
         remaining_size_raw = ?, filled_tranche_count = ?, peak_price = ?,
         trailing_armed = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.remainingSizeSol.raw.toString(), input.filledTrancheCount, input.peakPrice,
      input.trailingArmed ? 1 : 0, updatedAt, id,
    );
  }

  closePosition(id: string, closedAt: number): void {
    this.db.prepare(
      `UPDATE paper_positions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(closedAt, closedAt, id);
  }

  recordFill(input: RecordFillInput): void {
    this.db.prepare(
      `INSERT INTO paper_fills
         (position_id, kind, tranche_index, trigger_price, fill_price, size_raw, size_decimals,
          gross_pnl_sol_raw, dex_fee_sol_raw, fixed_fee_sol_raw, net_pnl_sol_raw,
          position_snapshot, filled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.positionId, input.kind, input.trancheIndex, input.triggerPrice, input.fillPrice,
      input.sizeSol.raw.toString(), input.sizeSol.decimals,
      amountOrNull(input.grossPnlSol), input.dexFeeSol.raw.toString(), input.fixedFeeSol.raw.toString(),
      amountOrNull(input.netPnlSol), JSON.stringify(input.positionSnapshot), input.filledAt,
    );
  }

  recordEvent(input: RecordEventInput): void {
    this.db.prepare(
      `INSERT INTO paper_events (symbol, kind, detail, occurred_at) VALUES (?,?,?,?)`,
    ).run(input.symbol, input.kind, input.detail, input.occurredAt);
  }

  private readFeedStats(symbol: string): FeedStats {
    const row = this.db
      .prepare<[string], {
        symbol: string; usableCount: number; staleCount: number; errorCount: number;
        blindStreakStartedAt: number | null; longestBlindStreakMs: number;
        longestBlindStreakEndedAt: number | null; lastTickAt: number | null;
      }>(
        `SELECT symbol, usable_count AS "usableCount", stale_count AS "staleCount",
                error_count AS "errorCount", blind_streak_started_at AS "blindStreakStartedAt",
                longest_blind_streak_ms AS "longestBlindStreakMs",
                longest_blind_streak_ended_at AS "longestBlindStreakEndedAt",
                last_tick_at AS "lastTickAt"
         FROM paper_feed_stats WHERE symbol = ?`,
      )
      .get(symbol);
    if (row !== undefined) return row;
    return {
      symbol, usableCount: 0, staleCount: 0, errorCount: 0,
      blindStreakStartedAt: null, longestBlindStreakMs: 0, longestBlindStreakEndedAt: null, lastTickAt: null,
    };
  }

  /**
   * Cumulative price-feed reliability tallies (DECISIONS §41), one upserted
   * row per symbol so a Task Scheduler restart never resets the count. A gap
   * since the last recorded tick larger than `normalPollGapMs` (the task was
   * down between a crash and its restart, not just a slow poll) counts
   * toward the blind streak too — a stop is exactly as blind during downtime
   * as during an in-process feed error.
   */
  recordFeedTick(input: {
    symbol: string; outcome: FeedTickOutcome; nowMs: number; normalPollGapMs: number;
  }): FeedStats {
    const { symbol, outcome, nowMs, normalPollGapMs } = input;
    const existing = this.readFeedStats(symbol);

    let blindStreakStartedAt = existing.blindStreakStartedAt;
    let longestBlindStreakMs = existing.longestBlindStreakMs;
    let longestBlindStreakEndedAt = existing.longestBlindStreakEndedAt;
    let { usableCount, staleCount, errorCount } = existing;

    const gapSinceLastTick = existing.lastTickAt === null ? 0 : nowMs - existing.lastTickAt;
    if (gapSinceLastTick > normalPollGapMs && blindStreakStartedAt === null) {
      // Unexplained downtime since the last tick, and we were not already
      // mid-streak — the gap itself becomes the start of a blind streak,
      // backdated to the last moment we actually had a price.
      blindStreakStartedAt = existing.lastTickAt;
    }

    if (outcome === 'usable') {
      if (blindStreakStartedAt !== null) {
        const duration = nowMs - blindStreakStartedAt;
        if (duration > longestBlindStreakMs) { longestBlindStreakMs = duration; longestBlindStreakEndedAt = nowMs; }
      }
      blindStreakStartedAt = null;
      usableCount += 1;
    } else {
      if (blindStreakStartedAt === null) blindStreakStartedAt = nowMs;
      const duration = nowMs - blindStreakStartedAt;
      if (duration > longestBlindStreakMs) { longestBlindStreakMs = duration; longestBlindStreakEndedAt = nowMs; }
      if (outcome === 'stale') staleCount += 1; else errorCount += 1;
    }

    const next: FeedStats = {
      symbol, usableCount, staleCount, errorCount,
      blindStreakStartedAt, longestBlindStreakMs, longestBlindStreakEndedAt, lastTickAt: nowMs,
    };
    this.db.prepare(
      `INSERT INTO paper_feed_stats
         (symbol, usable_count, stale_count, error_count, blind_streak_started_at,
          longest_blind_streak_ms, longest_blind_streak_ended_at, last_tick_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol) DO UPDATE SET
         usable_count = excluded.usable_count, stale_count = excluded.stale_count,
         error_count = excluded.error_count, blind_streak_started_at = excluded.blind_streak_started_at,
         longest_blind_streak_ms = excluded.longest_blind_streak_ms,
         longest_blind_streak_ended_at = excluded.longest_blind_streak_ended_at,
         last_tick_at = excluded.last_tick_at, updated_at = excluded.updated_at`,
    ).run(
      symbol, usableCount, staleCount, errorCount, blindStreakStartedAt,
      longestBlindStreakMs, longestBlindStreakEndedAt, nowMs, nowMs,
    );
    return next;
  }

  getFeedStats(symbol: string): FeedStats {
    return this.readFeedStats(symbol);
  }

  /** Every currently-open position — this is what a restart resumes from. */
  loadOpenPositions(): PersistedPaperPosition[] {
    const rows = this.db
      .prepare<[], {
        id: string; symbol: string; address: string; poolAddress: string;
        entryPrice: number; entryTimestamp: number;
        originalSizeRaw: string; remainingSizeRaw: string; sizeDecimals: number;
        filledTrancheCount: number; peakPrice: number; trailingArmed: number;
        stopLossPrice: number; ladderConfig: string;
      }>(
        `SELECT id, symbol, address, pool_address AS "poolAddress",
                entry_price AS "entryPrice", entry_timestamp AS "entryTimestamp",
                original_size_raw AS "originalSizeRaw", remaining_size_raw AS "remainingSizeRaw",
                size_decimals AS "sizeDecimals", filled_tranche_count AS "filledTrancheCount",
                peak_price AS "peakPrice", trailing_armed AS "trailingArmed",
                stop_loss_price AS "stopLossPrice", ladder_config AS "ladderConfig"
         FROM paper_positions WHERE status = 'open'`,
      )
      .all();
    return rows.map((r) => ({
      id: r.id, symbol: r.symbol, address: r.address, poolAddress: r.poolAddress,
      entryPrice: r.entryPrice, entryTimestamp: r.entryTimestamp,
      originalSizeSol: TokenAmount.fromRaw(BigInt(r.originalSizeRaw), r.sizeDecimals),
      remainingSizeSol: TokenAmount.fromRaw(BigInt(r.remainingSizeRaw), r.sizeDecimals),
      filledTrancheCount: r.filledTrancheCount, peakPrice: r.peakPrice,
      trailingArmed: r.trailingArmed !== 0, stopLossPrice: r.stopLossPrice,
      ladderConfig: JSON.parse(r.ladderConfig) as LadderExitConfig,
    }));
  }

  getOpenPosition(symbol: string): PersistedPaperPosition | null {
    return this.loadOpenPositions().find((p) => p.symbol === symbol) ?? null;
  }
}
