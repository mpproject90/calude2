import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { liveTick, type LiveTickDeps } from '../src/execution/liveRunner.js';
import { PaperStore } from '../src/paper/store.js';
import { openDb } from '../src/db/index.js';
import { LiveExecutionUnlock } from '../src/execution/gate.js';
import { engageKillSwitch, isKillSwitchEngaged } from '../src/execution/killSwitch.js';
import type { RpcClient, LatestBlockhash } from '../src/execution/rpcClient.js';
import type { PriceFeed, QuoteRequest } from '../src/paper/priceFeed.js';
import type { FetchFn } from '../src/execution/jupiterSwap.js';
import { parseConfig } from '../src/config/load.js';
import { globalSchema } from '../src/config/schema.js';
import type { ManualPositionConfig } from '../src/config/schema.js';
import { sol } from '../src/util/amount.js';

/** A real, locally-signable (if chain-meaningless) VersionedTransaction — enough for VersionedTransaction.deserialize + .sign to succeed in a test, without ever touching the network. */
function fakeSerializedTransaction(payer: PublicKey): string {
  const message = new TransactionMessage({
    payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const T0 = 1_700_000_000_000;
const MIN = 60_000;

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

async function testUnlock(): Promise<LiveExecutionUnlock> {
  return LiveExecutionUnlock.acquire({ env: { LIVE_TRADING: 'true' }, confirm: async () => 'yes', requiredPhrase: 'yes' });
}

function fixedFeed(price: number, timestamp: number, priceImpactPct?: number): PriceFeed {
  return { getPrice: async (_req: QuoteRequest) => ({ price, timestamp, ...(priceImpactPct !== undefined ? { priceImpactPct } : {}) }) };
}

function fakeRpc(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getSolBalanceLamports: async () => 0n,
    getTokenBalance: async () => null,
    getLatestBlockhash: async (): Promise<LatestBlockhash> => ({ blockhash: 'abc', lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => 500,
    sendRawTransaction: async () => 'sig123',
    getSignatureStatus: async () => ({ confirmationStatus: 'confirmed', err: null }),
    ...overrides,
  };
}

/** A fake fetchFn serving both the /quote and /swap-build requests executeSwap makes — `payer` MUST match the wallet the test signs with, or VersionedTransaction.sign() throws. */
function jupiterFetch(payer: PublicKey, opts: { priceImpactPct?: string; outAmount?: string } = {}): FetchFn {
  const priceImpactPct = opts.priceImpactPct ?? '0.001';
  const outAmount = opts.outAmount ?? '493000000';   // arbitrary plausible token amount
  return async (url) => {
    if (url.includes('/quote')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ inAmount: '1000000000', outAmount, priceImpactPct }),
        text: async () => '',
      };
    }
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ swapTransaction: fakeSerializedTransaction(payer), lastValidBlockHeight: 999, prioritizationFeeLamports: 1000 }),
      text: async () => '',
    };
  };
}

function harness() {
  const db = openDb(':memory:');
  const store = new PaperStore(db);
  const logs: string[] = [];
  const alerts: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'killswitch-live-'));
  const killPath = join(dir, 'KILL');
  const wallet = Keypair.generate();
  return { db, store, logs, alerts, dir, killPath, wallet };
}

describe('liveTick (DECISIONS §42) — kill switch checked first, unconditionally', () => {
  it('takes no action and never touches the feed when the kill switch is engaged', async () => {
    const h = harness();
    engageKillSwitch(h.killPath, 'test');
    let feedCalled = false;
    const deps: LiveTickDeps = {
      feed: { getPrice: async () => { feedCalled = true; return { price: 1, timestamp: T0 }; } },
      store: h.store, rpc: fakeRpc(), wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
    };
    await liveTick(testPosition(), deps);
    expect(feedCalled).toBe(false);
    expect(h.logs.some((l) => l.includes('KILL SWITCH ENGAGED'))).toBe(true);
    expect(h.store.getOpenPosition('JUP')).toBeNull();
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('liveTick entry (DECISIONS §42)', () => {
  it('confirms and opens a real position when the entry swap succeeds end-to-end', async () => {
    const h = harness();
    const deps: LiveTickDeps = {
      feed: fixedFeed(99, T0, 0.001), store: h.store, rpc: fakeRpc(), wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
      jupiterOpts: { fetchFn: jupiterFetch(h.wallet.publicKey) },
    };
    await liveTick(testPosition(), deps);
    const open = h.store.getOpenPosition('JUP');
    expect(open).not.toBeNull();
    expect(open!.entryPrice).toBeGreaterThan(0);
    expect(h.logs.some((l) => l.includes('ENTRY CONFIRMED'))).toBe(true);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('aborts before submitting anything when the fresh execution quote exceeds the slippage cap', async () => {
    const h = harness();
    let sendCalled = false;
    const deps: LiveTickDeps = {
      feed: fixedFeed(99, T0, 0.001), store: h.store,
      rpc: fakeRpc({ sendRawTransaction: async () => { sendCalled = true; return 'sig'; } }),
      wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
      jupiterOpts: { fetchFn: jupiterFetch(h.wallet.publicKey, { priceImpactPct: '0.5' }) },   // 50% impact, way over the 2% default cap
    };
    await liveTick(testPosition(), deps);
    expect(sendCalled).toBe(false);
    expect(h.store.getOpenPosition('JUP')).toBeNull();
    expect(h.logs.some((l) => l.includes('ENTRY ABORTED'))).toBe(true);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('halts EVERYTHING (kill switch engaged, alert raised) and does NOT open a position when confirmation comes back unknown', async () => {
    const h = harness();
    const deps: LiveTickDeps = {
      feed: fixedFeed(99, T0, 0.001), store: h.store,
      rpc: fakeRpc({
        getSignatureStatus: async () => null,   // no record, ever
        getBlockHeight: async () => 1001,        // past lastValidBlockHeight (999 from jupiterFetch)
      }),
      wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
      jupiterOpts: { fetchFn: jupiterFetch(h.wallet.publicKey) },
    };
    await liveTick(testPosition(), deps);
    expect(h.store.getOpenPosition('JUP')).toBeNull();   // NOT opened — state is unknown, not assumed successful
    expect(h.alerts.length).toBeGreaterThan(0);
    expect(h.alerts.some((a) => a.includes('UNKNOWN'))).toBe(true);
    expect(isKillSwitchEngaged(h.killPath)).toBe(true);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('a subsequent tick takes no action once the kill switch has been engaged by an unknown confirmation', async () => {
    const h = harness();
    const unknownDeps: LiveTickDeps = {
      feed: fixedFeed(99, T0, 0.001), store: h.store,
      rpc: fakeRpc({ getSignatureStatus: async () => null, getBlockHeight: async () => 1001 }),
      wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
      jupiterOpts: { fetchFn: jupiterFetch(h.wallet.publicKey) },
    };
    await liveTick(testPosition(), unknownDeps);
    expect(isKillSwitchEngaged(h.killPath)).toBe(true);

    let sendCalledAgain = false;
    const nextTickDeps: LiveTickDeps = {
      ...unknownDeps, now: () => T0 + MIN,
      rpc: fakeRpc({ sendRawTransaction: async () => { sendCalledAgain = true; return 'sig'; } }),
    };
    await liveTick(testPosition(), nextTickDeps);
    expect(sendCalledAgain).toBe(false);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('does nothing when price is above the limit — no swap attempted at all', async () => {
    const h = harness();
    let sendCalled = false;
    const deps: LiveTickDeps = {
      feed: fixedFeed(101, T0), store: h.store,   // above the limitPrice (100)
      rpc: fakeRpc({ sendRawTransaction: async () => { sendCalled = true; return 'sig'; } }),
      wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
    };
    await liveTick(testPosition(), deps);
    expect(sendCalled).toBe(false);
    expect(h.store.getOpenPosition('JUP')).toBeNull();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('skips the entry when the trigger quote has no price-impact figure to bound slippage with', async () => {
    const h = harness();
    const deps: LiveTickDeps = {
      feed: fixedFeed(99, T0), store: h.store,   // no priceImpactPct on the observation
      rpc: fakeRpc(), wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
    };
    await liveTick(testPosition(), deps);
    expect(h.store.getOpenPosition('JUP')).toBeNull();
    expect(h.logs.some((l) => l.includes('ENTRY SKIPPED'))).toBe(true);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('liveTick exit (DECISIONS §42) — ledger safety: remainingSizeSol never changes before confirmed success', () => {
  function seedOpenPosition(h: ReturnType<typeof harness>): void {
    h.store.openPosition({
      id: 'pos1', symbol: 'JUP', address: JUP, poolAddress: '',
      entryPrice: 100, entryTimestamp: T0, originalSizeSol: sol('1'),
      peakPrice: 100, stopLossPrice: 85, ladderConfig: testPosition().ladder,
    });
  }

  it('confirms an exit end-to-end and closes the position when the whole remainder sells', async () => {
    const h = harness();
    // single-tranche ladder for a clean full close on the first fill:
    h.store.openPosition({
      id: 'pos1', symbol: 'JUP', address: JUP, poolAddress: '',
      entryPrice: 100, entryTimestamp: T0, originalSizeSol: sol('1'),
      peakPrice: 100, stopLossPrice: 85,
      ladderConfig: testPosition({ ladder: { tranches: [{ targetGainPct: 15, sellPct: 100 }], stopLossPct: 15, timeExitMinutes: 2880 } }).ladder,
    });
    const deps: LiveTickDeps = {
      feed: fixedFeed(80, T0 + MIN, 0.001), store: h.store, rpc: fakeRpc(), wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0 + MIN, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
      jupiterOpts: { fetchFn: jupiterFetch(h.wallet.publicKey) },
    };
    await liveTick(testPosition(), deps);
    expect(h.store.getOpenPosition('JUP')).toBeNull();   // stop-loss took the whole remainder -> closed
    expect(h.logs.some((l) => l.includes('STOP_LOSS') && l.includes('CONFIRMED') && l.includes('CLOSED'))).toBe(true);
  });

  it('leaves remainingSizeSol/filledTrancheCount untouched (only peak/trailing update) when the exit swap fails on-chain', async () => {
    const h = harness();
    seedOpenPosition(h);
    const before = h.store.getOpenPosition('JUP')!;

    const deps: LiveTickDeps = {
      feed: fixedFeed(80, T0 + MIN, 0.001), store: h.store,   // well past the 15% stop
      rpc: fakeRpc({ getSignatureStatus: async () => ({ confirmationStatus: 'finalized', err: { InstructionError: [0, 'slippage'] } }) }),
      wallet: h.wallet, unlock: await testUnlock(),
      global: globalSchema.parse({}), now: () => T0 + MIN, log: (m) => h.logs.push(m), alert: (m) => h.alerts.push(m),
      staleAfterMs: 5 * MIN, killSwitchPath: h.killPath,
      jupiterOpts: { fetchFn: jupiterFetch(h.wallet.publicKey) },
    };
    await liveTick(testPosition(), deps);

    const after = h.store.getOpenPosition('JUP')!;
    expect(after.remainingSizeSol.eq(before.remainingSizeSol)).toBe(true);   // NOT reduced — the swap failed on-chain
    expect(after.filledTrancheCount).toBe(before.filledTrancheCount);
    expect(h.logs.some((l) => l.includes('EXIT') && l.includes('FAILED on-chain'))).toBe(true);
    rmSync(h.dir, { recursive: true, force: true });
  });
});
