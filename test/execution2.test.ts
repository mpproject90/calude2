import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  getExecutionQuote, assertWithinSlippageCap, buildSwapTransaction, executeSwap,
  JupiterSwapError, SlippageCapExceededError, type FetchFn, type JupiterQuote,
} from '../src/execution/jupiterSwap.js';
import { confirmSwap, type ConfirmationOutcome } from '../src/execution/confirmation.js';
import { reconcileBalances, formatReconciliationReport } from '../src/execution/balanceReconciliation.js';
import { LiveExecutionUnlock } from '../src/execution/gate.js';
import type { RpcClient, LatestBlockhash } from '../src/execution/rpcClient.js';

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function testUnlock(): Promise<LiveExecutionUnlock> {
  return LiveExecutionUnlock.acquire({
    env: { LIVE_TRADING: 'true' }, confirm: async () => 'yes', requiredPhrase: 'yes',
  });
}

function quoteResponse(inAmount: string, outAmount: string, priceImpactPct = '0'): unknown {
  return { inAmount, outAmount, priceImpactPct };
}

function jsonFetch(status: number, body: unknown, statusText = 'OK'): FetchFn {
  return async () => ({
    ok: status >= 200 && status < 300, status, statusText,
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

describe('getExecutionQuote (DECISIONS §42) — a FRESH quote for execution, mint-pair direction-aware', () => {
  it('requests SOL -> token for a buy, token -> SOL for a sell', async () => {
    let lastUrl = '';
    const fetchFn: FetchFn = async (url) => { lastUrl = url; return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => quoteResponse('100000000', '48931100'), text: async () => '',
    }; };
    await getExecutionQuote({ direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 100_000_000n, slippageBps: 50 }, { fetchFn });
    expect(lastUrl).toContain(`inputMint=${SOL_MINT}`);
    expect(lastUrl).toContain(`outputMint=${JUP}`);

    await getExecutionQuote({ direction: 'sell', tokenMint: JUP, tokenDecimals: 6, amountRaw: 48_931_100n, slippageBps: 50 }, { fetchFn });
    expect(lastUrl).toContain(`inputMint=${JUP}`);
    expect(lastUrl).toContain(`outputMint=${SOL_MINT}`);
  });

  it('parses inAmount/outAmount/priceImpactPct and keeps the raw quote for /swap', async () => {
    const fetchFn = jsonFetch(200, quoteResponse('100000000', '48931100', '0.0055'));
    const quote = await getExecutionQuote(
      { direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 100_000_000n, slippageBps: 50 }, { fetchFn },
    );
    expect(quote.inAmountRaw).toBe(100_000_000n);
    expect(quote.outAmountRaw).toBe(48_931_100n);
    expect(quote.priceImpactFraction).toBeCloseTo(0.0055, 10);
    expect(quote.raw).toEqual(quoteResponse('100000000', '48931100', '0.0055'));
  });

  it('throws JupiterSwapError on a non-OK response', async () => {
    const fetchFn = jsonFetch(429, 'rate limited', 'Too Many Requests');
    await expect(getExecutionQuote(
      { direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 1n, slippageBps: 50 }, { fetchFn },
    )).rejects.toThrow(JupiterSwapError);
  });

  it('throws JupiterSwapError on a malformed response', async () => {
    const fetchFn = jsonFetch(200, { nonsense: true });
    await expect(getExecutionQuote(
      { direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 1n, slippageBps: 50 }, { fetchFn },
    )).rejects.toThrow(JupiterSwapError);
  });
});

describe('assertWithinSlippageCap (DECISIONS §42) — abort, not accept', () => {
  function quote(priceImpactFraction: number): JupiterQuote {
    return { raw: {}, inAmountRaw: 1n, outAmountRaw: 1n, priceImpactFraction };
  }

  it('passes silently when impact is within the cap', () => {
    expect(() => assertWithinSlippageCap(quote(0.005), 1.0)).not.toThrow();   // 0.5% impact, 1% cap
  });

  it('throws SlippageCapExceededError when impact exceeds the cap', () => {
    expect(() => assertWithinSlippageCap(quote(0.02), 1.0)).toThrow(SlippageCapExceededError);   // 2% impact, 1% cap
  });

  it('is exact at the boundary — equal to the cap passes, one hair over does not', () => {
    expect(() => assertWithinSlippageCap(quote(0.01), 1.0)).not.toThrow();   // exactly 1%
    expect(() => assertWithinSlippageCap(quote(0.0100001), 1.0)).toThrow(SlippageCapExceededError);
  });
});

describe('buildSwapTransaction (DECISIONS §42)', () => {
  it('throws JupiterSwapError when the response has no swapTransaction field', async () => {
    const fetchFn = jsonFetch(200, { lastValidBlockHeight: 100 });
    await expect(buildSwapTransaction(
      { quote: { raw: {}, inAmountRaw: 1n, outAmountRaw: 1n, priceImpactFraction: 0 }, userPublicKey: Keypair.generate().publicKey.toBase58(), maxPriorityFeeLamports: 1000 },
      { fetchFn },
    )).rejects.toThrow(JupiterSwapError);
  });

  it('sends the quote and userPublicKey in the POST body', async () => {
    let sentBody: unknown = null;
    const fetchFn: FetchFn = async (_url, init) => {
      sentBody = init?.body !== undefined ? JSON.parse(init.body) : null;
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ swapTransaction: 'AA==', lastValidBlockHeight: 999 }), text: async () => '' };
    };
    const pubkey = Keypair.generate().publicKey.toBase58();
    // "AA==" decodes to a single zero byte — not a real transaction, so
    // deserialization will throw; that's fine, this test only checks the
    // REQUEST shape, not a successful build.
    await buildSwapTransaction(
      { quote: { raw: { fake: 'quote' }, inAmountRaw: 1n, outAmountRaw: 1n, priceImpactFraction: 0 }, userPublicKey: pubkey, maxPriorityFeeLamports: 5000 },
      { fetchFn },
    ).catch(() => {});
    expect(sentBody).toMatchObject({ quoteResponse: { fake: 'quote' }, userPublicKey: pubkey });
  });
});

function fakeRpc(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getSolBalanceLamports: async () => 0n,
    getTokenBalance: async () => null,
    getLatestBlockhash: async (): Promise<LatestBlockhash> => ({ blockhash: 'abc', lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => 500,
    sendRawTransaction: async () => 'sig123',
    getSignatureStatus: async () => null,
    ...overrides,
  };
}

describe('confirmSwap (DECISIONS §42) — three outcomes, UNKNOWN is never treated as failure', () => {
  const noSleep = async (): Promise<void> => {};

  it('returns confirmed/success=true once the RPC reports confirmed with no error', async () => {
    let calls = 0;
    const rpc = fakeRpc({
      getSignatureStatus: async () => {
        calls += 1;
        return calls < 2 ? null : { confirmationStatus: 'confirmed', err: null };
      },
    });
    const outcome = await confirmSwap({ rpc, signature: 'sig', lastValidBlockHeight: 1000, sleep: noSleep, pollIntervalMs: 0 });
    expect(outcome).toEqual<ConfirmationOutcome>({ kind: 'confirmed', success: true });
  });

  it('returns confirmed/success=false with the on-chain error when the tx landed but failed', async () => {
    const rpc = fakeRpc({
      getSignatureStatus: async () => ({ confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } }),
    });
    const outcome = await confirmSwap({ rpc, signature: 'sig', lastValidBlockHeight: 1000, sleep: noSleep });
    expect(outcome.kind).toBe('confirmed');
    if (outcome.kind === 'confirmed') {
      expect(outcome.success).toBe(false);
      if (!outcome.success) expect(outcome.err).toBeDefined();
    }
  });

  it('returns UNKNOWN, not failure, when the blockhash expires with no definitive status', async () => {
    const rpc = fakeRpc({
      getSignatureStatus: async () => null,   // no record, ever
      getBlockHeight: async () => 1001,        // past lastValidBlockHeight
    });
    const outcome = await confirmSwap({ rpc, signature: 'sig', lastValidBlockHeight: 1000, sleep: noSleep });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind === 'unknown') {
      expect(outcome.reason.length).toBeGreaterThan(0);
      expect(outcome.reason).toMatch(/do not resubmit/i);
    }
  });

  it('does not treat a transient RPC error as expiry or as success — keeps polling', async () => {
    let statusCalls = 0;
    const rpc = fakeRpc({
      getSignatureStatus: async () => {
        statusCalls += 1;
        if (statusCalls <= 2) throw new Error('ECONNRESET');
        return { confirmationStatus: 'confirmed', err: null };
      },
      getBlockHeight: async () => 500,   // never exceeds lastValidBlockHeight
    });
    const outcome = await confirmSwap({ rpc, signature: 'sig', lastValidBlockHeight: 1000, sleep: noSleep, pollIntervalMs: 0 });
    expect(outcome).toEqual<ConfirmationOutcome>({ kind: 'confirmed', success: true });
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });

  it('gives up as UNKNOWN after maxAttempts even if the blockhash never observably expires', async () => {
    const rpc = fakeRpc({ getSignatureStatus: async () => null, getBlockHeight: async () => 500 });
    const outcome = await confirmSwap({
      rpc, signature: 'sig', lastValidBlockHeight: 1000, sleep: noSleep, pollIntervalMs: 0, maxAttempts: 3,
    });
    expect(outcome.kind).toBe('unknown');
  });
});

describe('reconcileBalances (DECISIONS §42)', () => {
  it('reports ok:true when everything matches exactly', async () => {
    const owner = Keypair.generate().publicKey;
    const rpc = fakeRpc({ getSolBalanceLamports: async () => 5_000_000_000n });
    const report = await reconcileBalances({
      rpc, owner, expected: [{ label: 'SOL', mint: 'SOL', expectedRaw: 5_000_000_000n, decimals: 9 }],
    });
    expect(report.ok).toBe(true);
    expect(report.mismatches).toHaveLength(0);
  });

  it('reports a mismatch beyond tolerance, with the exact delta', async () => {
    const owner = Keypair.generate().publicKey;
    const rpc = fakeRpc({ getSolBalanceLamports: async () => 4_900_000_000n });
    const report = await reconcileBalances({
      rpc, owner, expected: [{ label: 'SOL', mint: 'SOL', expectedRaw: 5_000_000_000n, decimals: 9 }],
    });
    expect(report.ok).toBe(false);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.deltaRaw).toBe(-100_000_000n);
  });

  it('a delta within tolerance is not reported as a mismatch', async () => {
    const owner = Keypair.generate().publicKey;
    const rpc = fakeRpc({ getSolBalanceLamports: async () => 4_999_995_000n });   // 5000 lamports short — fee dust
    const report = await reconcileBalances({
      rpc, owner, expected: [{ label: 'SOL', mint: 'SOL', expectedRaw: 5_000_000_000n, decimals: 9 }],
      toleranceRaw: 10_000n,
    });
    expect(report.ok).toBe(true);
  });

  it('checks token balances by mint, treating a missing token account as zero', async () => {
    const owner = Keypair.generate().publicKey;
    const rpc = fakeRpc({ getTokenBalance: async () => null });
    const report = await reconcileBalances({
      rpc, owner, expected: [{ label: 'JUP', mint: JUP, expectedRaw: 1_000_000n, decimals: 6 }],
    });
    expect(report.ok).toBe(false);
    expect(report.mismatches[0]!.actualRaw).toBe(0n);
  });

  it('formatReconciliationReport renders a human-readable mismatch line with decimals applied', async () => {
    const owner = Keypair.generate().publicKey;
    const rpc = fakeRpc({ getSolBalanceLamports: async () => 4_900_000_000n });
    const report = await reconcileBalances({
      rpc, owner, expected: [{ label: 'SOL', mint: 'SOL', expectedRaw: 5_000_000_000n, decimals: 9 }],
    });
    const text = formatReconciliationReport(report);
    expect(text).toContain('MISMATCH');
    expect(text).toContain('expected 5');
    expect(text).toContain('actual 4.9');
  });
});

describe('executeSwap (DECISIONS §42) — requires a LiveExecutionUnlock; aborts on excessive slippage before submitting', () => {
  it('aborts before building or submitting anything when the fresh quote exceeds the slippage cap', async () => {
    let swapCalled = false;
    let sendCalled = false;
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/quote')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => quoteResponse('100000000', '1', '0.5'), text: async () => '' };   // 50% impact
      }
      swapCalled = true;
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ swapTransaction: 'AA==', lastValidBlockHeight: 1 }), text: async () => '' };
    };
    const rpc = fakeRpc({ sendRawTransaction: async () => { sendCalled = true; return 'sig'; } });
    const wallet = Keypair.generate();
    const unlock = await testUnlock();

    await expect(executeSwap(
      {
        direction: 'buy', tokenMint: JUP, tokenDecimals: 6, amountRaw: 100_000_000n, slippageBps: 50,
        maxPriceImpactPct: 1.0, maxPriorityFeeLamports: 5000, wallet, rpc, unlock,
      },
      { fetchFn },
    )).rejects.toThrow(SlippageCapExceededError);

    expect(swapCalled).toBe(false);   // never even asked Jupiter to build a transaction
    expect(sendCalled).toBe(false);   // never touched the RPC
  });
});

describe('PublicKey sanity (guards against a typo in the SOL mint constant used across execution + paper)', () => {
  it('SOL_MINT used in getExecutionQuote is a valid base58 public key', () => {
    expect(() => new PublicKey(SOL_MINT)).not.toThrow();
  });
});
