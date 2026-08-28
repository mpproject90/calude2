/**
 * Portfolio-level risk limits (spec §8). Checked before EVERY entry. A breach
 * blocks the signal and is logged with its reason — those logs are the record
 * of what the limits cost or saved.
 */
import { TokenAmount } from '../util/amount.js';
import { fail, pass, type FilterResult } from '../filters/types.js';

export interface ClosedTrade {
  readonly token: string;
  readonly closedAt: number;
  readonly closedIndex: number;
  readonly realizedPnlSol: TokenAmount;
}

export interface PortfolioState {
  readonly openPositions: readonly { token: string; costSol: TokenAmount }[];
  readonly walletBalanceSol: TokenAmount;
  readonly recentClosed: readonly ClosedTrade[];
}

export interface PortfolioLimits {
  readonly maxConcurrentPositions: number;
  readonly dailyLossLimitPct: number;
  readonly maxDeployedCapitalPct: number;
  readonly maxAllocationPerTokenPct: number;
  readonly cooldownCandlesAfterLoss: number;
}

export interface PortfolioCheckInput {
  readonly state: PortfolioState;
  readonly limits: PortfolioLimits;
  readonly token: string;
  readonly proposedSizeSol: TokenAmount;
  readonly nowMs: number;
  readonly currentIndex: number;
}

const DAY_MS = 86_400_000;

/** Realized loss over a rolling 24h window, as a positive SOL amount. */
export function rollingDailyLoss(
  closed: readonly ClosedTrade[],
  nowMs: number,
): TokenAmount {
  let total = TokenAmount.fromRaw(0n, 9);
  for (const t of closed) {
    if (nowMs - t.closedAt > DAY_MS) continue;
    if (t.realizedPnlSol.isNegative()) total = total.add(t.realizedPnlSol);
  }
  return TokenAmount.fromRaw(total.raw < 0n ? -total.raw : 0n, 9);
}

export function checkPortfolioLimits(input: PortfolioCheckInput): FilterResult[] {
  const { state, limits, token, proposedSizeSol, nowMs, currentIndex } = input;
  const out: FilterResult[] = [];
  const F = 'position-size' as const;

  // Max concurrent positions — especially important given SOL correlation.
  const open = state.openPositions.length;
  out.push(
    open < limits.maxConcurrentPositions
      ? pass(F, 'concurrent position limit not reached', { open, max: limits.maxConcurrentPositions })
      : fail(F, `already holding ${open} positions (max ${limits.maxConcurrentPositions})`,
             { open, max: limits.maxConcurrentPositions }),
  );

  // Rolling 24h realized loss limit.
  const loss = rollingDailyLoss(state.recentClosed, nowMs);
  const lossCap = state.walletBalanceSol.mulBps(
    BigInt(Math.round(limits.dailyLossLimitPct * 100)),
  );
  const lossContext = { lossSol: loss.toString(), capSol: lossCap.toString() };
  out.push(
    loss.lt(lossCap)
      ? pass(F, 'within the daily loss limit', lossContext)
      : fail(F, `daily loss ${loss.toString()} SOL has reached the ` +
                `${limits.dailyLossLimitPct}% limit (${lossCap.toString()} SOL) — ` +
                'blocking all new entries', lossContext),
  );

  // Total deployed capital.
  let deployed = TokenAmount.fromRaw(0n, 9);
  for (const p of state.openPositions) deployed = deployed.add(p.costSol);
  const deployedAfter = deployed.add(proposedSizeSol);
  const deployCap = state.walletBalanceSol.mulBps(
    BigInt(Math.round(limits.maxDeployedCapitalPct * 100)),
  );
  out.push(
    deployedAfter.gt(deployCap)
      ? fail(F, `deploying ${deployedAfter.toString()} SOL would exceed the ` +
                `${limits.maxDeployedCapitalPct}% cap (${deployCap.toString()} SOL)`,
             { deployedAfter: deployedAfter.toString(), capSol: deployCap.toString() })
      : pass(F, 'within the deployed capital cap',
             { deployedAfter: deployedAfter.toString(), capSol: deployCap.toString() }),
  );

  // Per-token allocation.
  let inToken = TokenAmount.fromRaw(0n, 9);
  for (const p of state.openPositions) if (p.token === token) inToken = inToken.add(p.costSol);
  const tokenAfter = inToken.add(proposedSizeSol);
  const tokenCap = state.walletBalanceSol.mulBps(
    BigInt(Math.round(limits.maxAllocationPerTokenPct * 100)),
  );
  out.push(
    tokenAfter.gt(tokenCap)
      ? fail(F, `allocation to ${token} would exceed the ${limits.maxAllocationPerTokenPct}% cap`,
             { tokenAfter: tokenAfter.toString(), capSol: tokenCap.toString() })
      : pass(F, 'within the per-token allocation cap',
             { tokenAfter: tokenAfter.toString(), capSol: tokenCap.toString() }),
  );

  // Cooldown after a losing trade in this token.
  const lastLoss = state.recentClosed
    .filter((t) => t.token === token && t.realizedPnlSol.isNegative())
    .sort((a, b) => b.closedIndex - a.closedIndex)[0];
  if (lastLoss !== undefined) {
    const since = currentIndex - lastLoss.closedIndex;
    out.push(
      since < limits.cooldownCandlesAfterLoss
        ? fail(F, `cooling down after a loss in ${token}: ${since}/${limits.cooldownCandlesAfterLoss} candles`,
               { candlesSinceLoss: since, cooldown: limits.cooldownCandlesAfterLoss })
        : pass(F, 'cooldown elapsed', { candlesSinceLoss: since }),
    );
  }

  return out;
}
