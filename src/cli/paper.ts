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
 * Every configured `positions[]` entry needs `pinnedPoolAddress` (dynamic
 * discovery isn't part of this delivery — see `runner.ts`'s
 * `poolAddressFor`). State lives in `--db`, the same schema-v3 file
 * `data:fetch` writes candles to; running this against a fresh path is
 * fine, the schema migration runs either way. Ctrl-C (SIGINT) stops
 * cleanly after the in-flight poll — state is already durable per-tick, so
 * there is nothing to flush on exit.
 */
import { openDb } from '../db/index.js';
import { loadConfig, ConfigError } from '../config/load.js';
import { GeckoTerminalCandleProvider } from '../data/providers/geckoterminal.js';
import { GeckoTerminalPriceFeed } from '../paper/priceFeed.js';
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
 * fail-closed rule) — five polls at the default 30s `stopPollSeconds`
 * before staleness bites, wide enough that a single slow request doesn't
 * itself trip the guard, tight enough that a genuinely stuck feed does.
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
  for (const p of cfg.positions) {
    if (p.pinnedPoolAddress === undefined) {
      throw new Error(
        `${p.symbol}: positions[].pinnedPoolAddress is required for paper trading (dynamic discovery ` +
        'is not part of this delivery — see DECISIONS §41).',
      );
    }
  }

  const db = openDb(dbPath);
  const store = new PaperStore(db);
  const provider = new GeckoTerminalCandleProvider();
  const feed = new GeckoTerminalPriceFeed(provider);

  const deps: TickDeps = {
    feed, store, global: cfg.global, now: () => Date.now(),
    log: (msg) => console.log(`${new Date().toISOString()} ${msg}`),
    staleAfterMs: STALE_AFTER_MS,
    // No live pool-liquidity feed in this delivery (module header in
    // runner.ts) — every entry/cost-floor evaluation prints its own
    // explicit "not evaluated"/fallback line, same as the backtest CLI
    // without --pool-liquidity-sol. Not a silent gap.
    poolLiquiditySol: null,
  };

  console.log(
    `Paper trading started — ${cfg.positions.length} position(s), polling every ` +
    `${cfg.global.stopPollSeconds}s, state in ${dbPath}. Ctrl-C to stop.`,
  );
  console.log('NOTE: poolLiquiditySol is not supplied — position-size and cost-floor checks run in their fail-closed/fallback mode for every entry (see runner.ts).');
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
