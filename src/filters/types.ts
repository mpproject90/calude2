/**
 * Filter results (spec §6). Every filter returns the numbers it computed, not
 * just a verdict — rejections are logged with their context so we can count
 * what each filter is doing and tune from backtest data (§10).
 */
export type FilterName =
  | 'tier-gates'
  | 'relative-strength'
  | 'cost-floor'
  | 'position-size'
  | 'regime'
  | 'tier-b-safety';

export interface FilterResult {
  readonly filter: FilterName;
  readonly pass: boolean;
  readonly reason: string;
  readonly context: Readonly<Record<string, number | string | boolean | null>>;
}

export function pass(
  filter: FilterName,
  reason: string,
  context: FilterResult['context'] = {},
): FilterResult {
  return { filter, pass: true, reason, context };
}

export function fail(
  filter: FilterName,
  reason: string,
  context: FilterResult['context'] = {},
): FilterResult {
  return { filter, pass: false, reason, context };
}
