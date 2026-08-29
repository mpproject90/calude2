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
