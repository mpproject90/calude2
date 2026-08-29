/**
 * Exit replay (DECISIONS §38) — take an ALREADY-KNOWN entry (index, price)
 * and walk the SAME candle path forward under a different exit rule, without
 * re-running entry logic. Built specifically so an alternative-exit
 * comparison cannot change which trades exist: entry evaluation in
 * `runBacktest` only resumes once a position closes, so re-running the whole
 * engine with a different exit config CAN silently add or remove trades if
 * an exit fires earlier or later than the original (freeing up, or using up,
 * bars the original run's entry scan never saw as "flat"). Replaying a fixed
 * list of known entries in isolation avoids that entirely — by construction,
 * every variant is evaluated against exactly the same 10 entries.
 *
 * Reuses the REAL exit primitives (`evaluateIntrabarStops`, `evaluateExit`)
 * unchanged for stop-loss, trailing-stop, RSI-recovery and time — the only
 * new concept is a fixed take-profit target, which has no schema field
 * (deliberately not added to config/schema.ts — this is a one-off diagnostic
 * per operator direction, "no tuning, no sweep, no parameter changes," not a
 * new strategy feature). Take-profit is checked intrabar at the same
 * priority tier as trailing: after the hard stop-loss, before RSI/time.
 */
import type { Candle, IndicatorValue } from '../types/index.js';
import type { TokenConfig } from '../config/schema.js';
import {
  evaluateIntrabarStops, evaluateExit, stopLossPriceFor, type OpenPosition, type ExitReason,
} from '../rules/exit.js';

export interface ExitVariant {
  readonly label: string;
  readonly stopLossPct: number;
  readonly timeExitCandles: number;
  readonly rsiExitLevel: number;
  readonly trailing: { readonly enabled: boolean; readonly activateAtPct: number; readonly trailPct: number };
  /** Fixed take-profit target as a decimal percent gain, or null to disable. */
  readonly takeProfitPct: number | null;
}

export type ReplayExitReason = ExitReason | 'take_profit';

export interface ReplayedExit {
  readonly exitIndex: number;
  readonly exitReason: ReplayExitReason;
  readonly exitPrice: number;
  readonly barsHeld: number;
  readonly grossPnlPct: number;
}

function fillAfterSlippage(triggerPrice: number, slippagePct: number): number {
  return triggerPrice * (1 - slippagePct / 100);
}

/**
 * Replays ONE known entry under `variant`'s exit rule, capped at
 * `variant.timeExitCandles` bars — the same ceiling for every variant, so
 * "same bars" holds: no variant can see further into the future than the
 * control's original 48-candle window.
 */
export function replayExit(
  candles: readonly Candle[], rsi: readonly IndicatorValue[],
  entryIndex: number, entryPrice: number, tokenTemplate: TokenConfig,
  variant: ExitVariant, exitSlippagePct: number,
): ReplayedExit {
  const token: TokenConfig = {
    ...tokenTemplate,
    exit: {
      ...tokenTemplate.exit,
      stopLossPct: variant.stopLossPct,
      timeExitCandles: variant.timeExitCandles,
      rsiExitLevel: variant.rsiExitLevel,
      trailingStop: variant.trailing,
    },
  };
  let position: OpenPosition = {
    entryPrice, entryIndex, peakPrice: entryPrice, trailingArmed: false,
    stopLossPrice: stopLossPriceFor(entryPrice, variant.stopLossPct),
  };
  const takeProfitPrice = variant.takeProfitPct === null ? null : entryPrice * (1 + variant.takeProfitPct / 100);
  const lastIndex = Math.min(candles.length - 1, entryIndex + variant.timeExitCandles);

  for (let i = entryIndex + 1; i <= lastIndex; i++) {
    const candle = candles[i]!;

    const stopCheck = evaluateIntrabarStops({
      token, position, window: { low: candle.low, high: candle.high }, exitSlippagePct,
    });
    if (stopCheck.trigger !== null) {
      return toResult(i, stopCheck.trigger.reason, stopCheck.trigger.fillPrice, entryIndex, entryPrice);
    }
    position = stopCheck.nextPosition;

    if (takeProfitPrice !== null && candle.high >= takeProfitPrice) {
      return toResult(i, 'take_profit', fillAfterSlippage(takeProfitPrice, exitSlippagePct), entryIndex, entryPrice);
    }

    const decision = evaluateExit({ candles, index: i, rsi, token, position, exitSlippagePct });
    if (decision.exit && decision.reason !== null && decision.fillPrice !== null) {
      return toResult(i, decision.reason, decision.fillPrice, entryIndex, entryPrice);
    }
    position = decision.nextPosition;
  }

  // Should not normally be reached — the time exit always fires by lastIndex
  // — but a data-availability cap (near the end of cached history) could
  // truncate the window, so force a close rather than return nothing.
  const last = candles[lastIndex]!;
  return toResult(lastIndex, 'time', last.close, entryIndex, entryPrice);
}

function toResult(
  exitIndex: number, exitReason: ReplayExitReason, exitPrice: number, entryIndex: number, entryPrice: number,
): ReplayedExit {
  return {
    exitIndex, exitReason, exitPrice, barsHeld: exitIndex - entryIndex,
    grossPnlPct: (exitPrice / entryPrice - 1) * 100,
  };
}

/** Highest bar HIGH reached from `entryIndex+1` through `entryIndex+withinBars` (inclusive), or through data end. */
export function mfeWithinBars(
  candles: readonly Candle[], entryIndex: number, entryPrice: number, withinBars: number,
): number {
  const lastIndex = Math.min(candles.length - 1, entryIndex + withinBars);
  let peak = entryPrice;
  for (let i = entryIndex + 1; i <= lastIndex; i++) {
    peak = Math.max(peak, candles[i]!.high);
  }
  return (peak / entryPrice - 1) * 100;
}
