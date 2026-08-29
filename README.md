# Solana RSI/MFI Mean-Reversion Bot

A mean-reversion trading bot for liquid Solana tokens. It buys oversold
conditions confirmed by RSI and MFI, and exits on momentum recovery, a hard
stop-loss, or time.

Not a sniper, not a copy-trading bot, not an MEV bot. Speed is not the edge —
discipline and filtering are. Token selection is manual: you paste contract
addresses, and the bot only decides *when* to enter and exit within them.

> **Status: phase 1, steps 1–5 of 10. Nothing here can place a trade.**
> There is no execution layer and no code path submits a transaction.
> No backtest has run, so no result about profitability exists.
>
> **Step 6 is blocked** on a local data-layer review — see `docs/STATUS.md`.

## Read these first

| File | What it is |
|---|---|
| **`CLAUDE.md`** | Entry point: hard rules and the current stop condition. |
| **`docs/STATUS.md`** | **The handoff.** What is built, outstanding, unverified; what happens next. |
| **`docs/DECISIONS.md`** | Every design decision and why. Read before changing anything. |
| **`docs/SPEC.md`** | The original requirements. Where code diverges, DECISIONS is authoritative. |

## Setup from a clean clone

Requires **Node 22** — pinned in `package.json`'s `engines` field, not just a
minimum. `better-sqlite3` has no prebuilt binary for Node 24 yet, and building
it from source needs a C++ toolchain most machines don't have set up. Via
[nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.

```bash
git clone https://github.com/mpproject90/calude2
cd calude2
npm install

cp .env.example .env      # .env is gitignored and must stay that way
npm run config:check -- config/default.yaml
npm test
```

Expected: `config/default.yaml is valid`, and 216 test cases passing across 9
files (see `docs/STATUS.md` for the breakdown). Nothing above needs network
access beyond the npm registry.

### Scripts

```bash
npm test                  # run the suite
npm run test:watch        # watch mode
npm run typecheck         # tsc --noEmit
npm run build             # compile to dist/
npm run config:check -- config/default.yaml
npm run data:fetch -- --symbol JUP --interval 1h --days 90
```

## Configuration

`config/default.yaml` holds strategy and risk settings, validated against a zod
schema on load. Invalid config is rejected loudly at startup with **every**
problem listed, not just the first.

`mode` defaults to `backtest`. Live trading additionally requires
`LIVE_TRADING=true` — exactly that string — in the environment; config alone can
never arm real swaps.

Secrets live in `.env` only, never in config, never in logs, never committed.

## Reviewing the data layer against real candles

This is the current step. The default provider is **GeckoTerminal**
(DECISIONS §18) — it needs outbound access to `api.geckoterminal.com`, no API
key. Binance is unreachable for the operator this project was built for
(regional block), so it is no longer the default, but it remains available via
`--provider binance` for anyone who can reach `api.binance.com`. **Neither will
run inside a sandboxed environment that blocks its host** — run this on your
own machine.

```bash
npm run data:fetch -- --symbol JUP --interval 1h --days 90
npm run data:fetch -- --symbol JTO --interval 4h --days 365 --db data/candles.db --address <JTO's Solana mint>
npm run data:fetch -- --symbol JUP --provider binance      # alternate path
```

GeckoTerminal needs the token's Solana mint address to find its pools: pass
`--address <mint>`, or add the token to `config/default.yaml`'s `tokens[]` and
it is looked up by `--symbol`. Only JUP is in `config/default.yaml` today, so
`--symbol JUP` resolves with no `--address` needed; any other token (JTO
included) needs `--address` until it's added to the config.

The GeckoTerminal path pulls the token's **dominant pool against SOL directly**
— real pool OHLC, no ratio synthesis — plus an independent SOL/USDC reference
pool the regime and relative-strength filters still need (DECISIONS §20). When
a token has more than one SOL pool, the one with the highest total traded
volume over the window is used as the sole source; if dominance shifted to a
different pool partway through, that is reported as a fact, never spliced in
(DECISIONS §19). It also writes `data/raw-sample.json` — verbatim response
bodies plus this build's parse of row 0. That file is **generated locally and
gitignored**: it is not part of the repository and will not be present in a
fresh clone.

What to scrutinise:

- **Bar coverage %** — for pool data, well below 100% is *expected* for a
  young pool (history is bounded by when the pool was created, not by an
  exchange listing date) and is not on its own a red flag. Cross-check against
  the reported `createdAt` for the selected pool before treating it as one.
- **Gap count** — a real gap (not explained by pool age) means the
  interval-alignment assumption is wrong, or the dominant pool went quiet for
  a stretch.
- **Rejected candles** — should be zero. Non-zero means real data violates an
  invariant asserted in `src/data/validate.ts`.
- **Pool dominance migration** — if reported, review which pool traded when
  before trusting the series; the tool does not resolve this for you.
- **Wick/ATR diagnostics** (GeckoTerminal path only, replaces range widening —
  DECISIONS §23, §26) — wick size as a percentage of price, and the count of
  bars whose high/low sits more than 3× ATR(14) outside the open-close body.
  (An earlier wick-to-BODY ratio was wrong: neither MFI nor ATR reads the
  candle body, and dividing by it blew up on the ~20% of bars where price ends
  the hour where it started — see DECISIONS §26.) This is real pool OHLC, so a
  bad ATR-outlier number means thin-liquidity noise (a wash trade or one
  oversized swap), not a synthesis artifact — different cause, same
  "review before trusting MFI/ATR on this token" conclusion.
- **Range widening** (Binance path only) — how much wider the synthesized
  high/low is than `|close − open|`. If large, **build the 1m-aggregated path
  before concluding anything about MFI** (DECISIONS §6) — exhaust the
  data-quality fix before changing the strategy's shape.

Both providers have **never made a real request** from inside this build
(every test uses a mock), so this review is also how their parsing gets
verified. If anything looks wrong, send back the locally generated
`data/raw-sample.json` described above.

## Layout

```
config/default.yaml   strategy + risk configuration (mode: backtest)
CLAUDE.md             entry point for a fresh session
docs/SPEC.md          original requirements
docs/DECISIONS.md     design decisions and their reasoning
docs/STATUS.md        build state, blockers, what is unverified
src/cli/              config:check and data:fetch entry points
src/config/           zod schema, loader, live-trading gate
src/data/             providers, cache, validation, gap detection, pool selection
src/data/providers/   GeckoTerminal (default), Binance (alternate), DexPaprika (stub)
src/db/               SQLite schema and connection
src/filters/          the filter stack
src/indicators/       RSI, MFI, ATR with warm-up gating
src/rules/            entry, exit and portfolio limits
src/types/            Candle, Interval, IndicatorValue, CandleProvider
src/util/amount.ts    integer (bigint) token math — no floats on-chain
src/util/logger.ts    structured logging with secret redaction
src/util/errorChain.ts  fail-loud error formatting (status/URL/full cause chain)
test/fixtures/        cross-language indicator reference values (committed)
```

## Invariants enforced in code

- **No position without an exit path.** `positions` requires `stop_loss_price`
  and `time_exit_candle_ts` as `NOT NULL` at insert.
- **Fail closed.** Indicators return `{ value, reliable, reason }`, never a bare
  number; the rules engine refuses `reliable: false` with no override. Missing
  data blocks trading rather than proceeding on assumption.
- **No floats on-chain.** `TokenAmount` is `bigint` + decimals, parsed from
  strings, stored as `TEXT`. Sizing truncates toward zero, never up.
- **Stops are intrabar.** A 15% stop checked once an hour is not a 15% stop.
- **Secrets never logged.** Every record passes a redactor.
- **One strategy implementation** shared by backtest, paper and live. If they
  could disagree, the backtest would be worthless.

## Build phases

| Phase | Contents | Gate |
|---|---|---|
| 1 | Data layer, indicators, filters, rules, backtest | Review backtest results |
| 2 | Paper trading against live data, no transactions | Several weeks of results |
| 3 | Live execution via Jupiter | Explicit approval only |

## Expected outcome

The most likely result is that this strategy has thin or no edge. Retail
mechanical mean-reversion frequently fails out-of-sample, and the failure is
usually structural rather than a parameter problem. Phases 1 and 2 exist to find
that out cheaply.

**A well-built system that produces a clear negative answer is a successful
project.** Build for measurement honesty, not for numbers that look good.
