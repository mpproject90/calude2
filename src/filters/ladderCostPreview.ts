/**
 * Take-profit ladder cost preview (DECISIONS §40) — computed at config time,
 * before a position is ever opened, so a bad ladder shape is visible before
 * it's committed to rather than discovered after (costs ran 44% of gross
 * P&L in the phase-1 backtest, DECISIONS §36).
 *
 * SCOPE OF "COST" HERE — stated explicitly because it's a real modelling
 * choice, not the only possible one: each tranche's numbers cover ONLY that
 * tranche's own EXIT leg (DEX fee + slippage + the fixed priority-fee/Jito
 * cost of that one sell transaction) — "each exit paying DEX fee, priority
 * fee and slippage," per the operator's own framing. The ENTRY leg is paid
 * once, is identical regardless of how the exit is laddered, and is not
 * apportioned into these per-tranche numbers; it would only add a constant
 * that cancels out of every comparison this preview makes.
 *
 * SLIPPAGE MODELLING CAVEAT: `estimateRoundTripCost` (costFloor.ts) and this
 * module both use a LINEAR price-impact model (positionValue / poolLiquidity).
 * Under a strictly linear model, splitting one sell into several smaller ones
 * does not change the AGGREGATE slippage cost — only the fixed per-transaction
 * fee (priority + Jito) scales with the number of transactions. So the
 * ladder-vs-single-exit cost premium this preview reports is driven almost
 * entirely by the fixed-fee multiplication, not by slippage — a real
 * (convex) market would likely show smaller per-tranche slippage too, which
 * this linear model cannot capture. Read the premium as a lower bound on
 * the true cost of laddering, not a full accounting of it.
 */
import type { LadderExitConfig } from '../config/schema.js';

export interface LadderCostPreviewInput {
  readonly originalPositionSol: number;
  readonly ladder: Pick<LadderExitConfig, 'tranches' | 'minNetFloorPct' | 'maxFixedCostPctOfProceeds'>;
  readonly dexFeePct: number;
  readonly priorityFeeSol: number;
  readonly jitoTipSol: number;
  readonly fallbackSlippagePct: number;
  /** Null uses `fallbackSlippagePct` — no historical/live pool depth available. */
  readonly poolLiquiditySol: number | null;
}

export interface TrancheCostPreview {
  readonly trancheIndex: number;
  readonly targetGainPct: number;
  readonly sellPct: number;
  readonly costBasisSol: number;
  readonly grossProceedsSol: number;
  readonly dexFeeSol: number;
  readonly slippageSol: number;
  readonly slippagePct: number;
  readonly slippageEstimated: boolean;
  readonly fixedFeeSol: number;
  readonly totalExitCostSol: number;
  readonly netProceedsSol: number;
  /** Net return on the capital THIS tranche exits, after its own exit costs. */
  readonly netGainPct: number;
  readonly fixedCostPctOfGrossProceeds: number;
  readonly netFloorPass: boolean;
  readonly fixedCostRatioPass: boolean;
  readonly pass: boolean;
}

export interface SingleExitPreview {
  readonly averageGainPct: number;
  readonly grossProceedsSol: number;
  readonly totalExitCostSol: number;
  readonly totalExitCostPctOfPosition: number;
}

export interface LadderCostPreview {
  readonly tranches: readonly TrancheCostPreview[];
  readonly allPass: boolean;
  readonly ladderTotalExitCostSol: number;
  readonly ladderTotalExitCostPctOfPosition: number;
  readonly singleExit: SingleExitPreview;
  /** ladder cost % of position minus single-exit cost % of position — "the price of laddering." */
  readonly ladderPremiumPct: number;
}

function exitLegCost(
  grossProceedsSol: number, dexFeePct: number, priorityFeeSol: number, jitoTipSol: number,
  fallbackSlippagePct: number, poolLiquiditySol: number | null,
): { dexFeeSol: number; slippageSol: number; slippagePct: number; slippageEstimated: boolean; fixedFeeSol: number; totalSol: number } {
  const dexFeeSol = grossProceedsSol * (dexFeePct / 100);
  const slippageEstimated = poolLiquiditySol === null || poolLiquiditySol <= 0;
  const slippagePct = slippageEstimated ? fallbackSlippagePct : (grossProceedsSol / poolLiquiditySol) * 100;
  const slippageSol = grossProceedsSol * (slippagePct / 100);
  const fixedFeeSol = priorityFeeSol + jitoTipSol;
  return { dexFeeSol, slippageSol, slippagePct, slippageEstimated, fixedFeeSol, totalSol: dexFeeSol + slippageSol + fixedFeeSol };
}

export function computeLadderCostPreview(input: LadderCostPreviewInput): LadderCostPreview {
  const { originalPositionSol, ladder, dexFeePct, priorityFeeSol, jitoTipSol, fallbackSlippagePct, poolLiquiditySol } = input;

  const tranches: TrancheCostPreview[] = ladder.tranches.map((t, trancheIndex) => {
    const costBasisSol = originalPositionSol * (t.sellPct / 100);
    const grossProceedsSol = costBasisSol * (1 + t.targetGainPct / 100);
    const cost = exitLegCost(grossProceedsSol, dexFeePct, priorityFeeSol, jitoTipSol, fallbackSlippagePct, poolLiquiditySol);
    const netProceedsSol = grossProceedsSol - cost.totalSol;
    const netGainPct = costBasisSol > 0 ? ((netProceedsSol - costBasisSol) / costBasisSol) * 100 : 0;
    const fixedCostPctOfGrossProceeds = grossProceedsSol > 0 ? (cost.fixedFeeSol / grossProceedsSol) * 100 : Infinity;
    const netFloorPass = netGainPct >= ladder.minNetFloorPct;
    const fixedCostRatioPass = fixedCostPctOfGrossProceeds <= ladder.maxFixedCostPctOfProceeds;
    return {
      trancheIndex, targetGainPct: t.targetGainPct, sellPct: t.sellPct,
      costBasisSol, grossProceedsSol,
      dexFeeSol: cost.dexFeeSol, slippageSol: cost.slippageSol, slippagePct: cost.slippagePct,
      slippageEstimated: cost.slippageEstimated, fixedFeeSol: cost.fixedFeeSol,
      totalExitCostSol: cost.totalSol, netProceedsSol, netGainPct, fixedCostPctOfGrossProceeds,
      netFloorPass, fixedCostRatioPass, pass: netFloorPass && fixedCostRatioPass,
    };
  });

  const ladderTotalExitCostSol = tranches.reduce((s, t) => s + t.totalExitCostSol, 0);
  const ladderTotalExitCostPctOfPosition = originalPositionSol > 0 ? (ladderTotalExitCostSol / originalPositionSol) * 100 : 0;

  // The single-exit comparison must sell the SAME total amount the ladder
  // actually sells (sumSellPct% of the position), not the full position —
  // a ladder that only sells 50% and holds the rest as a runner is not
  // comparable to a hypothetical single exit of the OTHER position that
  // sells 100%. Any held remainder sits outside both numbers, unsold
  // either way, so it cannot count as part of "the cost of laddering."
  const sumSellPct = ladder.tranches.reduce((s, t) => s + t.sellPct, 0);
  const averageGainPct = sumSellPct > 0
    ? ladder.tranches.reduce((s, t) => s + t.targetGainPct * t.sellPct, 0) / sumSellPct
    : 0;
  const soldPositionSol = originalPositionSol * (sumSellPct / 100);
  const singleGrossProceedsSol = soldPositionSol * (1 + averageGainPct / 100);
  const singleCost = exitLegCost(singleGrossProceedsSol, dexFeePct, priorityFeeSol, jitoTipSol, fallbackSlippagePct, poolLiquiditySol);
  const singleExit: SingleExitPreview = {
    averageGainPct, grossProceedsSol: singleGrossProceedsSol, totalExitCostSol: singleCost.totalSol,
    totalExitCostPctOfPosition: originalPositionSol > 0 ? (singleCost.totalSol / originalPositionSol) * 100 : 0,
  };

  return {
    tranches, allPass: tranches.every((t) => t.pass),
    ladderTotalExitCostSol, ladderTotalExitCostPctOfPosition, singleExit,
    ladderPremiumPct: ladderTotalExitCostPctOfPosition - singleExit.totalExitCostPctOfPosition,
  };
}
