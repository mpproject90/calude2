/**
 * DexPaprika on-chain pool provider — ALTERNATE, not wired into the default
 * fetch path (DECISIONS §21). Kept behind the same `CandleProvider` interface
 * in case GeckoTerminal's free tier proves too tight over a weeks-long paper
 * trading run.
 *
 * Endpoint: GET /networks/{network}/pools/{pool}/ohlcv?start=&end=&interval=&limit=
 * Response, per candle: { time_open, time_close, open, high, low, close, volume }.
 * Max 366 candles/request. No API key for the free tier.
 *
 * RATE LIMIT — deliberately left UNRESOLVED (DECISIONS §21). DexPaprika's own
 * docs contradict themselves: the API-reference page states 50,000
 * credits/month and 15 req/min; the marketing page states 200,000 req/month
 * and 10 concurrent SSE streams. This was not resolved by reading further
 * documentation — an empirical check against the real API would be needed,
 * and since this provider is not primary, that check was not worth doing now.
 * The throttle below uses the MORE CONSERVATIVE documented figure (15/min) as
 * a placeholder; treat it as unverified before relying on it.
 *
 * Unlike a JUP/SOL Binance-ratio synthesis, this returns the pool's own OHLC
 * directly — no `currency`/inversion parameter is documented, so the
 * assumption (unverified — this provider has never made a real request,
 * same status as GeckoTerminal and Binance before their first real run) is
 * that it returns price in the pool's native quote-asset terms.
 *
 * Solana does not support the `4h` interval this project otherwise uses
 * (DexPaprika offers `1h`/`6h`/`12h`, no `4h`) — `supports('4h')` is `false`
 * rather than silently approximating via aggregation.
 */
import type { Candle, CandleProvider, Interval } from '../../types/index.js';

const NETWORK = 'solana';
const DEFAULT_BASE_URL = 'https://api.dexpaprika.com';
const MAX_LIMIT = 366;
const REQUEST_BUDGET_PER_MIN = 15;   // conservative pick among conflicting docs — see header
const SAFETY_FACTOR = 0.8;

const INTERVAL_FOR: Readonly<Partial<Record<Interval, string>>> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '1d': '24h',
  // '4h' intentionally absent — not offered by this API.
};

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class DexPaprikaProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DexPaprikaProviderError';
  }
}

export interface DexPaprikaOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly poolMap?: Readonly<Record<string, string>>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface OhlcvRowShape {
  time_open?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
}

function parseRow(row: unknown, url: string): Candle {
  const r = row as OhlcvRowShape;
  const ts = typeof r.time_open === 'string' ? Date.parse(r.time_open) : NaN;
  if (!Number.isFinite(ts)) {
    throw new DexPaprikaProviderError(`malformed OHLCV row from ${url}: ${JSON.stringify(row)}`);
  }
  return {
    timestamp: ts,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  };
}

export class DexPaprikaCandleProvider implements CandleProvider {
  readonly name = 'dexpaprika';

  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly poolMap: Record<string, string>;
  private requestTimes: number[] = [];

  constructor(opts: DexPaprikaOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url) as unknown as ReturnType<FetchFn>);
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
    this.poolMap = { ...(opts.poolMap ?? {}) };
  }

  supports(interval: Interval): boolean {
    return interval in INTERVAL_FOR;
  }

  setPool(token: string, poolAddress: string): void {
    this.poolMap[token] = poolAddress;
  }

  poolFor(token: string): string {
    const pool = this.poolMap[token];
    if (pool === undefined) {
      throw new DexPaprikaProviderError(`no pool resolved for "${token}" — call setPool() first`);
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

  async getCandles(token: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
    if (!this.supports(interval)) {
      throw new DexPaprikaProviderError(`dexpaprika provider does not support interval ${interval}`);
    }
    const pool = this.poolFor(token);
    const intervalStr = INTERVAL_FOR[interval]!;
    const out: Candle[] = [];
    let cursorMs = from;
    let guard = 0;

    while (cursorMs <= to) {
      if (++guard > 10_000) {
        throw new DexPaprikaProviderError('pagination guard tripped — refusing to loop forever');
      }
      const url =
        `${this.baseUrl}/networks/${NETWORK}/pools/${encodeURIComponent(pool)}/ohlcv` +
        `?start=${new Date(cursorMs).toISOString()}&end=${new Date(to).toISOString()}` +
        `&interval=${intervalStr}&limit=${MAX_LIMIT}`;

      await this.throttle();
      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await this.fetchFn(url);
      } catch (err) {
        throw new DexPaprikaProviderError(`network request failed for ${url}`, { cause: err });
      }
      if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch { /* status alone still fails loud */ }
        throw new DexPaprikaProviderError(`DexPaprika returned ${res.status} for ${url}: ${detail}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        throw new DexPaprikaProviderError(`DexPaprika returned a non-JSON body for ${url}`, { cause: err });
      }
      if (!Array.isArray(body)) {
        throw new DexPaprikaProviderError(
          `OHLCV response from ${url} is not an array — the response shape differs from the ` +
          'modeled API (this provider has never made a real request); capture the raw sample and compare',
          { cause: body },
        );
      }
      if (body.length === 0) break;

      const parsed = body.map((r) => parseRow(r, url));
      for (const c of parsed) if (c.timestamp >= from && c.timestamp <= to) out.push(c);

      const last = parsed[parsed.length - 1]!;
      if (last.timestamp <= cursorMs) break;
      cursorMs = last.timestamp + 1;
      if (body.length < MAX_LIMIT) break;
    }

    return out.sort((a, b) => a.timestamp - b.timestamp);
  }
}
