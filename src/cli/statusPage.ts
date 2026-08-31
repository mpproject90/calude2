/**
 * Read-only status page over the paper-trading database (DECISIONS §43).
 * Regenerates a self-contained static HTML file on every run — no server,
 * no live updates, no controls, nothing that writes anywhere or could
 * trigger an action. Safe to run at any time while the soak is polling.
 *
 *   npm run status:page
 *   npm run status:page -- --db data/paper.db --log data/paper-run.log --config config/default.yaml --out data/status.html
 *
 * READ-ONLY, structurally, not by convention: opens `--db` with
 * better-sqlite3's `readonly: true` — every statement in this file is a
 * bare `SELECT`, and a write attempt against a readonly connection throws
 * (SQLITE_READONLY) rather than silently succeeding. `timeout: 0` means a
 * busy database fails immediately rather than waiting or retrying — "open
 * read-only rather than waiting or forcing" (operator's own words). This
 * file never imports anything from `paper/store.ts`'s WRITE methods and
 * never calls `openDb` (which runs `CREATE TABLE IF NOT EXISTS` — a DDL
 * statement that itself needs write access, and would throw against a
 * readonly connection even though it's a no-op against an existing db).
 *
 * PRICE HISTORY has no dedicated table (DECISIONS §41: "a usable, nothing
 * happened tick has no row anywhere else" — recording one for every tick
 * over a week would be schema churn this tool has no business proposing).
 * The chart and "current price" are read from `--log`
 * (`data/paper-run.log`, an operational convention from how the Scheduled
 * Task redirects output, not a schema-enforced path) — parsed as plain
 * text, read-only, same as everything else here.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TokenAmount } from '../util/amount.js';
import { loadConfig, ConfigError } from '../config/load.js';
import type { LadderExitConfig } from '../config/schema.js';
import { computeGaps, fmtDuration, fmtPct, fmtPrice, esc, splitIntoSegments, type LogTick as HelperLogTick } from './statusPageHelpers.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v ?? fallback;
}

const dbPath = arg('db', 'data/paper.db');
const logPath = arg('log', 'data/paper-run.log');
const configPath = arg('config', 'config/default.yaml');
const outPath = arg('out', 'data/status.html');

// ---------------------------------------------------------------- types --

interface PositionRow {
  readonly id: string;
  readonly symbol: string;
  readonly address: string;
  readonly status: 'open' | 'closed';
  readonly entry_price: number;
  readonly entry_timestamp: number;
  readonly original_size_raw: string;
  readonly remaining_size_raw: string;
  readonly size_decimals: number;
  readonly filled_tranche_count: number;
  readonly peak_price: number;
  readonly trailing_armed: number;
  readonly stop_loss_price: number;
  readonly closed_at: number | null;
  readonly ladder_config: string;
  readonly updated_at: number;
}

interface FillRow {
  readonly id: number;
  readonly position_id: string;
  readonly kind: string;
  readonly tranche_index: number | null;
  readonly trigger_price: number;
  readonly fill_price: number;
  readonly size_raw: string;
  readonly size_decimals: number;
  readonly gross_pnl_sol_raw: string | null;
  readonly dex_fee_sol_raw: string;
  readonly fixed_fee_sol_raw: string;
  readonly net_pnl_sol_raw: string | null;
  readonly filled_at: number;
}

interface EventRow {
  readonly id: number;
  readonly symbol: string | null;
  readonly kind: string;
  readonly detail: string;
  readonly occurred_at: number;
}

interface FeedStatsRow {
  readonly symbol: string;
  readonly usable_count: number;
  readonly stale_count: number;
  readonly error_count: number;
  readonly blind_streak_started_at: number | null;
  readonly longest_blind_streak_ms: number;
  readonly longest_blind_streak_ended_at: number | null;
  readonly last_tick_at: number | null;
}

type LogTick = HelperLogTick;

// ------------------------------------------------------------- db read --

if (!existsSync(dbPath)) {
  console.error(`FAILED\n  No database at ${resolve(dbPath)} — has the paper CLI ever been run against this path?`);
  process.exitCode = 1;
  process.exit();
}

let db: Database.Database;
try {
  // readonly + fileMustExist: never creates, never migrates, never writes.
  // timeout: 0 — a busy db fails this call immediately, no internal retry/wait.
  db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
} catch (err) {
  console.error(`FAILED\n  Could not open ${resolve(dbPath)} read-only: ${(err as Error).message}`);
  process.exitCode = 1;
  process.exit();
}

function tableExists(name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
}

const positions: PositionRow[] = tableExists('paper_positions')
  ? db.prepare('SELECT * FROM paper_positions ORDER BY entry_timestamp ASC').all() as PositionRow[]
  : [];
const fills: FillRow[] = tableExists('paper_fills')
  ? db.prepare('SELECT * FROM paper_fills ORDER BY filled_at ASC').all() as FillRow[]
  : [];
const events: EventRow[] = tableExists('paper_events')
  ? db.prepare('SELECT * FROM paper_events ORDER BY occurred_at ASC').all() as EventRow[]
  : [];
const feedStats: FeedStatsRow[] = tableExists('paper_feed_stats')
  ? db.prepare('SELECT * FROM paper_feed_stats').all() as FeedStatsRow[]
  : [];

db.close();

// ------------------------------------------------------------ log read --

const logTicks: LogTick[] = [];
if (existsSync(logPath)) {
  const text = readFileSync(logPath, 'utf8');
  const priceRe = /^(\S+)\s+\[([^\]]+)]\s+price\s+([0-9.eE+-]+)\s+\((buy|sell)(?:,\s*([0-9.]+)%\s+impact)?\)/;
  const errRe = /^(\S+)\s+\[([^\]]+)]\s+(FEED ERROR|STALE FEED):/;
  for (const line of text.split('\n')) {
    const p = priceRe.exec(line);
    if (p !== null) {
      const ts = Date.parse(p[1]!);
      const price = Number(p[3]);
      if (Number.isFinite(ts) && Number.isFinite(price)) {
        logTicks.push({ timestamp: ts, symbol: p[2]!, kind: 'price', price });
      }
      continue;
    }
    const e = errRe.exec(line);
    if (e !== null) {
      const ts = Date.parse(e[1]!);
      if (Number.isFinite(ts)) {
        logTicks.push({ timestamp: ts, symbol: e[2]!, kind: e[3] === 'STALE FEED' ? 'stale' : 'error', price: null });
      }
    }
  }
}

// ---------------------------------------------------------------- config --

let limitPriceBySymbol = new Map<string, number>();
let stopPollSeconds = 30;
try {
  const cfg = loadConfig(configPath);
  limitPriceBySymbol = new Map(cfg.positions.map((p) => [p.symbol, p.limitPrice] as const));
  stopPollSeconds = cfg.global.stopPollSeconds;
} catch (err) {
  console.error(`NOTE: could not load ${configPath} (${err instanceof ConfigError ? err.message : String(err)}) — limit-price reference lines will be omitted.`);
}

// -------------------------------------------------------------- helpers --

function amt(raw: string, decimals: number): TokenAmount {
  return TokenAmount.fromRaw(BigInt(raw), decimals);
}
function fmtAmt(raw: string, decimals: number): string {
  return amt(raw, decimals).toString();
}
function fmtNullableAmt(raw: string | null, decimals: number): string {
  return raw === null ? '—' : fmtAmt(raw, decimals);
}
function fmtTs(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString();
}

// ------------------------------------------------------ per-symbol chart --

function renderChart(symbol: string, ticks: LogTick[], refLines: { label: string; price: number; color: string }[], fillMarkers: { ts: number; price: number; kind: string }[]): string {
  const priceTicks = ticks.filter((t) => t.kind === 'price' && t.price !== null).sort((a, b) => a.timestamp - b.timestamp);
  if (priceTicks.length === 0) {
    return `<p class="muted">No price observations found in the log for ${esc(symbol)}.</p>`;
  }

  const W = 1000, H = 340, padL = 90, padR = 110, padT = 16, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const minT = priceTicks[0]!.timestamp;
  const maxT = priceTicks[priceTicks.length - 1]!.timestamp;
  const prices = priceTicks.map((t) => t.price!);
  const refPrices = refLines.map((r) => r.price);
  let minP = Math.min(...prices, ...refPrices);
  let maxP = Math.max(...prices, ...refPrices);
  if (minP === maxP) { minP -= minP * 0.01 || 0.0001; maxP += maxP * 0.01 || 0.0001; }
  const padP = (maxP - minP) * 0.06;
  minP -= padP; maxP += padP;

  const x = (t: number): number => padL + ((t - minT) / (maxT - minT || 1)) * plotW;
  const y = (p: number): number => padT + plotH - ((p - minP) / (maxP - minP || 1)) * plotH;

  // Break the line into segments wherever a gap (a blind streak) occurred —
  // a single continuous polyline across an 18-hour sleep would visually
  // claim data that does not exist. Threshold matches computeGaps' own.
  const threshold = stopPollSeconds * 1000 * 3;
  const segments = splitIntoSegments(priceTicks, threshold);

  const polylines = segments
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      const pts = seg.map((t) => `${x(t.timestamp).toFixed(1)},${y(t.price!).toFixed(1)}`).join(' ');
      return `<polyline points="${pts}" fill="none" stroke="#4ea1ff" stroke-width="1.5" />`;
    })
    .join('\n    ');

  const refSvg = refLines
    .filter((r) => r.price >= minP && r.price <= maxP)
    .map((r) => {
      const yy = y(r.price).toFixed(1);
      return `<line x1="${padL}" y1="${yy}" x2="${padL + plotW}" y2="${yy}" stroke="${r.color}" stroke-width="1" stroke-dasharray="4,3" />` +
        `<text x="${padL + plotW + 6}" y="${yy}" font-size="10" fill="${r.color}" dominant-baseline="middle">${esc(r.label)} ${fmtPrice(r.price)}</text>`;
    })
    .join('\n    ');

  const markerColor: Record<string, string> = {
    entry: '#4ea1ff', take_profit: '#3ecf6b', stop_loss: '#ff4d4f', trailing: '#f5a623', time: '#9e9e9e',
  };
  const markersSvg = fillMarkers
    .filter((m) => m.ts >= minT && m.ts <= maxT)
    .map((m) => {
      const cx = x(m.ts).toFixed(1), cy = y(m.price).toFixed(1);
      const color = markerColor[m.kind] ?? '#fff';
      return `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}" stroke="#000" stroke-width="0.5"><title>${esc(m.kind)} @ ${fmtPrice(m.price)}</title></circle>`;
    })
    .join('\n    ');

  const axisSvg = `
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#555" />
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#555" />
    <text x="${padL}" y="${H - 6}" font-size="10" fill="#999">${esc(new Date(minT).toISOString())}</text>
    <text x="${padL + plotW}" y="${H - 6}" font-size="10" fill="#999" text-anchor="end">${esc(new Date(maxT).toISOString())}</text>
    <text x="4" y="${padT + 8}" font-size="10" fill="#999">${fmtPrice(maxP)}</text>
    <text x="4" y="${padT + plotH}" font-size="10" fill="#999">${fmtPrice(minP)}</text>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="chart">
    ${axisSvg}
    ${polylines}
    ${refSvg}
    ${markersSvg}
  </svg>`;
}

// -------------------------------------------------------------- render --

const now = Date.now();
const symbols = new Set<string>([...positions.map((p) => p.symbol), ...logTicks.map((t) => t.symbol)]);

let openPositionsHtml = '';
const openPositions = positions.filter((p) => p.status === 'open');
if (openPositions.length === 0) {
  openPositionsHtml = '<p class="muted">No open position.</p>';
} else {
  openPositionsHtml = openPositions.map((p) => {
    const ladder: LadderExitConfig = JSON.parse(p.ladder_config) as LadderExitConfig;
    const symbolTicks = logTicks.filter((t) => t.symbol === p.symbol && t.kind === 'price' && t.price !== null);
    const latest = symbolTicks.length > 0 ? symbolTicks[symbolTicks.length - 1]! : null;
    const currentPrice = latest?.price ?? null;

    const originalSol = amt(p.original_size_raw, p.size_decimals).toNumberUnsafe();
    const remainingSol = amt(p.remaining_size_raw, p.size_decimals).toNumberUnsafe();
    const unrealizedSol = currentPrice === null ? null : remainingSol * (currentPrice / p.entry_price - 1);
    const unrealizedPct = currentPrice === null ? null : (currentPrice / p.entry_price - 1) * 100;

    const timeExitAt = p.entry_timestamp + ladder.timeExitMinutes * 60_000;
    const timeRemainingMs = timeExitAt - now;

    const trancheRows = ladder.tranches.map((t, i) => {
      const filled = i < p.filled_tranche_count;
      const targetPrice = p.entry_price * (1 + t.targetGainPct / 100);
      return `<tr><td>${i}</td><td>+${t.targetGainPct}%</td><td>${t.sellPct}%</td><td>${fmtPrice(targetPrice)}</td><td>${filled ? '✓ filled' : '—'}</td></tr>`;
    }).join('');

    const trailLevel = ladder.trailing.enabled && p.trailing_armed
      ? fmtPrice(p.peak_price * (1 - ladder.trailing.trailPct / 100))
      : '—';

    return `
    <div class="card">
      <h3>${esc(p.symbol)} <span class="muted">(${esc(p.id.slice(0, 8))})</span></h3>
      <table class="kv">
        <tr><td>Entry price</td><td>${fmtPrice(p.entry_price)}</td></tr>
        <tr><td>Entry time</td><td>${fmtTs(p.entry_timestamp)}</td></tr>
        <tr><td>Original size</td><td>${originalSol.toFixed(6)} SOL</td></tr>
        <tr><td>Remaining size</td><td>${remainingSol.toFixed(6)} SOL</td></tr>
        <tr><td>Current price</td><td>${currentPrice === null ? '<span class="muted">no observation in log</span>' : `${fmtPrice(currentPrice)} <span class="muted">(as of ${fmtTs(latest!.timestamp)})</span>`}</td></tr>
        <tr><td>Unrealized P&amp;L</td><td class="${unrealizedSol !== null && unrealizedSol < 0 ? 'neg' : 'pos'}">${unrealizedSol === null ? '—' : `${unrealizedSol.toFixed(6)} SOL (${fmtPct(unrealizedPct!)})`}</td></tr>
        <tr><td>Stop-loss</td><td>${fmtPrice(p.stop_loss_price)}</td></tr>
        <tr><td>Trailing armed</td><td>${ladder.trailing.enabled ? (p.trailing_armed ? `yes, stop at ${trailLevel} (peak ${fmtPrice(p.peak_price)}, trail ${ladder.trailing.trailPct}%)` : 'not yet') : 'disabled'}</td></tr>
        <tr><td>Time exit</td><td>${fmtTs(timeExitAt)} — ${timeRemainingMs > 0 ? `${fmtDuration(timeRemainingMs)} remaining` : '<span class="neg">past due, awaiting next tick</span>'}</td></tr>
      </table>
      <table class="tranches">
        <thead><tr><th>#</th><th>Target</th><th>Sell%</th><th>Target price</th><th>Status</th></tr></thead>
        <tbody>${trancheRows}</tbody>
      </table>
    </div>`;
  }).join('\n');
}

const fillsHtml = fills.length === 0 ? '<p class="muted">No fills yet.</p>' : `
  <table class="fills">
    <thead><tr><th>Time</th><th>Symbol</th><th>Kind</th><th>Tranche</th><th>Trigger</th><th>Fill</th><th>Size (SOL)</th><th>Gross P&amp;L</th><th>Fees</th><th>Net P&amp;L</th></tr></thead>
    <tbody>
      ${[...fills].reverse().map((f) => {
        const pos = positions.find((p) => p.id === f.position_id);
        const dexFee = amt(f.dex_fee_sol_raw, f.size_decimals).toNumberUnsafe();
        const fixedFee = amt(f.fixed_fee_sol_raw, f.size_decimals).toNumberUnsafe();
        return `<tr>
          <td>${fmtTs(f.filled_at)}</td>
          <td>${esc(pos?.symbol ?? '?')}</td>
          <td>${esc(f.kind)}</td>
          <td>${f.tranche_index ?? '—'}</td>
          <td>${fmtPrice(f.trigger_price)}</td>
          <td>${fmtPrice(f.fill_price)}</td>
          <td>${fmtAmt(f.size_raw, f.size_decimals)}</td>
          <td>${fmtNullableAmt(f.gross_pnl_sol_raw, f.size_decimals)}</td>
          <td>${(dexFee + fixedFee).toFixed(6)}</td>
          <td class="${f.net_pnl_sol_raw !== null && f.net_pnl_sol_raw.startsWith('-') ? 'neg' : ''}">${fmtNullableAmt(f.net_pnl_sol_raw, f.size_decimals)}</td>
        </tr>`;
      }).join('\n      ')}
    </tbody>
  </table>`;

const feedStatsHtml = feedStats.length === 0 ? '<p class="muted">No feed-stats row yet.</p>' : feedStats.map((s) => {
  const symbolTicks = logTicks.filter((t) => t.symbol === s.symbol);
  const gaps = computeGaps(symbolTicks, stopPollSeconds * 1000 * 3);
  const gapRows = gaps.slice(0, 10).map((g) =>
    `<tr><td>${fmtTs(g.startTs)}</td><td>${fmtTs(g.endTs)}</td><td>${fmtDuration(g.durationMs)}</td></tr>`,
  ).join('');
  const total = s.usable_count + s.stale_count + s.error_count;
  const pct = total === 0 ? '—' : `${((s.usable_count / total) * 100).toFixed(2)}%`;
  return `
  <div class="card">
    <h3>${esc(s.symbol)}</h3>
    <table class="kv">
      <tr><td>Usable ticks</td><td>${s.usable_count} (${pct})</td></tr>
      <tr><td>Blind ticks</td><td>${s.stale_count + s.error_count} (${s.error_count} error, ${s.stale_count} stale)</td></tr>
      <tr><td>Longest blind streak</td><td>${fmtDuration(s.longest_blind_streak_ms)}${s.blind_streak_started_at !== null ? ' <span class="neg">— ONGOING right now</span>' : ''}</td></tr>
      <tr><td>Last tick</td><td>${fmtTs(s.last_tick_at)}</td></tr>
    </table>
    <p class="muted">Gaps &gt; ${(stopPollSeconds * 3)}s between consecutive log entries (from the log, not the counter — up to 10 largest):</p>
    ${gaps.length === 0 ? '<p class="muted">None found.</p>' : `<table class="fills"><thead><tr><th>Gap start</th><th>Gap end</th><th>Duration</th></tr></thead><tbody>${gapRows}</tbody></table>`}
  </div>`;
}).join('\n');

const chartsHtml = [...symbols].sort().map((symbol) => {
  const symbolTicks = logTicks.filter((t) => t.symbol === symbol);
  const pos = positions.filter((p) => p.symbol === symbol);
  const latestPos = pos.length > 0 ? pos[pos.length - 1]! : null;
  const refLines: { label: string; price: number; color: string }[] = [];
  const limitPrice = limitPriceBySymbol.get(symbol);
  if (limitPrice !== undefined) refLines.push({ label: 'limit', price: limitPrice, color: '#f5a623' });
  if (latestPos !== null) {
    refLines.push({ label: 'entry', price: latestPos.entry_price, color: '#4ea1ff' });
    refLines.push({ label: 'stop', price: latestPos.stop_loss_price, color: '#ff4d4f' });
    const ladder: LadderExitConfig = JSON.parse(latestPos.ladder_config) as LadderExitConfig;
    ladder.tranches.forEach((t, i) => {
      refLines.push({ label: `T${i} +${t.targetGainPct}%`, price: latestPos.entry_price * (1 + t.targetGainPct / 100), color: '#3ecf6b' });
    });
  }
  const markers = fills
    .filter((f) => positions.find((p) => p.id === f.position_id)?.symbol === symbol)
    .map((f) => ({ ts: f.filled_at, price: f.fill_price, kind: f.kind }));
  return `<h3>${esc(symbol)}</h3>${renderChart(symbol, symbolTicks, refLines, markers)}`;
}).join('\n');

const eventsHtml = events.length === 0 ? '<p class="muted">No operational events recorded.</p>' : `
  <details><summary>${events.length} operational events (stale/error/skip) — click to expand</summary>
  <table class="fills">
    <thead><tr><th>Time</th><th>Symbol</th><th>Kind</th><th>Detail</th></tr></thead>
    <tbody>
      ${[...events].reverse().slice(0, 200).map((e) =>
        `<tr><td>${fmtTs(e.occurred_at)}</td><td>${esc(e.symbol ?? '—')}</td><td>${esc(e.kind)}</td><td>${esc(e.detail)}</td></tr>`,
      ).join('\n      ')}
    </tbody>
  </table>
  ${events.length > 200 ? `<p class="muted">Showing the most recent 200 of ${events.length}.</p>` : ''}
  </details>`;

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>Paper trading status</title>
<style>
  body { background: #111; color: #ddd; font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; margin: 20px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin-top: 28px; border-bottom: 1px solid #333; padding-bottom: 4px; }
  h3 { font-size: 13px; margin: 10px 0 4px; }
  .muted { color: #888; }
  .neg { color: #ff6b6b; }
  .pos { color: #6bcf7f; }
  .meta { color: #888; font-size: 11px; margin-bottom: 16px; }
  .card { border: 1px solid #333; border-radius: 4px; padding: 10px 14px; margin: 10px 0; background: #171717; }
  table { border-collapse: collapse; width: 100%; }
  table.kv td { padding: 2px 10px 2px 0; vertical-align: top; }
  table.kv td:first-child { color: #999; white-space: nowrap; }
  table.tranches, table.fills { margin-top: 8px; }
  table.tranches th, table.tranches td, table.fills th, table.fills td { border: 1px solid #333; padding: 3px 6px; text-align: left; font-size: 12px; }
  table.tranches th, table.fills th { background: #1c1c1c; color: #999; }
  .chart { background: #171717; border: 1px solid #333; border-radius: 4px; }
  summary { cursor: pointer; color: #999; }
</style></head>
<body>
<h1>Paper trading — status</h1>
<div class="meta">Generated ${new Date(now).toISOString()} · db: ${esc(resolve(dbPath))} · log: ${esc(resolve(logPath))} · read-only, regenerated on each run (npm run status:page)</div>

<h2>Open position</h2>
${openPositionsHtml}

<h2>Price chart</h2>
${chartsHtml || '<p class="muted">No symbols found.</p>'}

<h2>Fill history</h2>
${fillsHtml}

<h2>Feed stats</h2>
${feedStatsHtml}

<h2>Operational events</h2>
${eventsHtml}

</body></html>`;

writeFileSync(outPath, html, 'utf8');
console.log(`Wrote ${resolve(outPath)}`);
console.log(`Open it: file://${resolve(outPath).replace(/\\/g, '/')}`);
