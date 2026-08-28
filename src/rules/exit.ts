/**
 * Exit rules (spec §9), with intrabar stop evaluation.
 *
 * Priority, highest first:
 *   1. safety    — Tier B liquidity drain / authority change (deferred)
 *   2. stop-loss — INTRABAR
 *   3. trailing  — INTRABAR
 *   4. rsi       — on candle close
 *   5. time      — on candle close, last
 *
 * Time is last deliberately. If a trailing stop and a time exit both come due on
 * the same bar the position is in profit, and trailing gives the better fill.
 * The time exit is the "nothing happened" fallback and should only fire when no
 * profit exit did.
 *
 * WHY STOPS ARE INTRABAR: a 15% stop checked once an hour is not a 15% stop. A
 * bar whose low pierced the stop but whose close recovered above it would have
 * stopped out in reality, at a worse price than the close. Evaluating on close
 * alone does not merely mis-measure that — it changes the strategy into one that
 * cannot be executed. So:
 *   - backtest: `bar.low <= stopPrice` means the position stopped out during the
 *     bar, and fills at stopPrice minus modelled slippage, never at the close.
 *   - live: price is polled on a faster tick than the candle timeframe
 *     (config `global.stopPollSeconds`, default 30s) and the stop is evaluated
 *     against that tick, independent of candle boundaries.
 * The same treatment applies to the trailing stop.
 *
 * Entry signals remain on candle close — never act on an incomplete candle.
 *
 * ON THE RSI EXIT: RSI is a momentum indicator, not a price level. It can cross
 * above the overbought threshold while the position is deeply underwater. That
 * is expected behaviour, not a bug; the stop and time exits exist because the
 * RSI exit alone is not an exit strategy.
 */
import type { Candle, IndicatorValue } from '../types/index.js';
import type { TokenConfig } from '../config/schema.js';

export type ExitReason = 'stop_loss' | 'time' | 'rsi_recovery' | 'trailing' | 'safety';

export interface OpenPosition {
  readonly entryPrice: number;
  readonly entryIndex: number;
  /** Highest price seen since entry. Updated from bar HIGH, not close. */
  readonly peakPrice: number;
  readonly trailingArmed: boolean;
  readonly stopLossPrice: number;
}

/**
 * The price window to evaluate stops against.
 *   - backtest: { low: bar.low, high: bar.high }
 *   - live:     { low: tick, high: tick } from the fast poller
 */
export interface PriceWindow {
  readonly low: number;
  readonly high: number;
}

export interface StopCheckInput {
  readonly token: TokenConfig;
  readonly position: OpenPosition;
  readonly window: PriceWindow;
  /** Modelled adverse slippage on a stop fill, in percent. */
  readonly exitSlippagePct: number;
}

export interface StopTrigger {
  readonly reason: 'stop_loss' | 'trailing';
  readonly fillPrice: number;
  readonly triggerPrice: number;
  readonly detail: string;
}

/** A stop fill is adverse: we sell into the move, below the trigger. */
function fillAfterSlippage(triggerPrice: number, slippagePct: number): number {
  return triggerPrice * (1 - slippagePct / 100);
}

/**
 * Advance trailing state for this price window, then test both stops against it.
 * Returns null when neither stop is hit.
 *
 * ORDERING ASSUMPTION: within a bar we cannot know whether the high or the low
 * came first, so we assume the adverse sequence — peak first, then trough. That
 * arms the trailing stop from the bar's high and then tests the trail against
 * the same bar's low. It exits earlier and at a worse price than the optimistic
 * reading, which is the direction an honest backtest should err in. In live
 * mode the question does not arise: low and high are both the current tick.
 */
export function evaluateIntrabarStops(
  input: StopCheckInput,
): { trigger: StopTrigger | null; nextPosition: OpenPosition } {
  const { token, position, window, exitSlippagePct } = input;
  const trailing = token.exit.trailingStop;

  const peakPrice = Math.max(position.peakPrice, window.high);
  const peakGainPct = (peakPrice / position.entryPrice - 1) * 100;
  const trailingArmed =
    position.trailingArmed || (trailing.enabled && peakGainPct >= trailing.activateAtPct);
  const nextPosition: OpenPosition = { ...position, peakPrice, trailingArmed };

  // 2. Hard stop-loss, intrabar.
  if (window.low <= position.stopLossPrice) {
    return {
      trigger: {
        reason: 'stop_loss',
        triggerPrice: position.stopLossPrice,
        fillPrice: fillAfterSlippage(position.stopLossPrice, exitSlippagePct),
        detail:
          `price reached ${window.low} during the bar, at or below the stop ` +
          `${position.stopLossPrice}; filled at the stop less ${exitSlippagePct}% slippage`,
      },
      nextPosition,
    };
  }

  // 3. Trailing stop, intrabar.
  if (trailing.enabled && trailingArmed) {
    const trailStop = peakPrice * (1 - trailing.trailPct / 100);
    if (window.low <= trailStop) {
      return {
        trigger: {
          reason: 'trailing',
          triggerPrice: trailStop,
          fillPrice: fillAfterSlippage(trailStop, exitSlippagePct),
          detail:
            `price reached ${window.low} during the bar, ${trailing.trailPct}% below ` +
            `the peak ${peakPrice}; filled at the trail less ${exitSlippagePct}% slippage`,
        },
        nextPosition,
      };
    }
  }

  return { trigger: null, nextPosition };
}

export interface ExitInput {
  readonly candles: readonly Candle[];
  readonly index: number;
  readonly rsi: readonly IndicatorValue[];
  readonly token: TokenConfig;
  readonly position: OpenPosition;
  readonly exitSlippagePct: number;
  /** Tier B safety breach. Deferred, so always false today. */
  readonly safetyBreach?: boolean;
}

export interface ExitDecision {
  readonly exit: boolean;
  readonly reason: ExitReason | null;
  /**
   * The price the exit fills at. For intrabar stops this is the trigger price
   * less modelled slippage — NOT the candle close. Null when not exiting.
   */
  readonly fillPrice: number | null;
  readonly detail: string;
  readonly context: Readonly<Record<string, number | string | boolean | null>>;
  readonly nextPosition: OpenPosition;
}

export function evaluateExit(input: ExitInput): ExitDecision {
  const { candles, index, rsi, token, position, safetyBreach, exitSlippagePct } = input;
  const candle = candles[index];
  if (candle === undefined) {
    return {
      exit: false, reason: null, fillPrice: null, detail: 'no candle at index',
      context: { index }, nextPosition: position,
    };
  }

  const close = candle.close;
  const barsHeld = index - position.entryIndex;

  // 1. Safety — overrides everything, including a stop that also triggered.
  if (safetyBreach === true) {
    return {
      exit: true, reason: 'safety', fillPrice: fillAfterSlippage(close, exitSlippagePct),
      detail: 'safety breach while holding — exiting regardless of P&L',
      context: { close, entryPrice: position.entryPrice, barsHeld },
      nextPosition: position,
    };
  }

  // 2 & 3. Stops, evaluated against the bar's full range rather than its close.
  const { trigger, nextPosition } = evaluateIntrabarStops({
    token, position, window: { low: candle.low, high: candle.high }, exitSlippagePct,
  });

  /**
   * Retained as a reported metric: did the bar's low breach the stop while its
   * close did not? That is exactly the case a close-only rule would have missed,
   * so counting it shows how much the old behaviour was costing.
   */
  const intrabarStopBreach = candle.low <= position.stopLossPrice && close > position.stopLossPrice;

  const baseContext = {
    close, low: candle.low, high: candle.high,
    entryPrice: position.entryPrice, barsHeld,
    stopLossPrice: position.stopLossPrice,
    peakPrice: nextPosition.peakPrice,
    trailingArmed: nextPosition.trailingArmed,
    intrabarStopBreach,
  };

  if (trigger !== null) {
    return {
      exit: true, reason: trigger.reason, fillPrice: trigger.fillPrice,
      detail: trigger.detail,
      context: {
        ...baseContext,
        triggerPrice: trigger.triggerPrice,
        fillPrice: trigger.fillPrice,
        realizedPct: (trigger.fillPrice / position.entryPrice - 1) * 100,
      },
      nextPosition,
    };
  }

  const gainPct = (close / position.entryPrice - 1) * 100;

  // 4. RSI recovery, on candle close.
  const r = rsi[index];
  if (r !== undefined && r.reliable && r.value >= token.exit.rsiExitLevel) {
    return {
      exit: true, reason: 'rsi_recovery', fillPrice: close,
      detail:
        `RSI ${r.value.toFixed(2)} reached ${token.exit.rsiExitLevel} ` +
        `(P&L ${gainPct.toFixed(2)}% — this exit can and does fire underwater)`,
      context: { ...baseContext, rsi: r.value, gainPct }, nextPosition,
    };
  }

  // 5. Time, last: the fallback for when no profit exit fired.
  if (barsHeld >= token.exit.timeExitCandles) {
    return {
      exit: true, reason: 'time', fillPrice: close,
      detail: `held ${barsHeld} candles, limit ${token.exit.timeExitCandles} (${gainPct.toFixed(2)}%)`,
      context: { ...baseContext, gainPct }, nextPosition,
    };
  }

  return {
    exit: false, reason: null, fillPrice: null, detail: 'no exit condition met',
    context: { ...baseContext, gainPct }, nextPosition,
  };
}

/** Stop-loss price written at fill time. No position exists without one. */
export function stopLossPriceFor(entryPrice: number, stopLossPct: number): number {
  return entryPrice * (1 - stopLossPct / 100);
}

/** Candle index at which the time exit fires. Written at fill time. */
export function timeExitIndexFor(entryIndex: number, timeExitCandles: number): number {
  return entryIndex + timeExitCandles;
}
