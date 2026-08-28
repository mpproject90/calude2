/**
 * Entry rule (spec §7). Every condition must pass; the first failure short-
 * circuits but every evaluated check is returned so rejections can be counted
 * per condition (§10).
 *
 * This code is shared verbatim by backtest, paper and live. There is no second
 * implementation to drift from it.
 */
import type { Candle, IndicatorValue } from '../types/index.js';
import type { TokenConfig } from '../config/schema.js';
import type { FilterResult } from '../filters/types.js';
import { crossedUpThrough, hasBullishDivergence, wasOverboughtWithin } from './conditions.js';

export interface ConditionResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
  readonly context?: Readonly<Record<string, number | string | boolean | null>>;
}

export interface EntryDecision {
  readonly enter: boolean;
  readonly checks: readonly ConditionResult[];
  /** The first failing check, or null when every check passed. */
  readonly blockedBy: ConditionResult | null;
}

export interface EntryInput {
  readonly candles: readonly Candle[];
  readonly index: number;
  readonly rsi: readonly IndicatorValue[];
  readonly mfi: readonly IndicatorValue[];
  readonly token: TokenConfig;
  /** Results of the §6 filter stack, already evaluated. */
  readonly filters: readonly FilterResult[];
}

function check(
  name: string,
  pass: boolean,
  detail: string,
  context?: ConditionResult['context'],
): ConditionResult {
  return context === undefined ? { name, pass, detail } : { name, pass, detail, context };
}

export function evaluateEntry(input: EntryInput): EntryDecision {
  const { candles, index, rsi, mfi, token, filters } = input;
  const checks: ConditionResult[] = [];

  const rsiNow = rsi[index];
  const mfiNow = mfi[index];

  // §7.6 — indicator reliability. Checked FIRST: every other condition reads
  // these values, so an unreliable indicator makes the rest meaningless.
  const reliable = rsiNow?.reliable === true && mfiNow?.reliable === true;
  checks.push(
    check('indicators-reliable', reliable,
      reliable ? 'RSI and MFI are warm and gap-free'
               : `refusing to trade on unreliable indicators (rsi=${rsiNow?.reason ?? 'missing'}, mfi=${mfiNow?.reason ?? 'missing'})`,
      { rsiReliable: rsiNow?.reliable ?? false, mfiReliable: mfiNow?.reliable ?? false }),
  );

  if (reliable && rsiNow !== undefined && mfiNow !== undefined) {
    // §7.1 — prior overbought cycle
    const priorOverbought = wasOverboughtWithin(
      rsi, index, token.entry.priorOverboughtWithinCandles, token.rsi.overbought,
    );
    checks.push(check('prior-overbought', priorOverbought,
      priorOverbought
        ? `RSI exceeded ${token.rsi.overbought} within the last ${token.entry.priorOverboughtWithinCandles} candles`
        : 'no prior pump — this is decline, not a dip from a pump',
      { withinCandles: token.entry.priorOverboughtWithinCandles, overbought: token.rsi.overbought }));

    // §7.2 — RSI crossing UP through oversold
    const crossUp = crossedUpThrough(rsi, index, token.rsi.oversold);
    checks.push(check('rsi-cross-up', crossUp,
      crossUp
        ? `RSI crossed up through ${token.rsi.oversold}`
        : `RSI is not crossing up through ${token.rsi.oversold} on this bar`,
      { rsiPrev: rsi[index - 1]?.value ?? null, rsiNow: rsiNow.value, oversold: token.rsi.oversold }));

    // §7.3 — MFI confirmation only, never a standalone trigger
    const mfiConfirms = mfiNow.value < token.mfi.threshold;
    checks.push(check('mfi-confirmation', mfiConfirms,
      mfiConfirms
        ? `MFI ${mfiNow.value.toFixed(2)} is below ${token.mfi.threshold}`
        : `MFI ${mfiNow.value.toFixed(2)} does not confirm (needs < ${token.mfi.threshold})`,
      { mfi: mfiNow.value, threshold: token.mfi.threshold }));

    // §7.4 — optional divergence, required when the flag is set
    if (token.entry.requireDivergence) {
      const lookback = token.entry.relativeStrengthLookback;
      const diverges = hasBullishDivergence(candles, rsi, index, lookback);
      checks.push(check('bullish-divergence', diverges,
        diverges ? 'price made a lower low while RSI made a higher low'
                 : 'no bullish divergence',
        { lookback }));
    }
  }

  // §7.5 — the whole §6 filter stack
  for (const f of filters) {
    checks.push(check(`filter:${f.filter}`, f.pass, f.reason, f.context));
  }

  const blockedBy = checks.find((c) => !c.pass) ?? null;
  return { enter: blockedBy === null, checks, blockedBy };
}
