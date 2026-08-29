/**
 * Take-profit ladder exit (DECISIONS §39) — phase 2's exit for a
 * price-triggered position. Extends the same intrabar-stop philosophy
 * `rules/exit.ts` already uses (stops are evaluated against a bar's full
 * range, never close alone — a 15% stop checked once an hour is not a 15%
 * stop) to support PARTIAL fills, which the original single-position
 * `OpenPosition`/`evaluateExit` model does not. This is a parallel
 * implementation, not a wrapper around `evaluateExit` — the position shape
 * (partial fills, wall-clock time instead of candle count) is different
 * enough that forcing it through the old shape would be more contortion
 * than the code it would save. `stopLossPriceFor` (the one piece with no
 * behavioural difference) is reused directly.
 *
 * No RSI, no candles, no indicator of any kind — the entry decision was the
 * operator's; this only manages exiting a position that already exists.
 */
import { TokenAmount } from '../util/amount.js';
import { stopLossPriceFor } from './exit.js';
import type { LadderExitConfig } from '../config/schema.js';

export type LadderExitReason = 'take_profit' | 'trailing' | 'stop_loss' | 'time';

/**
 * The price window to evaluate this tick/bar against. `close` is the
 * reference price for time-based exits (mirrors candle close in
 * `rules/exit.ts`); `low`/`high` drive intrabar stop/take-profit triggers.
 * In live polling, low = high = close = the single observed tick, exactly
 * as `rules/exit.ts` already does for its own live path.
 */
export interface LadderPriceWindow {
  readonly low: number;
  readonly high: number;
  readonly close: number;
  readonly now: number;   // ms epoch — wall-clock; this position is not candle-driven
}

export interface LadderState {
  readonly entryPrice: number;
  readonly entryTimestamp: number;
  readonly originalSizeSol: TokenAmount;
  readonly remainingSizeSol: TokenAmount;
  /** Tranches fire in ascending targetGainPct order — how many have already filled. */
  readonly filledTrancheCount: number;
  readonly peakPrice: number;
  readonly trailingArmed: boolean;
  readonly stopLossPrice: number;
}

export interface LadderTrigger {
  readonly reason: LadderExitReason;
  readonly sizeSol: TokenAmount;
  readonly fillPrice: number;
  /** Which tranche fired, only set for `take_profit`. */
  readonly trancheIndex: number | null;
}

function fillAfterSlippage(triggerPrice: number, slippagePct: number): number {
  return triggerPrice * (1 - slippagePct / 100);
}

export function openLadderPosition(
  entryPrice: number, entryTimestamp: number, sizeSol: TokenAmount, config: LadderExitConfig,
): LadderState {
  return {
    entryPrice, entryTimestamp, originalSizeSol: sizeSol, remainingSizeSol: sizeSol,
    filledTrancheCount: 0, peakPrice: entryPrice, trailingArmed: false,
    stopLossPrice: stopLossPriceFor(entryPrice, config.stopLossPct),
  };
}

/**
 * Priority, highest first (mirrors `rules/exit.ts`'s stated priority,
 * adapted for partial fills and wall-clock time):
 *   1. stop-loss     — INTRABAR, exits the ENTIRE remaining position
 *   2. trailing stop — INTRABAR, arms only once the FIRST tranche has
 *      filled, exits the ENTIRE remaining position
 *   3. take-profit   — INTRABAR, fires the NEXT unfilled tranche only, in
 *      ascending target order. If one price move clears more than one
 *      tranche's target inside a single window, only the nearer one fires
 *      here — the caller's next evaluation picks up the next tranche. This
 *      is a realistic simplification, not an approximation: each tranche is
 *      a separate resting order at a different level, and price passes
 *      through the lower one first.
 *   4. time — wall-clock elapsed since entry, exits the ENTIRE remaining
 *      position, fills at `window.close` with no slippage adjustment
 *      (matches `rules/exit.ts`'s time exit — not an adverse intrabar
 *      trigger, just "nothing else happened").
 *
 * ORDERING ASSUMPTION for stop vs. take-profit inside one window: same
 * conservative "peak, then trough" reasoning as `evaluateIntrabarStops` —
 * stop-loss is checked first against the window's low, before a
 * take-profit target is considered against the window's high.
 */
export function evaluateLadderExit(input: {
  config: LadderExitConfig; state: LadderState; window: LadderPriceWindow; exitSlippagePct: number;
}): { trigger: LadderTrigger | null; nextState: LadderState } {
  const { config, state, window, exitSlippagePct } = input;

  const peakPrice = Math.max(state.peakPrice, window.high);
  const trailingArmed = state.trailingArmed || (config.trailing.enabled && state.filledTrancheCount > 0);
  const nextState: LadderState = { ...state, peakPrice, trailingArmed };

  // 1. Hard stop-loss, intrabar, exits everything remaining.
  if (window.low <= state.stopLossPrice) {
    return {
      trigger: {
        reason: 'stop_loss', sizeSol: state.remainingSizeSol,
        fillPrice: fillAfterSlippage(state.stopLossPrice, exitSlippagePct), trancheIndex: null,
      },
      nextState,
    };
  }

  // 2. Trailing stop, intrabar, armed only after the first tranche fills.
  if (config.trailing.enabled && trailingArmed) {
    const trailStop = peakPrice * (1 - config.trailing.trailPct / 100);
    if (window.low <= trailStop) {
      return {
        trigger: {
          reason: 'trailing', sizeSol: state.remainingSizeSol,
          fillPrice: fillAfterSlippage(trailStop, exitSlippagePct), trancheIndex: null,
        },
        nextState,
      };
    }
  }

  // 3. Take-profit — the next unfilled tranche only.
  if (state.filledTrancheCount < config.tranches.length) {
    const trancheIndex = state.filledTrancheCount;
    const tranche = config.tranches[trancheIndex]!;
    const targetPrice = state.entryPrice * (1 + tranche.targetGainPct / 100);
    if (window.high >= targetPrice) {
      const trancheSizeSol = state.originalSizeSol.mulBps(BigInt(Math.round(tranche.sellPct * 100)));
      const fillSizeSol = trancheSizeSol.gt(state.remainingSizeSol) ? state.remainingSizeSol : trancheSizeSol;
      return {
        trigger: {
          reason: 'take_profit', sizeSol: fillSizeSol,
          fillPrice: fillAfterSlippage(targetPrice, exitSlippagePct), trancheIndex,
        },
        nextState: {
          ...nextState, filledTrancheCount: trancheIndex + 1,
          remainingSizeSol: state.remainingSizeSol.sub(fillSizeSol),
          // This tranche just filled — re-derive arming from the POST-fill
          // count, not the pre-fill value already baked into `nextState`
          // above (trailing must arm on the SAME evaluation the first
          // tranche fires, not one evaluation later).
          trailingArmed: nextState.trailingArmed || config.trailing.enabled,
        },
      };
    }
  }

  // 4. Time, last — wall-clock, exits everything remaining.
  const elapsedMinutes = (window.now - state.entryTimestamp) / 60_000;
  if (elapsedMinutes >= config.timeExitMinutes) {
    return {
      trigger: { reason: 'time', sizeSol: state.remainingSizeSol, fillPrice: window.close, trancheIndex: null },
      nextState,
    };
  }

  return { trigger: null, nextState };
}
