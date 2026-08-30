/**
 * Paper-trading runner (DECISIONS §41) — one `tick()` per configured
 * position per poll. SAME rule-evaluation code as any future live path
 * (`evaluateLimitEntry`, `evaluateLadderExit`, `evaluatePositionSize`,
 * `evaluateCostFloor`) — nothing here re-implements a decision, only
 * simulates the fill and persists the result. If paper and live disagree,
 * it is because the execution layer they call into differs, never because
 * the position logic does.
 *
 * PRICE SOURCE (DECISIONS §41 follow-up): Jupiter's quote API, not the old
 * pool-candle feed — a quote is direction- and size-aware, so the request
 * itself differs depending on what's being evaluated. With no open
 * position, "the actual trade size" is the configured buy amount (a `buy`
 * quote, SOL -> token). With one open, it's whatever of the position
 * remains — this system tracks position size as a SOL VALUE, not a token
 * quantity (`evaluateLadderExit`'s model), so the remaining TOKEN quantity
 * for a `sell` quote is derived each tick from `remainingSizeSol /
 * entryPrice` (exact, since entryPrice is the same reference the position
 * was sized against throughout its life — not re-derived from a moving
 * current price).
 *
 * FAIL CLOSED, explicitly, at two points:
 *   - A stale or failed price observation blocks BOTH entry and exit
 *     evaluation for that tick — no action on unknown-age data, the same
 *     treatment the indicator reliability mask gives a gap.
 *   - `poolLiquiditySol` is `null` here (no live liquidity feed built in
 *     this delivery) — `evaluatePositionSize`/`evaluateCostFloor` already
 *     have an explicit, labelled "not evaluated"/fallback path for this,
 *     the same one the backtest CLI uses without `--pool-liquidity-sol`;
 *     this is not a silent gap, it prints every run (see `cli/paper.ts`).
 *
 * COST-FLOOR'S "EXPECTED MOVE" for a price-triggered entry, since there is
 * no ATR/indicator computing one here: the ladder's OWN first tranche
 * target — the operator's own stated expected move — stands in for it, so
 * the existing gate ("target move must clear the round-trip cost by this
 * multiple") still applies meaningfully rather than being skipped.
 */
import { randomUUID } from 'node:crypto';
import type { GlobalConfig, ManualPositionConfig } from '../config/schema.js';
import { evaluateLimitEntry } from '../rules/limitEntry.js';
import { openLadderPosition, evaluateLadderExit, type LadderPriceWindow } from '../rules/ladderExit.js';
import { evaluatePositionSize } from '../filters/positionSize.js';
import { evaluateCostFloor } from '../filters/costFloor.js';
import { simulateEntryFill, tranchePnl } from './simulator.js';
import { isStale, type PriceFeed, type PriceObservation, type QuoteRequest } from './priceFeed.js';
import { PaperStore, type PersistedPaperPosition, type FeedStats } from './store.js';
import { sol, TokenAmount } from '../util/amount.js';

export interface TickDeps {
  readonly feed: PriceFeed;
  readonly store: PaperStore;
  readonly global: GlobalConfig;
  readonly now: () => number;
  readonly log: (msg: string) => void;
  readonly staleAfterMs: number;
  /** null unless a live liquidity figure is supplied — see module header. */
  readonly poolLiquiditySol: number | null;
}

function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  return minutes < 60 ? `${minutes.toFixed(1)}min` : `${(minutes / 60).toFixed(2)}h`;
}

/**
 * Cumulative feed-reliability summary, appended to every tick's log line
 * (DECISIONS §41) — a source-quality finding for the operator to weigh, not
 * a code diagnostic. "Longest blind" is the real number the −15% hard stop
 * could have been unable to see the price for, over the whole run,
 * including any downtime between a crash and a Task Scheduler restart.
 */
function formatFeedStats(stats: FeedStats): string {
  const blind = stats.staleCount + stats.errorCount;
  return `feed: ${stats.usableCount} ok / ${blind} blind (${stats.errorCount} err, ${stats.staleCount} stale) | longest blind ${formatDuration(stats.longestBlindStreakMs)}`;
}

/**
 * The remaining position's SOL value converted to a raw token quantity for
 * a sell-side quote. Exact, not an estimate: `originalSizeSol / entryPrice`
 * is definitionally the real token quantity the entry fill bought, and
 * `remainingSizeSol` is always a fixed proportion of `originalSizeSol` (the
 * ladder only ever removes fixed percentages of the ORIGINAL size), so
 * `remainingSizeSol / entryPrice` is the exact remaining token quantity
 * regardless of what the CURRENT price is.
 */
function remainingTokenRaw(open: PersistedPaperPosition, decimals: number): bigint {
  const tokenQty = open.remainingSizeSol.toNumberUnsafe() / open.entryPrice;
  if (!Number.isFinite(tokenQty) || tokenQty <= 0) {
    throw new Error(
      `${open.symbol}: cannot derive a positive remaining token quantity ` +
      `(remainingSizeSol=${open.remainingSizeSol.toString()}, entryPrice=${open.entryPrice})`,
    );
  }
  return TokenAmount.fromDecimalString(tokenQty.toFixed(decimals), decimals).raw;
}

function buildQuoteRequest(position: ManualPositionConfig, open: PersistedPaperPosition | null): QuoteRequest {
  if (open === null) {
    return {
      direction: 'buy', tokenMint: position.address, tokenDecimals: position.decimals,
      amountRaw: sol(position.buyAmountSol).raw,
    };
  }
  return {
    direction: 'sell', tokenMint: position.address, tokenDecimals: position.decimals,
    amountRaw: remainingTokenRaw(open, position.decimals),
  };
}

/**
 * A tick's poll normally takes seconds, not minutes — 1.5x the configured
 * poll interval is generous slack for one slow HTTP round trip before a gap
 * counts as real downtime (a crash, a sleeping machine, a Task Scheduler
 * restart) rather than ordinary jitter.
 */
const DOWNTIME_GAP_MULTIPLIER = 1.5;

async function observePrice(
  position: ManualPositionConfig, quoteRequest: QuoteRequest, deps: TickDeps,
): Promise<PriceObservation | null> {
  const nowMs = deps.now();
  const normalPollGapMs = deps.global.stopPollSeconds * 1000 * DOWNTIME_GAP_MULTIPLIER;
  const tally = (outcome: 'usable' | 'stale' | 'error'): FeedStats =>
    deps.store.recordFeedTick({ symbol: position.symbol, outcome, nowMs, normalPollGapMs });

  try {
    const obs = await deps.feed.getPrice(quoteRequest);
    if (isStale(obs, nowMs, deps.staleAfterMs)) {
      const stats = tally('stale');
      const detail = `last observation ${((nowMs - obs.timestamp) / 60_000).toFixed(1)} minutes old ` +
        `(threshold ${(deps.staleAfterMs / 60_000).toFixed(1)}m) — refusing to act`;
      deps.log(`[${position.symbol}] STALE FEED: ${detail} — ${formatFeedStats(stats)}`);
      deps.store.recordEvent({ symbol: position.symbol, kind: 'stale_feed', detail, occurredAt: nowMs });
      return null;
    }
    const stats = tally('usable');
    deps.log(
      `[${position.symbol}] price ${obs.price} (${quoteRequest.direction}` +
      `${obs.priceImpactPct !== undefined ? `, ${(obs.priceImpactPct * 100).toFixed(4)}% impact` : ''}) ` +
      `— ${formatFeedStats(stats)}`,
    );
    return obs;
  } catch (err) {
    const stats = tally('error');
    const detail = err instanceof Error ? err.message : String(err);
    deps.log(`[${position.symbol}] FEED ERROR: ${detail} — ${formatFeedStats(stats)}`);
    deps.store.recordEvent({ symbol: position.symbol, kind: 'feed_error', detail, occurredAt: nowMs });
    return null;
  }
}

async function tryEnter(
  position: ManualPositionConfig, observation: PriceObservation, deps: TickDeps,
): Promise<void> {
  const { price, timestamp } = observation;
  const entryDecision = evaluateLimitEntry(price, position.limitPrice);
  if (!entryDecision.fill) return;

  // Called UNCONDITIONALLY, unlike the backtest CLI's deliberate bypass when
  // poolLiquiditySol is null (engine.ts's own comment: that bypass is a
  // backtest-only accommodation for free data having no historical
  // liquidity — "correct for live/paper" is to let this filter fail closed,
  // which it already does on its own when poolLiquiditySol is null). Paper
  // trading is a live-code-path validation, not backtest, so it gets the
  // real fail-closed behavior: no liquidity figure means no entry, exactly
  // as live would refuse to size a trade it cannot bound the slippage of.
  const buyAmountSol = sol(position.buyAmountSol);
  const sizing = evaluatePositionSize({
    requestedSol: buyAmountSol, poolLiquiditySol: deps.poolLiquiditySol,
    maxPctOfPoolLiquidity: position.limits.maxPctOfPoolLiquidity, minViableSol: sol(position.limits.minViableBuyAmountSol),
  });
  if (!sizing.pass || sizing.sizeSol === null) {
    const detail = `position-size filter rejected the entry at ${price}: ${sizing.reason}`;
    deps.log(`[${position.symbol}] ENTRY SKIPPED: ${detail}`);
    deps.store.recordEvent({ symbol: position.symbol, kind: 'entry_skipped', detail, occurredAt: timestamp });
    return;
  }

  const firstTranche = position.ladder.tranches[0];
  const expectedMove = firstTranche === undefined
    ? { value: 0, reliable: false as const, reason: 'invalid-input' as const }
    : { value: firstTranche.targetGainPct / 100, reliable: true as const };
  const costFloor = evaluateCostFloor({
    expectedMove, positionValueSol: sizing.sizeSol.toNumberUnsafe(), poolLiquiditySol: deps.poolLiquiditySol,
    dexFeePct: deps.global.costFloor.dexFeePct, priorityFeeSol: Number(deps.global.costFloor.priorityFeeSol),
    jitoTipSol: Number(deps.global.costFloor.jitoTipSol), minTargetToCostRatio: deps.global.costFloor.minTargetToCostRatio,
    fallbackSlippagePct: deps.global.costFloor.fallbackSlippagePct,
  });
  if (!costFloor.pass) {
    const detail = `cost-floor rejected the entry: ${costFloor.reason}`;
    deps.log(`[${position.symbol}] ENTRY SKIPPED: ${detail}`);
    deps.store.recordEvent({ symbol: position.symbol, kind: 'entry_skipped', detail, occurredAt: timestamp });
    return;
  }

  const fill = simulateEntryFill({
    midPrice: price, buyAmountSol: sizing.sizeSol, dexFeePct: deps.global.costFloor.dexFeePct,
    priorityFeeSol: Number(deps.global.costFloor.priorityFeeSol), jitoTipSol: Number(deps.global.costFloor.jitoTipSol),
    fallbackSlippagePct: deps.global.costFloor.fallbackSlippagePct, poolLiquiditySol: deps.poolLiquiditySol,
    ...(observation.priceImpactPct !== undefined ? { realPriceImpactPct: observation.priceImpactPct } : {}),
  });

  // Reuse openLadderPosition for the initial state (stop price etc.) rather than
  // re-deriving stopLossPriceFor's math inline — one source of truth for it.
  const initialState = openLadderPosition(fill.fillPrice, timestamp, fill.netSizeSol, position.ladder);
  const id = randomUUID();
  deps.store.openPosition({
    id, symbol: position.symbol, address: position.address,
    poolAddress: '',   // no single pool with a mint-pair quote feed — see store.ts's "not pool-based" convention
    entryPrice: fill.fillPrice, entryTimestamp: timestamp, originalSizeSol: fill.netSizeSol,
    peakPrice: initialState.peakPrice, stopLossPrice: initialState.stopLossPrice,
    ladderConfig: position.ladder,
  });
  deps.store.recordFill({
    positionId: id, kind: 'entry', trancheIndex: null, triggerPrice: price, fillPrice: fill.fillPrice,
    sizeSol: fill.netSizeSol, grossPnlSol: null, dexFeeSol: fill.dexFeeSol, fixedFeeSol: fill.fixedFeeSol,
    netPnlSol: null, positionSnapshot: { remainingSizeSol: fill.netSizeSol.toString(), filledTrancheCount: 0 },
    filledAt: timestamp,
  });
  deps.log(
    `[${position.symbol}] ENTRY FILLED at ${fill.fillPrice.toFixed(8)} (observed ${price.toFixed(8)}, ` +
    `${fill.slippagePct.toFixed(4)}% ${fill.slippageEstimated ? 'slippage, estimated' : 'impact'}), ` +
    `size ${fill.netSizeSol.toString()} SOL`,
  );
}

async function tryExit(
  open: PersistedPaperPosition, observation: PriceObservation, deps: TickDeps,
): Promise<void> {
  const { price, timestamp } = observation;
  const state = {
    entryPrice: open.entryPrice, entryTimestamp: open.entryTimestamp,
    originalSizeSol: open.originalSizeSol, remainingSizeSol: open.remainingSizeSol,
    filledTrancheCount: open.filledTrancheCount, peakPrice: open.peakPrice,
    trailingArmed: open.trailingArmed, stopLossPrice: open.stopLossPrice,
  };
  const window: LadderPriceWindow = { low: price, high: price, close: price, now: timestamp };
  const { trigger, nextState } = evaluateLadderExit({
    config: open.ladderConfig, state, window, exitSlippagePct: deps.global.exitSlippagePct,
  });

  deps.store.updatePosition(open.id, {
    remainingSizeSol: nextState.remainingSizeSol, filledTrancheCount: nextState.filledTrancheCount,
    peakPrice: nextState.peakPrice, trailingArmed: nextState.trailingArmed,
  }, timestamp);

  if (trigger === null) return;

  const pnl = tranchePnl({
    sizeSol: trigger.sizeSol, entryPrice: open.entryPrice, fillPrice: trigger.fillPrice,
    dexFeePct: deps.global.costFloor.dexFeePct, priorityFeeSol: Number(deps.global.costFloor.priorityFeeSol),
    jitoTipSol: Number(deps.global.costFloor.jitoTipSol),
  });
  const stillOpen = !nextState.remainingSizeSol.isZero();
  deps.store.recordFill({
    positionId: open.id, kind: trigger.reason, trancheIndex: trigger.trancheIndex,
    triggerPrice: price, fillPrice: trigger.fillPrice, sizeSol: trigger.sizeSol,
    grossPnlSol: pnl.grossPnlSol, dexFeeSol: pnl.dexFeeSol, fixedFeeSol: pnl.fixedFeeSol, netPnlSol: pnl.netPnlSol,
    positionSnapshot: {
      remainingSizeSol: nextState.remainingSizeSol.toString(), filledTrancheCount: nextState.filledTrancheCount,
      peakPrice: nextState.peakPrice, trailingArmed: nextState.trailingArmed, status: stillOpen ? 'open' : 'closed',
    },
    filledAt: timestamp,
  });
  if (!stillOpen) deps.store.closePosition(open.id, timestamp);

  deps.log(
    `[${open.symbol}] ${trigger.reason.toUpperCase()} FILLED at ${trigger.fillPrice.toFixed(8)} ` +
    `(trigger ${price.toFixed(8)}), size ${trigger.sizeSol.toString()} SOL, net P&L ${pnl.netPnlSol.toString()} SOL` +
    `${stillOpen ? ` — ${nextState.remainingSizeSol.toString()} SOL remaining` : ' — position CLOSED'}`,
  );
}

/** One poll for one configured position: observe price, then act (or refuse to act) on it. */
export async function tick(position: ManualPositionConfig, deps: TickDeps): Promise<void> {
  const open = deps.store.getOpenPosition(position.symbol);
  const quoteRequest = buildQuoteRequest(position, open);
  const observation = await observePrice(position, quoteRequest, deps);
  if (observation === null) return;   // fail closed — stale or failed feed, no action this tick

  if (open === null) {
    await tryEnter(position, observation, deps);
  } else {
    await tryExit(open, observation, deps);
  }
}
