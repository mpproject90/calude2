/**
 * Paper trading (spec step 8, DECISIONS §41) — polls `positions[]` on
 * `global.stopPollSeconds` and runs each through `paper/runner.ts`'s
 * `tick()`, the SAME rule-evaluation code (`evaluateLimitEntry`,
 * `evaluateLadderExit`, `evaluatePositionSize`, `evaluateCostFloor`) any
 * future live path will use, with the fill simulated instead of sent to a
 * DEX. Validates the EXECUTION layer, not a strategy: does the stop fire at
 * the right price, does position state survive a restart, does the price
 * feed hold up over weeks, does a simulated failure get handled — not "is
 * this profitable" (CLAUDE.md: nothing here places a trade).
 *
 *   npm run paper -- --config config/default.yaml --db data/paper.db
 *
 * Price source is Jupiter's quote API (DECISIONS §41 follow-up) — mint-pair
 * only, no pool address needed. State lives in `--db`, the same schema-v4
 * file `data:fetch` writes candles to; running this against a fresh path is
 * fine, the schema migration runs either way. Ctrl-C (SIGINT) stops
 * cleanly after the in-flight poll — state is already durable per-tick, so
 * there is nothing to flush on exit.
 */
import { openDb } from '../db/index.js';
import { loadConfig, ConfigError } from '../config/load.js';
import { JupiterQuoteFeed } from '../paper/priceFeed.js';
import { PaperStore } from '../paper/store.js';
import { tick, type TickDeps } from '../paper/runner.js';
import { formatErrorChain } from '../util/errorChain.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v ?? fallback;
}

const configPath = arg('config', 'config/default.yaml');
const dbPath = arg('db', 'data/paper.db');

/**
 * A price observation older than 5 minutes is refused (DECISIONS §41's
 * fail-closed rule). For the Jupiter quote feed this guard rarely fires in
 * practice — a quote's timestamp is the moment the request returned, not
 * an underlying trade time, so staleness only bites if an observation is
 * somehow held and acted on long after being fetched. Kept as a generic
 * safety net rather than removed; `error` (a failed/malformed request) is
 * the outcome expected to dominate blind ticks now, not `stale`.
 */
const STALE_AFTER_MS = 5 * 60_000;

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nSIGINT received — stopping after the in-flight poll (state is already durable, nothing to flush).');
  stopping = true;
});
process.on('SIGTERM', () => { stopping = true; });

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const cfg = loadConfig(configPath);
  if (cfg.positions.length === 0) {
    throw new Error(`${configPath} has no positions[] configured — paper trading has nothing to do`);
  }

  const db = openDb(dbPath);
  const store = new PaperStore(db);
  const feed = new JupiterQuoteFeed();

  const deps: TickDeps = {
    feed, store, global: cfg.global, now: () => Date.now(),
    log: (msg) => console.log(`${new Date().toISOString()} ${msg}`),
    staleAfterMs: STALE_AFTER_MS,
    // No STANDALONE live pool-liquidity feed in this delivery — but
    // runner.ts derives an implied figure per-entry from the SAME Jupiter
    // quote already fetched for pricing (DECISIONS §41 second follow-up).
    // This is only the fallback for a feed observation with no real
    // priceImpactPct to derive from — should not bind in normal operation.
    poolLiquiditySol: null,
  };

  console.log(
    `Paper trading started — ${cfg.positions.length} position(s), polling every ` +
    `${cfg.global.stopPollSeconds}s, state in ${dbPath}. Ctrl-C to stop.`,
  );
  console.log('NOTE: position-size/cost-floor liquidity is derived per-entry from the Jupiter quote\'s own measured price impact (DECISIONS §41) — printed on every ENTRY FILLED line.');
  for (const p of cfg.positions) {
    const alreadyOpen = store.getOpenPosition(p.symbol) !== null;
    console.log(`  ${p.symbol}: limit ${p.limitPrice}, ${p.buyAmountSol} SOL${alreadyOpen ? ' — RESUMING an open position from a prior run' : ''}`);
  }

  while (!stopping) {
    for (const position of cfg.positions) {
      if (stopping) break;
      try {
        await tick(position, deps);
      } catch (err) {
        // A single position's tick failing (e.g. a malformed feed response)
        // must not take the whole poller down — log it as the same kind of
        // event a stale/errored feed already produces, then keep polling
        // the rest. Fail-closed means "don't act," not "crash."
        const detail = formatErrorChain(err);
        console.error(`[${position.symbol}] TICK FAILED (continuing): ${detail}`);
        store.recordEvent({ symbol: position.symbol, kind: 'feed_error', detail, occurredAt: deps.now() });
      }
    }
    if (stopping) break;
    await sleep(cfg.global.stopPollSeconds * 1000);
  }

  db.close();
  console.log('Stopped.');
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\nFAILED\n  ${err.message}`);
  } else {
    console.error(`\nFAILED\n  ${formatErrorChain(err)}`);
  }
  process.exitCode = 1;
});
