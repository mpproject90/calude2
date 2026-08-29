import { describe, it, expect } from 'vitest';
import { evaluateRelativeStrength } from '../src/filters/relativeStrength.js';
import { evaluateCostFloor, estimateRoundTripCost } from '../src/filters/costFloor.js';
import { evaluatePositionSize } from '../src/filters/positionSize.js';
import { evaluateRegime, simpleMovingAverage } from '../src/filters/regime.js';
import { evaluateTierGates } from '../src/filters/tierGates.js';
import {
  UnimplementedTierBSafetyProvider, NotImplementedError,
} from '../src/filters/tierBSafety.js';
import { sol } from '../src/util/amount.js';

/** Build a close series that moves by exactly `ret` over `lookback` bars. */
function movedBy(ret: number, lookback = 24, start = 100): number[] {
  return [start, ...new Array(lookback - 1).fill(start), start * (1 + ret)];
}

describe('SOL-relative strength', () => {
  const base = { lookback: 24, minUnderperformanceVsSol: 0.05 };

  it('REJECTS correlation: SOL -12%, token -13% is a ~1pp differential', () => {
    const r = evaluateRelativeStrength({
      ...base,
      tokenCloses: movedBy(-0.13),
      solCloses: movedBy(-0.12),
    });
    expect(r.pass).toBe(false);
    // Exact multiplicative relative return (DECISIONS §20), not -0.01: the
    // subtractive approximation and the exact figure only coincide when
    // solReturn is 0.
    expect(r.context['differential'] as number).toBeCloseTo(0.87 / 0.88 - 1, 10);
  });

  it('ACCEPTS dislocation: SOL flat, token -13%', () => {
    const r = evaluateRelativeStrength({
      ...base,
      tokenCloses: movedBy(-0.13),
      solCloses: movedBy(0),
    });
    expect(r.pass).toBe(true);
    expect(r.context['differential'] as number).toBeCloseTo(-0.13, 10);
  });

  it('rejects a token merely matching SOL down', () => {
    const r = evaluateRelativeStrength({
      ...base, tokenCloses: movedBy(-0.30), solCloses: movedBy(-0.30),
    });
    expect(r.pass).toBe(false);
  });

  it('rejects a token OUTperforming SOL', () => {
    const r = evaluateRelativeStrength({
      ...base, tokenCloses: movedBy(-0.05), solCloses: movedBy(-0.20),
    });
    expect(r.pass).toBe(false);
  });

  it('passes exactly at the threshold', () => {
    const r = evaluateRelativeStrength({
      ...base, tokenCloses: movedBy(-0.05), solCloses: movedBy(0),
    });
    expect(r.pass).toBe(true);
  });

  it('always reports token and SOL returns separately for later beta analysis', () => {
    const r = evaluateRelativeStrength({
      ...base, tokenCloses: movedBy(-0.13), solCloses: movedBy(-0.12),
    });
    expect(r.context['tokenReturn'] as number).toBeCloseTo(-0.13, 10);
    expect(r.context['solReturn'] as number).toBeCloseTo(-0.12, 10);
  });

  it('fails closed on insufficient history', () => {
    const r = evaluateRelativeStrength({
      ...base, tokenCloses: [100, 90], solCloses: movedBy(0),
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/insufficient history/);
  });

  it('fails closed on a non-positive reference price', () => {
    const bad = [0, ...new Array(24).fill(100)];
    const r = evaluateRelativeStrength({ ...base, tokenCloses: bad, solCloses: movedBy(0) });
    expect(r.pass).toBe(false);
  });
});

describe('cost floor', () => {
  const base = {
    positionValueSol: 1,
    poolLiquiditySol: 1000,
    dexFeePct: 0.25,
    priorityFeeSol: 0.0005,
    jitoTipSol: 0.0001,
    minTargetToCostRatio: 3,
    fallbackSlippagePct: 1,
  };

  it('breaks cost into its components', () => {
    const c = estimateRoundTripCost({ ...base, expectedMove: { value: 0.1, reliable: true } });
    expect(c.dexFeePct).toBeCloseTo(0.5, 10);       // 0.25% each leg
    expect(c.slippagePct).toBeCloseTo(0.2, 10);     // 1/1000 = 0.1% each leg
    expect(c.fixedFeePct).toBeCloseTo(0.12, 10);    // 0.0012 SOL on a 1 SOL position
    expect(c.roundTripPct).toBeCloseTo(0.82, 10);
    expect(c.slippageEstimated).toBe(false);
  });

  it('passes when the expected move clears 3x round-trip cost', () => {
    // cost 0.82% → needs 2.46%
    const r = evaluateCostFloor({ ...base, expectedMove: { value: 0.03, reliable: true } });
    expect(r.pass).toBe(true);
  });

  it('rejects a move that does not clear the floor', () => {
    const r = evaluateCostFloor({ ...base, expectedMove: { value: 0.02, reliable: true } });
    expect(r.pass).toBe(false);
    expect(r.context['requiredPct'] as number).toBeCloseTo(2.46, 8);
  });

  it('refuses to trade on an unreliable expected move', () => {
    const r = evaluateCostFloor({
      ...base,
      expectedMove: { value: 0.5, reliable: false, reason: 'insufficient-warmup' },
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not reliable/);
  });

  it('falls back to the configured slippage when liquidity is unknown, and says so', () => {
    const c = estimateRoundTripCost({
      ...base, poolLiquiditySol: null, expectedMove: { value: 0.1, reliable: true },
    });
    expect(c.slippagePct).toBeCloseTo(2, 10);   // 1% each leg
    expect(c.slippageEstimated).toBe(true);
  });

  it('makes flat fees dominate on a tiny position', () => {
    const c = estimateRoundTripCost({
      ...base, positionValueSol: 0.01, expectedMove: { value: 0.1, reliable: true },
    });
    expect(c.fixedFeePct).toBeCloseTo(12, 8);   // 0.0012/0.01 = 12%
    expect(c.roundTripPct).toBeGreaterThan(12);
  });
});

describe('position sizing cap', () => {
  const base = { maxPctOfPoolLiquidity: 0.5, minViableSol: sol('0.05') };

  it('leaves a size within the cap untouched', () => {
    const r = evaluatePositionSize({ ...base, requestedSol: sol('0.5'), poolLiquiditySol: 1000 });
    expect(r.pass).toBe(true);
    expect(r.sizeSol!.toString()).toBe('0.5');
    expect(r.context['wasCapped']).toBe(false);
  });

  it('reduces an oversized request to the cap', () => {
    // 0.5% of 100 SOL = 0.5 SOL
    const r = evaluatePositionSize({ ...base, requestedSol: sol('5'), poolLiquiditySol: 100 });
    expect(r.pass).toBe(true);
    expect(r.sizeSol!.toString()).toBe('0.5');
    expect(r.context['wasCapped']).toBe(true);
  });

  it('skips the trade when the capped size is below the minimum viable', () => {
    // 0.5% of 5 SOL = 0.025 SOL, below the 0.05 minimum
    const r = evaluatePositionSize({ ...base, requestedSol: sol('1'), poolLiquiditySol: 5 });
    expect(r.pass).toBe(false);
    expect(r.sizeSol).toBeNull();
    expect(r.reason).toMatch(/below the minimum viable/);
  });

  it('fails closed when liquidity is unknown', () => {
    for (const liq of [null, 0, -1, Number.NaN]) {
      const r = evaluatePositionSize({ ...base, requestedSol: sol('1'), poolLiquiditySol: liq });
      expect(r.pass).toBe(false);
      expect(r.sizeSol).toBeNull();
    }
  });

  it('never rounds the cap upward', () => {
    // 0.5% of 33.333333333 SOL = 0.166666666665 → must truncate, not round up
    const r = evaluatePositionSize({
      ...base, requestedSol: sol('10'), poolLiquiditySol: 33.333333333,
    });
    expect(r.sizeSol!.raw).toBeLessThanOrEqual(166_666_667n);
  });
});

describe('regime filter', () => {
  const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
  const falling = Array.from({ length: 60 }, (_, i) => 200 - i);

  it('computes a simple moving average over the trailing window', () => {
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 2)).toBe(4.5);
    expect(simpleMovingAverage([1, 2], 5)).toBeNull();
  });

  it('allows entries when SOL is above its MA', () => {
    expect(evaluateRegime({ enabled: true, solCloses: rising, maPeriod: 50 }).pass).toBe(true);
  });

  it('blocks entries when SOL is below its MA', () => {
    const r = evaluateRegime({ enabled: true, solCloses: falling, maPeriod: 50 });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/new entries blocked/);
  });

  it('fails closed without enough history to judge', () => {
    expect(evaluateRegime({ enabled: true, solCloses: [1, 2, 3], maPeriod: 50 }).pass).toBe(false);
  });

  it('passes when disabled', () => {
    expect(evaluateRegime({ enabled: false, solCloses: falling, maPeriod: 50 }).pass).toBe(true);
  });
});

describe('tier gates', () => {
  const gates = { minLiquidityUsd: 250_000, minVolume24hUsd: 500_000, minAgeDays: 30 };
  const ok = { liquidityUsd: 1_000_000, volume24hUsd: 2_000_000, ageDays: 365 };

  it('passes a token clearing every gate', () => {
    expect(evaluateTierGates(ok, gates).pass).toBe(true);
  });

  it('rejects thin liquidity, thin volume and youth independently', () => {
    expect(evaluateTierGates({ ...ok, liquidityUsd: 1000 }, gates).pass).toBe(false);
    expect(evaluateTierGates({ ...ok, volume24hUsd: 1000 }, gates).pass).toBe(false);
    expect(evaluateTierGates({ ...ok, ageDays: 2 }, gates).pass).toBe(false);
  });

  it('fails closed on missing metrics', () => {
    expect(evaluateTierGates({ ...ok, liquidityUsd: null }, gates).pass).toBe(false);
    expect(evaluateTierGates({ ...ok, volume24hUsd: null }, gates).pass).toBe(false);
    expect(evaluateTierGates({ ...ok, ageDays: null }, gates).pass).toBe(false);
  });
});

describe('Tier B safety provider', () => {
  const p = new UnimplementedTierBSafetyProvider();

  it('throws NotImplemented on every method rather than silently permitting a trade', () => {
    expect(() => p.getSafetyReport('x')).toThrow(NotImplementedError);
    expect(() => p.evaluateAtEntry('x')).toThrow(NotImplementedError);
    expect(() => p.checkWhileHolding('x')).toThrow(NotImplementedError);
  });

  it('explains why Tier B is deferred', () => {
    expect(() => p.evaluateAtEntry('x')).toThrow(/survivorship bias/);
  });
});
