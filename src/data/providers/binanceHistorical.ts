/**
 * Binance historical bulk-archive provider (data.binance.vision) — DECISIONS §33.
 *
 * Reads the free, keyless, no-rate-limit monthly kline zip archives Binance
 * publishes at data.binance.vision — a static file host, NOT api.binance.com
 * (a different domain, unaffected by this project's operator being
 * region-blocked from the live API, DECISIONS §14). Confirmed reachable
 * before building this (§33). Archives are immutable once published, so
 * every downloaded zip is cached on disk forever and never re-fetched.
 *
 * SCOPED EXCEPTION TO DECISIONS §6, not a reversal of it: §6 rejected USDT-
 * ratio synthesis as the default data source because high/low are BOUNDS
 * under synthesis, not observations (see `synthesizeRatioSeries` in
 * `../synthesize.js`). That objection never reached close: close_ratio =
 * close_num / close_den is exact, because both sides are sampled at the
 * identical instant, so RSI (built from closes alone) is exact on a
 * synthesized series regardless of the high/low approximation. This
 * provider exists specifically to measure RSI-cross-up base rate and
 * downstream funnel counts — the measured bottleneck (DECISIONS §31/§32) —
 * over years of history the 180-day GeckoTerminal free-tier ceiling cannot
 * reach. MFI and ATR remain approximate here, exactly as for `--provider
 * binance` in `fetch-data.ts`; every report built from this provider must
 * say so, not just this file's comments.
 *
 * TIMESTAMP UNITS: Binance switched kline archives from millisecond to
 * microsecond epoch timestamps starting with the 2025-01 monthly files
 * (confirmed by direct inspection while building this — SOLUSDT-1h-2024-12
 * is ms, SOLUSDT-1h-2025-01 is µs, every month since stays µs). Detected per
 * row by magnitude, not by trusting a fixed cutoff month, because that is
 * one fewer assumption to be wrong about.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import type { Candle, CandleProvider, Interval } from '../../types/index.js';

export class BinanceHistoricalProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BinanceHistoricalProviderError';
  }
}

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export interface MonthFetchedEvent {
  readonly symbol: string;
  readonly interval: Interval;
  readonly month: string;
  readonly cached: boolean;
}

export interface BinanceHistoricalOptions {
  /** Maps a config token symbol to its Binance USDT symbol, e.g. JUP -> JUPUSDT. */
  readonly symbolMap: Readonly<Record<string, string>>;
  readonly baseUrl?: string;          // file downloads
  readonly listingUrl?: string;       // S3 bucket listing (bulk discovery)
  readonly cacheDir?: string;
  readonly fetchFn?: FetchFn;
  readonly onMonthFetched?: (info: MonthFetchedEvent) => void;
}

const SUPPORTED: ReadonlySet<Interval> = new Set<Interval>(['1m', '5m', '15m', '1h', '4h', '1d']);

/**
 * A raw open-time value larger than 1e14 cannot be a millisecond epoch until
 * the year 5138 — it is µs; divide by 1000. Below that, it is already ms.
 */
function normalizeTimestamp(raw: number): number {
  return raw > 1e14 ? Math.round(raw / 1000) : raw;
}

function monthKey(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Every "YYYY-MM" from `fromMonth` to `toMonth` inclusive, both "YYYY-MM". */
function monthRange(fromMonth: string, toMonth: string): string[] {
  const [fy, fm] = fromMonth.split('-').map(Number) as [number, number];
  const [ty, tm] = toMonth.split('-').map(Number) as [number, number];
  const out: string[] = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(monthKey(y, m));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export class BinanceHistoricalCandleProvider implements CandleProvider {
  readonly name = 'binance-historical';

  private readonly symbolMap: Readonly<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly listingUrl: string;
  private readonly cacheDir: string;
  private readonly fetchFn: FetchFn;
  private readonly onMonthFetched: BinanceHistoricalOptions['onMonthFetched'];

  constructor(opts: BinanceHistoricalOptions) {
    this.symbolMap = opts.symbolMap;
    this.baseUrl = opts.baseUrl ?? 'https://data.binance.vision';
    this.listingUrl = opts.listingUrl ?? 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
    this.cacheDir = opts.cacheDir ?? 'data/binance-vision-cache';
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url) as unknown as ReturnType<FetchFn>);
    this.onMonthFetched = opts.onMonthFetched;
  }

  supports(interval: Interval): boolean {
    return SUPPORTED.has(interval);
  }

  symbolFor(token: string): string {
    const symbol = this.symbolMap[token];
    if (symbol === undefined) {
      throw new BinanceHistoricalProviderError(
        `no Binance symbol mapped for "${token}" — add it to the provider's symbolMap`,
      );
    }
    return symbol;
  }

  /**
   * Every "YYYY-MM" this symbol/interval has an archive for, oldest first —
   * ground truth for "as far back as listed" from the bucket's own listing,
   * rather than guessing a start date and probing months backwards.
   */
  async discoverAvailableMonths(symbol: string, interval: Interval): Promise<string[]> {
    const prefix = `data/spot/monthly/klines/${symbol}/${interval}/`;
    const url = `${this.listingUrl}/?prefix=${encodeURIComponent(prefix)}&delimiter=/`;
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(url);
    } catch (err) {
      throw new BinanceHistoricalProviderError(`listing request failed for ${url}`, { cause: err });
    }
    if (!res.ok) {
      throw new BinanceHistoricalProviderError(`listing returned ${res.status} for ${url}: ${await res.text()}`);
    }
    const xml = await res.text();
    if (/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)) {
      throw new BinanceHistoricalProviderError(
        `listing for ${symbol}/${interval} was truncated (>1000 keys) — pagination not ` +
        'implemented, refusing to silently miss months rather than guess',
      );
    }
    const months = new Set<string>();
    const re = new RegExp(
      `<Key>data/spot/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-(\\d{4}-\\d{2})\\.zip</Key>`, 'g',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) months.add(m[1]!);
    if (months.size === 0) {
      throw new BinanceHistoricalProviderError(
        `no monthly ${interval} archives found for ${symbol} — not listed on Binance spot, ` +
        'or the interval/symbol is misspelled',
      );
    }
    return [...months].sort();
  }

  private cachePath(symbol: string, interval: Interval, month: string): string {
    return join(this.cacheDir, symbol, interval, `${symbol}-${interval}-${month}.zip`);
  }

  /** Downloaded zips are immutable archives — cache on disk forever, never re-fetched. */
  private async fetchMonthZip(symbol: string, interval: Interval, month: string): Promise<Buffer | null> {
    const path = this.cachePath(symbol, interval, month);
    if (existsSync(path)) {
      this.onMonthFetched?.({ symbol, interval, month, cached: true });
      return readFileSync(path);
    }
    const url = `${this.baseUrl}/data/spot/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${month}.zip`;
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(url);
    } catch (err) {
      throw new BinanceHistoricalProviderError(`download failed for ${url}`, { cause: err });
    }
    if (res.status === 404) return null;   // month not published — not an error, just absent
    if (!res.ok) {
      throw new BinanceHistoricalProviderError(`download returned ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf);
    this.onMonthFetched?.({ symbol, interval, month, cached: false });
    return buf;
  }

  private parseCsv(csv: string): Candle[] {
    const out: Candle[] = [];
    for (const line of csv.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const cols = trimmed.split(',');
      if (cols.length < 6) {
        throw new BinanceHistoricalProviderError(`malformed kline row (expected >=6 columns): ${trimmed}`);
      }
      const rawTs = Number(cols[0]);
      if (!Number.isFinite(rawTs)) {
        throw new BinanceHistoricalProviderError(`malformed timestamp: ${trimmed}`);
      }
      out.push({
        timestamp: normalizeTimestamp(rawTs),
        open: Number(cols[1]),
        high: Number(cols[2]),
        low: Number(cols[3]),
        close: Number(cols[4]),
        volume: Number(cols[5]),
      });
    }
    return out;
  }

  private async monthCandles(symbol: string, interval: Interval, month: string): Promise<Candle[]> {
    const buf = await this.fetchMonthZip(symbol, interval, month);
    if (buf === null) return [];
    const zip = unzipSync(new Uint8Array(buf));
    const entryName = Object.keys(zip).find((n) => n.endsWith('.csv'));
    if (entryName === undefined) {
      throw new BinanceHistoricalProviderError(`no .csv entry inside ${symbol}-${interval}-${month}.zip`);
    }
    const csv = strFromU8(zip[entryName]!);
    // A handful of archives ship a header row ("open_time,open,high,..."). Detect
    // and skip it rather than assuming a fixed shape — every file checked while
    // building this had no header, but that is not a guarantee for every symbol.
    const firstLine = csv.slice(0, csv.indexOf('\n'));
    const bodyCsv = /^\d/.test(firstLine.trim()) ? csv : csv.slice(csv.indexOf('\n') + 1);
    return this.parseCsv(bodyCsv);
  }

  async getCandles(token: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
    if (!this.supports(interval)) {
      throw new BinanceHistoricalProviderError(`binance-historical provider does not support interval ${interval}`);
    }
    const symbol = this.symbolFor(token);
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const fromMonth = monthKey(fromDate.getUTCFullYear(), fromDate.getUTCMonth() + 1);
    const toMonth = monthKey(toDate.getUTCFullYear(), toDate.getUTCMonth() + 1);
    const months = monthRange(fromMonth, toMonth);

    const out: Candle[] = [];
    for (const month of months) {
      const rows = await this.monthCandles(symbol, interval, month);
      for (const c of rows) if (c.timestamp >= from && c.timestamp <= to) out.push(c);
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }
}
