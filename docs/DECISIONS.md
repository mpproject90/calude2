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

## 24. First real GeckoTerminal fetch: tighter rate limit than documented, and two resilience gaps

**The operator's first live run of `data:fetch --provider geckoterminal`**
(§18) surfaced real behavior no mock could: `api.geckoterminal.com`'s free
tier rate-limited (429) after roughly 5 requests within under a minute — far
tighter in practice than the documented "30 requests/min, no key" suggested,
and every 429 response sent no `Retry-After` header, so the throttle's
exponential-backoff fallback was doing all the work (§18's throttle assumed a
steady 30/min was achievable; it isn't, at least not in bursts).

**Two real gaps this exposed, both fixed:**

- **One candidate pool's persistent 429 killed the entire pull.** JUP had 5
  candidate pools; the second one's OHLCV fetch exhausted `maxAttempts` (4)
  and threw, discarding the pool-search results and the first candidate's
  already-successfully-fetched OHLCV along with it. **Fix:** `pullDominant`
  (`fetch-data.ts`) now catches a single candidate's failure, logs it, and
  excludes that candidate from `selectDominantPool` rather than aborting —
  only fails closed if EVERY candidate for a token fails. This is not "retry
  harder" — it accepts that a candidate may be genuinely unreachable this run
  and still produces a usable answer from the candidates that did respond.
- **A failed run threw away every raw sample already captured.**
  `writeRawSample` was only called after the whole function succeeded, so the
  first failure (before any resilience fix existed) discarded a real,
  successfully-parsed pool-search response and a real, successfully-parsed
  OHLCV response — exactly the diagnostic evidence this project's raw-sample
  mechanism exists to preserve (§14, §18). **Fix:** `runGeckoTerminal` now
  writes whatever raw samples and pool-selection metadata were captured in a
  `finally` block, so a run that fails partway through still leaves the
  evidence it already paid real request budget for.

Also added: `GeckoTerminalCandleProvider` takes an `onRateLimit` callback
fired on every 429 with the attempt number and the raw `Retry-After` header
value (or its absence), and `fetch-data.ts` prints each one. This is what
revealed the missing `Retry-After` header above — visibility added
specifically so the next tuning decision is made from evidence, not another
guess. **Not yet changed:** the throttle's request budget and backoff
constants. The real ceiling still isn't known precisely (only that 30/min
isn't reliably achievable in a burst); tightening the throttle further without
more evidence would be the same mistake as originally trusting the documented
number.

## 25. Pool-dominance migration must be judged per day, not per bar

**Bug found running the fix from §24 against real data**, not by any test.
The first successful live run reported JUP/SOL "DOMINANCE MIGRATED" — 881
separate periods over a 90-day, 2161-bar window, alternating almost every
hour between the two largest pools (a real 51%/34% volume split). That is not
migration; it is two consistently active pools whose per-bar volume leader
varies by chance. `selectDominantPool` (§19) compared raw per-BAR volume to
decide the "locally dominant" pool at each timestamp, so any two pools
trading at a similar clip look like constant migration — the diagnostic was
worse than useless, since 881 fake migrations bury the one real signal this
report exists to surface, and an operator skimming the count would reasonably
conclude the data is untrustworthy when it isn't.

**Decision:** bucket bars into calendar-day-sized buckets
(`DOMINANCE_BUCKET_MS = 24h`, independent of the candle interval — 1h, 4h and
1d series all get the same day-level migration granularity), sum volume per
pool per bucket, and compare bucket TOTALS to find the locally-dominant pool.
A period's reported boundaries are still real observed bar timestamps (the
bucket's min/max), never a fabricated bucket edge. This smooths hour-to-hour
noise while still catching a genuine multi-day shift — the case this
diagnostic actually exists to report (DECISIONS §19's original example:
liquidity migrating from an early pool to a later one).

**Verified against the exact failure pattern**, not just the fix in the
abstract: `test/data.test.ts` has a case with per-bar leadership alternating
A,B,A,B (the observed pathology) where the day TOTAL clearly favors one pool
— asserts `migrated: false`, one period — alongside a case spanning two real
days where the day-bucketed leader genuinely changes — asserts `migrated:
true`, two periods.

**Not addressed:** whether day is the RIGHT bucket size in general, versus
just the one that fixed this specific 90-day/1h case. A very short backtest
window (a few days) would see migration detection degrade toward "always one
bucket, never flagged" — a safe default (under-reporting on a report, not a
trading decision) but not necessarily the most useful one for a short window.
Revisit if a short-window fetch needs finer migration resolution than this
gives it.

## 26. Wick diagnostic reworked: percentage of price, not ratio to body

**The operator asked for evidence, not a fix, on why the wick:body p99
(~1.06 million) was so extreme.** The investigation (querying the cached
candles and cross-referencing `data/raw-sample.json` directly) found that
every top-ratio bar had `open` and `close` agreeing to 12-15 significant
digits — floating-point rounding noise, not a real price difference — and
that the wicks themselves were an ordinary 0.3-2% of price. The ratio only
looked catastrophic because §23's formula divided by a body that should have
been exactly zero and wasn't, quite.

**The premise behind the original formula was also wrong, independent of the
floating-point issue.** §23 built the wick:body ratio on the assumption that a
small body meant MFI's and ATR's inputs were compromised. Neither indicator
reads the candle body: ATR is true range, computed from high/low/previous
close (`indicators/atr.ts`); MFI's typical price is `(H+L+C)/3`
(`indicators/mfi.ts`). A tiny body just means price ended the hour where it
started — normal, especially for a token that isn't moving much that hour —
and says nothing about whether the high/low extremes are trustworthy, which
is the actual question this diagnostic exists to answer.

On the real JUP/SOL data reviewed, 416 of 1972 bars (21%) had a body under
0.1% of price. Read through the old (wrong) lens, "hundreds of tiny-body
bars" looked like a reliability problem for the indicators. It wasn't — it
was hundreds of ordinary quiet-hour bars being fed into a ratio formula that
is numerically unstable whenever its denominator is small, which for this
kind of formula is often.

**Decision:** `computeWickDiagnostics` (`src/data/wickDiagnostics.ts`) now
reports **wick size as a percentage of price** —
`(upperWick + lowerWick) / ((open + close) / 2) * 100` — instead of a ratio to
body. Every bar gets a real, comparable, finite number; there is no `Infinity`
case left to special-case, because the denominator (price) is never routinely
near zero the way body is. The **ATR-outlier count is unchanged** — it was
never body-dependent, and on the same real data it was the genuinely useful
signal (1 outlier in 1875 judged bars, a clean result) while the wick:body
ratio was noise dressed up as a finding.

**Consequence for the operator's step 6 decision:** the wick:body p99 that
originally looked alarming is not evidence against trusting MFI/ATR on this
token. Whatever concern remains rests on the ATR-outlier count, which was
already clean.

## 27. Backtest engine: scope decisions and the first real result

Step 6 (spec §10), unblocked by the operator after DECISIONS §24–§26's
findings were resolved. `src/backtest/engine.ts` replays candles through the
same `evaluateEntry`/`evaluateExit`/`checkPortfolioLimits`/filter functions
already tested in isolation — no duplicated strategy logic (spec §10, §16).
Several things had no existing precedent to follow and needed a decision:

**`tier-gates` is not called per bar.** It is a watchlist gate — does this
token even belong on the list at all — not a per-bar trading signal, and
`rules.test.ts`'s own example filter sets never included it either. The
operator configuring a token as `tier: A` already represents that decision.

**Historical pool liquidity does not exist** (§19), so `positionSize.ts`'s
§6.4 cap — which fails closed by design without it, correctly for live/paper
— would silently zero out every trade in a backtest and look exactly like "no
signal ever fired," burying the real cause. `BacktestInput.poolLiquiditySol`
accepts a constant snapshot (e.g. the pool's `reserveUsd` from `data:fetch`'s
output, converted to SOL) to evaluate the cap approximately across the whole
window, or `null` to skip it — in which case every bar's position-size check
is replaced with an explicit `pass(...)` carrying that reason, so the
omission shows up in `rejectedByFilter` as zero rather than vanishing
silently. `costFloor.ts`'s slippage estimate already had a graceful fallback
for `poolLiquiditySol: null` and needed no special-casing.

**Relative strength reconstructs a real JUP/USD-equivalent close** —
`candles[i].close * solCandles[i].close` (JUP/SOL × SOL/USD = JUP/USD, exact
for closes, same reasoning as §6's "close is EXACT" argument for a
synthesized series) — rather than feeding the filter a placeholder. This
matters because §20 changed the filter's pass/fail math to the JUP/SOL
series' own return, which makes SOL's absolute price irrelevant to the
DECISION, but `tokenReturn`/`solReturn` are still logged separately every
evaluation specifically so beta can be estimated later (§5, §20) — a
placeholder series would have made that logging fake. Verified algebraically
and by test: the reconstruction's `differential` reduces to exactly the
JUP/SOL series' own return regardless of SOL's price path, because the SOL
terms cancel in `(1+tokenReturn)/(1+solReturn)`.

**Regime alignment is look-ahead-free across timeframes** — the regime
filter reads SOL's trend on a HIGHER timeframe (`solMaTimeframe`, default
4h) than the token trades. `src/data/aggregate.ts` downsamples the cached
SOL series (only ever fetched at the token's own interval) into that
timeframe, dropping any bucket that doesn't have the exact expected bar
count rather than aggregating from a partial one. `src/backtest/
regimeAlignment.ts` then finds, for each token bar, the last regime bucket
that had fully CLOSED at or before that bar's timestamp — the same look-
ahead discipline as filling at the next candle's open, applied to a place it
would be easy to miss. On the real 90-day JUP window: aggregating the
GAPLESS SOL/USDC series into 4h buckets drops only 2 of 541 (boundary
effects); aggregating JUP's own 150-gap series the same way would drop 144 —
irrelevant to regime specifically, since regime is built from SOL, not the
traded token, but recorded here because it was asked about directly.

**Cost model:** DEX fee + slippage (real if `poolLiquiditySol` given, else
`fallbackSlippagePct`) + priority fee + Jito tip are computed ONCE per trade
via the existing `estimateRoundTripCost`, using the position size, and
deducted as a single round-trip SOL amount from gross P&L at exit — not
split into two separate price adjustments at entry and exit. Entry fills at
the next bar's open with NO slippage baked into the recorded price (spec
§10's "fills at the next candle's open" is taken literally); stop/trailing
exits already carry their own, separately-configured slippage
(`global.exitSlippagePct`) from `exit.ts`, unchanged, not double-applied.

**A position still open when the data runs out force-closes** at the last
bar's close, reason `end_of_data` — a backtest-boundary artifact, reported
separately and never counted in the spec §10 exit-trigger breakdown
(stop/time/RSI/trailing), but its P&L still counts toward the ending
balance so the books close.

**Not persisted to the `positions` table.** A backtest is a stateless,
one-shot replay — unlike paper/live, which need the table's crash-recovery
property (spec §3: a restart must not lose position state). The schema is
ready for it if the operator later wants to persist and compare multiple
backtest runs; not built because it wasn't needed for this one.

### First real result: 0 trades, and why

Run via `npm run backtest -- --symbol JUP` against the operator-approved
90-day JUP/SOL data (DECISIONS §24–§26). **Zero trades — not a strategy
verdict, a data-density one.** 92.4% of entry evaluations (1823 of 1973
bars) were blocked because RSI/MFI were not `reliable`. Broken down by
reason (`BacktestResult.indicatorUnreliableByReason`, added specifically so
this is a first-class report number rather than an ad-hoc calculation): 1726
of those (94.7%) were `gap-in-series`, only 97 `insufficient-warmup`. A gap
invalidates a full trailing warm-up window BEHIND it, not just the bar after
it (§10, `indicators/core.ts`) — with 150 gaps scattered through the 90-day
window (§24's "genuinely quiet pool" finding), that shadow covers most of
the series. The longest consecutive fully-reliable stretch is only 76 bars,
never a complete 98-bar (`period(14) × warmupMultiplier(7)`) window.

**This is the fail-closed rule working exactly as designed** — the operator
asked to see how often it fires, and it fires almost constantly on this
specific pool at this specific interval. It is not evidence the strategy
lacks edge; it is evidence this particular JUP/SOL pool, at 1h, does not
give RSI/MFI enough gap-free runway to ever reach a trustworthy reading.
Options that were NOT decided here, left for the operator: a coarser
interval (4h has far fewer bars to begin with, and gaps driven by quiet
weekend HOURS may or may not survive proportionally into 4h buckets — not
measured), a less gap-prone pool, a smaller `indicatorWarmupMultiplier`, or
accepting the result as-is. Report the number; the operator draws the
conclusion (CLAUDE.md hard rule).

## 28. Warm-up/gap-shadow default cut from `period × 7` to `period × 4.5`

**§10 justified `period × 7` (98 bars at period 14) by a seed-decay
calculation: `(1-1/14)^84 ≈ 0.2%`.** The operator, reviewing the real-data
0-trade result, asked whether that was numerically justified for a GAP
specifically (not just the initial seed) — Wilder smoothing is a first-order
IIR filter, so a gap's contamination decays by the same factor,
`(period-1)/period` per bar, every bar afterward. Solved for the bar count N
at which that residual influence falls below a threshold ε:
`N = ln(ε) / ln((period-1)/period)`. At period 14:

| Residual influence | N (bars) |
|---|---|
| <1% | 63 |
| <0.5% | 71 |
| <0.1% | 94 |

**§10's 98 sits almost exactly at the 0.1% mark (94), not meaningfully
beyond it** — the original heuristic was already close to a demanding
standard, just not derived this explicitly. The real question was which
standard is right, and the operator's answer: **1%, not 0.1%.** RSI/MFI feed
a threshold (30/70) chosen by convention, not calibrated to a tenth of a
point — demanding 0.1% purity on an input feeding a decision boundary that
coarse is false precision. Verified against the real 90-day JUP data (same
`buildReliabilityMask` the code runs, swept across N):

| N | Reliable bars | Reliable % | Longest stretch |
|---|---|---|---|
| 98 (old default) | 150 | 7.60% | 76 |
| 94 (0.1%) | 162 | 8.21% | 80 |
| 84 | 194 | 9.83% | — |
| 70 (0.5%) | 255 | 12.92% | — |
| **63 (1%, new default)** | **293** | **14.85%** | **111** |
| 56 | 340 | 17.23% | — |
| 42 | 455 | 23.06% | — |
| 28 | 621 | 31.47% | — |
| 14 | 971 | 49.21% | — |

63 roughly doubles the reliable fraction versus 98, and extends the longest
usable stretch by 46% (76→111) — a materially different backtest, not a
rounding change.

**Decision:** `indicators/core.ts`'s `DEFAULT_WARMUP_MULTIPLIER` is now
**4.5** (63 bars at period 14), and `global.indicatorWarmupMultiplier`'s
schema default matches. The multiplier no longer has to be an integer
(`z.number().min(1)`, `.int()` dropped) — 4.5 is deliberate, not a
convenience rounding — and `buildReliabilityMask` now does
`Math.ceil(period * mult)` so a fractional product (any period other than a
multiple of 2) still lands on a whole bar rather than truncating down, which
would have silently weakened the budget it's supposed to enforce.

**If ever tightened back toward the stricter end:** 94 is the 0.1% figure
(`indicatorWarmupMultiplier: 6.714285714...` at period 14, or more simply
just configure the absolute bar count desired via whatever period/multiplier
product gets there). Not done now — the operator's reasoning above is the
standing decision, this is just where the other end of the tradeoff sits if
revisited.

**This changes RSI, MFI and ATR identically** — `buildReliabilityMask` is
shared by all three (`indicators/core.ts`), and the backtest engine passes
`global.indicatorWarmupMultiplier` to all three calls (§27). No indicator's
own arithmetic changed, only how soon its output is trusted after a gap or
from cold start.

## 29. The cache caveat is bigger than "switching providers" — pool selection isn't stable run-to-run either

**§18's cache caveat warned about switching `--provider` for an
already-fetched symbol.** A `--days 179` fetch of JUP found a narrower,
same-provider version of the same problem: GeckoTerminal's free tier rate-
limited hard enough (§24) that 5 of JUP/SOL's 6 pool candidates were
excluded, leaving one — a much smaller, thinner pool (~0.13 base-asset
volume on a bar where the previously-selected pool had ~443) — as the
"selected" pool purely by elimination, not by winning a genuine volume
comparison. Re-fetching then **upserted that thin pool's candles into the
SAME `(token, interval, timestamp)` rows the previously-validated, much
larger pool had populated**, for every overlapping timestamp. Confirmed
directly: at timestamp 1787983200000, `close` changed from
`0.00210555555555556` (the earlier, validated pool) to `0.00210996712646431`
(the new one) with volume dropping from ~443 to ~0.127 — two different
pools' OHLC silently blended into what looks like one consistent series.

**The cache has no concept of "which pool."** `candles.provider` records
only the PROVIDER name (`geckoterminal`), not the pool address, so nothing
in the schema or the upsert logic can detect or prevent this — pool
selection can legitimately land on a different pool between two runs of
the exact same command (candidate availability varies with rate-limit luck,
not just genuine volume shifts), and every such re-fetch silently
contaminates whatever was cached before it for the overlapping window.

**Not fixed here** — same reasoning as §18: a `(token, interval, timestamp,
pool_address)` cache key would prevent it structurally, but that's a schema
migration not otherwise asked for. Until then: **treat any re-fetch of an
already-cached symbol as capable of silently replacing validated data with
data from a worse pool, even without changing `--provider`.** A fresh `--db`
path is the only reliable protection today. `fetch-data.ts`'s printed pool
address per run is the only way to notice this happened after the fact —
compare it against the previous run's printed selection before trusting a
re-fetch's data.

## 30. Pool pinning, and the cache key actually fixed

**§29 documented the contamination and deliberately did not fix it** (schema
migration "not otherwise asked for"). The operator asked for both fixes
after seeing it happen in normal use, not as a hypothetical:

**Cache key (schema v2):** `candles`' primary key is now `(token, interval,
pool_address, timestamp)`, not `(token, interval, timestamp)`. Two different
pools' candles for the same token/interval now coexist as separate rows,
visibly distinct, instead of one upsert silently overwriting the other.
`candle_fetch_log`, `candle_gaps` and `rejected_candles` got the same column
for consistency, since leaving them behind would just relocate the same
class of bug one table over. `pool_address = ''` means "not a pool-based
series" — Binance's `CandleService` path (exchange symbols, no pools) uses it
throughout. Every `CandleRepository` method that touches these tables now
takes `poolAddress` as a REQUIRED parameter, not optional-with-a-default —
forcing every caller to say which series it means, rather than letting an
omission silently resolve to one. This is a real, non-backward-compatible
schema change: `SCHEMA_VERSION` bumped 1 → 2, and `openDb` already refuses to
open a v1 database against v2 code with a clear error rather than risk silent
corruption — no migration path was written for existing v1 databases, since
`data/` is explicitly disposable, regenerated-at-runtime state (CLAUDE.md),
not data worth preserving across a schema change.

**Pool pinning (root-cause fix, not a workaround):** `--pool-address
<addr>` and `--sol-pool-address <addr>` skip GeckoTerminal pool
discovery/dominance-comparison entirely for that run's token or SOL
reference series, fetching the named pool's OHLCV directly. Reproducibly,
without a flag to remember: `tokens[].pinnedPoolAddress` (per token) and
`global.solReferencePoolAddress` (shared — one reference series, not one per
token) in config, with the CLI flag winning when both are given. This is
the actual fix for §29's root cause — rate-limit-driven candidate exclusion
handing a re-fetch a different pool than last time — because pinning removes
candidate discovery and comparison from the request path altogether, not
just the risk of a bad outcome from it.

**The tradeoff, made explicit, not hidden:** a pinned run cannot detect
whether dominance migrated to a different pool during the window, because no
comparison is made — `fetch-data.ts` prints `PINNED — pool discovery and
dominance comparison SKIPPED` prominently for each pinned series, and the
raw-sample metadata records `tokenPoolPinned`/`solPoolPinned` so this is
never a silent simplification.

**config/default.yaml pins JUP to `C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg`**
(the meteora pool validated across every real-data review so far, §24-§27)
and the SOL reference to `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`
(Orca's SOL/USDC pool, ~$25M reserve) — the two pools this project has
actual confidence in, chosen specifically to test whether pinning is what
makes a 179-day fetch achievable under the free tier's rate limit (§29's
179-day attempt lost 5 of JUP/SOL's 6 candidates to rate-limit attrition
before pinning existed).

## 31. Pinning worked; the 179-day backtest still found 0 trades; MFI at 30 is not miscalibrated

**Pinning fixed the fetch.** Re-run with §30's pinning against a wiped,
schema-v2 database: JUP/SOL's pool completed with ZERO 429s. SOL/USDC's
pinned pool needed retries on most pages but never exhausted its 4-attempt
budget — the full 179-day fetch succeeded end to end. Coverage: JUP/SOL 3944
of 4297 bars (91.78%, 283 gaps, 352 missing), SOL/USDC 100% (0 gaps),
essentially the same profile the 90-day review found — confirms discovery
was the expensive part, not OHLCV pagination itself.

**Gap density by month, checked for concentration (operator's question):**
5.14% (June) to 12.06% (August), a mild upward trend, not one catastrophic
month:

| Month | Missing | Expected | Missing % |
|---|---|---|---|
| 2026-03 | 39 | 688 | 5.67% |
| 2026-04 | 60 | 720 | 8.33% |
| 2026-05 | 65 | 744 | 8.74% |
| 2026-06 | 37 | 720 | 5.14% |
| 2026-07 | 69 | 744 | 9.27% |
| 2026-08 | 82 | 680 | 12.06% |

**The N=63 backtest (§28) against this data: still 0 trades.** 86.64%
of entry evaluations blocked by unreliable indicators (down from 92.40% at
N=98 on the 90-day series — the smaller shadow helped, as designed, but the
gap density here is high enough that it still dominates: 3355 `gap-in-series`
vs 62 `insufficient-warmup`). Of the 527 evaluations that DID have reliable
indicators, only 2 ever cleared both prior-overbought and RSI-cross-up — one
blocked by relative-strength, one by MFI. Same shape as the SOL/USDC control
run (§27): rare, coherent near-misses, not a broken engine.

**The MFI-at-30 question, answered with real data, not the earlier n=2
near-miss sample.** Computed MFI's value at every reliable RSI-cross-up-
through-30 event across the full 179-day window:

| Series | Cross-ups | MFI confirms (<30) | min | p25 | median | mean | p75 | max |
|---|---|---|---|---|---|---|---|---|
| SOL/USDC (0 gaps, n=59) | 59 | 33 (55.9%) | 8.94 | 21.12 | 29.03 | 29.15 | 35.60 | 57.96 |
| JUP/SOL (283 gaps, n=4) | 4 | 2 (50.0%) | 21.34 | — | 30.36 | 27.54 | — | 34.98 |

**30 is not miscalibrated.** On the large, gap-free SOL/USDC sample, MFI's
median AND mean at the moment of an RSI cross-up sit at 29.03/29.15 —
essentially exactly the 30 threshold, not systematically above it. The
confirm rate (55.9%) is close to a coin flip: MFI is doing real, roughly
even-odds filtering work at this threshold, not rejecting almost everything.
The earlier impression from §27's 90-day SOL run (0 of 2 confirmed) was
small-sample noise, not a signal — `binomial(2, p=0.559)` misses both
outcomes about 19% of the time by chance alone, unremarkable at n=2. The
conjunction (prior-overbought AND cross-up AND MFI-confirm, together) being
rare is a genuinely rare CONJUNCTION of three independent-ish conditions,
not evidence any single one of them — MFI included — is set wrong.

## 32. `data:screen`: cheap multi-token funnel counts to find a pooled sample, and what six real tokens showed

**§31 killed the relative-strength hypothesis** (a follow-up funnel measurement,
not written up as its own numbered section: JUP 254→2 reliable-to-cross-up,
SOL/USDC 1609→11, both ~0.7-0.8%; relative-strength discriminated correctly
on both of JUP's two near-misses). The bottleneck is the RSI cross-up itself,
which fires roughly 1% of the time on a liquid series. One token's 179-day
window is too short to collect enough cross-ups to say anything about
expectancy. The only lever left without waiting on more calendar time (the
180-day free-tier ceiling, §29) is pooling across multiple tokens — with the
explicit risk that correlated tokens dipping together on a shared SOL move
is one event counted several times, not several independent events.

**Built `data:screen`** (`src/cli/screen.ts`, `src/backtest/funnel.ts`,
`resolveCheapestPool` in `src/data/poolResolution.ts`) to make checking that
cheap: one discovery call and ONE candidate's OHLCV pagination per token
(highest current `reserveUsd`, no dominance/migration comparison — that
rigor is what `data:fetch` is for), reusing `computeEntryFunnel`, which calls
the exact same primitives `runBacktest`'s entry path uses
(`wasOverboughtWithin`, `crossedUpThrough`, `evaluateRelativeStrength`,
`evaluateRegime`) in the same order, so the funnel counts cannot drift from
what a real backtest would evaluate. No trades, no PnL — coverage, gaps,
longest reliable stretch, and stage counts only.

**Six tokens chosen for the live run**, deliberately spanning categories
rather than six meme coins that would all move together: JTO (Jito —
liquid-staking infra), PYTH (oracle infra), RAY (Raydium's own token — one
of the oldest, most continuously liquid pools on Solana), ORCA (Orca's own
token, same reasoning), WIF and BONK (the two highest-liquidity Solana
meme coins, included because they're liquid, not despite being memes). All
six mint addresses were verified against independent sources before use.
Interval 1h, 179 days, SOL/USDC reference pinned once and shared (§30).

**Result: two of six tokens returned unusable data, and the cheap pool
selection is why.**

| Token | Coverage | Gaps | Longest reliable stretch | Chosen pool reserveUsd |
|---|---|---|---|---|
| JTO | 22.71% | 209 | 5 | $43,775 |
| BONK | 18.41% | 244 | 0 | $124,630 |
| WIF | 99.56% | 19 | 1065 | $5,630,016 |
| PYTH | 99.74% | 11 | 1806 | $384,016 |
| RAY | 96.63% | 127 | 302 | $3,154,162 |
| ORCA | 85.99% | 391 | 269 | $764,290 |

JTO's and BONK's chosen pools are two to three orders of magnitude thinner
than WIF's or RAY's — both tokens have deep SOL pools in reality, but
`resolveCheapestPool`'s one-shot "highest current reserveUsd among whatever
`searchPools` returned" heuristic picked a shallow one, and a shallow pool
has enough missing/rejected candles that its reliability mask almost never
opens (BONK: 0 reliable bars in 4297; JTO: 5). This is a limitation of the
cheap path, not a finding about JTO or BONK's tradability — screen data at
this coverage isn't a "the strategy doesn't fire on JTO" result, it's a
"the cheap resolver didn't find JTO's real pool" result. Read the funnel
counts for JTO/BONK as inconclusive, not as zero-signal.

**Funnel counts, the four tokens with usable coverage (>85%):**

| Token | Reliable | Prior-OB | Cross-up | MFI-confirm | Rel-strength | Regime |
|---|---|---|---|---|---|---|
| WIF | 3408 | 951 | 1 | 0 | 0 | 0 |
| PYTH | 3694 | 1080 | 4 | 4 | 2 | 1 |
| RAY | 1619 | 330 | 0 | 0 | 0 | 0 |
| ORCA | 363 | 185 | 1 | 0 | 0 | 0 |

Pooled across all six tokens: 6 cross-up events total in 179 days, and only
one (PYTH) ever reached a full regime-pass. Pooling six liquid tokens did
not turn a rare per-token signal into a workable sample — it turned four
usable tokens' rare signals into six events, most of which still failed a
downstream filter individually.

**Clustering check (the operator's explicit risk), and the finding is the
opposite of the worry:** the 6 pooled cross-ups landed on 6 distinct UTC
days — no two events, even across different tokens, shared a day. There is
no evidence here of one shared SOL-driven move being counted six times. The
actual concentration risk is different: 4 of the 6 events are the same
token (PYTH), so the tiny sample is dominated by one asset's history rather
than being diversified across six. Six independent-by-day events from four
tokens, one of which supplies two-thirds of them, is still too thin to
estimate expectancy — it answers "is this worth a full run" (yes, PYTH looks
like the best-populated single candidate so far) not "does this make
money," which §-rule (`CLAUDE.md`) forbids concluding from counts alone
regardless.

## 33. A scoped exception to §6: Binance's bulk archive for RSI base-rate depth, not final validation

**The blocker after §32:** 6 pooled cross-up events across 6 tokens in 179
days is not a usable sample, and the 180-day GeckoTerminal free-tier ceiling
(§29) means no amount of re-fetching gets more history from that source.
The only way to get a real sample is more calendar time, and the only free
source with years of it is Binance's own bulk archive.

**Confirmed reachable before writing any code:** `data.binance.vision`
(HTTP 200 on the root listing) is a distinct domain from `api.binance.com`
(§14's regionally-blocked live API) — a static file host on a different
domain is not necessarily blocked just because the API is, and it wasn't.

**Why this does not reverse §6.** §6 rejected USDT-ratio synthesis as the
*default* data source because a synthesized high/low is the widest
mathematically possible BOUND, not an observation (`synthesize.ts`) — it
biases ATR high and MFI's typical price. That objection is entirely about
high/low. It never reached close: `close_ratio = close_num / close_den` is
exact, because both sides are sampled at the same instant regardless of
what happened between candles. RSI is computed from closes alone (spec
§5.1), so **RSI on a synthesized series is exact**, not approximate. Since
§31 and §32 both identified the RSI cross-up itself as the binding
constraint — not MFI, not relative-strength — a data source that is exact
for RSI and only approximate for the confirming/filtering indicators is
fit for the specific question being asked (base rate and event count), even
though it remains unfit for the final validation §6 was written to protect.
Scope, not reversal: **MFI and ATR stay approximate here, exactly as they
are for `--provider binance` in `fetch-data.ts`, and every report built
from this provider must say so.** Real Solana DEX price also differs from
Binance's CEX price — this data answers "how often does the entry pattern
fire," not "what would it have paid."

**Built `BinanceHistoricalCandleProvider`** (`src/data/providers/
binanceHistorical.ts`), behind the same `CandleProvider` interface as
every other provider. Two request shapes, both to `data.binance.vision`,
neither rate-limited (confirmed: no 429s across the requests made building
and testing this):
- `discoverAvailableMonths(symbol, interval)` — queries the underlying S3
  bucket's own listing API (`?prefix=...&delimiter=/`) for the true set of
  published months, rather than guessing a start year and probing
  backwards. Throws rather than silently under-reporting if the listing is
  ever truncated (>1000 keys — not reached by any symbol here, checked).
- `getCandles(token, interval, from, to)` — walks the requested month range,
  downloading each `SYMBOL-INTERVAL-YYYY-MM.zip` once and caching it to
  disk **forever** (`data/binance-vision-cache/`) — these archives are
  published once and never revised, so a cache hit never re-validates
  against the network. A 404 for an unpublished month is treated as "no
  data," not an error.

**A real format change caught while building this, not from documentation:**
Binance's kline archives switched from millisecond to microsecond epoch
timestamps starting with the **2025-01** monthly file — confirmed directly
(`SOLUSDT-1h-2024-12` is 13-digit ms; `SOLUSDT-1h-2025-01` onward is
16-digit µs; every month checked since stays µs). A parser trusting a fixed
13-digit width, or trusting one cutoff month without checking it directly,
would have silently mis-timestamped every bar from 2025 onward — Candle
timestamps would land 1000x in the future and every downstream check
(alignment with SOL, gap detection, reliability windows) would break
without an obvious error. `normalizeTimestamp` detects units **per row** by
magnitude (`> 1e14` ⇒ µs, divide by 1000) rather than trusting a cutoff
date, so a future format change on either side of that boundary is still
handled correctly. Would not have been caught by reading Binance's own
docs — found by fetching real files across a year boundary and comparing
timestamps to their own filenames' month.

**Listing depth for the 8 symbols this project needs** (all confirmed
listed, none gapped — month count matches the calendar span exactly for
every one, checked before writing the provider):

| Symbol | First archive | Last archive (as of this check) | Months |
|---|---|---|---|
| SOLUSDT | 2020-08 | 2026-07 | 72 |
| RAYUSDT | 2021-08 | 2026-07 | 60 |
| JTOUSDT | 2023-12 | 2026-07 | 32 |
| BONKUSDT | 2023-12 | 2026-07 | 32 |
| JUPUSDT | 2024-01 | 2026-07 | 31 |
| PYTHUSDT | 2024-02 | 2026-07 | 30 |
| WIFUSDT | 2024-03 | 2026-07 | 29 |
| ORCAUSDT | 2024-12 | 2026-07 | 20 |

**Scope boundary, stated plainly:** only complete monthly archives are used
— the current partial month (2026-08) is not included, since Binance does
not publish it as a monthly file until the month closes. This is a
recency gap, not a history-depth one; the daily-archive path that would
close it was not built (not needed for a base-rate study over years of
history, and not asked for).

## 34. The CEX study live run: 356 pooled cross-ups, real but incomplete clustering

**Built `npm run data:cex-study`** (`src/cli/cex-study.ts`) on top of §33's
provider: for SOL and each of JUP/JTO/PYTH/WIF/BONK/RAY/ORCA, discover the
full listed month range, download+cache every archive, synthesize TOKEN/SOL
(`synthesizeRatioSeries`, unchanged from §6), and run the exact same
`computeEntryFunnel` §32's `data:screen` uses — no duplicated strategy
logic, no parameter tuning (default RSI(14)/MFI(14)/entry config, same as
every prior funnel measurement). Writes to a separate `data/binance-vision.
db`, not the DEX-sourced `data/candles.db`, so study data can never be
mistaken for validation data. Prints the MFI/ATR-approximate, CEX-price,
Binance-listed-only caveat block at the top of every run, unconditionally.

**The live run** (from cold cache — ~300 archive downloads, none rate-
limited, completed in under two minutes):

| Symbol | Listed | History (d) | Coverage | Gaps | Reliable | Prior-OB | Cross-up | MFI-confirm | Rel-strength | Regime |
|---|---|---|---|---|---|---|---|---|---|---|
| JUP | 2024-01→2026-07 | 943 | 96.75% | 0 | 21834 | 8332 | 50 | 36 | 7 | 1 |
| JTO | 2023-12→2026-07 | 974 | 99.32% | 0 | 23154 | 8285 | 63 | 45 | 24 | 11 |
| PYTH | 2024-02→2026-07 | 912 | 99.84% | 0 | 21790 | 7558 | 56 | 28 | 14 | 8 |
| WIF | 2024-03→2026-07 | 883 | 99.48% | 0 | 21020 | 6988 | 51 | 39 | 27 | 13 |
| BONK | 2023-12→2026-07 | 974 | 98.53% | 0 | 22970 | 7379 | 44 | 27 | 13 | 7 |
| RAY | 2021-08→2026-07 | 1826 | 99.48% | 3 | 43347 | 14666 | 61 | 38 | 12 | 8 |
| ORCA | 2024-12→2026-07 | 608 | 99.09% | 0 | 14397 | 4859 | 31 | 13 | 4 | 1 |

SOL/USDT (reference): 99.50% coverage, 10 gaps, over the full 2020-08→
2026-07 span. **CEX data is essentially gapless, confirmed** — every token
above has 0-3 gaps in years of hourly bars, an order of magnitude cleaner
than any GeckoTerminal series reviewed so far (§24, §31). No token crossed
the 0.5% gap-rate warning threshold built into the script.

**Coverage below 100% with (near-)zero gaps is a real finding, checked, not
a bug:** JUP shows 96.75% coverage with 0 gaps — mathematically that can
only mean bars missing from the EDGES, not the middle, since gap detection
only flags discontinuities BETWEEN observed bars. Confirmed directly against
the cached database: JUP's real first candle is **2024-01-31**, not
2024-01-01 — `fullListedRange`'s "from" is the first day of the first
*archived* month, and Binance published a full January 2024 archive file
for JUPUSDT even though the token only started trading on the exchange at
the very end of that month (JUP's public TGE was 2024-01-31, consistent).
Same pattern confirmed for ORCA (first real bar 2024-12-06, archived from
2024-12-01) and BONK (first real bar 2023-12-15, archived from 2023-12-01).
**"Coverage %" in this report is measured against the archived month's
first day, not the token's actual first trade — a coverage number under
100% with 0 gaps means the exchange listing started partway through the
first archived month, not that data is missing.**

**Pooled total: 356 cross-up events across all 7 tokens, full listed
history — clears the operator's 50-event threshold.** This is the number a
sweep can be designed against; nothing about entry rules or parameters was
touched to reach it, only the data source.

**Clustering, checked at two different granularities because the operator's
concern is specifically about cross-token correlation, not raw event
count:**
- **356 events land on 210 distinct UTC days** (59% of events are the only
  cross-up that day). 86 days have more than one event, accounting for
  232 of 356 events (65.17%).
- **Of the top 10 busiest days, 9 are genuinely cross-token** (multiple
  different symbols crossing up the same UTC day — e.g. 2025-08-05: JTO,
  JTO, PYTH, WIF, WIF, BONK, BONK, 4 distinct tokens in one day), not one
  token repeatedly re-triggering. Only 2024-09-10 (5 events, all JTO) is a
  single-token repeat cluster. **This is the pattern the operator's original
  hypothesis predicted**: correlated alts firing together, most plausibly
  on a shared SOL-wide move, and it shows up clearly at this larger sample
  size where the 6-event §32 screen was too small to see it.
- **210 distinct days is an upper bound on the effective independent
  sample, not a confirmed floor.** Same-day co-occurrence is the clearest
  signal of a shared driver, but a SOL-wide dip-and-recovery can plausibly
  span more than one calendar day, in which case even 210 overstates
  independence. Not resolved here — a proper declustering approach (e.g.
  a minimum-gap-between-counted-events window) is a sweep-design question,
  not answered by this baseline run.

**Not run: no backtest, no parameter sweep.** Per operator direction, this
script stops at reporting the event count and clustering — designing an
in-sample/out-of-sample sweep against these 356 (or ~210 effective) events
is the next, separate decision.

## 35. Declustering the 356 pooled events: 137 effective at the chosen 2-day window

**§34 quantified real cross-token clustering but did not correct for it** —
210 distinct days is an upper bound, not the honest independent sample
size. Operator direction: implement declustering (events within a rolling
window collapse to one), test windows of 1/2/3/7 days, report the effective
count and how many clusters span 3+ distinct tokens at each, choose one, and
quote the declustered count everywhere from here on — not the raw 356.

**Built `decluster()`/`declusterAtWindows()`** (`src/backtest/decluster.ts`).
CHAIN declustering, not fixed bins: sort events by time, and an event joins
the current cluster if it falls within the window of the MOST RECENT event
already in that cluster, not the cluster's first event — so a cluster's
total span can exceed the window if events keep arriving inside it. This is
the standard approach for this kind of runs-based declustering (the same
shape as seismic aftershock declustering) and avoids the artifact a fixed
bin would introduce: splitting one continuous cluster in two just because it
crosses a bin boundary. Documented as a deliberate choice, not the only
possible one — see the module's header comment.

**Result, at each window (356 raw events, 7 tokens, full listed history):**

| Window | Effective count | Reduction | Clusters with 3+ distinct tokens |
|---|---|---|---|
| 1 day | 160 | 55% | 13 |
| 2 days | 137 | 61% | 18 |
| 3 days | 123 | 65% | 21 |
| 7 days | 64 | 82% | 28 |

**Chosen: the 2-day window — 137 is the honest sample size, not 356 or 210.**
Two independent reasons, not one:

1. **It matches the strategy's own definition of "the same cycle."**
   `entry.priorOverboughtWithinCandles = 50` (hours, at 1h) = 2.08 days is
   already how the entry rule itself decides whether a cross-up belongs to
   the same overbought-then-reverted cycle as a prior peak. Declustering at
   a window the strategy already treats as "one episode" is a principled
   anchor, not an arbitrary round number.
2. **The decay is smooth through 3 days and then falls off a cliff at 7.**
   160→137→123 (1d→2d→3d) is a steady, proportionate reduction as the window
   widens. 123→64 (3d→7d) nearly halves the count again in one step — at
   356 pooled events over roughly 2.4 years combined, the mean pooled
   inter-arrival gap is already under 2.4 days, so a 7-day window is wide
   enough that chains rarely terminate: it isn't finding more genuine shared
   episodes, it's running into density-driven chain runaway, silently
   merging causally-unrelated later signals into one earlier cluster. 2-3
   days sits before that cliff; 7 does not.

**This does not fully resolve the clustering question, and says so
explicitly:** even at 2 days, 18 of 137 clusters (13%) still span 3+
distinct tokens — real, not eliminated, contamination. 137 is this study's
best honest estimate of the independent sample size, not a claim the
remaining clusters are clean.

**From here on, 137 (not 356) is the number quoted as the sample size** for
anything built on top of this pooled event set, per operator direction —
the same declustering is applied to actual backtest TRADES (a smaller,
downstream population after MFI/relative-strength/regime/cost-floor/
portfolio filtering) in §36.
