import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isStale, JupiterQuoteFeed, PriceFeedError, SOL_MINT,
  type FetchFn, type PriceFeed, type QuoteRequest,
} from '../src/paper/priceFeed.js';
import { simulateEntryFill, tranchePnl } from '../src/paper/simulator.js';
import { PaperStore } from '../src/paper/store.js';
import { tick, type TickDeps } from '../src/paper/runner.js';
import { openDb } from '../src/db/index.js';
import { sol } from '../src/util/amount.js';
import { parseConfig } from '../src/config/load.js';
import { globalSchema } from '../src/config/schema.js';
import type { LadderExitConfig, ManualPositionConfig } from '../src/config/schema.js';

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function testLadderConfig(): LadderExitConfig {
  return parseConfig({
    global: {}, tokens: [],
    positions: [{
      address: JUP, symbol: 'JUP', decimals: 6, buyAmountSol: '1', limitPrice: 100,
      ladder: { tranches: [{ targetGainPct: 15, sellPct: 40 }, { targetGainPct: 30, sellPct: 40 }] },
    }],
  }).positions[0]!.ladder;
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;

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

function quoteResponse(inAmount: string, outAmount: string, priceImpactPct = '0'): unknown {
  return { inAmount, outAmount, priceImpactPct };
}

function mockFetch(status: number, body: unknown, statusText = 'OK'): FetchFn {
  return async () => ({
    ok: status >= 200 && status < 300, status, statusText,
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function throwingFetch(message: string): FetchFn {
  return async () => { throw new Error(message); };
}

function capturingFetch(body: unknown, onUrl: (url: string) => void): FetchFn {
  return async (url) => {
    onUrl(url);
    return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
  };
}

describe('JupiterQuoteFeed (DECISIONS §41 follow-up) — live executable price, no pool needed', () => {
  it('computes SOL-per-token price for a buy quote (SOL -> token), and passes priceImpactPct through', async () => {
    const fetchFn = mockFetch(200, quoteResponse('100000000', '48931100', '0.0000973521893710759875445972'));
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    const obs = await feed.getPrice({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 100_000_000n });
    expect(obs.price).toBeCloseTo(0.1 / 48.9311, 6);
    expect(obs.timestamp).toBe(T0);
    expect(obs.priceImpactPct).toBeCloseTo(0.0000973521893710759875445972, 10);
  });

  it('requests inputMint=SOL, outputMint=token for a buy quote', async () => {
    let url = '';
    const fetchFn = capturingFetch(quoteResponse('100000000', '48931100'), (u) => { url = u; });
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    await feed.getPrice({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 100_000_000n });
    expect(url).toContain(`inputMint=${SOL_MINT}`);
    expect(url).toContain(`outputMint=${JUP}`);
    expect(url).toContain('amount=100000000');
  });

  it('requests inputMint=token, outputMint=SOL for a sell quote, price still in SOL-per-token units', async () => {
    let url = '';
    const fetchFn = capturingFetch(quoteResponse('48931100', '99417000'), (u) => { url = u; });
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    const obs = await feed.getPrice({ direction: 'sell', tokenMint: JUP, tokenDecimals: 6, amountRaw: 48_931_100n });
    expect(url).toContain(`inputMint=${JUP}`);
    expect(url).toContain(`outputMint=${SOL_MINT}`);
    expect(url).toContain('amount=48931100');
    expect(obs.price).toBeCloseTo(0.099417 / 48.9311, 6);
  });

  it('throws PriceFeedError with the status and body on a non-OK response', async () => {
    const fetchFn = mockFetch(429, 'rate limited', 'Too Many Requests');
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    const err = await feed.getPrice({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 1_000_000_000n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceFeedError);
    expect((err as Error).message).toContain('429');
    expect((err as Error).message).toContain('rate limited');
  });

  it('wraps a network-level failure as PriceFeedError with a cause', async () => {
    const fetchFn = throwingFetch('ECONNRESET');
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    const err = await feed.getPrice({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 1_000_000_000n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceFeedError);
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('throws PriceFeedError on a malformed response body', async () => {
    const fetchFn = mockFetch(200, { unexpected: 'shape' });
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    await expect(
      feed.getPrice({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 1_000_000_000n }),
    ).rejects.toThrow(PriceFeedError);
  });

  it('throws PriceFeedError on a zero output amount rather than dividing by zero', async () => {
    const fetchFn = mockFetch(200, quoteResponse('1000000000', '0'));
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    await expect(
      feed.getPrice({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 1_000_000_000n }),
    ).rejects.toThrow(PriceFeedError);
  });

  it('rejects a non-positive amount before making a request', async () => {
    let called = false;
    const fetchFn: FetchFn = async () => { called = true; throw new Error('should not be called'); };
    const feed = new JupiterQuoteFeed({ fetchFn, now: () => T0 });
    await expect(
      feed.getPrice({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 0n }),
    ).rejects.toThrow(PriceFeedError);
    expect(called).toBe(false);
  });
});

describe('simulateEntryFill (DECISIONS §41, §41 follow-up) — fills at the ASK, never the mid', () => {
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

  it('fills at the quoted price directly when a real price-impact figure is supplied — no synthetic markup', () => {
    const r = simulateEntryFill({
      midPrice: 100, buyAmountSol: sol('1'), dexFeePct: 0.25,
      priorityFeeSol: 0.0005, jitoTipSol: 0.0001, fallbackSlippagePct: 1, poolLiquiditySol: null,
      realPriceImpactPct: 0.0097,
    });
    expect(r.fillPrice).toBe(100);   // midPrice IS the ask already — no markup applied
    expect(r.slippagePct).toBe(0.0097);
    expect(r.slippageEstimated).toBe(false);
  });

  it('a real price-impact figure wins even when pool liquidity is ALSO supplied', () => {
    const r = simulateEntryFill({
      midPrice: 100, buyAmountSol: sol('10'), dexFeePct: 0.25,
      priorityFeeSol: 0.0005, jitoTipSol: 0.0001, fallbackSlippagePct: 1, poolLiquiditySol: 1000,
      realPriceImpactPct: 0.02,
    });
    expect(r.fillPrice).toBe(100);
    expect(r.slippagePct).toBe(0.02);   // not the 1.0 the liquidity formula would have given
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

describe('PaperStore.recordFeedTick/getFeedStats (DECISIONS §41) — cumulative feed reliability, persisted', () => {
  function newStore(): PaperStore {
    return new PaperStore(openDb(':memory:'));
  }
  const GAP = 45_000;   // > 30s * 1.5 normalPollGapMs used in these tests

  it('starts at zero for a symbol with no recorded ticks', () => {
    const store = newStore();
    const stats = store.getFeedStats('JUP');
    expect(stats).toMatchObject({
      usableCount: 0, staleCount: 0, errorCount: 0,
      blindStreakStartedAt: null, longestBlindStreakMs: 0, lastTickAt: null,
    });
  });

  it('counts a usable tick and leaves the blind streak untouched', () => {
    const store = newStore();
    const stats = store.recordFeedTick({ symbol: 'JUP', outcome: 'usable', nowMs: T0, normalPollGapMs: GAP });
    expect(stats.usableCount).toBe(1);
    expect(stats.errorCount).toBe(0);
    expect(stats.blindStreakStartedAt).toBeNull();
    expect(stats.longestBlindStreakMs).toBe(0);
  });

  it('starts a blind streak on the first error tick and grows it on consecutive ones', () => {
    const store = newStore();
    store.recordFeedTick({ symbol: 'JUP', outcome: 'error', nowMs: T0, normalPollGapMs: GAP });
    const s2 = store.recordFeedTick({ symbol: 'JUP', outcome: 'error', nowMs: T0 + 30_000, normalPollGapMs: GAP });
    expect(s2.errorCount).toBe(2);
    expect(s2.blindStreakStartedAt).toBe(T0);
    expect(s2.longestBlindStreakMs).toBe(30_000);
    const s3 = store.recordFeedTick({ symbol: 'JUP', outcome: 'stale', nowMs: T0 + 90_000, normalPollGapMs: GAP });
    expect(s3.staleCount).toBe(1);
    expect(s3.longestBlindStreakMs).toBe(90_000);   // mixed error+stale still one continuous streak
  });

  it('ends the streak on a usable tick, keeping the longest-so-far recorded', () => {
    const store = newStore();
    store.recordFeedTick({ symbol: 'JUP', outcome: 'error', nowMs: T0, normalPollGapMs: GAP });
    store.recordFeedTick({ symbol: 'JUP', outcome: 'error', nowMs: T0 + 5 * MIN, normalPollGapMs: GAP });
    const ended = store.recordFeedTick({ symbol: 'JUP', outcome: 'usable', nowMs: T0 + 6 * MIN, normalPollGapMs: GAP });
    expect(ended.blindStreakStartedAt).toBeNull();
    expect(ended.longestBlindStreakMs).toBe(6 * MIN);   // streak ran from T0 to the usable tick that ended it
    expect(ended.longestBlindStreakEndedAt).toBe(T0 + 6 * MIN);

    // a later, SHORTER blind spell must not overwrite the longer historical max
    store.recordFeedTick({ symbol: 'JUP', outcome: 'error', nowMs: T0 + 7 * MIN, normalPollGapMs: GAP });
    const shorter = store.recordFeedTick({ symbol: 'JUP', outcome: 'usable', nowMs: T0 + 7 * MIN + 60_000, normalPollGapMs: GAP });
    expect(shorter.longestBlindStreakMs).toBe(6 * MIN);   // unchanged — the 1-minute spell was shorter
  });

  it('folds unexplained downtime (a crash-to-restart gap) into the blind streak, not just in-process errors', () => {
    const store = newStore();
    store.recordFeedTick({ symbol: 'JUP', outcome: 'usable', nowMs: T0, normalPollGapMs: GAP });
    // simulate a process restart 20 minutes later with no ticks recorded in between —
    // the gap itself, backdated to the last known-good tick, becomes the blind streak
    const afterGap = store.recordFeedTick({ symbol: 'JUP', outcome: 'usable', nowMs: T0 + 20 * MIN, normalPollGapMs: GAP });
    expect(afterGap.longestBlindStreakMs).toBe(20 * MIN);
    expect(afterGap.blindStreakStartedAt).toBeNull();   // this tick is usable, so the streak already closed
  });

  it('persists across a fresh PaperStore on the same db file (survives a real restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paper-feedstats-'));
    const dbPath = join(dir, 'paper.db');
    try {
      const db1 = openDb(dbPath);
      const store1 = new PaperStore(db1);
      store1.recordFeedTick({ symbol: 'JUP', outcome: 'error', nowMs: T0, normalPollGapMs: GAP });
      store1.recordFeedTick({ symbol: 'JUP', outcome: 'error', nowMs: T0 + 10 * MIN, normalPollGapMs: GAP });
      db1.close();

      const db2 = openDb(dbPath);
      const store2 = new PaperStore(db2);
      const resumed = store2.getFeedStats('JUP');
      expect(resumed.errorCount).toBe(2);
      expect(resumed.longestBlindStreakMs).toBe(10 * MIN);
      expect(resumed.blindStreakStartedAt).toBe(T0);   // still mid-streak — the count was not reset by the restart
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function testPosition(over: Record<string, unknown> = {}): ManualPositionConfig {
  return parseConfig({
    global: {}, tokens: [],
    positions: [{
      address: JUP, symbol: 'JUP', decimals: 6, buyAmountSol: '1', limitPrice: 100,
      ladder: {
        tranches: [{ targetGainPct: 15, sellPct: 50 }, { targetGainPct: 30, sellPct: 50 }],
        stopLossPct: 15, timeExitMinutes: 2880,
      },
      ...over,
    }],
  }).positions[0]!;
}

/** Ignores the request's direction/size — same fixed price/timestamp regardless. */
function fixedFeed(price: number, timestamp: number, priceImpactPct?: number): PriceFeed {
  return {
    getPrice: async () => ({ price, timestamp, ...(priceImpactPct !== undefined ? { priceImpactPct } : {}) }),
  };
}

function throwingFeed(message: string): PriceFeed {
  return { getPrice: async (): Promise<never> => { throw new Error(message); } };
}

/** Records every QuoteRequest it's asked for, so a test can inspect direction/size wiring. */
function capturingFeed(price: number, timestamp: number, requests: QuoteRequest[]): PriceFeed {
  return {
    getPrice: async (req) => { requests.push(req); return { price, timestamp }; },
  };
}

describe('tick (DECISIONS §41, §41 follow-up) — runner integration, same rule-evaluation code throughout', () => {
  function harness() {
    const db = openDb(':memory:');
    const store = new PaperStore(db);
    const logs: string[] = [];
    const baseDeps = {
      store, global: globalSchema.parse({}), log: (m: string) => logs.push(m),
      staleAfterMs: 5 * MIN, poolLiquiditySol: 100_000,
    };
    return { db, store, logs, baseDeps };
  }

  it('does nothing while price is above the limit — no entry, but the tick is still logged (feed stats, DECISIONS §41)', async () => {
    const { store, logs, baseDeps } = harness();
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(101, T0), now: () => T0 };
    await tick(testPosition(), deps);
    expect(store.getOpenPosition('JUP')).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('price 101');
    expect(logs[0]).toContain('feed: 1 ok / 0 blind');
  });

  it('fills the entry at the ask (worse than mid), opens the position, records the fill', async () => {
    const { store, logs, baseDeps } = harness();
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0), now: () => T0 };
    await tick(testPosition(), deps);
    const open = store.getOpenPosition('JUP');
    expect(open).not.toBeNull();
    expect(open!.entryPrice).toBeGreaterThan(99);   // ask, not the observed mid
    expect(open!.remainingSizeSol.toNumberUnsafe()).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('ENTRY FILLED'))).toBe(true);
  });

  it('fills at the quoted price directly (no synthetic markup) when the feed supplies a real price-impact figure', async () => {
    const { store, baseDeps } = harness();
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0, 0.0055), now: () => T0 };
    await tick(testPosition(), deps);
    const open = store.getOpenPosition('JUP')!;
    expect(open.entryPrice).toBe(99);   // the quoted price itself, not 99 * (1 + fallback%)
  });

  it('fails closed and skips the entry when pool liquidity is unknown AND the feed has no real impact figure', async () => {
    const { db, store, logs, baseDeps } = harness();
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0), now: () => T0, poolLiquiditySol: null };
    await tick(testPosition(), deps);
    expect(store.getOpenPosition('JUP')).toBeNull();
    expect(logs.some((l) => l.includes('ENTRY SKIPPED'))).toBe(true);
    const events = db.prepare("SELECT kind FROM paper_events WHERE kind = 'entry_skipped'").all() as { kind: string }[];
    expect(events).toHaveLength(1);
  });

  it('DECISIONS §41 second follow-up: fills even when poolLiquiditySol is null, deriving an implied bound from the real quoted impact', async () => {
    const { store, logs, baseDeps } = harness();
    // this is the exact regression the soak's smoke test found: deps.poolLiquiditySol
    // is null in the real CLI (no live liquidity feed), which used to mean NO entry
    // could ever fill — a real priceImpactPct from the feed must unblock it
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0, 0.0055), now: () => T0, poolLiquiditySol: null };
    await tick(testPosition(), deps);
    const open = store.getOpenPosition('JUP');
    expect(open).not.toBeNull();
    expect(logs.some((l) => l.includes('ENTRY FILLED') && l.includes('implied liquidity'))).toBe(true);
    expect(logs.some((l) => l.includes('ENTRY SKIPPED'))).toBe(false);
  });

  it('treats a near-zero measured impact as effectively unconstrained rather than dividing by ~zero', async () => {
    const { store, baseDeps } = harness();
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0, 0), now: () => T0, poolLiquiditySol: null };
    await tick(testPosition(), deps);
    expect(store.getOpenPosition('JUP')).not.toBeNull();   // did not throw, did not fail closed
  });

  it('still rejects a trade whose real measured impact exceeds maxPctOfPoolLiquidity, even with poolLiquiditySol null', async () => {
    const { store, logs, baseDeps } = harness();
    // default maxPctOfPoolLiquidity is small (schema default) — a measured
    // impact far above it must still reject, proving this isn't a blanket bypass
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0, 50), now: () => T0, poolLiquiditySol: null };
    await tick(testPosition(), deps);
    expect(store.getOpenPosition('JUP')).toBeNull();
    expect(logs.some((l) => l.includes('ENTRY SKIPPED'))).toBe(true);
  });

  it('skips the entry when cost-floor rejects it (target too small to clear round-trip cost)', async () => {
    const { store, logs, baseDeps } = harness();
    const position = testPosition({
      ladder: {
        tranches: [{ targetGainPct: 0.01, sellPct: 100 }],   // far too small to clear 3x round-trip cost
        stopLossPct: 15, timeExitMinutes: 2880,
      },
    });
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0), now: () => T0 };
    await tick(position, deps);
    expect(store.getOpenPosition('JUP')).toBeNull();
    expect(logs.some((l) => l.includes('ENTRY SKIPPED') && l.includes('cost-floor'))).toBe(true);
  });

  it('refuses to act on a stale price observation — no entry, event logged', async () => {
    const { store, logs, baseDeps } = harness();
    // observation is 10 minutes old, threshold is 5
    const deps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0 - 10 * MIN), now: () => T0 };
    await tick(testPosition(), deps);
    expect(store.getOpenPosition('JUP')).toBeNull();
    expect(logs.some((l) => l.includes('STALE FEED'))).toBe(true);
  });

  it('handles a feed error without crashing and without acting', async () => {
    const { store, logs, baseDeps } = harness();
    const deps: TickDeps = { ...baseDeps, feed: throwingFeed('connection reset'), now: () => T0 };
    await expect(tick(testPosition(), deps)).resolves.toBeUndefined();
    expect(store.getOpenPosition('JUP')).toBeNull();
    expect(logs.some((l) => l.includes('FEED ERROR'))).toBe(true);
  });

  it('requests a buy quote sized to buyAmountSol when there is no open position', async () => {
    const { baseDeps } = harness();
    const position = testPosition({ buyAmountSol: '2.5' });
    const requests: QuoteRequest[] = [];
    const deps: TickDeps = { ...baseDeps, feed: capturingFeed(101, T0, requests), now: () => T0 };   // 101 > limit 100, no fill
    await tick(position, deps);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: sol('2.5').raw });
  });

  it('requests a sell quote sized to the derived remaining token quantity when a position is open', async () => {
    const { store, baseDeps } = harness();
    const position = testPosition();
    await tick(position, { ...baseDeps, feed: fixedFeed(99, T0), now: () => T0 });
    const open = store.getOpenPosition('JUP')!;

    const requests: QuoteRequest[] = [];
    // returns entryPrice back — no trigger, position stays open, request still captured
    const deps: TickDeps = { ...baseDeps, feed: capturingFeed(open.entryPrice, T0 + MIN, requests), now: () => T0 + MIN };
    await tick(position, deps);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.direction).toBe('sell');
    expect(requests[0]!.tokenMint).toBe(JUP);
    expect(requests[0]!.tokenDecimals).toBe(6);
    const impliedQty = Number(requests[0]!.amountRaw) / 10 ** 6;
    const expectedQty = open.remainingSizeSol.toNumberUnsafe() / open.entryPrice;
    expect(impliedQty).toBeCloseTo(expectedQty, 5);
  });

  it('fires the hard stop-loss intrabar-equivalent (the single observed tick), closes the position', async () => {
    const { store, logs, baseDeps } = harness();
    const position = testPosition();
    const entryDeps: TickDeps = { ...baseDeps, feed: fixedFeed(99, T0), now: () => T0 };
    await tick(position, entryDeps);
    const entryPrice = store.getOpenPosition('JUP')!.entryPrice;

    const stopPrice = entryPrice * 0.8;   // well past the 15% stop
    const exitDeps: TickDeps = { ...baseDeps, feed: fixedFeed(stopPrice, T0 + MIN), now: () => T0 + MIN };
    await tick(position, exitDeps);

    expect(store.getOpenPosition('JUP')).toBeNull();   // closed
    expect(logs.some((l) => l.includes('STOP_LOSS FILLED') && l.includes('CLOSED'))).toBe(true);
  });

  it('arms trailing exactly on the tranche-1 fill, and partial-fill accounting stays consistent', async () => {
    const { store, logs, baseDeps } = harness();
    const position = testPosition({
      ladder: {
        tranches: [{ targetGainPct: 15, sellPct: 40 }, { targetGainPct: 30, sellPct: 40 }],
        trailing: { enabled: true, trailPct: 5 }, stopLossPct: 15, timeExitMinutes: 2880,
      },
    });
    await tick(position, { ...baseDeps, feed: fixedFeed(99, T0), now: () => T0 });
    const afterEntry = store.getOpenPosition('JUP')!;
    expect(afterEntry.trailingArmed).toBe(false);   // not armed before any tranche fills
    const entryPrice = afterEntry.entryPrice;
    const originalSize = afterEntry.originalSizeSol;

    const tranche1Price = entryPrice * 1.16;   // clears the +15% target
    await tick(position, { ...baseDeps, feed: fixedFeed(tranche1Price, T0 + MIN), now: () => T0 + MIN });
    const afterTranche1 = store.getOpenPosition('JUP')!;
    expect(afterTranche1.trailingArmed).toBe(true);   // armed on the SAME tick tranche 1 filled
    expect(afterTranche1.filledTrancheCount).toBe(1);
    // 40% sold, 60% remains — checked against the ORIGINAL size, not re-derived
    const expectedRemaining = originalSize.toNumberUnsafe() * 0.6;
    expect(afterTranche1.remainingSizeSol.toNumberUnsafe()).toBeCloseTo(expectedRemaining, 6);
    expect(afterTranche1.stopLossPrice).toBeCloseTo(afterEntry.stopLossPrice, 10);   // stop level unchanged by a TP fill
    expect(logs.some((l) => l.includes('TAKE_PROFIT FILLED'))).toBe(true);

    // now trail: price retreats 5% from its peak — should fire the trailing stop for the REMAINDER
    const peak = afterTranche1.peakPrice;
    const trailPrice = peak * 0.94;
    await tick(position, { ...baseDeps, feed: fixedFeed(trailPrice, T0 + 2 * MIN), now: () => T0 + 2 * MIN });
    expect(store.getOpenPosition('JUP')).toBeNull();   // fully closed — the trail took the rest
    expect(logs.some((l) => l.includes('TRAILING FILLED') && l.includes('CLOSED'))).toBe(true);
  });

  it('resumes correctly across a simulated restart — a fresh PaperStore on the SAME db mid-ladder', async () => {
    const { db, store, baseDeps } = harness();
    const position = testPosition();
    await tick(position, { ...baseDeps, feed: fixedFeed(99, T0), now: () => T0 });
    const entryPrice = store.getOpenPosition('JUP')!.entryPrice;
    const tranche1Price = entryPrice * 1.16;
    await tick(position, { ...baseDeps, feed: fixedFeed(tranche1Price, T0 + MIN), now: () => T0 + MIN });
    const beforeRestart = store.getOpenPosition('JUP')!;

    // "restart" — a brand new PaperStore wrapping the SAME underlying db, as
    // a fresh process would after re-running `openDb` against the same file
    const freshStore = new PaperStore(db);
    const resumed = freshStore.getOpenPosition('JUP')!;
    expect(resumed.remainingSizeSol.eq(beforeRestart.remainingSizeSol)).toBe(true);
    expect(resumed.filledTrancheCount).toBe(beforeRestart.filledTrancheCount);
    expect(resumed.peakPrice).toBe(beforeRestart.peakPrice);

    // continue trading against the RESUMED store — the second tranche should
    // still fire correctly, proving the resumed state is fully usable, not just readable
    const freshLogs: string[] = [];
    const resumedDeps: TickDeps = { ...baseDeps, store: freshStore, log: (m) => freshLogs.push(m), feed: fixedFeed(entryPrice * 1.31, T0 + 2 * MIN), now: () => T0 + 2 * MIN };
    await tick(position, resumedDeps);
    expect(freshStore.getOpenPosition('JUP')).toBeNull();   // both tranches filled -> closed
    expect(freshLogs.some((l) => l.includes('TAKE_PROFIT FILLED') && l.includes('CLOSED'))).toBe(true);
  });

  it('feeds cumulative feed-stats tallies through to the log on every tick (DECISIONS §41)', async () => {
    const { store, logs, baseDeps } = harness();
    const position = testPosition();

    await tick(position, { ...baseDeps, feed: throwingFeed('boom'), now: () => T0 });
    expect(logs[0]).toContain('feed: 0 ok / 1 blind (1 err, 0 stale)');

    await tick(position, { ...baseDeps, feed: throwingFeed('boom'), now: () => T0 + 30_000 });
    expect(logs[1]).toContain('feed: 0 ok / 2 blind (2 err, 0 stale)');
    expect(logs[1]).toContain('longest blind 0.5min');

    // price is above the limit so this stays a quiet, no-action tick — must still be counted
    await tick(position, { ...baseDeps, feed: fixedFeed(101, T0 + 60_000), now: () => T0 + 60_000 });
    expect(logs[2]).toContain('feed: 1 ok / 2 blind (2 err, 0 stale)');

    const finalStats = store.getFeedStats('JUP');
    expect(finalStats.usableCount).toBe(1);
    expect(finalStats.errorCount).toBe(2);
    expect(finalStats.longestBlindStreakMs).toBe(60_000);   // streak ran from tick 1 (T0) to tick 3's usable observation
  });
});
