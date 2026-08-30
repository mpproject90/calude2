/**
 * Live price feed for paper trading (DECISIONS §41, source switched to
 * Jupiter's quote API in the §41 follow-up). Originally built on the most
 * recent 1-minute candle's close — REPLACED after the first real soak run
 * showed 13 of 13 ticks came back "no trades in the last 5 minutes": a
 * candle only exists if someone traded that minute, but an AMM pool has a
 * price continuously (its reserve ratio). Jupiter's quote endpoint returns
 * an executable price from live pool state on every call, independent of
 * recent trade activity, already inclusive of routing and price impact for
 * the SIZE actually being traded — the same number a limit or a stop
 * should be measured against, and the same router phase 3 will execute
 * through, so paper and live measure the same thing.
 *
 * STALENESS (operator-specified — treat a stale feed the same way the
 * indicator reliability mask treats a gap: refuse to act, log loudly). A
 * price observation older than `staleAfterMs` must not be acted on — a stop
 * evaluated against a 20-minute-old price is worse than no stop at all.
 * For a quote-based observation `timestamp` is always "now" (the moment the
 * request returned), so staleness in practice now guards against something
 * different than before: a caller holding an observation too long before
 * acting on it, not "the underlying data is old." `error` (a failed
 * request — network, non-200, malformed body) is expected to be the
 * dominant blind-tick reason now, not `stale`.
 */
export interface PriceObservation {
  readonly price: number;
  readonly timestamp: number;
  /**
   * Jupiter's own `priceImpactPct` for this exact quote, when the feed is
   * quote-based — lets the fill simulator use the REAL size-aware impact
   * instead of a synthetic estimate. `undefined` for a feed that doesn't
   * have one to offer.
   */
  readonly priceImpactPct?: number;
}

/** Which leg of the trade is being priced — see `QuoteRequest`. */
export type QuoteDirection = 'buy' | 'sell';

/**
 * `buy` (entry): quote SOL -> token for `amountRaw` lamports — "the actual
 * trade size" is the configured buy amount.
 * `sell` (exit): quote token -> SOL for `amountRaw` raw token units — "the
 * actual trade size" is whatever of the position remains. The system
 * tracks position size as a SOL VALUE, not a token quantity (DECISIONS
 * §39), so the caller derives `amountRaw` from `remainingSizeSol /
 * entryPrice` at the moment of the request — see `runner.ts`.
 */
export interface QuoteRequest {
  readonly direction: QuoteDirection;
  readonly tokenMint: string;
  readonly tokenDecimals: number;
  readonly amountRaw: bigint;
}

export interface PriceFeed {
  getPrice(request: QuoteRequest): Promise<PriceObservation>;
}

export class PriceFeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PriceFeedError';
  }
}

/** True when there is no observation yet, or the most recent one is older than `staleAfterMs`. */
export function isStale(
  observation: PriceObservation | null, nowMs: number, staleAfterMs: number,
): boolean {
  if (observation === null) return true;
  return nowMs - observation.timestamp > staleAfterMs;
}

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface JupiterQuoteFeedOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
  /** Cosmetic for a price-only quote — doesn't change outAmount/priceImpactPct, only otherAmountThreshold, which this feed never reads. */
  readonly slippageBps?: number;
}

const DEFAULT_BASE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const DEFAULT_SLIPPAGE_BPS = 50;
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

interface JupiterQuoteResponse {
  readonly inAmount: string;
  readonly outAmount: string;
  readonly priceImpactPct: string;
}

function isJupiterQuoteResponse(v: unknown): v is JupiterQuoteResponse {
  return typeof v === 'object' && v !== null
    && typeof (v as Record<string, unknown>).inAmount === 'string'
    && typeof (v as Record<string, unknown>).outAmount === 'string'
    && typeof (v as Record<string, unknown>).priceImpactPct === 'string';
}

function toFloat(raw: string, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Jupiter's quote API as the live price feed (DECISIONS §41 follow-up) —
 * no pool address needed (mint-pair only), no dependence on recent trade
 * activity, an executable size-aware price on every call.
 */
export class JupiterQuoteFeed implements PriceFeed {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly slippageBps: number;

  constructor(opts: JupiterQuoteFeedOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url) as unknown as ReturnType<FetchFn>);
    this.now = opts.now ?? (() => Date.now());
    this.slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  }

  async getPrice(request: QuoteRequest): Promise<PriceObservation> {
    if (request.amountRaw <= 0n) {
      throw new PriceFeedError(`quote amount must be positive, got ${request.amountRaw}`);
    }
    const inputMint = request.direction === 'buy' ? SOL_MINT : request.tokenMint;
    const outputMint = request.direction === 'buy' ? request.tokenMint : SOL_MINT;
    const url = `${this.baseUrl}?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${request.amountRaw.toString()}&slippageBps=${this.slippageBps}`;

    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(url);
    } catch (err) {
      throw new PriceFeedError(`quote request failed: ${inputMint} -> ${outputMint}`, { cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PriceFeedError(
        `quote request returned ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      );
    }
    const data: unknown = await res.json();
    if (!isJupiterQuoteResponse(data)) {
      throw new PriceFeedError(`quote response missing expected fields: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const inDecimals = request.direction === 'buy' ? SOL_DECIMALS : request.tokenDecimals;
    const outDecimals = request.direction === 'buy' ? request.tokenDecimals : SOL_DECIMALS;
    const inFloat = toFloat(data.inAmount, inDecimals);
    const outFloat = toFloat(data.outAmount, outDecimals);
    if (outFloat <= 0) {
      throw new PriceFeedError(`quote returned a non-positive output amount: ${data.outAmount}`);
    }
    // Price is always SOL per unit of the token, regardless of direction —
    // matches limitPrice/stopLossPrice's existing units (DECISIONS §39).
    const solAmount = request.direction === 'buy' ? inFloat : outFloat;
    const tokenAmount = request.direction === 'buy' ? outFloat : inFloat;
    const priceImpactPct = Number(data.priceImpactPct);

    return {
      price: solAmount / tokenAmount,
      timestamp: this.now(),
      ...(Number.isFinite(priceImpactPct) ? { priceImpactPct } : {}),
    };
  }
}
