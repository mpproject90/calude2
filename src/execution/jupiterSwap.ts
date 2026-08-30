/**
 * Jupiter swap execution (phase 3, DECISIONS §42). A FRESH quote is fetched
 * at execution time — never the paper runner's pricing-only quote — because
 * Jupiter's `/swap` endpoint requires the exact `quoteResponse` object from
 * `/quote` verbatim, and price may have moved since the last poll anyway.
 *
 * SLIPPAGE CAP, enforced here, ABORT not accept: `assertWithinSlippageCap`
 * throws before a transaction is ever built if the quote's REAL measured
 * impact exceeds the configured cap. This is a hard stop, not a warning —
 * the caller (`executeSwap`) checks it before doing anything else.
 *
 * PRIORITY FEE: uses Jupiter's own dynamic estimator
 * (`prioritizationFeeLamports.priorityLevelWithMaxLamports`) rather than a
 * hand-rolled `getRecentPrioritizationFees` heuristic — real per-slot
 * congestion data Jupiter already tracks, with `maxLamports` as OUR hard
 * cap so a spike in network congestion can raise the fee but never past
 * what we've configured we're willing to pay.
 *
 * This module builds and can submit a transaction, but `executeSwap`
 * requires a `LiveExecutionUnlock` (`gate.ts`) as a parameter — the type
 * system will not compile a call site that skips the gate.
 */
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { SOL_MINT } from '../paper/priceFeed.js';
import type { LiveExecutionUnlock } from './gate.js';
import type { RpcClient } from './rpcClient.js';

export class JupiterSwapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JupiterSwapError';
  }
}

export class SlippageCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlippageCapExceededError';
  }
}

export type SwapDirection = 'buy' | 'sell';

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface JupiterQuote {
  /** The full quote object, passed to /swap verbatim — never hand-modified. */
  readonly raw: unknown;
  readonly inAmountRaw: bigint;
  readonly outAmountRaw: bigint;
  /** Jupiter's own units — a FRACTION (0.0001 = 0.01%), same as the paper price feed. */
  readonly priceImpactFraction: number;
}

interface RawQuoteResponse {
  readonly inAmount: string;
  readonly outAmount: string;
  readonly priceImpactPct: string;
}

function isRawQuoteResponse(v: unknown): v is RawQuoteResponse {
  return typeof v === 'object' && v !== null
    && typeof (v as Record<string, unknown>).inAmount === 'string'
    && typeof (v as Record<string, unknown>).outAmount === 'string'
    && typeof (v as Record<string, unknown>).priceImpactPct === 'string';
}

const DEFAULT_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const DEFAULT_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

export interface JupiterClientOptions {
  readonly quoteUrl?: string;
  readonly swapUrl?: string;
  readonly fetchFn?: FetchFn;
}

/** A FRESH quote for execution — separate from the paper feed's pricing-only quote (module header). */
export async function getExecutionQuote(
  input: { direction: SwapDirection; tokenMint: string; tokenDecimals: number; amountRaw: bigint; slippageBps: number },
  opts: JupiterClientOptions = {},
): Promise<JupiterQuote> {
  const fetchFn = opts.fetchFn ?? ((url: string) => fetch(url) as unknown as ReturnType<FetchFn>);
  const inputMint = input.direction === 'buy' ? SOL_MINT : input.tokenMint;
  const outputMint = input.direction === 'buy' ? input.tokenMint : SOL_MINT;
  const url = `${opts.quoteUrl ?? DEFAULT_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${input.amountRaw.toString()}&slippageBps=${input.slippageBps}`;

  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new JupiterSwapError(`quote request failed: ${inputMint} -> ${outputMint}`, { cause: err });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new JupiterSwapError(`quote request returned ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const data: unknown = await res.json();
  if (!isRawQuoteResponse(data)) {
    throw new JupiterSwapError(`quote response missing expected fields: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const priceImpactFraction = Number(data.priceImpactPct);
  return {
    raw: data,
    inAmountRaw: BigInt(data.inAmount),
    outAmountRaw: BigInt(data.outAmount),
    priceImpactFraction: Number.isFinite(priceImpactFraction) ? priceImpactFraction : 0,
  };
}

/**
 * ABORT, not accept: throws BEFORE anything is built or submitted when the
 * quote's real measured impact exceeds the configured cap. `maxImpactPct`
 * is in PERCENT (e.g. 1.0 = 1%), matching this project's existing
 * `slippagePct`/`fallbackSlippagePct` convention (DECISIONS §41 follow-up
 * documents this exact fraction-vs-percent boundary once already — the
 * same conversion applies here).
 */
export function assertWithinSlippageCap(quote: JupiterQuote, maxImpactPct: number): void {
  const impactPct = quote.priceImpactFraction * 100;
  if (impactPct > maxImpactPct) {
    throw new SlippageCapExceededError(
      `quote price impact ${impactPct.toFixed(4)}% exceeds the configured cap ${maxImpactPct}% — aborting, not accepting`,
    );
  }
}

interface RawSwapResponse {
  readonly swapTransaction: string;
  readonly lastValidBlockHeight: number;
  readonly prioritizationFeeLamports?: number;
}

function isRawSwapResponse(v: unknown): v is RawSwapResponse {
  return typeof v === 'object' && v !== null
    && typeof (v as Record<string, unknown>).swapTransaction === 'string'
    && typeof (v as Record<string, unknown>).lastValidBlockHeight === 'number';
}

export interface BuiltSwapTransaction {
  readonly transaction: VersionedTransaction;
  readonly lastValidBlockHeight: number;
  readonly prioritizationFeeLamports: number;
}

export async function buildSwapTransaction(
  input: { quote: JupiterQuote; userPublicKey: string; maxPriorityFeeLamports: number },
  opts: JupiterClientOptions = {},
): Promise<BuiltSwapTransaction> {
  const fetchFn = opts.fetchFn ?? ((url: string, init) => fetch(url, init) as unknown as ReturnType<FetchFn>);
  const body = JSON.stringify({
    quoteResponse: input.quote.raw,
    userPublicKey: input.userPublicKey,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { maxLamports: input.maxPriorityFeeLamports, priorityLevel: 'high' },
    },
  });

  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(opts.swapUrl ?? DEFAULT_SWAP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
  } catch (err) {
    throw new JupiterSwapError('swap-build request failed', { cause: err });
  }
  if (!res.ok) {
    const respBody = await res.text().catch(() => '');
    throw new JupiterSwapError(`swap-build request returned ${res.status} ${res.statusText}: ${respBody.slice(0, 300)}`);
  }
  const data: unknown = await res.json();
  if (!isRawSwapResponse(data)) {
    throw new JupiterSwapError(`swap-build response missing expected fields: ${JSON.stringify(data).slice(0, 300)}`);
  }

  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
  } catch (err) {
    throw new JupiterSwapError('swap-build response transaction could not be deserialized', { cause: err });
  }

  return {
    transaction, lastValidBlockHeight: data.lastValidBlockHeight,
    prioritizationFeeLamports: data.prioritizationFeeLamports ?? 0,
  };
}

export interface ExecuteSwapInput {
  readonly direction: SwapDirection;
  readonly tokenMint: string;
  readonly tokenDecimals: number;
  readonly amountRaw: bigint;
  readonly slippageBps: number;
  readonly maxPriceImpactPct: number;
  readonly maxPriorityFeeLamports: number;
  readonly wallet: Keypair;
  readonly rpc: RpcClient;
  /** Proof both gates (LIVE_TRADING + interactive confirmation) were satisfied — see gate.ts's header comment. */
  readonly unlock: LiveExecutionUnlock;
}

export interface ExecutedSwap {
  readonly signature: string;
  readonly quote: JupiterQuote;
  readonly lastValidBlockHeight: number;
  readonly prioritizationFeeLamports: number;
}

/**
 * Fetches a fresh quote, aborts on an excessive slippage cap, builds and
 * signs the transaction, and submits it — returning the signature WITHOUT
 * waiting for confirmation (see `confirmation.ts`: submission and
 * confirmation are deliberately separate steps, because "sent" and
 * "confirmed" must never be conflated — DECISIONS §42).
 */
export async function executeSwap(input: ExecuteSwapInput, opts: JupiterClientOptions = {}): Promise<ExecutedSwap> {
  // input.unlock's VALUE is never read — its presence in the parameter type
  // IS the gate (gate.ts): only LiveExecutionUnlock.acquire() can produce
  // one, so a call site without a valid unlock does not compile.
  const quote = await getExecutionQuote(
    {
      direction: input.direction, tokenMint: input.tokenMint, tokenDecimals: input.tokenDecimals,
      amountRaw: input.amountRaw, slippageBps: input.slippageBps,
    },
    opts,
  );
  assertWithinSlippageCap(quote, input.maxPriceImpactPct);

  const built = await buildSwapTransaction(
    {
      quote, userPublicKey: input.wallet.publicKey.toBase58(),
      maxPriorityFeeLamports: input.maxPriorityFeeLamports,
    },
    opts,
  );
  built.transaction.sign([input.wallet]);
  const signature = await input.rpc.sendRawTransaction(built.transaction.serialize());

  return {
    signature, quote, lastValidBlockHeight: built.lastValidBlockHeight,
    prioritizationFeeLamports: built.prioritizationFeeLamports,
  };
}
