# Status — handoff document

**This file is the definitive handoff.** If you are a fresh session with no
conversation history, this tells you where the project stands and what happens
next. Read `docs/DECISIONS.md` for *why* things are the way they are, and
`docs/SPEC.md` for the original requirements.

**Last updated:** end of phase 1 step 2, plus the documentation and durability
pass, plus the GeckoTerminal provider switch (DECISIONS §18–§23: Binance is
regionally blocked for this project's operator, GeckoTerminal is now the
default data provider, and this file's data-review checklist below changed
accordingly). Verified against `main` by clean clone and tree-versus-index
diff.

**Branch:** `main` is the working branch and the repository default. Clone it and
you have everything.

---

## THE NEXT ACTION IS NOT THE ASSISTANT'S

**Step 6 (the backtest engine) is blocked**, and not on anything the assistant
can do. The operator must run the data layer against real candles on their own
machine and report back.

**This is blocked on machine access, not on work.** The operator is on a browser
without access to their PC, and this may be days away. That is expected. **Do not
start step 6. Do not build speculatively while waiting.** Resuming from a clean,
documented state is preferable to finding unevaluable work.

### Commands the operator runs (locally)

```bash
git clone https://github.com/mpproject90/calude2
cd calude2
npm install
npm test                  # see the test-count table at the bottom of this file, all passing

npm run data:fetch -- --symbol JUP --interval 1h --days 90
npm run data:fetch -- --symbol JTO --interval 4h --days 365 --db data/candles.db
```

Default provider is **GeckoTerminal** (`api.geckoterminal.com`, free, no key —
DECISIONS §18), chosen because Binance is regionally blocked for this
project's operator. Needs JUP's mint address to find its pools — already
resolvable from `config/default.yaml`'s `tokens[]`, or pass `--address <mint>`
for a token not yet configured. `--provider binance` remains available for
anyone who can reach `api.binance.com`, using the original synthesis path
(DECISIONS §6, §14). **Neither will run in a sandboxed cloud environment that
blocks its host** — that is expected, not a bug.

### What to report back — GeckoTerminal path (default)

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

**Phase 1, steps 1–5 of 10.** See the test-count table at the bottom of this
file for the current suite size. **Typecheck clean** under `strict`,
`noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.

```
✓ 1. Scaffold, config schema + validation, SQLite, .gitignore with .env
✓ 2. Data layer — GeckoTerminal (default) + Binance (alternate) providers,
     pool selection, caching, gap detection, wick/ATR diagnostics
✓ 3. Indicator engine with warm-up gating and reference-value tests
✓ 4. Filter stack, each filter independently tested
✓ 5. Rules engine (entry/exit) against synthetic candle series
□ 6. Backtest engine with realistic cost modelling      ← BLOCKED, see above
□ 7. STOP — report results, await operator review
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
| CLI | `src/cli/` | `config:check`, `data:fetch` (`--provider geckoterminal\|binance`) |
| Hygiene | `test/repo-hygiene.test.ts` | asserts nothing under `src/`/`test/` is gitignored |

**Nothing here can place a trade.** There is no execution layer and no code path
submits a transaction.

## What is UNVERIFIED

**Neither the GeckoTerminal provider (default) nor the Binance provider
(alternate) has ever made a real request.** Both hosts are egress-blocked in
the build container this was written in, so every provider test runs against
an injected mock. For GeckoTerminal: pagination, pool search/selection, the
rate throttle and JSON:API parsing are verified against a *documented model* of
the response shape, not the API itself (DECISIONS §18). For Binance:
pagination, the weight budget, 429/418 backoff and row parsing, same status as
before. **The operator's local fetch is what verifies both**, whichever
`--provider` is used.

The failure path is known-good for both, and now carries more than a bare
message: a blocked host, a bad HTTP status, or a raw network/TLS failure all
throw with the request URL and the full error `cause` chain attached
(DECISIONS §22) — `fetch-data.ts`'s top-level handler prints all of it via
`formatErrorChain`, not just `err.message`.

**No backtest has ever run, so no strategy result of any kind exists. No claim
about profitability has been made and none should be inferred.**

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
- **Dashboard** (SPEC §14) — not started. Comes after a backtest exists.
- **Execution layer** (phase 3) — not started, and must not be until phases 1 and
  2 are reviewed and explicitly approved.

## Requirements carried into step 6

From SPEC §10 and decisions made since:

- Fills at the **next candle's open**, never the signal candle's close.
  Look-ahead bias is the most common way backtests lie.
- **Stop fills use the intrabar rule** already implemented in `src/rules/exit.ts`.
  The backtest must not reintroduce close-only stops.
- **Maximum Favorable Excursion distribution per signal.** Required output: the
  median MFE per token becomes the empirical expected move, replacing the ATR
  bootstrap (DECISIONS §4). It also shows whether the 15% stop and the RSI-70
  exit are sized sanely against how far moves actually run.
- **Out-of-sample split**, reported separately from in-sample. If out-of-sample
  collapses, say so plainly.
- **Minimum 50 trades** before results are conclusive; warn prominently below it.
- **Expectancy per trade** is the headline metric, not win rate.
- **Exit trigger breakdown** — count and average P&L per exit reason, so the
  RSI-70 exit's value can be judged.
- **Rejection counts per filter**, so it is visible which filters do work.
- Total fees and slippage as a percentage of gross P&L.
- Document how the test universe was assembled (survivorship bias).

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

Counts are **test cases**, as reported by vitest — never assertions. 183 cases
across 9 files: `data` 45, `rules` 45, `filters` 29, `indicators` 21, `config`
14, `repo-hygiene` 9, `amount` 8, `logger` 8, `db` 4.
