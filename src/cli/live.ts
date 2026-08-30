/**
 * Live trading (phase 3, DECISIONS §42) — WRITTEN, NOT ENABLED by default.
 * CLAUDE.md's hard rule: reaching a real swap submission requires BOTH
 * `LIVE_TRADING=true` in the environment AND typing the exact confirmation
 * phrase below when prompted. Config `mode` must also be `live`
 * (`assertLiveTradingAllowed`, pre-existing gate from phase 1). Missing any
 * one of these refuses to start — this file does not weaken that.
 *
 *   LIVE_TRADING=true npm run live -- --config config/default.yaml --db data/live.db
 *
 * Same tick loop shape as `cli/paper.ts`, but every position round-trips
 * through `execution/liveRunner.ts`'s `liveTick()` — the SAME rule
 * evaluation, real swaps instead of simulated fills. Balance reconciliation
 * runs once at startup (refuses to proceed past a mismatch without
 * operator acknowledgement) and then on `global.execution
 * .balanceReconcileIntervalMinutes`. The kill switch
 * (`global.execution.killSwitchPath`) is checked every tick inside
 * `liveTick` itself, not just here.
 */
import { createInterface } from 'node:readline/promises';
import { openDb } from '../db/index.js';
import { loadConfig, assertLiveTradingAllowed, ConfigError } from '../config/load.js';
import { JupiterQuoteFeed } from '../paper/priceFeed.js';
import { PaperStore } from '../paper/store.js';
import { liveTick, type LiveTickDeps } from '../execution/liveRunner.js';
import { loadWalletFromEnv } from '../execution/wallet.js';
import { SolanaRpcClient } from '../execution/rpcClient.js';
import { LiveExecutionUnlock, GateError } from '../execution/gate.js';
import { isKillSwitchEngaged } from '../execution/killSwitch.js';
import { reconcileBalances, formatReconciliationReport, type ExpectedBalance } from '../execution/balanceReconciliation.js';
import { formatErrorChain } from '../util/errorChain.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v ?? fallback;
}

const configPath = arg('config', 'config/default.yaml');
const dbPath = arg('db', 'data/live.db');

/** Must be typed EXACTLY. Not configurable — see gate.ts's header comment on why. */
const CONFIRMATION_PHRASE = 'I UNDERSTAND THIS PLACES REAL TRADES WITH REAL MONEY';
const STALE_AFTER_MS = 5 * 60_000;

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nSIGINT received — stopping after the in-flight poll.');
  stopping = true;
});
process.on('SIGTERM', () => { stopping = true; });

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptConfirmation(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n*** LIVE TRADING — THIS WILL SUBMIT REAL ON-CHAIN SWAPS WITH REAL MONEY ***');
    console.log(`Type the following EXACTLY to continue, or Ctrl-C to abort:\n  ${CONFIRMATION_PHRASE}\n`);
    return await rl.question('> ');
  } finally {
    rl.close();
  }
}

function buildExpectedBalances(store: PaperStore, symbols: readonly string[], decimalsBySymbol: ReadonlyMap<string, number>): ExpectedBalance[] {
  const expected: ExpectedBalance[] = [];
  for (const symbol of symbols) {
    const open = store.getOpenPosition(symbol);
    if (open === null) continue;
    const decimals = decimalsBySymbol.get(symbol);
    if (decimals === undefined) continue;
    const tokenQty = open.remainingSizeSol.toNumberUnsafe() / open.entryPrice;
    if (!(tokenQty > 0)) continue;
    const expectedRaw = BigInt(Math.round(tokenQty * 10 ** decimals));
    expected.push({ label: symbol, mint: open.address, expectedRaw, decimals });
  }
  return expected;
}

async function main(): Promise<void> {
  const cfg = loadConfig(configPath);
  // assertLiveTradingAllowed is a NO-OP for non-'live' modes (it exists to
  // gate OTHER callers that merely ACCEPT a config claiming live mode) —
  // this CLI's whole purpose is live trading, so mode: live is checked
  // explicitly here too, not left to that function's narrower contract.
  if (cfg.global.mode !== 'live') {
    throw new Error(`${configPath} has global.mode: "${cfg.global.mode}", not "live" — refusing to start the live CLI.`);
  }
  assertLiveTradingAllowed(cfg);   // gate 1 of 2 — LIVE_TRADING=true, now that mode is confirmed live
  if (cfg.positions.length === 0) {
    throw new Error(`${configPath} has no positions[] configured — live trading has nothing to do`);
  }

  if (isKillSwitchEngaged(cfg.global.execution.killSwitchPath)) {
    throw new Error(
      `Kill switch file ${cfg.global.execution.killSwitchPath} is present — refusing to start. ` +
      'Remove it by hand once you have confirmed it is safe to resume.',
    );
  }

  const rpcUrl = process.env['SOLANA_RPC_URL'];
  if (rpcUrl === undefined || rpcUrl.trim() === '') {
    throw new Error('SOLANA_RPC_URL is not set — see .env.example.');
  }

  const wallet = loadWalletFromEnv();
  const rpc = new SolanaRpcClient(rpcUrl);

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Positions: ${cfg.positions.map((p) => `${p.symbol}(limit ${p.limitPrice}, ${p.buyAmountSol} SOL)`).join(', ')}`);

  const typed = await promptConfirmation();
  const unlock = await LiveExecutionUnlock.acquire({
    env: process.env, confirm: async () => typed, requiredPhrase: CONFIRMATION_PHRASE,   // gate 2 of 2
  });
  console.log(`Unlocked at ${new Date(unlock.unlockedAtMs).toISOString()}. Starting in 3 seconds — Ctrl-C now to abort.`);
  await sleep(3000);

  const db = openDb(dbPath);
  const store = new PaperStore(db);
  const feed = new JupiterQuoteFeed();
  const decimalsBySymbol = new Map(cfg.positions.map((p) => [p.symbol, p.decimals] as const));

  const alert = (msg: string): void => {
    // No external paging/SMS integration in this delivery — deliberately:
    // adding one is a real, separate decision (which service, whose phone
    // number) not implied by "build the execution layer." Loud stderr with
    // a distinct prefix is the floor, not the intended final form.
    console.error(`\n!!! ALERT !!! ${msg}\n`);
  };

  console.log('Running startup balance reconciliation...');
  const startupExpected = buildExpectedBalances(store, cfg.positions.map((p) => p.symbol), decimalsBySymbol);
  const startupReport = await reconcileBalances({
    rpc, owner: wallet.publicKey, expected: startupExpected,
    toleranceRaw: 0n,
  });
  console.log(formatReconciliationReport(startupReport));
  if (!startupReport.ok) {
    throw new Error('Startup balance reconciliation found mismatches (printed above) — refusing to start. Resolve manually first.');
  }

  const deps: LiveTickDeps = {
    feed, store, rpc, wallet, unlock, global: cfg.global, now: () => Date.now(),
    log: (msg) => console.log(`${new Date().toISOString()} ${msg}`),
    alert, staleAfterMs: STALE_AFTER_MS, killSwitchPath: cfg.global.execution.killSwitchPath,
  };

  console.log(`Live trading started — polling every ${cfg.global.stopPollSeconds}s, state in ${dbPath}. Ctrl-C to stop.`);

  let lastReconcileAt = deps.now();
  const reconcileIntervalMs = cfg.global.execution.balanceReconcileIntervalMinutes * 60_000;
  const toleranceRaw = BigInt(Math.round(Number(cfg.global.execution.balanceReconcileToleranceSol) * 1e9));

  while (!stopping) {
    if (isKillSwitchEngaged(cfg.global.execution.killSwitchPath)) {
      console.log('Kill switch engaged — idling without acting until it is cleared.');
    } else {
      for (const position of cfg.positions) {
        if (stopping) break;
        try {
          await liveTick(position, deps);
        } catch (err) {
          const detail = formatErrorChain(err);
          console.error(`[${position.symbol}] TICK FAILED (continuing): ${detail}`);
          store.recordEvent({ symbol: position.symbol, kind: 'feed_error', detail, occurredAt: deps.now() });
        }
      }
    }

    if (deps.now() - lastReconcileAt >= reconcileIntervalMs) {
      const expected = buildExpectedBalances(store, cfg.positions.map((p) => p.symbol), decimalsBySymbol);
      const report = await reconcileBalances({ rpc, owner: wallet.publicKey, expected, toleranceRaw });
      if (!report.ok) alert(formatReconciliationReport(report));
      lastReconcileAt = deps.now();
    }

    if (stopping) break;
    await sleep(cfg.global.stopPollSeconds * 1000);
  }

  db.close();
  console.log('Stopped.');
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof GateError) {
    console.error(`\nFAILED\n  ${err.message}`);
  } else {
    console.error(`\nFAILED\n  ${formatErrorChain(err)}`);
  }
  process.exitCode = 1;
});
