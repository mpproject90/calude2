/**
 * Exit rules (spec §9). Every open position carries all of these and they are
 * evaluated on every candle close. First to trigger wins.
 *
 * Priority order, highest first:
 *   1. safety      — Tier B liquidity drain / authority change (deferred)
 *   2. stop-loss   — non-negotiable, set at fill time
 *   3. time        — frees capital, prevents dead bags accumulating
 *   4. trailing    — optional, locks in a run that has already paid
 *   5. rsi         — momentum recovery
 *
 * ON THE RSI EXIT: RSI is a momentum indicator, not a price level. It can cross
 * above the overbought threshold while the position is deeply underwater — a
 * token can drop 60%, chop, then bounce 15% and trigger this exit at a loss.
 * That is expected behaviour, not a bug. The stop-loss and time exits exist
 * precisely because the RSI exit alone is not an exit strategy. Every exit is
 * logged with its trigger so the backtest can report how often each fires and
 * at what P&L (§10).
 */
import type { Candle, IndicatorValue } from '../types/index.js';
import type { TokenConfig } from '../config/schema.js';

export type ExitReason = 'stop_loss' | 'time' | 'rsi_recovery' | 'trailing' | 'safety';

export interface OpenPosition {
  readonly entryPrice: number;
  readonly entryIndex: number;
  /** Highest close seen since entry; drives the trailing stop. */
  readonly peakPrice: number;
  readonly trailingArmed: boolean;
  readonly stopLossPrice: number;
}

export interface ExitInput {
  readonly candles: readonly Candle[];
  readonly index: number;
  readonly rsi: readonly IndicatorValue[];
  readonly token: TokenConfig;
  readonly position: OpenPosition;
  /** Tier B safety breach. Deferred, so always false today. */
  readonly safetyBreach?: boolean;
}

export interface ExitDecision {
  readonly exit: boolean;
  readonly reason: ExitReason | null;
  readonly detail: string;
  readonly context: Readonly<Record<string, number | string | boolean | null>>;
  /** Updated position state to carry to the next bar when not exiting. */
  readonly nextPosition: OpenPosition;
}

export function evaluateExit(input: ExitInput): ExitDecision {
  const { candles, index, rsi, token, position, safetyBreach } = input;
  const candle = candles[index];
  if (candle === undefined) {
    return {
      exit: false, reason: null, detail: 'no candle at index',
      context: { index }, nextPosition: position,
    };
  }

  const price = candle.close;
  const gainPct = (price / position.entryPrice - 1) * 100;
  const barsHeld = index - position.entryIndex;

  const peakPrice = Math.max(position.peakPrice, price);
  const trailing = token.exit.trailingStop;
  const trailingArmed =
    position.trailingArmed ||
    (trailing.enabled && gainPct >= trailing.activateAtPct);
  const nextPosition: OpenPosition = { ...position, peakPrice, trailingArmed };

  /**
   * Whether the bar's LOW breached the stop even though its close did not.
   * The decision itself uses the close, per spec §9 ("evaluated on every candle
   * close"), but a close-only stop is optimistic: in reality the position would
   * have been stopped out intrabar at a worse price. Reporting it lets the
   * backtest quantify how much that assumption flatters the results.
   */
  const intrabarStopBreach = candle.low <= position.stopLossPrice;

  const baseContext = {
    price, entryPrice: position.entryPrice, gainPct, barsHeld,
    stopLossPrice: position.stopLossPrice, peakPrice, trailingArmed,
    intrabarStopBreach,
  };

  // 1. Safety (Tier B — deferred, never true today)
  if (safetyBreach === true) {
    return {
      exit: true, reason: 'safety',
      detail: 'safety breach while holding — exiting regardless of P&L',
      context: baseContext, nextPosition,
    };
  }

  // 2. Hard stop-loss
  if (price <= position.stopLossPrice) {
    return {
      exit: true, reason: 'stop_loss',
      detail: `close ${price} at or below stop ${position.stopLossPrice} (${gainPct.toFixed(2)}%)`,
      context: baseContext, nextPosition,
    };
  }

  // 3. Time-based exit
  if (barsHeld >= token.exit.timeExitCandles) {
    return {
      exit: true, reason: 'time',
      detail: `held ${barsHeld} candles, limit ${token.exit.timeExitCandles} (${gainPct.toFixed(2)}%)`,
      context: baseContext, nextPosition,
    };
  }

  // 4. Trailing stop (optional)
  if (trailing.enabled && trailingArmed) {
    const trailStop = peakPrice * (1 - trailing.trailPct / 100);
    if (price <= trailStop) {
      return {
        exit: true, reason: 'trailing',
        detail: `close ${price} fell ${trailing.trailPct}% from peak ${peakPrice}`,
        context: { ...baseContext, trailStop }, nextPosition,
      };
    }
  }

  // 5. RSI recovery
  const r = rsi[index];
  if (r !== undefined && r.reliable && r.value >= token.exit.rsiExitLevel) {
    return {
      exit: true, reason: 'rsi_recovery',
      detail:
        `RSI ${r.value.toFixed(2)} reached ${token.exit.rsiExitLevel} ` +
        `(P&L ${gainPct.toFixed(2)}% — this exit can and does fire underwater)`,
      context: { ...baseContext, rsi: r.value }, nextPosition,
    };
  }

  return {
    exit: false, reason: null, detail: 'no exit condition met',
    context: baseContext, nextPosition,
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
