/**
 * Live-trading tick loop (phase 3, DECISIONS §42) — WRITTEN, NOT ENABLED
 * (CLAUDE.md's updated hard rule). Every call into `executeSwap` requires a
 * `LiveExecutionUnlock` (`gate.ts`); nothing here bypasses that.
 *
 * SAME rule-evaluation code as paper (`evaluateLimitEntry`,
 * `evaluateLadderExit`, `evaluatePositionSize`, `evaluateCostFloor`,
 * `impliedPoolLiquiditySol`, `buildQuoteRequest`) — imported from
 * `paper/runner.ts`, not reimplemented, per CLAUDE.md's "one strategy
 * implementation" rule. `PaperStore` is ALSO reused unchanged for
 * persistence — a position's shape (SOL-value-tracked, ladder-based) does
 * not depend on whether its fill was simulated or real; only the DATABASE
 * FILE differs (`data/live.db`, never `data/paper.db` — the two must never
 * share a file, or a live position could be misread as paper or vice
 * versa).
 *
 * Two things paper does NOT need that live does:
 *   1. A CHEAP quote (via the same `PriceFeed`/`JupiterQuoteFeed` paper
 *      already uses) drives entry/exit TRIGGER evaluation every tick, but
 *      `executeSwap` fetches its OWN fresh quote at the moment of
 *      execution — the trigger-check quote is never what's actually
 *      traded against, since price can move between the two.
 *   2. Confirmation has three outcomes, and UNKNOWN is not a class this
 *      loop is allowed to paper over: it engages the kill switch and
 *      raises an alert, then returns — no further ticks act on ANY
 *      position until a human clears it. This is deliberately more
 *      conservative than per-position halting: an unconfirmed transaction
 *      means our own view of chain state is unreliable, which is not
 *      scoped to one position.
 */
import type { GlobalConfig, ManualPositionConfig } from '../config/schema.js';
import { evaluateLimitEntry } from '../rules/limitEntry.js';
import { openLadderPosition, evaluateLadderExit, type LadderPriceWindow } from '../rules/ladderExit.js';
import { evaluatePositionSize } from '../filters/positionSize.js';
import { evaluateCostFloor } from '../filters/costFloor.js';
import {
  isStale, type PriceFeed, type PriceObservation,
} from '../paper/priceFeed.js';
import {
  buildQuoteRequest, impliedPoolLiquiditySol,
} from '../paper/runner.js';
import { PaperStore, type PersistedPaperPosition } from '../paper/store.js';
import { sol, TokenAmount } from '../util/amount.js';
import { Keypair } from '@solana/web3.js';
import type { RpcClient } from './rpcClient.js';
import type { LiveExecutionUnlock } from './gate.js';
import { executeSwap, JupiterSwapError, SlippageCapExceededError, type JupiterClientOptions } from './jupiterSwap.js';
import { confirmSwap } from './confirmation.js';
import { isKillSwitchEngaged, engageKillSwitch } from './killSwitch.js';

export interface LiveTickDeps {
  /** Cheap, direction/size-aware quote for TRIGGER evaluation only — never what's actually traded against (module header). */
  readonly feed: PriceFeed;
  readonly store: PaperStore;
  readonly rpc: RpcClient;
  readonly wallet: Keypair;
  readonly unlock: LiveExecutionUnlock;
  /** Injected fetchFn/URLs for executeSwap's OWN quote+build requests — same injection pattern as everywhere else, so a test never touches the real network. Omit to use the real Jupiter endpoints. */
  readonly jupiterOpts?: JupiterClientOptions;
  readonly global: GlobalConfig;
  readonly now: () => number;
  readonly log: (msg: string) => void;
  /** Distinct from log: an UNKNOWN confirmation, or anything that engages the kill switch, is always ALSO an alert. */
  readonly alert: (msg: string) => void;
  readonly staleAfterMs: number;
  readonly killSwitchPath: string;
}

async function observeTriggerPrice(
  position: ManualPositionConfig, open: PersistedPaperPosition | null, deps: LiveTickDeps,
): Promise<PriceObservation | null> {
  const nowMs = deps.now();
  const quoteRequest = buildQuoteRequest(position, open);
  try {
    const obs = await deps.feed.getPrice(quoteRequest);
    if (isStale(obs, nowMs, deps.staleAfterMs)) {
      deps.log(`[${position.symbol}] STALE FEED — refusing to evaluate this tick.`);
      return null;
    }
    return obs;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log(`[${position.symbol}] FEED ERROR: ${detail} — refusing to evaluate this tick.`);
    return null;
  }
}

/**
 * An UNKNOWN confirmation halts EVERYTHING, not just this position (module
 * header) — engages the kill switch and alerts. Returns true if the caller
 * should stop (this tick and every future one, until a human clears it).
 */
async function haltOnUnknownConfirmation(
  symbol: string, signature: string, reason: string, deps: LiveTickDeps,
): Promise<void> {
  const msg = `[${symbol}] TRANSACTION STATE UNKNOWN for signature ${signature}: ${reason} ` +
    'Engaging the kill switch. Do NOT resubmit or retry. Check the signature on-chain by hand, ' +
    'then clear the kill switch file manually once resolved.';
  deps.alert(msg);
  engageKillSwitch(deps.killSwitchPath, msg);
}

async function tryEnterLive(
  position: ManualPositionConfig, observation: PriceObservation, deps: LiveTickDeps,
): Promise<void> {
  const entryDecision = evaluateLimitEntry(observation.price, position.limitPrice);
  if (!entryDecision.fill) return;

  const buyAmountSol = sol(position.buyAmountSol);
  const poolLiquiditySol = impliedPoolLiquiditySol(buyAmountSol.toNumberUnsafe(), observation.priceImpactPct);
  if (poolLiquiditySol === null) {
    deps.log(`[${position.symbol}] ENTRY SKIPPED: no price-impact figure from the trigger quote — cannot bound slippage.`);
    return;
  }

  const sizing = evaluatePositionSize({
    requestedSol: buyAmountSol, poolLiquiditySol,
    maxPctOfPoolLiquidity: position.limits.maxPctOfPoolLiquidity, minViableSol: sol(position.limits.minViableBuyAmountSol),
  });
  if (!sizing.pass || sizing.sizeSol === null) {
    deps.log(`[${position.symbol}] ENTRY SKIPPED: ${sizing.reason}`);
    return;
  }

  const firstTranche = position.ladder.tranches[0];
  const expectedMove = firstTranche === undefined
    ? { value: 0, reliable: false as const, reason: 'invalid-input' as const }
    : { value: firstTranche.targetGainPct / 100, reliable: true as const };
  const costFloor = evaluateCostFloor({
    expectedMove, positionValueSol: sizing.sizeSol.toNumberUnsafe(), poolLiquiditySol,
    dexFeePct: deps.global.costFloor.dexFeePct, priorityFeeSol: Number(deps.global.costFloor.priorityFeeSol),
    jitoTipSol: Number(deps.global.costFloor.jitoTipSol), minTargetToCostRatio: deps.global.costFloor.minTargetToCostRatio,
    fallbackSlippagePct: deps.global.costFloor.fallbackSlippagePct,
  });
  if (!costFloor.pass) {
    deps.log(`[${position.symbol}] ENTRY SKIPPED: cost-floor rejected: ${costFloor.reason}`);
    return;
  }

  deps.log(`[${position.symbol}] ENTRY TRIGGERED at ${observation.price} — submitting a real swap.`);
  let executed;
  try {
    executed = await executeSwap({
      direction: 'buy', tokenMint: position.address, tokenDecimals: position.decimals,
      amountRaw: sizing.sizeSol.raw, slippageBps: 50,
      maxPriceImpactPct: deps.global.execution.maxSlippageCapPct,
      maxPriorityFeeLamports: deps.global.execution.maxPriorityFeeLamports,
      wallet: deps.wallet, rpc: deps.rpc, unlock: deps.unlock,
    }, deps.jupiterOpts);
  } catch (err) {
    if (err instanceof SlippageCapExceededError) {
      deps.log(`[${position.symbol}] ENTRY ABORTED (not submitted): ${err.message}`);
      return;
    }
    if (err instanceof JupiterSwapError) {
      deps.log(`[${position.symbol}] ENTRY FAILED to build/submit: ${err.message}`);
      return;
    }
    throw err;
  }

  const confirmation = await confirmSwap({
    rpc: deps.rpc, signature: executed.signature, lastValidBlockHeight: executed.lastValidBlockHeight,
  });
  if (confirmation.kind === 'unknown') {
    await haltOnUnknownConfirmation(position.symbol, executed.signature, confirmation.reason, deps);
    return;
  }
  if (confirmation.kind === 'confirmed' && !confirmation.success) {
    deps.log(`[${position.symbol}] ENTRY FAILED on-chain (signature ${executed.signature}): ${JSON.stringify(confirmation.err)}`);
    return;
  }

  // Confirmed success — the fill PRICE and the SOL VALUE of the position
  // both come directly from the quote's own actual amounts (inAmountRaw
  // lamports spent, outAmountRaw raw token units received), not from
  // `sizing.sizeSol` (the PRE-execution request) or any synthetic model:
  // real transaction costs are paid on-chain and reconciled via
  // balanceReconciliation.ts, not simulated the way simulateEntryFill does
  // for paper (DECISIONS §42: there is nothing to simulate once a real
  // fill has already happened — the quote's own numbers ARE the fill).
  const inSol = Number(executed.quote.inAmountRaw) / 10 ** 9;
  const outTokenQty = Number(executed.quote.outAmountRaw) / 10 ** position.decimals;
  if (!(outTokenQty > 0)) {
    deps.log(`[${position.symbol}] ENTRY CONFIRMED but the quote reported a non-positive output amount — cannot record a fill. Manual review required.`);
    return;
  }
  const fillPrice = inSol / outTokenQty;
  const netSizeSol = TokenAmount.fromDecimalString(inSol.toFixed(9), 9);
  const initialState = openLadderPosition(fillPrice, deps.now(), netSizeSol, position.ladder);
  const id = executed.signature;
  deps.store.openPosition({
    id, symbol: position.symbol, address: position.address, poolAddress: '',
    entryPrice: fillPrice, entryTimestamp: deps.now(), originalSizeSol: netSizeSol,
    peakPrice: initialState.peakPrice, stopLossPrice: initialState.stopLossPrice,
    ladderConfig: position.ladder,
  });
  deps.store.recordFill({
    positionId: id, kind: 'entry', trancheIndex: null, triggerPrice: observation.price, fillPrice,
    sizeSol: netSizeSol, grossPnlSol: null, dexFeeSol: sol('0'), fixedFeeSol: sol('0'),
    netPnlSol: null, positionSnapshot: { remainingSizeSol: netSizeSol.toString(), filledTrancheCount: 0, signature: executed.signature },
    filledAt: deps.now(),
  });
  deps.log(`[${position.symbol}] ENTRY CONFIRMED — signature ${executed.signature}, fill ${fillPrice.toFixed(8)}, size ${netSizeSol.toString()} SOL.`);
}

async function tryExitLive(
  position: ManualPositionConfig, open: PersistedPaperPosition, observation: PriceObservation, deps: LiveTickDeps,
): Promise<void> {
  const state = {
    entryPrice: open.entryPrice, entryTimestamp: open.entryTimestamp,
    originalSizeSol: open.originalSizeSol, remainingSizeSol: open.remainingSizeSol,
    filledTrancheCount: open.filledTrancheCount, peakPrice: open.peakPrice,
    trailingArmed: open.trailingArmed, stopLossPrice: open.stopLossPrice,
  };
  const window: LadderPriceWindow = { low: observation.price, high: observation.price, close: observation.price, now: observation.timestamp };
  const { trigger, nextState } = evaluateLadderExit({
    config: open.ladderConfig, state, window, exitSlippagePct: deps.global.exitSlippagePct,
  });

  // UNLIKE paper: remainingSizeSol/filledTrancheCount must NOT update yet —
  // `nextState` assumes the trigger's sale already happened, but a live
  // trigger is only an INTENTION until the swap is confirmed. Updating the
  // ledger now and having the swap fail or come back UNKNOWN would corrupt
  // it — the position would show less than what is actually still held
  // on-chain. peakPrice/trailingArmed ARE safe to persist immediately:
  // they track what price was OBSERVED, not what was traded, and are
  // correct regardless of whether any trade happens this tick.
  deps.store.updatePosition(open.id, {
    remainingSizeSol: open.remainingSizeSol, filledTrancheCount: open.filledTrancheCount,
    peakPrice: nextState.peakPrice, trailingArmed: nextState.trailingArmed,
  }, deps.now());
  if (trigger === null) return;

  // trigger.sizeSol is this TRANCHE's value in SOL terms (the whole
  // system's position-size unit, DECISIONS §39) — a sell-side quote needs
  // the real TOKEN quantity instead, derived via `entryPrice` exactly the
  // same way `remainingTokenRaw` derives it for the trigger-check quote
  // (module header): `originalSizeSol / entryPrice` is definitionally the
  // real token quantity bought, so `trancheValueSol / entryPrice` is the
  // real token quantity this tranche represents, regardless of current price.
  const trancheTokenQty = trigger.sizeSol.toNumberUnsafe() / open.entryPrice;
  if (!(trancheTokenQty > 0)) {
    deps.log(`[${open.symbol}] EXIT (${trigger.reason}) SKIPPED: could not derive a positive token quantity to sell.`);
    return;
  }
  const sellAmountRaw = TokenAmount.fromDecimalString(trancheTokenQty.toFixed(position.decimals), position.decimals).raw;

  deps.log(`[${open.symbol}] EXIT TRIGGERED (${trigger.reason}) at ${observation.price} — submitting a real swap.`);
  let executed;
  try {
    executed = await executeSwap({
      direction: 'sell', tokenMint: open.address, tokenDecimals: position.decimals,
      amountRaw: sellAmountRaw, slippageBps: 50,
      maxPriceImpactPct: deps.global.execution.maxSlippageCapPct,
      maxPriorityFeeLamports: deps.global.execution.maxPriorityFeeLamports,
      wallet: deps.wallet, rpc: deps.rpc, unlock: deps.unlock,
    }, deps.jupiterOpts);
  } catch (err) {
    if (err instanceof SlippageCapExceededError || err instanceof JupiterSwapError) {
      deps.log(`[${open.symbol}] EXIT (${trigger.reason}) ABORTED/FAILED to submit: ${err.message} — will retry next tick.`);
      return;
    }
    throw err;
  }

  const confirmation = await confirmSwap({
    rpc: deps.rpc, signature: executed.signature, lastValidBlockHeight: executed.lastValidBlockHeight,
  });
  if (confirmation.kind === 'unknown') {
    await haltOnUnknownConfirmation(open.symbol, executed.signature, confirmation.reason, deps);
    return;
  }
  if (confirmation.kind === 'confirmed' && !confirmation.success) {
    deps.log(`[${open.symbol}] EXIT (${trigger.reason}) FAILED on-chain (signature ${executed.signature}): ${JSON.stringify(confirmation.err)} — will retry next tick.`);
    return;
  }

  // The REAL fill price, from what the quote actually returned — not
  // `trigger.fillPrice` (the rule engine's pre-trade TARGET level). Token
  // quantity sold is `trigger.sizeSol`'s equivalent (module comment above:
  // exactly what was requested, `executed.quote.inAmountRaw` confirms it).
  const outSol = Number(executed.quote.outAmountRaw) / 10 ** 9;
  const realFillPrice = trancheTokenQty > 0 ? outSol / trancheTokenQty : trigger.fillPrice;

  // NOW commit the ledger update deferred above — confirmed success is the
  // only point at which remainingSizeSol/filledTrancheCount are allowed to
  // change (module comment above the earlier updatePosition call).
  deps.store.updatePosition(open.id, {
    remainingSizeSol: nextState.remainingSizeSol, filledTrancheCount: nextState.filledTrancheCount,
    peakPrice: nextState.peakPrice, trailingArmed: nextState.trailingArmed,
  }, deps.now());

  const stillOpen = !nextState.remainingSizeSol.isZero();
  deps.store.recordFill({
    positionId: open.id, kind: trigger.reason, trancheIndex: trigger.trancheIndex,
    triggerPrice: observation.price, fillPrice: realFillPrice, sizeSol: trigger.sizeSol,
    grossPnlSol: null, dexFeeSol: sol('0'), fixedFeeSol: sol('0'), netPnlSol: null,
    positionSnapshot: {
      remainingSizeSol: nextState.remainingSizeSol.toString(), filledTrancheCount: nextState.filledTrancheCount,
      peakPrice: nextState.peakPrice, trailingArmed: nextState.trailingArmed, status: stillOpen ? 'open' : 'closed',
      signature: executed.signature,
    },
    filledAt: deps.now(),
  });
  if (!stillOpen) deps.store.closePosition(open.id, deps.now());
  deps.log(`[${open.symbol}] ${trigger.reason.toUpperCase()} CONFIRMED — signature ${executed.signature}${stillOpen ? '' : ' — position CLOSED'}.`);
}

/** One poll for one configured position — kill-switch checked first, unconditionally. */
export async function liveTick(position: ManualPositionConfig, deps: LiveTickDeps): Promise<void> {
  if (isKillSwitchEngaged(deps.killSwitchPath)) {
    deps.log(`[${position.symbol}] KILL SWITCH ENGAGED — no action taken.`);
    return;
  }

  const open = deps.store.getOpenPosition(position.symbol);
  const observation = await observeTriggerPrice(position, open, deps);
  if (observation === null) return;

  if (open === null) {
    await tryEnterLive(position, observation, deps);
  } else {
    await tryExitLive(position, open, observation, deps);
  }
}
