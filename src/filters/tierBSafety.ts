/**
 * Tier B on-chain safety checks (spec §6.1) — INTERFACE ONLY, NOT IMPLEMENTED.
 *
 * Tier B is deferred by explicit decision. The reasoning:
 *
 *   Honest Tier B backtesting requires a survivorship-bias-free dataset that
 *   includes memecoins which went to zero. Dead tokens fall out of the free
 *   data sources this project uses, so such a dataset is not obtainable without
 *   paid historical data. A tier that cannot be validated will not be traded.
 *
 * The interface is defined so the shape is settled if we later pay for data.
 * Every method throws. This is a second line of defence — a tier: B token is
 * already rejected at config load — so reaching one of these is a bug, and it
 * fails loudly rather than silently permitting an unchecked trade.
 */
import type { FilterResult } from './types.js';

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not implemented: Tier B is deferred because it cannot be ` +
        'honestly backtested on free data (survivorship bias). Tier A is the ' +
        'only supported path.',
    );
    this.name = 'NotImplementedError';
  }
}

export interface TokenSafetyReport {
  readonly mintAuthorityRevoked: boolean;
  readonly freezeAuthorityRevoked: boolean;
  readonly lpBurnedOrLocked: boolean;
  readonly top10HolderPct: number;
  readonly lpValueTrendPct: number;
  readonly priorCycles: number;
}

/**
 * What a Tier B implementation would have to provide. Note `checkWhileHolding`:
 * §6.1 requires safety to be re-checked while a position is open, not only at
 * entry, with a liquidity drain triggering an immediate exit regardless of P&L.
 */
export interface TierBSafetyProvider {
  readonly name: string;
  getSafetyReport(tokenAddress: string): Promise<TokenSafetyReport>;
  evaluateAtEntry(tokenAddress: string): Promise<FilterResult>;
  checkWhileHolding(tokenAddress: string): Promise<FilterResult>;
}

export class UnimplementedTierBSafetyProvider implements TierBSafetyProvider {
  readonly name = 'unimplemented';

  getSafetyReport(_tokenAddress: string): Promise<TokenSafetyReport> {
    throw new NotImplementedError('TierBSafetyProvider.getSafetyReport');
  }

  evaluateAtEntry(_tokenAddress: string): Promise<FilterResult> {
    throw new NotImplementedError('TierBSafetyProvider.evaluateAtEntry');
  }

  checkWhileHolding(_tokenAddress: string): Promise<FilterResult> {
    throw new NotImplementedError('TierBSafetyProvider.checkWhileHolding');
  }
}
