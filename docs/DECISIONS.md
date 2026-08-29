# Design decisions

A running log of every significant decision and the reasoning behind it. It
explains why the code looks the way it does.

**Document map** — the four files a fresh session needs, in reading order:

| File | Purpose |
|---|---|
| `CLAUDE.md` | Entry point. Hard rules and the current stop condition. |
| `docs/STATUS.md` | **The handoff.** What is built, outstanding, unverified; what happens next. |
| `docs/DECISIONS.md` | This file. Why things are the way they are. |
| `docs/SPEC.md` | The original requirements. Where code diverges, **this file is authoritative**. |

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

## 15. `.gitignore` patterns are anchored, and pushes are verified by clean clone

**Bug found by clean-clone testing, not by any test or review.** A bare `data/`
pattern in `.gitignore` matches a directory named `data` at **any depth**, so it
also matched `src/data/`. The entire data layer — `validate.ts`, `gaps.ts`,
`repository.ts`, `synthesize.ts`, `index.ts`, `providers/binance.ts` — was never
committed. `git add -A` skipped it silently, the local working tree looked
correct, and three consecutive pushes reported success while the repo did not
contain the code.

It surfaced only on cloning the pushed branch into a clean directory and running
the documented setup: `npm test` could not resolve `../src/data/validate.js` and
`tsc` reported four missing modules.

**Decision:** anchor every root-only ignore pattern with a leading slash —
`/data/`, `/logs/`, `/dist/`, `/coverage/`. `node_modules/` stays unanchored
because nested copies are legitimate.

**A later audit found two more depth-matching patterns worth fixing.** `*.db`
and `*.log` also match at any depth, which would silently swallow a committed
test fixture — the same failure mode. Both are now re-included for
`test/fixtures/`. The secret patterns (`.env`, `*.pem`, `*.key`, `wallet.json`,
`keypair.json`) are left deliberately unanchored: a secret nested anywhere is
still a secret, so matching at any depth is the behaviour we want, and the
negations do not re-include them.

**Standing rule:** "pushed" is not the same as "in the repo". After a push that
adds files, run **both** a clean clone (catches anything whose absence breaks an
import) and a tree-versus-index diff (catches a doc, a config example, or a
module nothing imports yet). `test/repo-hygiene.test.ts` automates most of this
and runs with the suite — it asserts that nothing under `src/` or `test/` is
ignored, that the docs and reference fixtures are tracked, and that secrets stay
ignored at every depth.

**Branching:** `main` is the working branch. The repository was created with zero
commits, so no `main` existed and GitHub made the first pushed branch the
default — a conversation-specific name is a fragile thing for a fresh session to
depend on.

## 16. The spec and the handoff live in the repo, not in a conversation

**Decision:** commit the original build spec as `docs/SPEC.md`, add `CLAUDE.md`
as an entry point, and make `docs/STATUS.md` a self-contained handoff.

**Why:** the project is built in an ephemeral container, and the operator may
resume from a completely fresh session days later with no conversation history.
`DECISIONS.md` records *decisions*, but a fresh session also needs the *original
requirements* — the dashboard spec, the full metrics list, the "what not to do"
rules, the phase gates. None of that was reconstructible from the code.

`CLAUDE.md` exists because documentation only helps if it is read: a fresh Claude
Code session loads it automatically, so it carries the pointers to the other
three files and the current stop condition.

`SPEC.md` opens with a divergence table, because the code deliberately departs
from the original brief in six places (Tier B deferred, ATR-derived expected
move, the relative-strength rename, SOL-quoted synthesis, intrabar stops, exit
priority). Where they conflict, DECISIONS wins and SPEC says so.

**Standing rule:** anything a fresh session would need and could not reconstruct
from the code belongs in the repo, committed, before the session ends.

## 17. Development environment constraint

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

## 18. Data provider switch: GeckoTerminal replaces Binance as default

**Finding.** `api.binance.com` is unreachable from the operator's connection —
a TLS handshake fails with a certificate-for-the-wrong-domain error
(`SEC_E_WRONG_PRINCIPAL`) specific to that host, while other HTTPS hosts
(`api.github.com`) succeed over the identical stack. Consistent with an
ISP-level domain block, common for exchange domains from this operator's
region. **This is not a code defect** and nothing in §14's Binance provider is
being changed to work around it.

**Rejected:** routing the data path through a VPN. Paper trading (phase 2) runs
continuously for weeks; a VPN drop becomes a silent data gap for however long
it takes to notice, which is a worse failure mode than switching providers.

**Decision:** `GeckoTerminalCandleProvider` (`src/data/providers/geckoterminal.ts`)
becomes the DEFAULT for `npm run data:fetch`. Uses the free, KEYLESS surface at
`api.geckoterminal.com/api/v2` — deliberately not `api.coingecko.com/api/v3/onchain`,
which is a different host requiring a CoinGecko Pro key with its own (paid-tier)
rate limits and an explicit 6-months-on-Basic-plan historical cutoff that does
not apply to the free surface. Confirmed from documentation: 30 requests/min,
no key. Chosen over DexPaprika (§21) because its rate limit is confirmed and
uncontradicted, which matters more for a weeks-long unattended run than
DexPaprika's finer native interval.

**Binance is retained**, unchanged, as `--provider binance` (`src/cli/fetch-data.ts`).
It is not regionally blocked for everyone, and its provider, tests and the
JUP/USDT ÷ SOL/USDT synthesis path (§6) all still work — this is a default
change, not a deprecation.

**The upside beyond working around a block:** GeckoTerminal (and DexPaprika,
§21) index a pool's own trades directly, so requesting a JUP/SOL pool's OHLCV
returns REAL high/low, not the synthesized BOUNDS §6 describes. Pulling
`currency=token&token=base` for a JUP(base)/SOL(quote) pool returns exactly the
JUP/SOL series the strategy needs, with no ratio math and no widening. §6's
high/low-bounds problem and the "MFI confirmation-only" caveat it produced do
not apply to data fetched this way — see §23 for what replaces them.

**Never made a real request**, same status Binance carried until the
operator's first local run (§14): every test in `test/data.test.ts` runs
against a documented MODEL of the response shape (JSON:API-style `{ data: {
attributes: { ohlcv_list } } }` for candles, `{ data: [...] }` with
`relationships.base_token`/`quote_token`/`dex` for pool search). If the real
shape differs, every parse failure throws with the raw response body attached
as the error's `cause`, and `onRawSample` captures one verbatim OHLCV response
and one verbatim pool-search response per run — same discipline as Binance's
raw-sample dump, extended to the new endpoints.

**Known cache-collision caveat, not fixed here:** `CandleRepository` caches by
`(token, interval, timestamp)` only (§ repository.ts) — it does not record
which provider or quote asset produced a row. Fetching `JUP` via GeckoTerminal
(JUP/SOL) and later via Binance (JUP/USDT) into the same `--db` path will
silently blend rows from two different quote assets, latest write wins. Not
fixed with a schema change here because it wasn't asked for and adds migration
risk for a problem the CLI now warns about at runtime instead: use a fresh
`--db` path when switching providers for a symbol already fetched. Revisit
with a proper `(token, interval, timestamp, provider)` key if this becomes a
real operational hazard rather than a one-line warning.

## 19. Pool selection: volume-weighted dominance, migration surfaced not resolved

A token can trade on more than one pool against SOL (Raydium, Orca, Meteora,
...), and which pool is dominant can shift partway through the window being
fetched. Two options were rejected before landing on the one below:

- Picking "whatever has the most liquidity right now" and pulling its full
  history. Wrong whenever that pool didn't exist, or was thin, for part of the
  window — exactly the kind of assumption §11 says to fail closed on instead.
- Silently splicing multiple pools into one continuous series. This is the
  same failure mode §15/gaps.ts already refuses for missing bars: a stitched
  series is indistinguishable downstream from a real one, but isn't one.

**Decision** (`src/data/poolSelection.ts`, `selectDominantPool`): discover every
candidate pool via `GeckoTerminalCandleProvider.searchPools`, fetch each
candidate's own OHLCV over the window, and use ONLY the single pool with the
highest total traded volume as the series for that token. Wherever the winning
pool has no bars, the result is a genuine gap via the existing `CandleGap`
machinery — never backfilled from a different pool. If the LOCALLY dominant
pool (bar by bar) changed at least once, that is reported to the operator as a
fact (`migrated: true`, plus the `dominancePeriods` it shifted across) and
`fetch-data.ts` prints it — never resolved automatically.

**Deviation from "liquidity" as literally specified:** the free GeckoTerminal
and DexPaprika surfaces expose a pool's CURRENT reserve/liquidity
(`reserve_in_usd`) but no historical liquidity time series, so "time-weighted
liquidity" is not obtainable without a paid data source. TRADED VOLUME per bar
is used as the dominance signal instead — available historically (every OHLCV
bar carries it) and arguably a more direct measure of where real price
discovery happened than TVL, which can be parked capital rather than activity.
Flagged explicitly rather than silently relabelling liquidity as volume.
Current `reserve_in_usd` is still captured per candidate and printed, useful as
a snapshot and for `costFloor.ts`'s `poolLiquiditySol` going forward, just not
usable for this historical selection.

## 20. SOL/USD reference retained; relative-strength filter now exact

Pulling JUP/SOL directly (§18) raised the question of whether the SOL-relative
strength filter (§5) becomes redundant, since a JUP/SOL series already nets out
SOL exposure by construction. **It does not.** Checked every consumer of a SOL
series in the filter stack:

- `regime.ts` needs SOL's own USD-denominated trend (price vs. its moving
  average) — this has nothing to do with any token and cannot be derived from
  a JUP/SOL series at all.
- `relativeStrength.ts` still logs `tokenReturn` and `solReturn` SEPARATELY on
  every evaluation specifically so beta can be estimated later (§5) — that
  requirement survives switching providers.

**Decision:** an independent SOL/USD reference is still fetched every run — via
a SOL/USDC pool discovered and dominance-selected the same way as the token's
own pool (§19), using USDC's canonical Solana mint as the reference asset.

**What did change:** the filter's PASS/FAIL formula. It was
`tokenReturn - solReturn <= -threshold`, a subtractive approximation of
relative performance. The JUP/SOL pool's own return over the lookback window is
now available for free and is the EXACT figure —
`(1+tokenReturn)/(1+solReturn) - 1` — so `relativeStrength.ts` was changed to
compute it that way instead. The two formulas agree exactly when `solReturn` is
0 and diverge more as SOL's own move grows; the worked examples in §5 (built
under the old formula) are left as-is per the "append, not rewrite" rule, and
`test/filters.test.ts`'s SOL -12%/token -13% case now asserts the exact ratio
value rather than the old -0.01 approximation.

## 21. DexPaprika: alternate stub, rate limit deliberately left unresolved

`src/data/providers/dexpaprika.ts` implements the same `CandleProvider`
interface against `GET /networks/{network}/pools/{pool}/ohlcv` — cheap to add
alongside GeckoTerminal's client since the shapes are similar (real per-pool
OHLC, JSON body, injectable `fetchFn`) — but is **not wired into
`fetch-data.ts`'s pool-discovery/selection flow**. It exists so a working
alternate is available behind the interface if GeckoTerminal's free tier
proves too tight over a multi-week paper-trading run, without having to design
it from scratch under time pressure then.

**Rate limit is UNRESOLVED, on purpose.** DexPaprika's own documentation
contradicts itself: the API-reference page states 50,000 credits/month and 15
requests/min; the marketing page states 200,000 requests/month and 10
concurrent SSE streams. This was not chased further by reading more
documentation — resolving it needs an empirical check against the live API,
and since this provider is not primary, that check was not worth doing now.
The provider's throttle uses the more conservative figure (15/min) as an
unverified placeholder. Do not treat it as a real budget without checking it
against the live API first.

Also unresolved for the same reason: whether the OHLCV response returns price
in the pool's native quote-asset terms by default (assumed, since no
`currency`-style parameter is documented) — untested against the real API,
same status every provider carries before its first real request (§14, §18).

Solana's `4h` interval, which this project otherwise uses throughout, is not
offered by this API (`1h`/`6h`/`12h` are); `supports('4h')` returns `false`
rather than silently approximating it via aggregation.

## 22. Fail-loud fetch errors: status, URL and the full cause chain

**Bug found this session, and it cost a debugging round.** `fetch-data.ts`'s
top-level `catch` printed only `err instanceof Error ? err.message : String(err)`.
Node's `fetch` reports a network/TLS/DNS failure as `TypeError: fetch failed`
— a message that is true but useless — with the actual reason (a
certificate-for-the-wrong-domain error, in the incident that prompted this)
reachable only via `err.cause`. The top-level catch never looked there, so the
terminal output was `FAILED: fetch failed` with no status, no URL, and no hint
of what actually broke.

**Decision, two parts:**

- `src/util/errorChain.ts` (`formatErrorChain`) walks an error's full `cause`
  chain, not just its outermost message, and includes each `Error`'s `code`
  (e.g. `ECONNREFUSED`) when present. `fetch-data.ts`'s top-level catch uses it
  instead of printing `err.message` alone.
- Every provider's raw `fetchFn` call (`BinanceCandleProvider`,
  `GeckoTerminalCandleProvider`, `DexPaprikaCandleProvider`) is now wrapped in
  its own `try`/`catch` that re-throws as that provider's own error type with
  the request URL in the message and the original error attached as `cause` —
  so even a bare network throw, before any HTTP status exists to report,
  carries the URL and the full chain by the time it reaches the top level.

`BinanceProviderError` gained an `options?: { cause?: unknown }` constructor
parameter (standard `Error` cause support) to carry this; it previously only
accepted a message string.

## 23. Wick-to-body / ATR-outlier diagnostic replaces range-widening for real pool data

`rangeWideningRatio()` (§6, `synthesize.ts`) quantified a SPECIFIC, known
distortion: synthesizing JUP/SOL from two USDT legs produces high/low BOUNDS,
not observations. Pulling a pool's own OHLCV directly (§18) removes that
distortion entirely — the check is moot on that path — but does not mean real
pool data is clean. A thin pool's high/low can be a single wash trade or one
oversized swap rather than a representative price, which is real data, not a
synthesis artifact, so `rangeWideningRatio` cannot catch it (there is no
"widening" to measure — the high/low ARE observations, just possibly
unrepresentative ones).

**Decision:** `src/data/wickDiagnostics.ts` (`computeWickDiagnostics`), run by
`fetch-data.ts` on the selected token/SOL series, reports two signals instead:

- **Wick-to-body ratio distribution** (p50/p90/p99/max) —
  `(upperWick + lowerWick) / |close - open|` per bar. A zero-body bar with real
  range reports `Infinity` deliberately (all range, no direction — that IS the
  signal) rather than being clipped out of the distribution.
- **ATR-outlier count** — bars where the high or low sits more than 3× ATR(14)
  outside `[min(open,close), max(open,close)]`. Reuses `computeAtr` from
  `indicators/atr.ts` directly, so it is judged against the same ATR the
  strategy itself would compute; bars still in ATR's warm-up (§10) are
  reported separately and excluded from the outlier count rather than
  misjudged.

This is a report for the operator, the same role range-widening played — it
never blocks anything. A high outlier count means MFI's typical price and
ATR's true range on this token are eating single-swap noise, and is grounds to
scrutinize the token/pool before trusting either, same conclusion as a bad
range-widening number, different underlying cause.
