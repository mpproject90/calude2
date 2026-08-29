/**
 * Fill simulation for paper trading (DECISIONS §41). Two distinct cost
 * treatments, kept separate deliberately so nothing is double-counted:
 *
 *   PRICE-LEVEL slippage is baked directly into the fill price itself — an
 *   entry fills at the ASK (mid + slippage), never the observed mid; exit
 *   tranches already do this via `evaluateLadderExit`'s `fillAfterSlippage`
 *   (unchanged, reused as-is). "Optimistic fills would validate nothing."
 *
 *   TRANSACTION-LEVEL cost — the DEX swap fee (%) and the flat priority-fee
 *   + Jito-tip (SOL) — is a SEPARATE deduction, exactly as a real swap fee
 *   is separate from price impact. It is never folded into the fill price,
 *   only into the recorded SOL amounts (size acquired on entry, net
 *   proceeds on exit) — mirrors the ladder cost preview's own per-tranche
 *   treatment (DECISIONS §40), not a new invented model.
 */
import { TokenAmount } from '../util/amount.js';

export interface EntryFillInput {
  readonly midPrice: number;
  readonly buyAmountSol: TokenAmount;
  readonly dexFeePct: number;
  readonly priorityFeeSol: number;
  readonly jitoTipSol: number;
  readonly fallbackSlippagePct: number;
  readonly poolLiquiditySol: number | null;
}

export interface EntryFillResult {
  readonly fillPrice: number;
  readonly slippagePct: number;
  readonly slippageEstimated: boolean;
  readonly dexFeeSol: TokenAmount;
  readonly fixedFeeSol: TokenAmount;
  /** buyAmountSol minus dexFeeSol minus fixedFeeSol — what actually opens the position. */
  readonly netSizeSol: TokenAmount;
}

/**
 * Simulates a market buy against `midPrice`: fills at the ASK
 * (`midPrice * (1 + slippagePct/100)`), never at the raw observed price.
 * `poolLiquiditySol` sizes the slippage the same way `costFloor.ts` does
 * for one leg; null falls back to the configured flat estimate.
 */
export function simulateEntryFill(input: EntryFillInput): EntryFillResult {
  const { midPrice, buyAmountSol, dexFeePct, priorityFeeSol, jitoTipSol, fallbackSlippagePct, poolLiquiditySol } = input;
  const buyAmountNum = buyAmountSol.toNumberUnsafe();

  const slippageEstimated = poolLiquiditySol === null || poolLiquiditySol <= 0;
  const slippagePct = slippageEstimated ? fallbackSlippagePct : (buyAmountNum / poolLiquiditySol) * 100;
  const fillPrice = midPrice * (1 + slippagePct / 100);

  const dexFeeSol = TokenAmount.fromDecimalString((buyAmountNum * (dexFeePct / 100)).toFixed(buyAmountSol.decimals), buyAmountSol.decimals);
  const fixedFeeSol = TokenAmount.fromDecimalString((priorityFeeSol + jitoTipSol).toFixed(buyAmountSol.decimals), buyAmountSol.decimals);
  const netSizeSol = buyAmountSol.sub(dexFeeSol).sub(fixedFeeSol);

  return { fillPrice, slippagePct, slippageEstimated, dexFeeSol, fixedFeeSol, netSizeSol };
}

export interface TrancheFillCostInput {
  readonly sizeSol: TokenAmount;
  readonly entryPrice: number;
  readonly fillPrice: number;
  readonly dexFeePct: number;
  readonly priorityFeeSol: number;
  readonly jitoTipSol: number;
}

export interface TrancheFillCostResult {
  readonly grossPnlSol: TokenAmount;
  readonly dexFeeSol: TokenAmount;
  readonly fixedFeeSol: TokenAmount;
  readonly netPnlSol: TokenAmount;
}

/**
 * Cost of one exit fill (a tranche, a trailing/stop exit, or a time exit).
 * `grossPnlSol` uses the same formula the backtest engine uses
 * (`sizeSol * (fillPrice/entryPrice - 1)`) — price-level slippage is
 * already inside `fillPrice` (from `evaluateLadderExit`); this only adds
 * the transaction-level DEX fee and fixed fee, same treatment as the §40
 * cost preview's per-tranche exit leg.
 */
export function tranchePnl(input: TrancheFillCostInput): TrancheFillCostResult {
  const { sizeSol, entryPrice, fillPrice, dexFeePct, priorityFeeSol, jitoTipSol } = input;
  const decimals = sizeSol.decimals;
  const grossPnlNum = sizeSol.toNumberUnsafe() * (fillPrice / entryPrice - 1);
  const grossProceedsNum = sizeSol.toNumberUnsafe() * (fillPrice / entryPrice);

  const grossPnlSol = TokenAmount.fromDecimalString(grossPnlNum.toFixed(decimals), decimals);
  const dexFeeSol = TokenAmount.fromDecimalString((grossProceedsNum * (dexFeePct / 100)).toFixed(decimals), decimals);
  const fixedFeeSol = TokenAmount.fromDecimalString((priorityFeeSol + jitoTipSol).toFixed(decimals), decimals);
  const netPnlSol = grossPnlSol.sub(dexFeeSol).sub(fixedFeeSol);

  return { grossPnlSol, dexFeeSol, fixedFeeSol, netPnlSol };
}
