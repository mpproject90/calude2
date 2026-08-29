import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candle } from '../src/types/index.js';
import {
  isStale, GeckoTerminalPriceFeed, PriceFeedError, type PoolOhlcvSource,
} from '../src/paper/priceFeed.js';
import { simulateEntryFill, tranchePnl } from '../src/paper/simulator.js';
import { PaperStore } from '../src/paper/store.js';
import { openDb } from '../src/db/index.js';
import { sol } from '../src/util/amount.js';
import { parseConfig } from '../src/config/load.js';
import type { LadderExitConfig } from '../src/config/schema.js';

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function testLadderConfig(): LadderExitConfig {
  return parseConfig({
    global: {}, tokens: [],
    positions: [{
      address: JUP, symbol: 'JUP', buyAmountSol: '1', limitPrice: 100,
      ladder: { tranches: [{ targetGainPct: 15, sellPct: 40 }, { targetGainPct: 30, sellPct: 40 }] },
    }],
  }).positions[0]!.ladder;
}

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

describe('PaperStore (DECISIONS §41) — mutable position state + immutable fill/event records', () => {
  it('opens a position and reads it back with TokenAmount/ladder config round-tripped exactly', () => {
    const db = openDb(':memory:');
    const store = new PaperStore(db);
    const ladder = testLadderConfig();
    store.openPosition({
      id: 'pos1', symbol: 'JUP', address: JUP, poolAddress: 'pool1',
      entryPrice: 100, entryTimestamp: T0, originalSizeSol: sol('1'),
      peakPrice: 100, stopLossPrice: 85, ladderConfig: ladder,
    });
    const open = store.loadOpenPositions();
    expect(open).toHaveLength(1);
    const p = open[0]!;
    expect(p.id).toBe('pos1');
    expect(p.entryPrice).toBe(100);
    expect(p.originalSizeSol.eq(sol('1'))).toBe(true);
    expect(p.remainingSizeSol.eq(sol('1'))).toBe(true);
    expect(p.filledTrancheCount).toBe(0);
    expect(p.trailingArmed).toBe(false);
    expect(p.stopLossPrice).toBe(85);
    expect(p.ladderConfig.tranches).toHaveLength(2);
    expect(p.ladderConfig.tranches[0]!.targetGainPct).toBe(15);
    db.close();
  });

  it('updatePosition persists partial-fill state exactly', () => {
    const db = openDb(':memory:');
    const store = new PaperStore(db);
    store.openPosition({
      id: 'pos1', symbol: 'JUP', address: JUP, poolAddress: 'pool1',
      entryPrice: 100, entryTimestamp: T0, originalSizeSol: sol('1'),
      peakPrice: 100, stopLossPrice: 85, ladderConfig: testLadderConfig(),
    });
    store.updatePosition('pos1', {
      remainingSizeSol: sol('0.6'), filledTrancheCount: 1, peakPrice: 120, trailingArmed: true,
    }, T0 + MIN);
    const p = store.getOpenPosition('JUP')!;
    expect(p.remainingSizeSol.eq(sol('0.6'))).toBe(true);
    expect(p.filledTrancheCount).toBe(1);
    expect(p.peakPrice).toBe(120);
    expect(p.trailingArmed).toBe(true);
    db.close();
  });

  it('closePosition removes it from the open set', () => {
    const db = openDb(':memory:');
    const store = new PaperStore(db);
    store.openPosition({
      id: 'pos1', symbol: 'JUP', address: JUP, poolAddress: 'pool1',
      entryPrice: 100, entryTimestamp: T0, originalSizeSol: sol('1'),
      peakPrice: 100, stopLossPrice: 85, ladderConfig: testLadderConfig(),
    });
    store.closePosition('pos1', T0 + 5 * MIN);
    expect(store.loadOpenPositions()).toHaveLength(0);
    db.close();
  });

  it('records a fill with a null P&L for the entry fill and a real one for an exit fill', () => {
    const db = openDb(':memory:');
    const store = new PaperStore(db);
    store.openPosition({
      id: 'pos1', symbol: 'JUP', address: JUP, poolAddress: 'pool1',
      entryPrice: 100, entryTimestamp: T0, originalSizeSol: sol('1'),
      peakPrice: 100, stopLossPrice: 85, ladderConfig: testLadderConfig(),
    });
    store.recordFill({
      positionId: 'pos1', kind: 'entry', trancheIndex: null, triggerPrice: 100, fillPrice: 101,
      sizeSol: sol('1'), grossPnlSol: null, dexFeeSol: sol('0.0025'), fixedFeeSol: sol('0.0006'),
      netPnlSol: null, positionSnapshot: { note: 'opened' }, filledAt: T0,
    });
    store.recordFill({
      positionId: 'pos1', kind: 'take_profit', trancheIndex: 0, triggerPrice: 115, fillPrice: 114.5,
      sizeSol: sol('0.4'), grossPnlSol: sol('0.058'), dexFeeSol: sol('0.001145'), fixedFeeSol: sol('0.0006'),
      netPnlSol: sol('0.056155'), positionSnapshot: { note: 'tranche 0 filled' }, filledAt: T0 + MIN,
    });
    const rows = db.prepare(
      'SELECT kind, tranche_index, gross_pnl_sol_raw, net_pnl_sol_raw, position_snapshot FROM paper_fills ORDER BY id',
    ).all() as {
      kind: string; tranche_index: number | null; gross_pnl_sol_raw: string | null;
      net_pnl_sol_raw: string | null; position_snapshot: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('entry');
    expect(rows[0]!.gross_pnl_sol_raw).toBeNull();
    expect(rows[0]!.net_pnl_sol_raw).toBeNull();
    expect(JSON.parse(rows[0]!.position_snapshot)).toEqual({ note: 'opened' });
    expect(rows[1]!.kind).toBe('take_profit');
    expect(rows[1]!.tranche_index).toBe(0);
    expect(rows[1]!.gross_pnl_sol_raw).not.toBeNull();
    db.close();
  });

  it('records operational events (staleness, feed errors, restarts)', () => {
    const db = openDb(':memory:');
    const store = new PaperStore(db);
    store.recordEvent({ symbol: 'JUP', kind: 'stale_feed', detail: 'no observation in 12 minutes', occurredAt: T0 });
    store.recordEvent({ symbol: null, kind: 'restart', detail: 'process started', occurredAt: T0 + MIN });
    const rows = db.prepare('SELECT symbol, kind, detail FROM paper_events ORDER BY id').all() as {
      symbol: string | null; kind: string; detail: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('stale_feed');
    expect(rows[1]!.symbol).toBeNull();
    db.close();
  });

  describe('restart survival — a REAL file db, closed and reopened fresh', () => {
    let dir: string | undefined;
    afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

    it('resumes an open position with its partial-fill state intact after the process (and db connection) restarts', () => {
      dir = mkdtempSync(join(tmpdir(), 'paper-store-test-'));
      const dbPath = join(dir, 'paper.db');

      // "process 1" — opens a position, fills tranche 0, then dies (connection closed, no graceful shutdown)
      const db1 = openDb(dbPath);
      const store1 = new PaperStore(db1);
      store1.openPosition({
        id: 'pos1', symbol: 'JUP', address: JUP, poolAddress: 'pool1',
        entryPrice: 100, entryTimestamp: T0, originalSizeSol: sol('1'),
        peakPrice: 100, stopLossPrice: 85, ladderConfig: testLadderConfig(),
      });
      store1.updatePosition('pos1', {
        remainingSizeSol: sol('0.6'), filledTrancheCount: 1, peakPrice: 118, trailingArmed: true,
      }, T0 + MIN);
      store1.recordFill({
        positionId: 'pos1', kind: 'take_profit', trancheIndex: 0, triggerPrice: 115, fillPrice: 114.5,
        sizeSol: sol('0.4'), grossPnlSol: sol('0.058'), dexFeeSol: sol('0.001145'), fixedFeeSol: sol('0.0006'),
        netPnlSol: sol('0.056155'), positionSnapshot: { remaining: '0.6' }, filledAt: T0 + MIN,
      });
      db1.close();

      // "process 2" — fresh connection to the SAME file, must resume correctly
      const db2 = openDb(dbPath);
      const store2 = new PaperStore(db2);
      const resumed = store2.getOpenPosition('JUP');
      expect(resumed).not.toBeNull();
      expect(resumed!.id).toBe('pos1');
      expect(resumed!.remainingSizeSol.eq(sol('0.6'))).toBe(true);
      expect(resumed!.filledTrancheCount).toBe(1);
      expect(resumed!.peakPrice).toBe(118);
      expect(resumed!.trailingArmed).toBe(true);
      expect(resumed!.stopLossPrice).toBe(85);
      expect(resumed!.entryPrice).toBe(100);
      const fills = db2.prepare('SELECT kind FROM paper_fills WHERE position_id = ?').all('pos1') as { kind: string }[];
      expect(fills).toHaveLength(1);
      expect(fills[0]!.kind).toBe('take_profit');
      db2.close();
    });
  });
});
