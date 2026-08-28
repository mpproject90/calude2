# Solana RSI/MFI Mean-Reversion Bot

A mean-reversion trading bot for liquid Solana tokens and manually vetted
memecoins. Buys oversold conditions confirmed by RSI and MFI; exits on momentum
recovery, hard stop-loss, or time.

**Status: Phase 1, steps 1 and 3–5 of 10.** Config, persistence, indicators,
filters and the rules engine are in place and unit-tested. No data layer yet, no
backtest, no execution. Nothing here can place a trade.

## What this is not

Not a sniper, not a copy-trading bot, not an MEV bot. Speed is not the edge —
discipline and filtering are. Token selection is manual; the bot only decides
*when* to enter and exit within tokens you have vetted and pasted in.

## Build phases

| Phase | Contents | Gate |
|---|---|---|
| 1 | Data layer, indicators, filters, rules, backtest | Review backtest results |
| 2 | Paper trading against live data, no transactions | Several weeks of results |
| 3 | Live execution via Jupiter | Explicit approval only |

Phase 3 additionally requires `LIVE_TRADING=true` in the environment *and* an
interactive confirmation at startup. Every config file defaults to `backtest`.

## Build order progress

- [x] 1. Scaffold, config schema + validation, SQLite, `.gitignore` with `.env`
- [ ] 2. Data layer — Binance provider, caching, gap detection, JUP/SOL synthesis
- [x] 3. Indicator engine with warm-up gating and reference-value tests
- [x] 4. Filter stack, each filter independently tested
- [x] 5. Rules engine (entry/exit) against synthetic candle series
- [ ] 6. Backtest engine with realistic cost modelling
- [ ] 7. **Stop — report results, await review**
- [ ] 8. Paper trading
- [ ] 9. **Stop — run for weeks, await review**
- [ ] 10. Live execution (explicit approval only)

## Setup

```bash
npm install
cp .env.example .env      # fill in; .env is gitignored and must stay that way
npm run config:check -- config/default.yaml
npm test
```

Requires Node 20+.

## Layout

```
config/default.yaml   strategy + risk configuration (mode: backtest)
src/config/           zod schema, loader, live-trading gate
src/db/               SQLite schema and connection
src/types/            Candle, Interval, IndicatorValue, CandleProvider
src/util/amount.ts    integer (bigint) token math — no floats on-chain
src/util/logger.ts    structured logging with secret redaction
test/                 unit tests
```

## Decisions made during the build

**Tier B is deferred and will not be built.** Honest Tier B backtesting needs a
survivorship-bias-free memecoin dataset including tokens that went to zero, which
is not obtainable from free data sources. A tier that cannot be validated will
not be traded. `TierBSafetyProvider` defines the interface; every method throws
`NotImplementedError`, and a `tier: B` token is rejected at config load.

**The expected move is derived, not hand-set.** The cost-floor gate (§6.3) needs
a target to compare against round-trip cost, but the exit rules define no fixed
take-profit. Rather than gate real trades on a guessed constant, the expected
move is `atrMultiplier * ATR(14) / price` — volatility-scaled, per token and
timeframe. This is a bootstrap: after phase 1 the median Maximum Favorable
Excursion per token replaces it.

**Relative strength ignores beta, deliberately.** The filter tests
`tokenReturn - solReturn <= -minUnderperformanceVsSol` in raw percentage points.
A token that habitually moves ~1.4x SOL will show underperformance on any SOL
drawdown purely from beta. The simple version is transparent and testable; token
and SOL returns are logged separately so beta can be estimated from backtest data
and the filter revisited if discrimination proves poor.

**Strategy runs on the SOL-quoted series.** P&L is in SOL, so the series that
matters is JUP/SOL, not JUP/USDT. It is synthesized as (JUP/USDT) ÷ (SOL/USDT).
Close is exact so RSI is exact; synthesized high/low are approximations, so MFI
on a synthesized series is approximate and is treated as confirmation only.

## Design rules enforced in code

- **No position without an exit path.** `positions` rows require a stop-loss
  price and a time-exit candle at insert; they are `NOT NULL` columns.
- **Fail closed.** Indicators return `{ value, reliable }`, never a bare
  number. The rules engine will refuse `reliable: false` with no override.
- **No floats on-chain.** `TokenAmount` holds a raw `bigint` plus decimals.
  Amounts are stored in SQLite as TEXT, never REAL.
- **Secrets never logged.** Every log record passes through a redactor that
  strips secret-shaped keys and key-length base58 strings.
- **Config cannot arm live trading alone.** `assertLiveTradingAllowed` requires
  `LIVE_TRADING` to be exactly `"true"`.

## Expected outcome

The most likely result is that this strategy has thin or no edge. Phases 1 and 2
exist to find that out cheaply. A clear negative answer, honestly measured, is a
successful outcome for this project.
