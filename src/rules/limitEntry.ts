/**
 * Price-triggered entry (DECISIONS §39) — phase 2's replacement for the
 * indicator-driven entry (`rules/entry.ts`, preserved but no longer on the
 * live path). No RSI, no MFI, no relative-strength, no regime: the operator
 * has already picked the token and a price; the only question left is
 * whether the market has reached it.
 *
 * "Limit buy price" uses the standard meaning: fill when the observed price
 * is at or below the configured limit — a marketable fill if price is
 * already there when the position is created, an intrabar fill once it
 * arrives. This is a trigger check only; it returns a reference price, not
 * a slippage-adjusted fill — the position-size cap and cost-floor filters
 * (§6.3/§6.4, unchanged, still apply — DECISIONS §39) run on this same
 * observation before an order is actually placed, and any execution
 * slippage is modelled at the execution layer (paper simulator or live),
 * not here.
 */
export interface LimitEntryDecision {
  readonly fill: boolean;
  /** The observed price that triggered the fill, or null if not yet triggered. */
  readonly referencePrice: number | null;
}

export function evaluateLimitEntry(currentPrice: number, limitPrice: number): LimitEntryDecision {
  if (currentPrice <= limitPrice) {
    return { fill: true, referencePrice: currentPrice };
  }
  return { fill: false, referencePrice: null };
}
