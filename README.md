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

Requires **Node 20+**.

```bash
git clone https://github.com/mpproject90/calude2
cd calude2
npm install

cp .env.example .env      # .env is gitignored and must stay that way
npm run config:check -- config/default.yaml
npm test
```

Expected: `config/default.yaml is valid`, and 183 test cases passing across 9
files. Nothing above needs network access beyond the npm registry.

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

This is the current step. It needs outbound access to `api.binance.com` and no
API key. **It will not run inside a sandboxed environment that blocks that
host** — run it on your own machine.

```bash
npm run data:fetch -- --symbol JUP --interval 1h --days 90
npm run data:fetch -- --symbol JTO --interval 4h --days 365 --db data/candles.db
```

Pulls `<SYMBOL>USDT` and `SOLUSDT`, caches both in SQLite, synthesizes
`<SYMBOL>/SOL`, and reports coverage, gaps, rejections and range widening. It
also writes `data/raw-sample.json` — verbatim response rows plus this build's
parse of row 0. That file is **generated locally and gitignored**: it is not part
of the repository and will not be present in a fresh clone.

What to scrutinise:

- **Bar coverage %** — well below 100% means Binance history is thinner than
  expected for that pair.
- **Gap count** — should be near zero for a CEX. Anything substantial means the
  interval-alignment assumption is wrong.
- **Rejected candles** — should be zero. Non-zero means real data violates an
  invariant asserted in `src/data/validate.ts`.
- **Range widening** — how much wider the synthesized high/low is than
  `|close − open|`. If it is large, MFI on the synthesized series is distorted.
  **Build the 1m-aggregated path before concluding anything about MFI** — exhaust
  the data-quality fix before changing the strategy's shape.

The Binance provider has **never made a real request** (every test uses a mock),
so this review is also how its parsing gets verified. If anything looks wrong,
send back the locally generated `data/raw-sample.json` described above.

## Layout

```
config/default.yaml   strategy + risk configuration (mode: backtest)
CLAUDE.md             entry point for a fresh session
docs/SPEC.md          original requirements
docs/DECISIONS.md     design decisions and their reasoning
docs/STATUS.md        build state, blockers, what is unverified
src/cli/              config:check and data:fetch entry points
src/config/           zod schema, loader, live-trading gate
src/data/             provider, cache, validation, gap detection, synthesis
src/db/               SQLite schema and connection
src/filters/          the filter stack
src/indicators/       RSI, MFI, ATR with warm-up gating
src/rules/            entry, exit and portfolio limits
src/types/            Candle, Interval, IndicatorValue, CandleProvider
src/util/amount.ts    integer (bigint) token math — no floats on-chain
src/util/logger.ts    structured logging with secret redaction
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
