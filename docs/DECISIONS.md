# Design decisions

A running log of every significant decision and the reasoning behind it. If you
are picking this project up with no conversation history, **read this file
first** — it explains why the code looks the way it does. `docs/STATUS.md` tells
you what is built and what is next.

Decisions are appended, not rewritten. If one is reversed, the entry stays and a
new entry records the reversal and why.

---

## 1. Scope: what this bot is and is not

A **mean-reversion** bot for liquid Solana tokens. It buys oversold conditions
confirmed by RSI and MFI, and exits on momentum recovery, a hard stop-loss, or
time.

It is **not** a sniper, not a copy-trading bot, not an MEV bot. Speed is not the
edge; discipline and filtering are. **Token selection is manual** — the operator
pastes contract addresses, and the bot only decides *when* to enter and exit
within those tokens. It never picks tokens on its own.

**The most likely outcome is that this strategy has thin or no edge.** Retail
mechanical mean-reversion frequently fails out-of-sample, and the failure is
usually structural rather than a parameter problem. Phases 1 and 2 exist to
establish that cheaply. A well-built system producing a clear negative answer is
a successful project. Build for measurement honesty, not for numbers that look
good.

## 2. Three phases, with hard gates

| Phase | Contents | Gate before proceeding |
|---|---|---|
| 1 | Data layer, indicators, filters, rules, backtest | Operator reviews backtest results |
| 2 | Paper trading against live data, no transactions | Several weeks of results reviewed |
| 3 | Live execution via Jupiter | Explicit operator approval |

Phase 3 additionally requires `LIVE_TRADING=true` in the environment **and** an
interactive confirmation at startup. Every config file defaults to `backtest`.
`assertLiveTradingAllowed` refuses `mode: live` unless the env var is exactly
the string `"true"` — config alone can never arm real trading.

## 3. Tier B (memecoins) is deferred and will not be built

**Decision:** build Tier A only. Define the `TierBSafetyProvider` interface,
stub every method to throw `NotImplementedError`, and reject `tier: B` at config
load.

**Why:** honest Tier B backtesting requires a survivorship-bias-free dataset
that includes memecoins which went to zero. Dead tokens fall out of the free data
sources this project uses (they are delisted from indexes), so such a dataset is
not obtainable without paid historical data. A tier that cannot be validated
will not be traded.

**Consequences:** no Helius key, no on-chain indexer, no spend. The mint/freeze
authority checks, LP-burn check, top-10 holder concentration, LP drain detection
and prior-cycle requirement are all unimplemented. The interface is retained so
the shape is settled if historical data is later purchased.

**Two independent guards**, because a single guard is a single point of failure:
config load rejects tier B tokens, and the provider stub throws if any code path
somehow reaches it.

## 4. Expected move is derived from ATR, not hand-set

**Problem found during the build:** the cost-floor gate (§6.3 of the spec)
rejects a signal unless the take-profit target beats round-trip cost by 3x. But
the exit rules define no fixed take-profit — exits are stop-loss, time, RSI-70
and trailing. There was no number to compare against.

**Rejected:** adding a hand-set `expectedMovePct` per token. A guessed constant
gating real trades is worse than a derived one.

**Decision, two stages:**

- **Bootstrap (built):** `expectedMove = atrMultiplier × ATR(14) / price`, with
  `atrMultiplier` default 2.0, configurable per token. Volatility-scaled, so it
  adapts per token and per timeframe, and needs no prior data.
- **Empirical (after phase 1):** the backtest must report the **Maximum
  Favorable Excursion** distribution for every signal — how far each trade went
  in our favour before reversing. The **median MFE per token is the real
  expected move** and replaces the ATR estimate in live config.

MFE also tells us directly whether the 15% stop and the RSI-70 exit are sized
sanely against how far these moves actually run. **MFE is a required output of
step 6.**

## 5. SOL-relative strength: `minUnderperformanceVsSol`

Solana alts run ~0.8+ correlated with SOL. When SOL dumps, everything hits
RSI < 30 at once, and a naive bot opens six positions that are functionally one
leveraged bet on SOL.

**Rule:** enter only when the token is oversold *relative to SOL*:

```
tokenReturn − solReturn ≤ −minUnderperformanceVsSol
```

A decimal fraction; `0.05` = 5 percentage points of underperformance. Worked
examples, both of which are literal test cases:

- SOL −12%, JUP −13% → differential −1pp → **reject**. That is correlation.
- SOL flat, JUP −13% → differential −13pp → **accept**. That is a dislocation.

**Named for the sign convention deliberately.** The original
`relativeStrengthThreshold` left it ambiguous whether a larger number was
stricter or looser.

**KNOWN LIMITATION — beta is ignored.** This is a raw percentage-point
difference. A token that habitually moves ~1.4x SOL will show "underperformance"
on any SOL drawdown purely from its higher beta: if SOL drops 12%, a 1.4-beta
token *should* drop ~17%, so a 13% drop is actually outperformance and we would
be rejecting it correctly by accident.

**We are building the simple version on purpose** — it is transparent and
testable. Token and SOL returns are logged **separately** on every evaluation so
beta can be estimated from backtest data. Revisit only if the filter shows poor
discrimination in results. Do not add a beta adjustment speculatively.

## 6. The strategy runs on the SOL-quoted series, synthesized

**Decision:** do not backtest in USDT terms. P&L is in SOL — SOL is spent, SOL
is received — so the series that matters is JUP/SOL, not JUP/USDT. A JUP/USDT
drawdown that is purely a SOL drawdown is not a signal, and testing on USDT
candles would manufacture exactly those false entries.

**Method:** synthesize `JUP/SOL = (JUP/USDT) ÷ (SOL/USDT)`, aligned strictly by
timestamp, from data already pulled free from Binance. The SOL exposure nets out
by construction — no separate SOL leg to model.

**ACCURACY — the important caveat.** The ratio of two OHLC series is not a true
OHLC:

| Field | Status | Reason |
|---|---|---|
| `open`, `close` | **EXACT** | Both legs are the same instant, so the quotient is the true ratio. **RSI is built from closes alone, so RSI on a synthesized series is exact.** |
| `high`, `low` | **BOUNDS** | The true intrabar extreme of a ratio depends on *when* each leg's extreme occurred, which OHLC does not record. We emit `high = high_num/low_den`, `low = low_num/high_den` — the widest mathematically possible range. |

**Consequences:**
- ATR is **biased high**, so the cost-floor gate is optimistic about available move.
- MFI uses typical price `(H+L+C)/3` and inherits the widening. This is why MFI
  is **confirmation only, never a standalone trigger**.
- Bars with no counterpart on the other side are **dropped**, never carried
  forward or interpolated, and reported so they can be recorded as gaps.

**Mitigation before changing the strategy:** use the finest base timeframe
available and aggregate upward. The shorter the bar, the less time for the
extremes to diverge, and the tighter the bounds. A 1h ratio built from 1m bars
is far more faithful than one built from 1h bars. **If range widening looks
material, build the 1m-aggregated path before concluding anything about MFI** —
exhaust the data-quality fix before changing the strategy's shape.
`rangeWideningRatio()` exists to quantify this.

## 7. Stops are evaluated intrabar, not on candle close

**Original approach and why it was wrong:** exits were evaluated on candle close
only. But a bar whose *low* pierced the stop while its *close* recovered above it
would have stopped out in reality, at a worse price. **A 15% stop checked once an
hour is not a 15% stop.** Close-only evaluation does not merely mis-measure this
— it describes a strategy that cannot be executed.

**Instrumenting it was not enough.** Reporting the discrepancy while leaving the
behaviour in place left the problem in both the backtest *and* the live bot.

**Decision:**
- **Entry signals stay on candle close.** Never act on an incomplete candle.
- **Backtest:** `bar.low <= stopPrice` means the position stopped out during
  that bar. Fill at `stopPrice × (1 − exitSlippagePct/100)`, never at the close.
- **Live:** poll price every `global.stopPollSeconds` (default 30s), faster than
  the candle timeframe, and evaluate the stop against that tick independent of
  candle boundaries. `evaluateIntrabarStops` takes the tick as both `low` and
  `high`.
- **Trailing stop gets the same treatment.**
- `intrabarStopBreach` is **retained as a reported metric** so the cost of the
  old behaviour stays visible.

**Trailing ordering assumption:** within a bar we cannot know whether the high or
the low came first. We assume the **adverse sequence** — peak first, then trough
— so trailing arms from the bar's **high** and then fires against the same bar's
**low**. This exits earlier and at a worse price than the optimistic reading,
which is the direction an honest backtest should err in. In live mode the
question does not arise: low and high are both the current tick.

## 8. Exit priority: safety → stop-loss → trailing → RSI → time

First to trigger wins. **Time is last, deliberately.** If a trailing stop and a
time exit both come due on the same bar, the position is in profit and trailing
gives the better fill. The time exit is the "nothing happened" fallback and
should only fire when no profit exit did.

**On the RSI exit:** RSI is a momentum indicator, not a price level. It can cross
above the overbought threshold while the position is deeply underwater — a token
can drop 60%, chop, then bounce 15% and trigger this exit at a loss. **That is
expected behaviour, not a bug**, and there is a passing test asserting it. The
stop-loss and time exits exist precisely because the RSI exit alone is not an
exit strategy. Every exit logs its trigger so the backtest can report how often
each fires and at what P&L.

## 9. The RSI reference value: 70.4641, not the published 70.53

**Finding.** The spec required unit tests against known reference values. For the
classic Wilder / StockCharts worked example, the widely-published first RSI(14)
value is **70.53**. This implementation produced **70.4641**.

**The published figure is the one that is wrong.** Verified with exact rational
arithmetic in integer cents:

```
first 14 changes:  gains = 334c ($3.34)    losses = 140c ($1.40)
avgGain = 334/(100·14) = 167/700           avgLoss = 140/(100·14) = 1/10
RS      = 167/70
RSI     = 100 − 100/(1 + 167/70) = 16700/237 = 70.4641350211…
```

No rounding at any step. The circulating 70.53 carries rounded intermediates —
confirmed by the error pattern across the series, which does not decay like a
seed artifact but **flips sign at index 26**, the signature of per-step rounding.

**Why this matters:** had the implementation been "corrected" to match the
published number, a correct implementation would have been broken to fit a wrong
reference. **Do not change the RSI tests to match a figure found online.**

Tests assert the exact rational value, and RSI/MFI/ATR are additionally
cross-checked against an independent Python implementation. Fixtures live in
`test/fixtures/reference.json` and are committed — regenerating them is the most
painful thing to lose.

## 10. Indicator warm-up gating and the reliability contract

**Every indicator returns `{ value, reliable, reason }` — never a bare number.**
The rules engine refuses to trade on `reliable: false`, with no override path.

- **Warm-up is `period × 7`** (≈98 candles for period 14). Wilder smoothing is
  an EMA: it never "completes", it converges. At period×7 the seed's weight is
  `(1 − 1/14)^84 ≈ 0.2%`, below the noise floor of the price data.
- **A gap invalidates a full warm-up behind it, not one bar.** Wilder smoothing
  carries pre-gap state forward, so contamination persists.
- **Flat series returns 50, not NaN.** RS is `0/0` there — genuinely undefined.
  50 is the neutral reading; 0 or 100 would each imply an extreme that a flat
  series plainly is not, and either would fire a threshold.

## 11. Fail closed, everywhere

Missing data, stale candles, an API error, an unconfirmed transaction — all block
trading, never proceed on assumption. Concretely: unknown pool liquidity blocks
sizing; insufficient history blocks the regime filter and relative strength;
missing token metrics fail the tier gates; an unreliable indicator blocks entry.

## 12. Numeric and safety invariants

- **No floats for on-chain amounts.** `TokenAmount` holds a raw `bigint` plus
  decimals; parsing is string-only, because taking a JS number would already have
  lost precision. Stored in SQLite as `TEXT`, never `REAL`. Basis-point scaling
  truncates toward zero so position sizing never rounds *up*.
- **No position without an exit path.** `positions` requires `stop_loss_price`
  and `time_exit_candle_ts` as `NOT NULL` at insert — a row cannot exist without
  an exit.
- **Secrets never logged.** Every log record passes a redactor.
- **One strategy implementation.** Backtest, paper and live share the same
  indicator, filter and rules code. If they could disagree, the backtest would be
  worthless.

## 13. Log redaction excludes the bare word `token`

**Bug found by running the CLI**, not by any test: the redactor matched the field
name `token` against its auth-secret pattern and printed `"token":"[REDACTED]"`.
In this project "token" means a **tradeable SPL token** and appears in nearly
every log line — the redactor was blinding the logs while protecting nothing.

Narrowed to qualified auth names (`accessToken`, `authToken`, `bearerToken`,
`refreshToken`, `sessionToken`, `apiToken`, `apiKey`, `private*`, `secret*`,
`seed`, `mnemonic`, `keypair`, `passphrase`) plus key-length base58 strings
anywhere in a message. Tests assert both directions.

## 14. Data provider: Binance for Tier A

Researched Birdeye, GeckoTerminal and Binance.

| Provider | Limits | Auth | Role |
|---|---|---|---|
| **Binance klines** | 1000 candles/req, weight 2–5 against 1200/min, IP-based (429 → 418 ban) | none | **Primary** for Tier A |
| GeckoTerminal | 30 calls/min, 1000 candles/req | none | Alternate, behind `CandleProvider`; not built |
| Birdeye | ~30k compute units/month free | key | **Skipped** — free tier too thin, and no longer needed once Tier B was deferred |

Binance also supplies SOLUSDT, which both the relative-strength filter and the
JUP/SOL synthesis depend on.

**The Binance provider has never made a real request.** Every test runs against
an injected mock — pagination, throttling, 429 backoff and row parsing are
verified against a *model* of the API, not the API. See `docs/STATUS.md`.

## 15. Development environment constraint

The cloud container this was built in blocks all market-data hosts by egress
policy (`api.binance.com`, `api.geckoterminal.com`, `public-api.birdeye.so`, and
the docs sites). **This is not worked around.** Everything is built and
unit-tested against fixtures in the container; real data pulls and backtests run
on the operator's local machine. The data layer therefore makes **no
cloud-specific assumptions** and must run unchanged in a plain local Node
environment.

The container is also **ephemeral and can be reclaimed without warning**.
Therefore: commit and push after every completed step, push before answering any
question, and commit work-in-progress to a branch rather than leaving it
uncommitted. A step that is built but unpushed does not exist.
