# Status — handoff document

**This file is the definitive handoff.** If you are a fresh session with no
conversation history, this tells you where the project stands and what happens
next. Read `docs/DECISIONS.md` for *why* things are the way they are, and
`docs/SPEC.md` for the original requirements.

**Last updated:** still phase 1 step 7 (STOP — awaiting operator review).
The sample-size blocker from the GeckoTerminal-only path is solved (§33-§34:
years of Binance-derived history, 356 pooled cross-ups), the resulting
clustering was quantified and corrected for (§35: 137 effective at a 2-day
decluster window), and a baseline backtest ran on that pooled series at
current settings — **result: 10 raw trades / 7 effective declustered
episodes, far below the 50-trade minimum, no conclusion possible (§36)**.
See "CEX baseline backtest" below. No parameters have been tuned anywhere
in this project yet. Verified against `main` by clean clone and
tree-versus-index diff after every push.

**Branch:** `main` is the working branch and the repository default. Clone it and
you have everything.

---

## THE NEXT ACTION IS NOT THE ASSISTANT'S

**Step 7 (spec §15): STOP — report backtest results, await operator review.**
Step 6 is built and has run once against real data. The result was **zero
trades**, for a specific, documented reason — not a verdict on the strategy
(DECISIONS §27, "First real backtest run" below). **Do not tune parameters,
change the interval, pick a different pool, or otherwise react to this result
without the operator's direction. Do not start phase 2 (paper trading).**

### Commands the operator runs (locally)

```bash
git clone https://github.com/mpproject90/calude2
cd calude2
npm install
npm test                  # see the test-count table at the bottom of this file, all passing

npm run data:fetch -- --symbol JUP --interval 1h --days 90
npm run backtest -- --symbol JUP
```

Default provider is **GeckoTerminal** (`api.geckoterminal.com`, free, no key —
DECISIONS §18), chosen because Binance is regionally blocked for this
project's operator. Needs the token's mint address to find its pools — JUP
resolves from `config/default.yaml`'s `tokens[]` with no flag needed; any other
token needs `--address <mint>`. `--provider binance` remains available for
anyone who can reach `api.binance.com`, using the original synthesis path
(DECISIONS §6, §14). **Neither will run in a sandboxed cloud environment that
blocks its host** — that is expected, not a bug. `npm run backtest` needs
candles already cached by `data:fetch` first; it does not touch the network.

### What to report back from `data:fetch` — GeckoTerminal path (default)

| # | Signal | Expected | If not |
|---|---|---|---|
| 1 | **Bar coverage %** (per series) | **NOT necessarily near 100%.** Pool history is bounded by when the pool was created, not by an exchange listing date — cross-check the printed `createdAt` for the selected pool before treating a low number as a problem. | if coverage is low AND the pool long predates the window, the interval-alignment assumption is wrong, or the dominant pool went quiet |
| 2 | **Gap count** | near zero once pool age is accounted for | same as above |
| 3 | **Rejected candles** | zero | real data violates an invariant in `src/data/validate.ts` |
| 4 | **Pool dominance migration** | none, ideally | if reported, review which pool traded when (`fetch-data.ts` prints the periods) before trusting the series — this tool selects the highest-volume pool and reports a migration as a fact, it does not resolve one (DECISIONS §19) |
| 5 | **Wick/ATR diagnostics** | few or no ATR-outlier bars | a nonzero count means thin-liquidity noise (a wash trade or one oversized swap) is producing phantom wicks that MFI/ATR would treat as real (DECISIONS §23) — this REPLACES the old range-widening check, which is moot once data isn't synthesized |

`rangeWideningRatio` and its decision rule below still apply, unchanged, to
`--provider binance` output — they do not apply to the GeckoTerminal path,
where the high/low are real observations, not synthesized bounds.

Also send the raw sample if anything looks wrong. It contains the verbatim first
response body of each kind (one OHLCV response, one pool-search response) plus
this build's parse of row 0, so a shape mismatch can be diagnosed from actual
data rather than from a description of it.

> **The raw sample is NOT in this repository and never will be.** `data/` is
> gitignored, so `data/raw-sample.json` does not exist in a fresh clone — do not
> go looking for it and do not treat its absence as a problem. It is *generated
> on the operator's machine* by the `data:fetch` run above, and reaches the
> assistant only when the operator pastes or uploads it. Path is configurable
> with `--raw-sample <path>`.

> **Cache caveat:** the candle cache keys on `(token, interval, timestamp)`
> only — it does not record which provider or quote asset produced a row.
> Re-running with a different `--provider` for the same symbol/db will
> silently blend rows from two different quote assets. Use a fresh `--db` path
> when switching providers (DECISIONS §18).

### Decision rule for range widening (`--provider binance` only)

Range widening measures how much wider the synthesized `<SYMBOL>/SOL` high/low is
than `|close − open|`. The synthesized high and low are mathematical **bounds**,
not observations (DECISIONS §6), which biases ATR high and distorts MFI's typical
price. This does not apply on the default GeckoTerminal path — see the
wick/ATR diagnostic above instead.

**If the number is ugly: build the 1m-aggregated synthesis path BEFORE touching
MFI's role.** A 1h ratio built from 1m bars is far more faithful than one built
from 1h bars, because the extremes have less time to diverge. Exhaust the
data-quality fix before changing the strategy's shape. Only if the 1m path still
leaves material distortion should MFI's role be reconsidered.

---

## What is built

**Phase 1, steps 1–6 of 10, step 7 (STOP) is now.** See the test-count table
at the bottom of this file for the current suite size. **Typecheck clean**
under `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`.

```
✓ 1. Scaffold, config schema + validation, SQLite, .gitignore with .env
✓ 2. Data layer — GeckoTerminal (default) + Binance (alternate) providers,
     pool selection, caching, gap detection, wick/ATR diagnostics
✓ 3. Indicator engine with warm-up gating and reference-value tests
✓ 4. Filter stack, each filter independently tested
✓ 5. Rules engine (entry/exit) against synthetic candle series
✓ 6. Backtest engine — same indicator/filter/rules code as live, fills at
     next open, MFE distribution, exit trigger breakdown, in/out-of-sample
     split, rejection counts per filter. Run once against real JUP data:
     0 trades, for a documented reason (DECISIONS §27) — see below.
■ 7. STOP — report results, await operator review           ← HERE NOW
□ 8. Paper trading mode
□ 9. STOP — run for weeks, await operator review
□ 10. Live execution layer, on explicit approval only
```

Steps 3–5 were built before step 2 — an instruction skipped it by mistake and it
was filled in afterwards. Nothing depended on the order, because everything above
the data layer operates on `Candle[]`.

Step 2 was revisited after the initial build: Binance turned out to be
regionally blocked for this project's operator, so GeckoTerminal became the
default provider (DECISIONS §18–§23). Binance's original code, tests and
JUP/SOL synthesis path are unchanged and remain available as an alternate.

| Area | Module | What it does |
|---|---|---|
| Config | `src/config/` | zod schema, all-problems-at-once errors, live-trading gate |
| Persistence | `src/db/` | candle cache, positions, rejected signals, regime events, token state |
| Data | `src/data/` | providers, repository + fetch log, validation, gap detection, pool selection, wick/ATR diagnostics |
| Providers | `src/data/providers/` | GeckoTerminal (default), Binance (alternate), DexPaprika (stub, not wired in) |
| Indicators | `src/indicators/` | RSI, MFI, ATR; warm-up gating; `{value, reliable, reason}` |
| Filters | `src/filters/` | relative strength (exact ratio-return, DECISIONS §20), cost floor, position sizing, regime, tier gates |
| Rules | `src/rules/` | entry conditions, intrabar exits, portfolio limits |
| Backtest | `src/backtest/` | engine (spec §10), summary metrics, regime timeframe alignment |
| CLI | `src/cli/` | `config:check`, `data:fetch` (`--provider geckoterminal\|binance`), `data:screen` (cheap multi-token coverage/funnel, no backtest — §32), `data:cex-study` (Binance bulk-archive base-rate study + declustering — §33–§35), `data:cex-backtest` (baseline backtest on the CEX-pooled series — §36), `backtest` |
| Hygiene | `test/repo-hygiene.test.ts` | asserts nothing under `src/`/`test/` is gitignored |

**Nothing here can place a trade.** There is no execution layer and no code path
submits a transaction.

## What is UNVERIFIED

**GeckoTerminal (default) has now made real requests and been reviewed once**
— see "First real GeckoTerminal review" below for the numbers and DECISIONS
§24–§26 for what that run found and fixed. It is no longer purely
mock-verified, but it has been reviewed exactly once, against one token
(JUP), one interval (1h), one 90-day window — treat that as a first data
point, not a settled verification. **Binance (alternate) has still never made
a real request** from inside this build; every Binance test runs against an
injected mock, same status as before (DECISIONS §14).

The failure path is known-good for both, and now carries more than a bare
message: a blocked host, a bad HTTP status, or a raw network/TLS failure all
throw with the request URL and the full error `cause` chain attached
(DECISIONS §22) — `fetch-data.ts`'s top-level handler prints all of it via
`formatErrorChain`, not just `err.message`. This is what made the §24–§26
findings diagnosable in the first place rather than just "it failed."

**A backtest has now run once, and produced zero trades — no strategy result
of any kind exists yet, because no trade ever fired.** See "First real
backtest run" below for why (a data-density finding, not a strategy one).
No claim about profitability has been made and none should be inferred —
there is nothing yet to draw one from.

## First real GeckoTerminal review — JUP, 1h, 90 days (2026-08-29)

Run twice: the first run hit an unresolved 429 on the second pool candidate
and crashed with nothing persisted (DECISIONS §24); after the resilience and
day-bucket-migration fixes (§24–§25) it completed cleanly. Numbers below are
from the second (fixed) run. **This has not been judged against the decision
checklist above by the operator — these are the numbers to review, not a
conclusion.**

| Signal | JUP/SOL | SOL/USDC (reference) |
|---|---|---|
| Pool candidates found | 5 | 5 |
| Selected pool | `C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg` (meteora) | `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` (orca) |
| Volume share of selected pool | 78.0% (one candidate excluded — persistent 429, see below) | 64.6% |
| Bar coverage | 1972 of 2161 (91.25%) | 2161 of 2161 (100.00%) |
| Gaps | 150 (189 bars missing) | 0 |
| Rejected candles | 0 | 0 |
| Dominance migration | YES — 3 periods: the selected pool led 2026-05-31 to 2026-06-19, a different pool (`HdsFGjjY46twFKjqHqUyT2bnRS4XCo1HaExts5CSNprU`, also meteora) led for one day (2026-06-20), then the selected pool resumed 2026-06-21 to 2026-08-29 | not reported (single dominant pool throughout) |
| Wick:body ratio p50/p90/p99/max (OLD formula, see below) | 1.00 / 127.17 / 1,056,450.59 / ∞ | not computed (reference series only) |
| All-wick (zero-body) bars (OLD formula) | 2 of 1972 | — |
| ATR-outlier bars (>3× ATR(14)) | 1 of 1875 judged (97 still in ATR warm-up) | — |

**Two items investigated and resolved (operator-directed follow-up, evidence
in DECISIONS §26 and this session's transcript):**

- **The 189 missing bars are a genuinely quiet pool, not a bug.** Mostly
  single-bar gaps (119 of 150), clustered on weekends (Sat+Sun account for 75
  of 189 missing bars vs. 16-28/day on weekdays), with neighboring bars
  running at 62-65% of the series' typical volume. Five gap timestamps were
  cross-checked directly against the verbatim `data/raw-sample.json` API
  response: all five are genuinely absent from what the API returned, with
  their immediate neighbors present in the same response — ruling out both an
  API drop and a client-side pagination bug. SOL/USDC's 100% coverage over
  the identical window, same code path, is the control showing this isn't
  systemic.
- **The wick:body p99/max were a diagnostic bug, not a data problem — fixed
  in DECISIONS §26.** Every top-ratio bar had open and close agreeing to
  12-15 significant digits (floating-point rounding noise, not a real price
  difference), and the wicks themselves were an ordinary 0.3-2% of price.
  Dividing by a near-zero body produced ratios in the hundreds of millions for
  unremarkable wicks. The original premise was also wrong: neither MFI
  (typical price, uses H/L/C) nor ATR (true range, uses H/L/prevClose) reads
  the candle body, so body size was never the right thing to worry about.
  `computeWickDiagnostics` now reports wick size as a percentage of price —
  see `wickToPricePct` in `src/data/wickDiagnostics.ts`. The table above keeps
  the old numbers as the historical record of what prompted the fix, not as a
  current reading.

**Still open, deliberately deferred — does not block step 6, per the
operator:**

- **The one-day dominance shift to `HdsFGjjY...` on 2026-06-20** is a real,
  reported migration, not noise (DECISIONS §25 fixed the false-positive
  version of this).
- **One of JUP/SOL's 5 candidate pools (`C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz`,
  orca) failed with a persistent 429 and was excluded from selection**
  (DECISIONS §24) — it holds real volume share (~34% in the first, partial
  run) so its exclusion is not neutral. A re-run may or may not include it;
  this is a live consequence of the free tier's tight rate limit, not a bug.
- **DexPaprika's rate limit remains unresolved** (DECISIONS §21) and this
  review did not touch it — it is not wired into `fetch-data.ts`.

`data/raw-sample.json` was written on the fixed run and is available locally
(gitignored, not in this repo) for inspecting the exact bars behind any of
the above.

**Operator decision: step 6 is unblocked.** 0 rejected candles, gaps real and
explained (flagged not interpolated, never traversed silently), 1 ATR-outlier
bar in 1875, SOL/USDC reference at 100% coverage. Proceeded to build the
backtest engine.

## First real backtest run — JUP, 1h, 90 days

`npm run backtest -- --symbol JUP` against the same real data reviewed above.
**Result: 0 trades. Not a strategy verdict — a data-density one, and the
fail-closed rule the operator specifically asked to watch for firing exactly
as designed (DECISIONS §27).**

| | |
|---|---|
| Entry evaluations (bars where flat, looking for a signal) | 1973 |
| Blocked — indicators not `reliable` | 1823 (92.40% of evaluations) |
| &nbsp;&nbsp;of those: `gap-in-series` | 1726 (94.7%) |
| &nbsp;&nbsp;of those: `insufficient-warmup` | 97 (5.3%) |
| Longest consecutive fully-reliable stretch | 76 bars (never a full 98-bar `period(14)×warmupMultiplier(7)` window) |
| Blocked — no prior overbought cycle | 88 |
| Blocked — no RSI cross-up | 61 |
| Blocked — MFI did not confirm | 1 |
| Trades | 0 |

**Why:** a gap invalidates a full trailing warm-up window BEHIND it, not just
the bar after it (`indicators/core.ts`, by design, tested — DECISIONS §10).
With 150 gaps scattered through the 90-day window (the "genuinely quiet pool"
finding above), that shadow covers most of the series — 1726 of 1823 blocked
bars, dwarfing the 97 from plain initial warm-up. This is `BacktestResult.
indicatorUnreliableByReason`, added specifically so this split is a
first-class report number rather than something computed ad hoc.

**This is not evidence the strategy lacks edge.** It is evidence this
specific JUP/SOL pool, at 1h, does not give RSI/MFI enough gap-free runway to
ever reach a trustworthy reading. Options NOT decided here, left for the
operator (DECISIONS §27): a coarser interval, a less gap-prone pool, a
smaller `indicatorWarmupMultiplier`, or accepting the result as-is and moving
to a different token. **Awaiting operator direction — do not act on any of
these without it.**

Also built into the engine, not yet exercised by a real trade: exact fill-at-
next-open timing, round-trip cost deduction from gross P&L, MFE tracking from
the real intrabar peak, force-close of a still-open position at series end
(`end_of_data`, never counted as a real exit trigger), and the full spec §10
metrics suite (expectancy, win rate, profit factor, max drawdown, longest
losing streak, exit trigger breakdown, MFE distribution, cost totals,
in-sample/out-of-sample split, minimum-trade-count warning) — all tested
against hand-computed numbers, none yet exercised against a real trade
because none has happened.

**Two scope decisions from the build, both documented in DECISIONS §27:**
`tier-gates` is not evaluated per bar (a watchlist gate, not a signal — the
token's `tier: A` config already represents that check); the §6.4
position-size cap needs historical pool liquidity that doesn't exist for
free, so it runs only with `--pool-liquidity-sol <amount>` supplied, and is
explicitly marked "not evaluated" (never silently skipped) otherwise — this
run used no liquidity figure, so the cap was not enforced.

## Second real backtest run — JUP, 1h, 179 days, N=63 shadow (superseded the 90-day run above)

Investigated three operator questions after the 90-day run above: is the
engine actually working (0 trades looks identical whether it's broken or
just gap-starved), is the 98-bar gap shadow numerically justified, and would
more data or a different interval help. Findings and the resulting changes:

- **Engine validated** by running it against SOL/USDC (0 gaps) as a control
  — 2 real near-misses found (a genuine RSI cross-up blocked by MFI missing
  the threshold by 0.55 points), proving the rule evaluation is coherent,
  not stuck (DECISIONS §27's addendum, this session).
- **Gap shadow cut from 98 to 63 bars** (period × 4.5, not × 7) — a 1%
  Wilder-decay contamination budget instead of 0.1%'s, chosen because
  RSI/MFI feed a threshold (30/70) picked by convention, not calibrated to a
  tenth of a point (DECISIONS §28, config default changed, now configurable
  and no longer required to be an integer).
- **Found and fixed real cache contamination**: GeckoTerminal pool selection
  is not stable run-to-run under rate-limit attrition, and a re-fetch
  silently overwrote a previously-validated pool's candles with a much
  thinner pool's, for every overlapping timestamp — confirmed happening in
  normal use. Fixed at the root: `pool_address` is now part of the `candles`
  primary key (schema v2), and pool discovery can be skipped entirely via
  pinning (`--pool-address`/`tokens[].pinnedPoolAddress`,
  `--sol-pool-address`/`global.solReferencePoolAddress`) — DECISIONS §29–§30.
- **179 days is achievable with pinning**: the un-pinned attempt lost 5 of 6
  JUP/SOL candidates to rate-limit attrition; pinned, JUP/SOL completed with
  zero 429s and SOL/USDC completed despite needing retries. Coverage: JUP/SOL
  91.78% (3944/4297, 283 gaps), SOL/USDC 100%. Gap density by month ranges
  5.14–12.06%, a mild upward trend, not one catastrophic month (table in
  DECISIONS §31).
- **Still 0 trades at N=63 on 179 days.** 86.64% of evaluations blocked by
  unreliable indicators (down from 92.40% at the old N=98/90-day setting,
  but the gap density here still dominates). Of the 527 evaluations with
  reliable indicators, exactly 2 cleared both prior-overbought and RSI-
  cross-up — same rare-near-miss shape as the SOL/USDC control, not a
  regression.
- **MFI's 30 threshold is not miscalibrated.** Computed MFI's value at every
  RSI-cross-up-through-30 event on the gap-free SOL/USDC series (n=59): MFI
  confirmed (<30) 55.9% of the time, and its median/mean AT the cross-up
  moment (29.03/29.15) sit almost exactly on the threshold. The earlier 0-of-
  2 near-miss impression was small-sample noise. DECISIONS §31 has the full
  distribution and the reasoning.

**Awaiting operator direction** on what, if anything, to do about the 0-trade
result now that the engine, the shadow window and the MFI threshold have all
been checked and none of them look like the explanation. The remaining
candidates are: this specific token/pool's price action genuinely didn't
produce the setup more than twice in 179 days, or a structural review of the
entry conjunction (three conditions that each fire independently but rarely
align) is warranted — not decided here (CLAUDE.md hard rule: report, don't
conclude).

## Third measurement — relative-strength hypothesis killed, then a multi-token screen (§32)

A follow-up funnel measurement (same reusable primitives as the engine, no
backtest run) tested the operator's hypothesis that relative-strength was
structurally rejecting SOL-driven correlated dips — the likely explanation
for the 179-day run's 2 near-misses. **Killed**: on the gap-free SOL/USDC
series, RSI-cross-up itself is the bottleneck (1609 reliable bars → 11
cross-ups, ~0.7%), matching JUP's 254→2 rate on an independent series, and
relative-strength discriminated correctly on both of JUP's real near-misses
(rejected the correlated one, passed the genuine dislocation). The
conjunction is rare because the base rate of the setup is rare, not because
any one filter is misconfigured.

Since one token's 179-day window is too short a base to draw an expectancy
conclusion from 1-2 events, and the 180-day free-tier ceiling blocks getting
more from *more calendar time*, the only remaining lever is pooling multiple
tokens — with an explicit risk the operator flagged in advance: correlated
tokens dipping together on one shared SOL move is one event counted several
times, not several independent ones.

**Built `npm run data:screen`** — cheap, no-backtest coverage/gap/funnel
counts per token, so a candidate can be screened before committing to a full
`data:fetch` + `backtest` run. `resolveCheapestPool` (one discovery call,
one candidate's OHLCV pagination — the highest current `reserveUsd`, no
dominance check) trades rigor for speed relative to `data:fetch`'s resolver;
`computeEntryFunnel` calls the exact same entry primitives the real engine
does, in the same order, so screen counts cannot drift from what a backtest
would find.

**Run against 6 real Solana tokens, 1h, 179 days** (JTO, PYTH, RAY, ORCA,
WIF, BONK — chosen to span categories rather than six correlated meme
coins; full reasoning and per-token tables in DECISIONS §32):

| Token | Coverage | Reliable | Cross-up | MFI-confirm | Rel-strength | Regime |
|---|---|---|---|---|---|---|
| JTO | 22.71% | 5 | 0 | 0 | 0 | 0 |
| BONK | 18.41% | 0 | 0 | 0 | 0 | 0 |
| WIF | 99.56% | 3408 | 1 | 0 | 0 | 0 |
| PYTH | 99.74% | 3694 | 4 | 4 | 2 | 1 |
| RAY | 96.63% | 1619 | 0 | 0 | 0 | 0 |
| ORCA | 85.99% | 363 | 1 | 0 | 0 | 0 |

**JTO and BONK's screen data is unusable** — the cheap resolver's "highest
current reserveUsd" heuristic picked pools two to three orders of magnitude
thinner than these tokens' real liquidity, so their reliability masks almost
never open. Read those two rows as "the cheap resolver didn't find the real
pool," not as a signal-density finding — `data:fetch`'s rigorous resolver
would need to be run before drawing any conclusion about JTO or BONK.

**Pooled across all six: 6 cross-up events total in 179 days, one full
regime-pass (PYTH).** Clustering check (the operator's explicit request):
the 6 events landed on 6 distinct UTC days — no two, even across different
tokens, shared a day, so there is no evidence of one shared SOL-wide move
being counted multiple times here. The actual concentration is different:
4 of the 6 events are PYTH alone, so the sample is dominated by one token's
history, not diversified across six. Still far too thin for an expectancy
conclusion — it answers "which candidate is worth a full run" (PYTH, so
far, on data volume alone), not "does this make money."

**Awaiting operator direction** on whether to run `data:fetch` + `backtest`
against PYTH specifically, re-screen JTO/BONK with the rigorous resolver, add
more tokens to the screen, or something else.

## CEX base-rate study — 356 pooled cross-ups, Binance bulk archives (§33–§34)

The 6-token GeckoTerminal screen above pooled only 6 cross-up events in 179
days — not a usable sample, and the 180-day free-tier ceiling means no
amount of re-fetching gets more history from that source. Operator
direction: build a Binance historical-dump provider (`data.binance.vision`
— confirmed reachable, a different domain from the region-blocked
`api.binance.com`) as a **scoped exception to DECISIONS §6**, not a
reversal — close is exact under ratio synthesis even though high/low stay
approximate bounds, and RSI (built from close alone) is the measured
bottleneck, not MFI or relative-strength (§31/§32). MFI/ATR remain
approximate on this source; every report says so.

`npm run data:cex-study` pulled SOL + JUP/JTO/PYTH/WIF/BONK/RAY/ORCA vs
USDT as far back as each is listed (608–1826 days per token), synthesized
each TOKEN/SOL ratio, and ran the same `computeEntryFunnel` as `data:
screen` — no parameter tuning, current settings only.

| Symbol | History (d) | Coverage | Gaps | Cross-up | MFI-confirm | Rel-strength | Regime |
|---|---|---|---|---|---|---|---|
| JUP | 943 | 96.75% | 0 | 50 | 36 | 7 | 1 |
| JTO | 974 | 99.32% | 0 | 63 | 45 | 24 | 11 |
| PYTH | 912 | 99.84% | 0 | 56 | 28 | 14 | 8 |
| WIF | 883 | 99.48% | 0 | 51 | 39 | 27 | 13 |
| BONK | 974 | 98.53% | 0 | 44 | 27 | 13 | 7 |
| RAY | 1826 | 99.48% | 3 | 61 | 38 | 12 | 8 |
| ORCA | 608 | 99.09% | 0 | 31 | 13 | 4 | 1 |

**CEX data is essentially gapless, confirmed** (0-3 gaps per token across
years of hourly bars). Coverage under 100% with 0 gaps is real but benign —
it means the token's actual exchange listing started partway through the
first archived calendar month (confirmed directly: JUP's real first bar is
2024-01-31, matching its public TGE date), not missing data.

**Pooled total: 356 cross-up events — clears the operator's 50-event
threshold.** Clustering, checked because the operator specifically asked
whether pooled events are independent: 356 events land on 210 distinct UTC
days (59%), and of the 10 busiest days, 9 are genuinely **cross-token**
(multiple different symbols firing the same day, not one token repeating) —
real evidence of a shared driver, most plausibly SOL-wide moves, showing up
clearly at this sample size where the 6-event screen was too small to see
it. 210 distinct days is an upper bound on the effective independent
sample, not a confirmed floor — a SOL-wide move can plausibly span more
than one calendar day, which a proper decluster step would need to handle.
Full breakdown (busiest-days list, per-token event counts) in DECISIONS §34.

**Not run: no backtest, no parameter sweep** — per operator direction, this
was a baseline read only. **Awaiting operator direction** on the
in-sample/out-of-sample sweep design against these 356 (or ~210 effective)
events.

## Declustering + CEX baseline backtest — 7 effective trades, no conclusion possible (§35–§36)

Operator direction: quantify the clustering above before trusting any
metric built on it. `decluster()`/`declusterAtWindows()`
(`src/backtest/decluster.ts`) chain-merge events within a rolling window;
tested at 1/2/3/7 days on the 356 pooled cross-ups:

| Window | Effective | 3+-token clusters |
|---|---|---|
| 1d | 160 | 13 |
| 2d | 137 | 18 |
| 3d | 123 | 21 |
| 7d | 64 | 28 |

**Chose the 2-day window (137 effective)** — matches the strategy's own
`priorOverboughtWithinCandles=50h` definition of "one cycle," and the decay
is smooth through 3 days before falling off a cliff at 7 (density-driven
chain runaway past that point, not genuine episode merging). 137, not 356,
is the number quoted from here on.

`npm run data:cex-backtest` then ran the real `runBacktest` engine (no
duplicated logic) per token against the cached CEX history, current
settings only (JUP's config as the template for every token, nothing
tuned), pooling trades and declustering their entry timestamps at the same
2-day window:

| Token | Trades | Expectancy (SOL) | Win rate | Profit factor | Costs (% gross P&L) |
|---|---|---|---|---|---|
| JUP | 0 | — | — | — | — |
| JTO | 4 | -0.0391 | 0% | 0.00 | 50.61% |
| PYTH | 2 | -0.0386 | 0% | 0.00 | 54.97% |
| WIF | 3 | -0.0588 | 0% | 0.00 | 30.37% |
| BONK | 0 | — | — | — | — |
| RAY | 1 | +0.0039 | 100% | +Inf | 77.71% |
| ORCA | 0 | — | — | — | — |
| **POOLED** | **10 raw / 7 effective** | **-0.0406** | **10%** | **0.01** | **44.04%** |

Exit breakdown, pooled: 8 time exits, 2 stop-losses, **zero rsi_recovery
exits** — no trade in this baseline ever recovered enough to trigger the
"back to 70" exit. Costs modeled as real on-chain execution (DEX fee +
priority fee + Jito tip + fallback slippage, `config/default.yaml`'s real
`costFloor`), not CEX fees; fills are from Binance prices, flagged as
optimistic vs. a real DEX fill in every line of the report.

**7 effective trades is far below the 50-trade minimum — no conclusion
about profitability is possible or claimed.** A real methodological finding
surfaced while reconciling this against §34's 49 pooled full-funnel-passes:
`computeEntryFunnel` doesn't model cost-floor or position-size at all, and
the real engine evaluates them BETWEEN relative-strength and regime, not
after — so the funnel's "N bars pass regime" was never a trade-count
estimate; it measures a different population than actual trade viability.
Traced exactly for JUP (36 mfi-confirms → 7 clear relative-strength → 3
rejected by cost-floor, unmodeled by the funnel → 4 remain → all 4 rejected
by regime → 0 trades) — full reconciliation in DECISIONS §36.

**Forward note, not yet built:** when a sweep is designed, split by
calendar time (~first 3.5 of 5 years in-sample, last ~1.5 out-of-sample),
never touching out-of-sample while tuning. Deliberately not implemented
yet — the existing `outOfSampleFraction` trade-count split was not invoked
in this baseline specifically so introducing the calendar split later
doesn't have to unwind an incompatible one first.

**Awaiting operator direction** on the sweep itself.

## What is deliberately NOT built

- **DexPaprika's pool-discovery/selection integration** — the provider client
  itself is built (`src/data/providers/dexpaprika.ts`) but is not wired into
  `fetch-data.ts`. Kept as a working alternate behind `CandleProvider` in case
  GeckoTerminal's free tier proves too tight; its own rate limit is unresolved
  and documented as such (DECISIONS §21).
- **A `(token, interval, timestamp, provider)` cache key** — the cache still
  keys on `(token, interval, timestamp)` only, so switching `--provider` for an
  already-fetched symbol without changing `--db` silently blends rows from two
  quote assets. Flagged with a runtime warning in `fetch-data.ts` and in
  DECISIONS §18 rather than fixed with a schema migration not otherwise asked
  for.
- **Tier B / memecoins** — deferred; DECISIONS §3. `TierBSafetyProvider` throws
  `NotImplementedError` and `tier: B` is rejected at config load. Two independent
  guards. Revisit only if Tier A proves out and the operator decides to pay for
  survivorship-bias-free historical data.
- **Birdeye** — skipped; free tier too thin, and unnecessary once Tier B was
  deferred.
- **Trades persisted to the `positions` table** — the backtest engine returns
  its trade list in memory and the CLI prints a report; nothing is written to
  SQLite. A backtest is a stateless one-shot replay, unlike paper/live which
  need the table's crash-recovery property. The schema is ready if repeated-
  run comparison is wanted later (DECISIONS §27).
- **`tier-gates` evaluated per bar in the backtest** — it is a watchlist gate
  (does this token qualify for its tier at all), not a per-bar signal; not
  called by the engine. The operator configuring `tier: A` already represents
  that decision (DECISIONS §27).
- **The §6.4 position-size cap, without an explicit liquidity figure** — no
  historical pool liquidity exists from the free data source (§19), so the
  cap only runs when `--pool-liquidity-sol <amount>` is passed to
  `npm run backtest`; otherwise it is explicitly marked "not evaluated" in
  the report rather than silently skipped or (per `positionSize.ts`'s real,
  correct-for-live-trading design) failing closed and zeroing every trade.
- **1m-aggregated regime resampling** — the regime filter's higher-timeframe
  SOL series is built from whatever interval `data:fetch` pulled, not a finer
  base timeframe. Not the same concern as §6's synthesis-bounds problem (SOL
  candles here are real, not synthesized), just unbuilt.
- **Dashboard** (SPEC §14) — not started. Comes after phase 1 is reviewed.
- **Execution layer** (phase 3) — not started, and must not be until phases 1 and
  2 are reviewed and explicitly approved.

## What step 6 delivered against the SPEC §10 requirements

All built and tested (`src/backtest/engine.ts`, `src/backtest/metrics.ts`);
none yet exercised against a real trade, since the first real run produced
zero (see above):

- Fills at the **next candle's open**, never the signal candle's close.
- **Stop fills use the intrabar rule** already implemented in `src/rules/exit.ts`,
  unchanged and re-used — no second implementation to drift from it.
- **Maximum Favorable Excursion, per trade** — the real intrabar peak reached
  while held, tracked via the same `evaluateExit`/`evaluateIntrabarStops`
  peak-tracking the live rules already use. Once real trades exist, the
  median MFE per token replaces the ATR bootstrap (DECISIONS §4).
- **Out-of-sample split**, reported separately from in-sample, split
  chronologically (never re-sorted).
- **Minimum trade count** (`global.minTradesForConclusion`, default 50) —
  flagged prominently below it.
- **Expectancy per trade** is the headline metric in the report, not win rate.
- **Exit trigger breakdown** — count and average net P&L per exit reason.
- **Rejection counts per check**, including — specifically requested —
  indicator-unreliable blocks split by `gap-in-series` vs `insufficient-warmup`.
- Total costs as a percentage of total absolute gross P&L.
- Document how the test universe was assembled (survivorship bias) — still
  outstanding; only relevant once Tier B (memecoins) is in scope, which it
  is not (DECISIONS §3).

## Working agreement

- Commit and push after **every completed step**, not at the end of a batch. The
  build container is ephemeral; unpushed work does not exist.
- Push **before** answering any operator question.
- If mid-step and the operator goes quiet, commit work-in-progress to a branch.
- Update this file as the **last action of every step**.
- After a push that adds files, run **both** checks — they catch different things,
  and a successful `git push` proves a commit was transferred, not that it
  contained what you think it did (DECISIONS §15):
  1. **Clean clone.** Clone the branch into an empty directory and run the
     documented setup end to end. Catches anything whose absence breaks a build
     or an import.
  2. **Tree-versus-index diff.** Catches what a clean clone cannot: a doc, a
     config example, or a module nothing imports yet.
     ```bash
     find . -type f -not -path './.git/*' -not -path './node_modules/*' \
       | sed 's|^\./||' | sort > /tmp/tree.txt
     git ls-files | sort > /tmp/index.txt
     comm -23 /tmp/tree.txt /tmp/index.txt   # on disk, not tracked
     comm -13 /tmp/tree.txt /tmp/index.txt   # tracked, missing from disk
     ```
     Every difference must be *intentionally* ignored. Expected after a local
     `data:fetch` run: `.env` and the generated `data/` contents (the SQLite
     cache and `raw-sample.json`), nothing else. In a fresh clone that has not
     been run, only `.env` — and only once setup has created it.
  `test/repo-hygiene.test.ts` automates most of this and runs with the suite.
- Never present backtest results without trade count, the out-of-sample split,
  and total costs paid. Report numbers and limitations; let the operator draw the
  conclusion.

## Test count convention

Counts are **test cases**, as reported by vitest — never assertions. 260
cases across 10 files: `data` 80, `backtest` 36, `rules` 45, `filters` 29,
`config` 17, `indicators` 23, `repo-hygiene` 10, `amount` 8, `logger` 8, `db`
4. `data` grew to 80 with the schema-v2 pool-coexistence tests (§29–§30);
`backtest` grew to 36 with the entry-funnel tests (§32); `indicators` and
`config` grew with the warm-up-multiplier and pool-pinning schema changes
(§28–§30).
