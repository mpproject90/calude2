/**
 * Binance spot klines provider (spec §4).
 *
 * Chosen for Tier A because it is free, needs no API key, offers deep history
 * and 1000 candles per request. It also supplies SOLUSDT, which the SOL-relative
 * strength filter and the JUP/SOL synthesis both depend on.
 *
 * Rate limits are IP-based, not key-based: /api/v3/klines costs weight 2 for up
 * to 500 candles and 5 for up to 1000, against a 1200 weight/minute budget.
 * Repeatedly ignoring a 429 escalates to an IP ban (HTTP 418) lasting from two
 * minutes to three days, so the budget is tracked locally and 429s are obeyed
 * rather than retried blindly.
 *
 * `fetchFn` is injectable so the provider can be unit-tested without network
 * access, and so it runs unchanged in a plain local Node environment.
 */
import type { Candle, CandleProvider, Interval } from '../../types/index.js';

const KLINE_LIMIT = 1000;
const WEIGHT_PER_REQUEST = 5;      // limit>500 costs 5
const WEIGHT_BUDGET_PER_MIN = 1200;
const SAFETY_FACTOR = 0.75;        // stay well clear of the ceiling

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class BinanceRateLimitError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number, message: string) {
    super(message);
    this.name = 'BinanceRateLimitError';
  }
}

export class BinanceProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BinanceProviderError';
  }
}

export interface BinanceOptions {
  /** Maps a config token address to its Binance symbol, e.g. JUP -> JUPUSDT. */
  readonly symbolMap: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Total attempts per request, including the first. */
  readonly maxAttempts?: number;
  /**
   * Called once, with the first successful raw response. The provider has never
   * been run against the live API — every test uses a mock — so if the real
   * response shape differs from the model, this is the evidence needed to fix it
   * rather than describe it.
   */
  readonly onRawSample?: (sample: RawSample) => void;
}

export interface RawSample {
  readonly url: string;
  readonly receivedAt: string;
  readonly rowCount: number;
  /** Verbatim, unparsed rows exactly as the exchange returned them. */
  readonly firstRows: unknown[];
}

/** Binance interval strings happen to match ours exactly. */
const SUPPORTED: ReadonlySet<Interval> = new Set<Interval>(['1m', '5m', '15m', '1h', '4h', '1d']);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class BinanceCandleProvider implements CandleProvider {
  readonly name = 'binance';

  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly symbolMap: Readonly<Record<string, string>>;
  private readonly onRawSample: ((sample: RawSample) => void) | undefined;
  private rawSampleTaken = false;

  /** Timestamps of recent requests, for the local weight budget. */
  private requestTimes: number[] = [];

  constructor(opts: BinanceOptions) {
    this.symbolMap = opts.symbolMap;
    this.baseUrl = opts.baseUrl ?? 'https://api.binance.com';
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url) as unknown as ReturnType<FetchFn>);
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.onRawSample = opts.onRawSample;
  }

  supports(interval: Interval): boolean {
    return SUPPORTED.has(interval);
  }

  symbolFor(token: string): string {
    const symbol = this.symbolMap[token];
    if (symbol === undefined) {
      throw new BinanceProviderError(
        `no Binance symbol mapped for "${token}" — add it to the provider's symbolMap`,
      );
    }
    return symbol;
  }

  /** Block until another request fits inside the local weight budget. */
  private async throttle(): Promise<void> {
    const cutoff = this.now() - 60_000;
    this.requestTimes = this.requestTimes.filter((t) => t > cutoff);
    const maxRequests = Math.floor((WEIGHT_BUDGET_PER_MIN * SAFETY_FACTOR) / WEIGHT_PER_REQUEST);
    if (this.requestTimes.length >= maxRequests) {
      const oldest = this.requestTimes[0]!;
      await this.sleepFn(Math.max(0, oldest + 60_000 - this.now()));
      this.requestTimes = this.requestTimes.filter((t) => t > this.now() - 60_000);
    }
    this.requestTimes.push(this.now());
  }

  private async requestKlines(
    symbol: string, interval: Interval, from: number, to: number,
  ): Promise<unknown[]> {
    const url =
      `${this.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${interval}&startTime=${from}&endTime=${to}&limit=${KLINE_LIMIT}`;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.throttle();

      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await this.fetchFn(url);
      } catch (err) {
        // A raw TLS/DNS/connection failure from Node's fetch surfaces as
        // `TypeError: fetch failed` with the real reason nested in `.cause` —
        // attach the URL and preserve the chain rather than letting it
        // propagate bare (DECISIONS §22).
        throw new BinanceProviderError(`network request failed for ${url}`, { cause: err });
      }

      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '0');
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 2 ** attempt * 1000);
        if (attempt === this.maxAttempts) {
          throw new BinanceRateLimitError(res.status, waitMs,
            `Binance rate limited (${res.status}) after ${attempt} attempts. ` +
            'Back off rather than retrying — 418 is an IP ban that escalates.');
        }
        await this.sleepFn(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new BinanceProviderError(
          `Binance returned ${res.status} for ${symbol} ${interval}: ${await res.text()}`,
        );
      }

      const body = await res.json();
      if (!Array.isArray(body)) {
        throw new BinanceProviderError(
          `Binance returned a non-array body for ${symbol} ${interval}: ${JSON.stringify(body)}`,
        );
      }
      if (!this.rawSampleTaken && this.onRawSample !== undefined) {
        this.rawSampleTaken = true;
        this.onRawSample({
          url,
          receivedAt: new Date().toISOString(),
          rowCount: body.length,
          firstRows: body.slice(0, 3),
        });
      }

      return body;
    }
    throw new BinanceProviderError('unreachable: retry loop exhausted');
  }

  /**
   * Kline row shape:
   *   [0] openTime  [1] open  [2] high  [3] low  [4] close  [5] volume  [6] closeTime …
   * Prices arrive as strings; parsing is explicit so a malformed field becomes
   * NaN and is caught by validation rather than propagating silently.
   */
  private parseRow(row: unknown): Candle {
    if (!Array.isArray(row) || row.length < 6) {
      throw new BinanceProviderError(`malformed kline row: ${JSON.stringify(row)}`);
    }
    return {
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    };
  }

  async getCandles(
    token: string, interval: Interval, from: number, to: number,
  ): Promise<Candle[]> {
    if (!this.supports(interval)) {
      throw new BinanceProviderError(`binance provider does not support interval ${interval}`);
    }
    const symbol = this.symbolFor(token);
    const out: Candle[] = [];
    let cursor = from;
    let guard = 0;

    // Binance caps each response at `limit` rows, so walk forward until the
    // window is covered or the exchange stops returning new bars.
    while (cursor <= to) {
      if (++guard > 10_000) {
        throw new BinanceProviderError('pagination guard tripped — refusing to loop forever');
      }
      const rows = await this.requestKlines(symbol, interval, cursor, to);
      if (rows.length === 0) break;

      const parsed = rows.map((r) => this.parseRow(r));
      for (const c of parsed) if (c.timestamp >= from && c.timestamp <= to) out.push(c);

      const last = parsed[parsed.length - 1]!;
      if (last.timestamp <= cursor) break;   // no forward progress; stop
      cursor = last.timestamp + 1;
      if (rows.length < KLINE_LIMIT) break;  // partial page means we reached the end
    }

    return out;
  }
}
