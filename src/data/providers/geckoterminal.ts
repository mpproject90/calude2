/**
 * GeckoTerminal on-chain pool provider (DECISIONS §18) — replaces Binance as
 * the default. Binance's exchange is unreachable from the operator's ISP
 * (regional block on api.binance.com, confirmed not a code bug: a TLS
 * certificate-domain-mismatch error on that host specifically, while other
 * HTTPS hosts work over the same stack), and this project does not put a VPN
 * in the data path for a paper-trading run that must stay up for weeks.
 *
 * Uses the FREE, KEYLESS surface at api.geckoterminal.com/api/v2 — deliberately
 * NOT api.coingecko.com/api/v3/onchain, which is a different host requiring a
 * CoinGecko Pro API key and carrying its own (higher, paid-tier) rate limits
 * and an explicit 6-months-on-Basic-plan historical cutoff. Conflating the two
 * is an easy mistake; they are not the same limits. Confirmed: 30 requests/min,
 * no key, no signup.
 *
 * Serves REAL per-pool OHLC — the pool's own trades — not a synthesized ratio.
 * Requesting `currency=token&token=base` returns the BASE token's price
 * expressed in the pool's QUOTE-token units: for a JUP(base)/SOL(quote) pool
 * that IS the JUP/SOL series directly. DECISIONS §6's high/low-as-bounds
 * problem, and the "MFI confirmation-only" caveat that came with it, do not
 * apply to data pulled this way.
 *
 * `fetchFn` is injectable so this provider can be unit-tested without network
 * access, same as Binance's. It has NEVER made a real request — every test
 * here runs against a documented MODEL of the response shape (JSON:API-style
 * `{ data: { attributes: { ohlcv_list: [...] } } }` for candles, `{ data: [...] }`
 * with `relationships.base_token`/`quote_token`/`dex` for pool search), not the
 * live API. If the operator's real fetch shows a different shape, the thrown
 * errors below carry the raw response body as `cause` specifically so that
 * mismatch is diagnosable from data rather than from a description of it —
 * same discipline as Binance's `onRawSample` (DECISIONS §14).
 *
 * Every raw `fetchFn` call is wrapped so a thrown network/TLS error (Node's
 * `fetch` surfaces these as `TypeError: fetch failed` with the real reason
 * only reachable via `.cause`) is re-thrown with the request URL attached
 * rather than propagating bare — see `util/errorChain.ts` and DECISIONS §22.
 */
import { INTERVAL_MS, type Candle, type CandleProvider, type Interval } from '../../types/index.js';

const NETWORK = 'solana';
const DEFAULT_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const REQUEST_BUDGET_PER_MIN = 30;
const SAFETY_FACTOR = 0.8;         // stay well clear of the documented ceiling
const MAX_LIMIT = 1000;

/** Solana's wrapped-SOL mint — the canonical SOL address on every DEX pool. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Circle's USDC mint on Solana — used only to find a deep SOL/USDC reference pool. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TIMEFRAME_FOR: Readonly<Record<Interval, { timeframe: 'minute' | 'hour' | 'day'; aggregate: number }>> = {
  '1m': { timeframe: 'minute', aggregate: 1 },
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '4h': { timeframe: 'hour', aggregate: 4 },
  '1d': { timeframe: 'day', aggregate: 1 },
};
const SUPPORTED: ReadonlySet<Interval> = new Set(Object.keys(TIMEFRAME_FOR) as Interval[]);

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class GeckoTerminalProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GeckoTerminalProviderError';
  }
}

export class GeckoTerminalRateLimitError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number, message: string) {
    super(message);
    this.name = 'GeckoTerminalRateLimitError';
  }
}

export interface PoolCandidate {
  readonly address: string;
  readonly dex: string;
  readonly createdAt: string | null;
  /** Current snapshot only — no historical liquidity is available for free; see poolSelection.ts. */
  readonly reserveUsd: number | null;
  readonly baseTokenAddress: string;
  readonly quoteTokenAddress: string;
}

export interface RawSample {
  readonly url: string;
  readonly receivedAt: string;
  readonly body: unknown;
}

export interface GeckoTerminalOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Total attempts per request, including the first. */
  readonly maxAttempts?: number;
  /** Token symbol -> resolved pool address. Populate via `setPool` after pool selection. */
  readonly poolMap?: Readonly<Record<string, string>>;
  readonly onRawSample?: (sample: RawSample) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function stripNetworkPrefix(id: string): string {
  const idx = id.indexOf('_');
  return idx === -1 ? id : id.slice(idx + 1);
}

function extractOhlcvList(body: unknown, url: string): unknown[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | undefined)
    ?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) {
    throw new GeckoTerminalProviderError(
      `OHLCV response from ${url} is missing data.attributes.ohlcv_list — the response ` +
      'shape differs from the modeled API (this provider has never made a real request); ' +
      'capture the raw sample and compare',
      { cause: body },
    );
  }
  return list;
}

function extractPoolList(body: unknown, url: string): unknown[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new GeckoTerminalProviderError(
      `pool list response from ${url} is missing a data[] array — the response shape ` +
      'differs from the modeled API; capture the raw sample and compare',
      { cause: body },
    );
  }
  return data;
}

interface PoolRowShape {
  attributes?: { address?: unknown; pool_created_at?: unknown; reserve_in_usd?: unknown };
  relationships?: {
    base_token?: { data?: { id?: unknown } };
    quote_token?: { data?: { id?: unknown } };
    dex?: { data?: { id?: unknown } };
  };
}

function parsePoolRow(row: unknown, url: string): PoolCandidate {
  const r = row as PoolRowShape;
  const address = r.attributes?.address;
  const baseId = r.relationships?.base_token?.data?.id;
  const quoteId = r.relationships?.quote_token?.data?.id;
  if (typeof address !== 'string' || typeof baseId !== 'string' || typeof quoteId !== 'string') {
    throw new GeckoTerminalProviderError(
      `pool entry from ${url} is missing address/base_token/quote_token — the response ` +
      'shape differs from the modeled API; capture the raw sample and compare',
      { cause: row },
    );
  }
  const dexId = r.relationships?.dex?.data?.id;
  const reserveRaw = r.attributes?.reserve_in_usd;
  const reserveUsd = typeof reserveRaw === 'string' || typeof reserveRaw === 'number' ? Number(reserveRaw) : null;
  const createdAt = r.attributes?.pool_created_at;
  return {
    address,
    dex: typeof dexId === 'string' ? dexId : 'unknown',
    createdAt: typeof createdAt === 'string' ? createdAt : null,
    reserveUsd: reserveUsd !== null && Number.isFinite(reserveUsd) ? reserveUsd : null,
    baseTokenAddress: stripNetworkPrefix(baseId),
    quoteTokenAddress: stripNetworkPrefix(quoteId),
  };
}

export class GeckoTerminalCandleProvider implements CandleProvider {
  readonly name = 'geckoterminal';

  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly onRawSample: ((sample: RawSample) => void) | undefined;
  private rawOhlcvSampleTaken = false;
  private rawPoolSampleTaken = false;
  private readonly poolMap: Record<string, string>;

  /** Timestamps of recent requests, for the local rate budget. */
  private requestTimes: number[] = [];

  constructor(opts: GeckoTerminalOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url) as unknown as ReturnType<FetchFn>);
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.onRawSample = opts.onRawSample;
    this.poolMap = { ...(opts.poolMap ?? {}) };
  }

  supports(interval: Interval): boolean {
    return SUPPORTED.has(interval);
  }

  /** Record the outcome of pool discovery/selection so `getCandles` can serve this token. */
  setPool(token: string, poolAddress: string): void {
    this.poolMap[token] = poolAddress;
  }

  poolFor(token: string): string {
    const pool = this.poolMap[token];
    if (pool === undefined) {
      throw new GeckoTerminalProviderError(
        `no pool resolved for "${token}" — run searchPools()/selectDominantPool() and call ` +
        'setPool() before fetching candles',
      );
    }
    return pool;
  }

  private async throttle(): Promise<void> {
    const cutoff = this.now() - 60_000;
    this.requestTimes = this.requestTimes.filter((t) => t > cutoff);
    const maxRequests = Math.floor(REQUEST_BUDGET_PER_MIN * SAFETY_FACTOR);
    if (this.requestTimes.length >= maxRequests) {
      const oldest = this.requestTimes[0]!;
      await this.sleepFn(Math.max(0, oldest + 60_000 - this.now()));
      this.requestTimes = this.requestTimes.filter((t) => t > this.now() - 60_000);
    }
    this.requestTimes.push(this.now());
  }

  private async request(url: string): Promise<unknown> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.throttle();

      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await this.fetchFn(url);
      } catch (err) {
        // The failure mode this exists for: a raw TLS/DNS/connection error from
        // Node's fetch, which arrives as `TypeError: fetch failed` with the real
        // reason nested in `.cause`. Attach the URL and preserve the cause chain
        // rather than letting it propagate bare.
        throw new GeckoTerminalProviderError(`network request failed for ${url}`, { cause: err });
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '0');
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 2 ** attempt * 1000);
        if (attempt === this.maxAttempts) {
          throw new GeckoTerminalRateLimitError(res.status, waitMs,
            `GeckoTerminal rate limited (429) after ${attempt} attempts for ${url}`);
        }
        await this.sleepFn(waitMs);
        continue;
      }

      if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch { /* body unreadable — status alone still fails loud */ }
        throw new GeckoTerminalProviderError(`GeckoTerminal returned ${res.status} for ${url}: ${detail}`);
      }

      try {
        return await res.json();
      } catch (err) {
        throw new GeckoTerminalProviderError(`GeckoTerminal returned a non-JSON body for ${url}`, { cause: err });
      }
    }
    throw new GeckoTerminalProviderError('unreachable: retry loop exhausted');
  }

  private parseRow(row: unknown, url: string): Candle {
    if (!Array.isArray(row) || row.length < 6) {
      throw new GeckoTerminalProviderError(`malformed OHLCV row from ${url}: ${JSON.stringify(row)}`);
    }
    return {
      timestamp: Number(row[0]) * 1000,   // GeckoTerminal timestamps are epoch SECONDS
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    };
  }

  async getCandles(token: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
    return this.getPoolOhlcv(this.poolFor(token), interval, from, to);
  }

  /**
   * Fetch a specific pool's OHLCV directly, bypassing the token->pool map.
   * Used both to serve `getCandles` once a pool is selected, and during
   * discovery to pull each candidate's volume history for `selectDominantPool`.
   *
   * GeckoTerminal paginates BACKWARD via `before_timestamp` (unlike Binance's
   * forward cursor), and does not document row order within a page, so this
   * tracks the minimum timestamp seen rather than assuming ascending or
   * descending order, and dedupes by timestamp across page boundaries.
   */
  async getPoolOhlcv(poolAddress: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
    if (!this.supports(interval)) {
      throw new GeckoTerminalProviderError(`geckoterminal provider does not support interval ${interval}`);
    }
    const { timeframe, aggregate } = TIMEFRAME_FOR[interval];
    const stepMs = INTERVAL_MS[interval];

    const collected = new Map<number, Candle>();
    let beforeSec = Math.floor(to / 1000) + Math.floor(stepMs / 1000);
    let prevMinMs: number | null = null;
    let guard = 0;

    while (true) {
      if (++guard > 10_000) {
        throw new GeckoTerminalProviderError('pagination guard tripped — refusing to loop forever');
      }
      const url =
        `${this.baseUrl}/networks/${NETWORK}/pools/${encodeURIComponent(poolAddress)}` +
        `/ohlcv/${timeframe}?aggregate=${aggregate}&before_timestamp=${beforeSec}` +
        `&limit=${MAX_LIMIT}&currency=token&token=base`;

      const body = await this.request(url);
      if (!this.rawOhlcvSampleTaken && this.onRawSample !== undefined) {
        this.rawOhlcvSampleTaken = true;
        this.onRawSample({ url, receivedAt: new Date().toISOString(), body });
      }
      const rows = extractOhlcvList(body, url);
      if (rows.length === 0) break;

      const parsed = rows.map((r) => this.parseRow(r, url));
      let minMs = Infinity;
      for (const c of parsed) {
        if (c.timestamp < minMs) minMs = c.timestamp;
        if (c.timestamp >= from && c.timestamp <= to) collected.set(c.timestamp, c);
      }
      if (prevMinMs !== null && minMs >= prevMinMs) break;   // no forward progress
      prevMinMs = minMs;
      if (minMs <= from) break;
      if (rows.length < MAX_LIMIT) break;                    // short page — nothing older
      beforeSec = Math.floor(minMs / 1000);
    }

    return [...collected.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Every pool that trades `tokenAddress`, filtered to ones paired against
   * `pairedWithAddress` (e.g. SOL, or USDC for the SOL/USD reference).
   */
  async searchPools(tokenAddress: string, pairedWithAddress: string): Promise<PoolCandidate[]> {
    const url = `${this.baseUrl}/networks/${NETWORK}/tokens/${encodeURIComponent(tokenAddress)}/pools`;
    const body = await this.request(url);
    if (!this.rawPoolSampleTaken && this.onRawSample !== undefined) {
      this.rawPoolSampleTaken = true;
      this.onRawSample({ url, receivedAt: new Date().toISOString(), body });
    }
    const rows = extractPoolList(body, url);
    const candidates: PoolCandidate[] = [];
    for (const row of rows) {
      const candidate = parsePoolRow(row, url);
      if (candidate.baseTokenAddress === pairedWithAddress || candidate.quoteTokenAddress === pairedWithAddress) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }
}
