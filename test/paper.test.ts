import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/types/index.js';
import {
  isStale, GeckoTerminalPriceFeed, PriceFeedError, type PoolOhlcvSource,
} from '../src/paper/priceFeed.js';
import { simulateEntryFill, tranchePnl } from '../src/paper/simulator.js';
import { sol } from '../src/util/amount.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function candle(ts: number, close: number): Candle {
  return { timestamp: ts, open: close, high: close, low: close, close, volume: 1 };
}

describe('isStale (DECISIONS §41) — refuse to act on old prices', () => {
  it('is stale when there is no observation at all', () => {
    expect(isStale(null, T0, 5 * MIN)).toBe(true);
  });

  it('is not stale within the threshold', () => {
    expect(isStale({ price: 100, timestamp: T0 }, T0 + 4 * MIN, 5 * MIN)).toBe(false);
  });

  it('is stale beyond the threshold', () => {
    expect(isStale({ price: 100, timestamp: T0 }, T0 + 6 * MIN, 5 * MIN)).toBe(true);
  });

  it('is not stale exactly at the threshold — boundary is inclusive on the fresh side', () => {
    expect(isStale({ price: 100, timestamp: T0 }, T0 + 5 * MIN, 5 * MIN)).toBe(false);
  });
});

describe('GeckoTerminalPriceFeed (DECISIONS §41)', () => {
  function fakeSource(candles: Candle[], onCall?: (pool: string, interval: string, from: number, to: number) => void): PoolOhlcvSource {
    return {
      getPoolOhlcv: async (pool, interval, from, to) => {
        onCall?.(pool, interval, from, to);
        return candles;
      },
    };
  }

  it('returns the latest candle as the current price observation', async () => {
    const source = fakeSource([candle(T0 - 2 * MIN, 10), candle(T0 - MIN, 11), candle(T0, 12)]);
    const feed = new GeckoTerminalPriceFeed(source, () => T0);
    const obs = await feed.getPrice('pool1');
    expect(obs.price).toBe(12);
    expect(obs.timestamp).toBe(T0);
  });

  it('throws PriceFeedError when the pool has no recent trades', async () => {
    const source = fakeSource([]);
    const feed = new GeckoTerminalPriceFeed(source, () => T0);
    await expect(feed.getPrice('pool1')).rejects.toThrow(PriceFeedError);
  });

  it('wraps a source error rather than letting it propagate bare', async () => {
    const source: PoolOhlcvSource = { getPoolOhlcv: async () => { throw new Error('network down'); } };
    const feed = new GeckoTerminalPriceFeed(source, () => T0);
    const err = await feed.getPrice('pool1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceFeedError);
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('requests a 5-minute lookback window ending now, at 1m resolution', async () => {
    let seen: [string, string, number, number] | null = null;
    const source = fakeSource([candle(T0, 10)], (pool, interval, from, to) => { seen = [pool, interval, from, to]; });
    const feed = new GeckoTerminalPriceFeed(source, () => T0);
    await feed.getPrice('poolXYZ');
    expect(seen).toEqual(['poolXYZ', '1m', T0 - 5 * MIN, T0]);
  });
});

describe('simulateEntryFill (DECISIONS §41) — fills at the ASK, never the mid', () => {
  it('fills above the observed mid using the fallback slippage estimate', () => {
    const r = simulateEntryFill({
      midPrice: 100, buyAmountSol: sol('1'), dexFeePct: 0.25,
      priorityFeeSol: 0.0005, jitoTipSol: 0.0001, fallbackSlippagePct: 1, poolLiquiditySol: null,
    });
    expect(r.slippageEstimated).toBe(true);
    expect(r.slippagePct).toBeCloseTo(1, 10);
    expect(r.fillPrice).toBeCloseTo(101, 10);   // 100 * 1.01 — worse than mid, never optimistic
    expect(r.dexFeeSol.toNumberUnsafe()).toBeCloseTo(0.0025, 10);
    expect(r.fixedFeeSol.toNumberUnsafe()).toBeCloseTo(0.0006, 10);
    expect(r.netSizeSol.toNumberUnsafe()).toBeCloseTo(1 - 0.0025 - 0.0006, 10);
  });

  it('sizes slippage from real pool liquidity when supplied', () => {
    const r = simulateEntryFill({
      midPrice: 100, buyAmountSol: sol('10'), dexFeePct: 0.25,
      priorityFeeSol: 0.0005, jitoTipSol: 0.0001, fallbackSlippagePct: 1, poolLiquiditySol: 1000,
    });
    expect(r.slippageEstimated).toBe(false);
    expect(r.slippagePct).toBeCloseTo(1, 10);   // 10/1000*100
    expect(r.fillPrice).toBeCloseTo(101, 10);
  });

  it('a larger position against thin liquidity fills further above mid', () => {
    const r = simulateEntryFill({
      midPrice: 100, buyAmountSol: sol('50'), dexFeePct: 0.25,
      priorityFeeSol: 0.0005, jitoTipSol: 0.0001, fallbackSlippagePct: 1, poolLiquiditySol: 1000,
    });
    expect(r.slippagePct).toBeCloseTo(5, 10);
    expect(r.fillPrice).toBeCloseTo(105, 10);
  });
});

describe('tranchePnl (DECISIONS §41) — same gross P&L formula as the backtest engine', () => {
  it('computes a winning exit exactly', () => {
    const r = tranchePnl({
      sizeSol: sol('1'), entryPrice: 100, fillPrice: 115,
      dexFeePct: 0.25, priorityFeeSol: 0.0005, jitoTipSol: 0.0001,
    });
    expect(r.grossPnlSol.toNumberUnsafe()).toBeCloseTo(0.15, 10);           // 1 * (115/100 - 1)
    expect(r.dexFeeSol.toNumberUnsafe()).toBeCloseTo(1.15 * 0.0025, 10);    // dex fee on GROSS PROCEEDS
    expect(r.fixedFeeSol.toNumberUnsafe()).toBeCloseTo(0.0006, 10);
    const expectedNet = 0.15 - (1.15 * 0.0025) - 0.0006;
    expect(r.netPnlSol.toNumberUnsafe()).toBeCloseTo(expectedNet, 10);
  });

  it('computes a losing exit exactly — costs make the loss worse, never better', () => {
    const r = tranchePnl({
      sizeSol: sol('1'), entryPrice: 100, fillPrice: 85,
      dexFeePct: 0.25, priorityFeeSol: 0.0005, jitoTipSol: 0.0001,
    });
    expect(r.grossPnlSol.toNumberUnsafe()).toBeCloseTo(-0.15, 10);
    expect(r.netPnlSol.toNumberUnsafe()).toBeLessThan(r.grossPnlSol.toNumberUnsafe());
  });

  it('scales correctly for a partial tranche, not the full position', () => {
    const full = tranchePnl({
      sizeSol: sol('1'), entryPrice: 100, fillPrice: 120,
      dexFeePct: 0.25, priorityFeeSol: 0.0005, jitoTipSol: 0.0001,
    });
    const half = tranchePnl({
      sizeSol: sol('0.5'), entryPrice: 100, fillPrice: 120,
      dexFeePct: 0.25, priorityFeeSol: 0.0005, jitoTipSol: 0.0001,
    });
    expect(half.grossPnlSol.toNumberUnsafe()).toBeCloseTo(full.grossPnlSol.toNumberUnsafe() / 2, 10);
    // the fixed fee does NOT halve — it's one transaction regardless of size
    expect(half.fixedFeeSol.toNumberUnsafe()).toBeCloseTo(full.fixedFeeSol.toNumberUnsafe(), 10);
  });
});
