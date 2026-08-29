# Build spec — Solana RSI/MFI mean-reversion trading bot

The original brief, reproduced here so it lives in the repo rather than only in
a conversation. This is the **requirements** document.

**Where reality has diverged from this spec, `docs/DECISIONS.md` is
authoritative** — it records each amendment and why. Known divergences, all
deliberate and operator-approved:

| Spec says | Now | See |
|---|---|---|
| Tier B memecoins with on-chain safety checks | Deferred, not built | DECISIONS §3 |
| Cost floor compares a take-profit target | Target derived from ATR; median MFE replaces it after phase 1 | DECISIONS §4 |
| `relativeStrengthThreshold` | Renamed `minUnderperformanceVsSol` | DECISIONS §5 |
| Backtest on whatever series | SOL-quoted, synthesized from two USDT series | DECISIONS §6 |
| Exits evaluated on candle close | Stops evaluated **intrabar**; entries stay on close | DECISIONS §7 |
| Exit order: stop, time, RSI, trailing, safety | safety → stop-loss → trailing → RSI → **time last** | DECISIONS §8 |
| Warm-up = `period × 7` (≈98 candles at period 14) | `period × 4.5` (63 candles) — a 1%, not 0.1%, Wilder-decay contamination budget | DECISIONS §28 |

---

## 1. What this is

A mean-reversion bot trading liquid, established Solana tokens (JUP, JTO, SOL and
similar) plus a small set of manually vetted memecoins added by contract address.
It buys oversold conditions confirmed by RSI and MFI, and exits on a combination
of momentum recovery, hard stop-loss, and time.

It is **not** a sniper, not a copy-trading bot, not an MEV bot. Speed is not the
edge. Discipline and filtering are the edge.

**Design principles**

- **Selection is manual, execution is automatic.** The operator pastes contract
  addresses. The bot decides when to enter and exit within those tokens. It never
  picks tokens on its own.
- **Every trade must clear the cost floor.** Fees plus slippage plus priority fees
  are real. A signal that predicts a 4% move is worthless.
- **No position without an exit path.** Every entry writes a stop-loss and a
  time-based exit at the moment it fills.
- **Fail closed.** Missing data, stale candles, an API error, an unconfirmed
  transaction — all block trading, never proceed on assumption.

## 2. Non-negotiable constraints

1. Private keys live in `.env` only. Never hardcoded, never logged, never written
   to any output file, never committed. `.env` in `.gitignore` from the first
   commit. Display public keys only.
2. Runs against a burner wallet with limited funds. Never assume access to a main
   wallet.
3. Phase 3 requires an explicit `LIVE_TRADING=true` flag **plus** a confirmation
   prompt on startup. Default in all config files is paper mode.
4. Every transaction must be **confirmed, not assumed**. Poll with a timeout. A
   submitted transaction is not a filled transaction. Handle dropped and expired
   transactions.
5. No `any` types in critical paths (order sizing, balance math, P&L). Precise
   integer math for token amounts — respect decimals, never floating point for
   on-chain amounts.

## 3. Stack

- TypeScript + Node.js, ESM modules
- SQLite for candle cache, trade log and state (`better-sqlite3`). Everything
  persists — a restart must not lose open position state.
- `@solana/web3.js` for chain interaction
- Jupiter swap API for routing and execution (phase 3 only)
- Own RSI and MFI implementations, unit-tested against known reference values.
  Indicator bugs are silent and expensive.

## 4. Data layer

Provider research required before implementation. Design behind an interface so
the provider can be swapped:

```ts
interface CandleProvider {
  getCandles(token: string, interval: Interval, from: number, to: number): Promise<Candle[]>
}
```

**Data quality requirements**

- Cache all fetched candles in SQLite, keyed by (token, interval, timestamp).
  Never re-fetch what you have.
- Detect and log gaps. A gap must not be silently interpolated.
- Validate every candle: `high >= max(open, close)`, `low <= min(open, close)`,
  `volume >= 0`. Reject and log anything that fails.
- Never compute indicators across a gap without flagging the result unreliable.
- Note that some providers omit empty candles entirely — handle gaps.

## 5. Indicator engine

RSI and MFI, period-configurable (default 14).

**Warm-up gating.** RSI uses Wilder's smoothing, which needs far more data than
its period to converge:

- Require a minimum of `period * 7` candles (≈100 for period 14) before emitting
  any value.
- Return an explicit `{ value: number, reliable: boolean }` — never a bare number.
- The rules engine must refuse to trade on `reliable: false`. No exceptions, no
  overrides.

Unit-test both against a known reference dataset with hand-verified expected
values. Include an edge case for a flat price series (RSI must handle division by
zero without producing NaN).

## 6. Filter stack

All must pass before an indicator signal may trigger an entry.

### 6.1 Universe tiers

**Tier A — established tokens:** minimum liquidity, minimum 24h volume, minimum
age.

**Tier B — vetted memecoins (by CA, stricter):** everything in Tier A, plus
liquidity trend check (LP value over trailing 15–30 min must not be declining
beyond a threshold — draining liquidity during a dip means the deployer is
exiting; treat failure as a hard block and remove from the watchlist), mint
authority revoked, freeze authority revoked, LP burned or locked, top-10 holder
concentration below a threshold, and a prior-cycle requirement (at least N prior
instances where RSI went above 70, then below 30, then recovered above 50).

Re-run Tier B safety checks periodically **while a position is open**. Liquidity
draining while holding triggers an immediate exit regardless of P&L.

> **Deferred — not built.** See DECISIONS §3.

### 6.2 SOL-relative strength filter (both tiers)

Solana alts run 0.8+ correlated with SOL. When SOL dumps, everything hits RSI < 30
simultaneously and a naive bot opens six positions that are functionally one
leveraged bet on SOL.

Only enter when the token is oversold **relative to SOL**. Compute the token's
return and SOL's return over a configurable lookback (default 24 candles) and
require the underperformance to exceed a threshold. SOL −12% / JUP −13% is
correlation → reject. SOL flat / JUP −13% is a dislocation → accept.

Make the threshold configurable and log the computed value on every evaluation.

### 6.3 Cost floor

Estimate round-trip cost: DEX fee + estimated slippage in and out (as a function
of position size versus pool liquidity) + priority fee + Jito tip. Reject any
signal where the take-profit target does not exceed round-trip cost by at least
3x. Log rejections with the computed numbers.

### 6.4 Position sizing cap

Never exceed a configurable percentage of pool liquidity (default 0.5%, hard
ceiling 1%). If the configured buy amount exceeds the cap, reduce to the cap — or
skip if the reduced size falls below a minimum viable amount.

### 6.5 Regime filter (global on/off)

Disables all new entries when conditions are hostile: SOL's own trend (price
versus its 50-period MA on a higher timeframe), optionally aggregate DEX volume
trend. Existing positions are still managed normally — only new entries blocked.
Log every state change. Make its contribution measurable in the backtest.

## 7. Entry rules

Per-token config. Every condition must pass.

1. **Prior overbought cycle** — RSI above the overbought threshold (default 70)
   within the last N candles. Buying a dip from a pump, not permanent decline.
2. **RSI cross up through oversold** — RSI was below the oversold threshold
   (default 30) and is now crossing back upward through it. **Trigger on the cross
   up, never on the drop below.** Buying the drop is knife-catching; buying the
   turn is mean reversion.
3. **MFI confirmation** — MFI below its threshold (default 30), as confirmation
   only, never a standalone trigger.
4. **Optional bullish divergence** (config flag) — price makes a lower low while
   RSI makes a higher low. When enabled it becomes required.
5. All §6 filters pass.
6. Indicator `reliable: true`.
7. Position limits not exceeded.

## 8. Risk management

Hard portfolio-level limits, checked before every entry:

- Max concurrent positions (default 3). Especially important given SOL correlation.
- Daily loss limit: cumulative realized loss in a rolling 24h window. When
  breached, block all new entries until the window resets. Log loudly.
- Max allocation per token and max total deployed capital as a percentage of
  wallet balance.
- Cooldown per token after a losing trade.

Log every blocked signal with its reason — those logs show what the limits cost
or saved.

## 9. Exit rules

Every position gets all of these, evaluated on every candle close. First to
trigger wins.

1. **Hard stop-loss** — fixed percentage below entry (default 15%).
   Non-negotiable, always set at fill time.
2. **Time-based exit** — close if no target hit within N candles.
3. **RSI recovery exit** — RSI crossing above the overbought threshold (70).
4. **Trailing stop** (optional) — activates after a configurable gain, then
   trails by a set percentage.
5. **Safety exit (Tier B)** — liquidity drain or authority change while holding.
   Immediate, ignore all other conditions.

**On rule 3:** RSI is a momentum indicator, not a price level. It can cross above
70 while the position is deeply underwater — a token can drop 60%, chop, then
bounce 15% and trigger this exit at a loss. **This is expected behaviour, not a
bug.** Rules 1 and 2 exist because rule 3 alone is not an exit strategy. Log
every exit with its trigger reason.

## 10. Phase 1: backtest engine

Replays historical candles through **the exact same** indicator, filter and rules
code the live bot uses. No duplicated strategy logic — if the backtest and live
bot can disagree, the backtest is worthless.

**Cost modelling:** DEX fee per swap; slippage as a function of position size
versus pool liquidity at that time (if historical liquidity is unavailable, use a
conservative fixed estimate and document it clearly); priority fee and tip
estimates; **fills at the next candle's open, never at the signal candle's
close** — look-ahead bias is the most common way backtests lie.

**Methodology:**

- **Survivorship bias** — for memecoin testing the dataset must include tokens
  that went to zero. Document how the test universe was assembled.
- **Out-of-sample split** — optimize on in-sample, validate on a later period
  never used for tuning. Report both separately. If out-of-sample collapses, the
  strategy is curve-fit; say so plainly.
- **Minimum sample size** — fewer than 50 trades is not conclusive. Display the
  trade count prominently and warn below this.

**Output metrics (minimum):**

- **Expectancy per trade** — `(win% × avg win) − (loss% × avg loss)`. **This is
  the headline number, not win rate.**
- Win rate, average win, average loss, profit factor
- Max drawdown and longest losing streak
- Total fees and slippage as a percentage of gross P&L
- **Exit trigger breakdown** — how many trades exited via stop-loss, time,
  RSI-70, trailing; and average P&L for each. Tells us whether the RSI-70 exit
  earns its place.
- **Count of signals rejected by each filter**
- **Maximum Favorable Excursion distribution per signal** (added — DECISIONS §4)

A parameter sweep mode would be useful, but must report in-sample and
out-of-sample side by side so overfitting is visible rather than hidden.

## 11. Phase 2: paper trading

Runs live against real-time data, executes no transactions, maintains a simulated
portfolio.

- Same code path as live, execution layer swapped for a simulator.
- Simulate fills at the current ask with modelled slippage, not at mid price.
- Persist all simulated trades to SQLite with full reasoning: which conditions
  triggered, filter values at entry, indicator values, computed relative strength.
- Same metrics as the backtest.
- Target 50–100 trades minimum before drawing conclusions. On longer timeframes
  this will take weeks. That is fine and expected.

## 12. Phase 3: live execution

**Do not build until phases 1 and 2 are done and the operator has reviewed
results.**

- Jupiter swap API for quotes and routing
- Slippage cap enforced on every swap; abort rather than accept a worse quote
- Dynamic priority fee estimation
- Confirm every transaction. Poll with timeout. Handle dropped transactions,
  expired blockhash, partial fills, insufficient balance. A transaction that
  cannot be confirmed is **unknown state** — halt trading and alert, do not retry
  blindly.
- Reconcile on-chain balances against internal position state on startup and
  periodically. If they disagree, halt and alert.
- Kill switch: a command or file flag that immediately stops new entries and
  optionally closes all positions.

## 13. Configuration

Single JSON or YAML config, validated on load with a schema. Reject invalid
config loudly at startup rather than failing at runtime. See `config/default.yaml`
for the live shape; `src/config/schema.ts` is the authority.

## 14. Dashboard

A local web dashboard served from the bot process:

- Watchlist with live RSI/MFI, relative strength versus SOL, and filter pass/fail
  state per token
- Price chart with RSI and MFI panes, entry and exit markers
- Open positions with live P&L, active stop level, time-exit countdown
- Closed trade log with exit reason
- Running expectancy and metrics
- Regime filter state and daily loss limit status
- Kill switch button

**Prioritize information density and correctness over visual polish. This is an
instrument panel, not a landing page.**

> Not started. Comes after a backtest exists.

## 15. Build order

1. Project scaffold, config schema and validation, SQLite setup, `.gitignore`
2. Data layer — provider research, interface, implementation, caching, gap
   detection, validation
3. Indicator engine with warm-up gating and unit tests
4. Filter stack, each filter independently unit-tested
5. Rules engine (entry and exit), unit-tested with synthetic candle series
6. Backtest engine with realistic cost modelling and full metrics output
7. **Stop. Report backtest results. Wait for review.**
8. Paper trading mode
9. **Stop. Run for several weeks. Report results. Wait for review.**
10. Live execution layer, only on explicit approval

## 16. What not to do

- Do not add features not asked for. No sniping, no copy-trading, no
  auto-discovery of new tokens, no social sentiment scraping.
- Do not silently swallow errors. Log everything with context.
- Do not let the backtest and live bot use different strategy code.
- Do not optimize parameters until the backtest engine is verified correct on a
  known dataset.
- Do not present backtest results without stating trade count, the out-of-sample
  split, and total costs paid.
- **Do not tell the operator the strategy is profitable.** Report the numbers and
  their limitations and let them draw the conclusion. If out-of-sample results are
  poor, say so directly.

## 17. Context

**The most likely outcome is that this strategy has thin or no edge.** Retail
mechanical mean-reversion strategies frequently fail out-of-sample, and the
failure is usually structural rather than a parameter problem. The purpose of
phases 1 and 2 is to find that out cheaply. **A well-built system that produces a
clear negative answer is a successful project, not a failed one.**

Build accordingly: prioritize measurement honesty over making the numbers look
good.
