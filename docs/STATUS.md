# Status — handoff document

**This file is the definitive handoff.** If you are a fresh session with no
conversation history, this tells you where the project stands and what happens
next. Read `docs/DECISIONS.md` for *why* things are the way they are, and
`docs/SPEC.md` for the original requirements.

**Last updated:** end of phase 1 step 2, plus the documentation and durability
pass. Verified against `main` by clean clone and tree-versus-index diff.

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
npm test                  # expect 183 cases across 9 files, all passing

npm run data:fetch -- --symbol JUP --interval 1h --days 90
npm run data:fetch -- --symbol JTO --interval 4h --days 365 --db data/candles.db
```

Needs outbound access to `api.binance.com`. No API key. **It will not run in a
sandboxed cloud environment that blocks that host** — that is expected, not a
bug.

### The four numbers to report back

| # | Number | Expected | If not |
|---|---|---|---|
| 1 | **Bar coverage %** (per series) | near 100% | Binance history is thinner than assumed for that pair |
| 2 | **Gap count** | near zero for a CEX | the interval-alignment assumption is wrong |
| 3 | **Rejected candles** | zero | real data violates an invariant asserted in `src/data/validate.ts` |
| 4 | **Range widening** | as low as possible | see the decision rule below |

Also send `data/raw-sample.json` if anything looks wrong. It contains the
verbatim first Binance response rows plus this build's parse of row 0, so a shape
mismatch can be diagnosed from actual data rather than a description of it. It is
gitignored, so it stays local until sent.

### Decision rule for range widening

Range widening measures how much wider the synthesized `<SYMBOL>/SOL` high/low is
than `|close − open|`. The synthesized high and low are mathematical **bounds**,
not observations (DECISIONS §6), which biases ATR high and distorts MFI's typical
price.

**If the number is ugly: build the 1m-aggregated synthesis path BEFORE touching
MFI's role.** A 1h ratio built from 1m bars is far more faithful than one built
from 1h bars, because the extremes have less time to diverge. Exhaust the
data-quality fix before changing the strategy's shape. Only if the 1m path still
leaves material distortion should MFI's role be reconsidered.

---

## What is built

**Phase 1, steps 1–5 of 10.** **183 test cases across 9 files. Typecheck clean**
under `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`.

```
✓ 1. Scaffold, config schema + validation, SQLite, .gitignore with .env
✓ 2. Data layer — Binance provider, caching, gap detection, JUP/SOL synthesis
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

| Area | Module | What it does |
|---|---|---|
| Config | `src/config/` | zod schema, all-problems-at-once errors, live-trading gate |
| Persistence | `src/db/` | candle cache, positions, rejected signals, regime events, token state |
| Data | `src/data/` | Binance provider, repository + fetch log, validation, gap detection, ratio synthesis |
| Indicators | `src/indicators/` | RSI, MFI, ATR; warm-up gating; `{value, reliable, reason}` |
| Filters | `src/filters/` | relative strength, cost floor, position sizing, regime, tier gates |
| Rules | `src/rules/` | entry conditions, intrabar exits, portfolio limits |
| CLI | `src/cli/` | `config:check`, `data:fetch` |
| Hygiene | `test/repo-hygiene.test.ts` | asserts nothing under `src/`/`test/` is gitignored |

**Nothing here can place a trade.** There is no execution layer and no code path
submits a transaction.

## What is UNVERIFIED

**The Binance provider has never made a real request.** `api.binance.com` is
egress-blocked in the build container, so every provider test runs against an
injected mock. Pagination, the weight budget, 429/418 backoff and row parsing are
verified against a *model* of the API, not the API itself. **The operator's local
fetch is what verifies this.**

The failure path is known-good: a blocked host aborts loudly
(`Binance returned 403 ... Host not in allowlist`) with no silent fallback.

**No backtest has ever run, so no strategy result of any kind exists. No claim
about profitability has been made and none should be inferred.**

## What is deliberately NOT built

- **Tier B / memecoins** — deferred; DECISIONS §3. `TierBSafetyProvider` throws
  `NotImplementedError` and `tier: B` is rejected at config load. Two independent
  guards. Revisit only if Tier A proves out and the operator decides to pay for
  survivorship-bias-free historical data.
- **GeckoTerminal provider** — the `CandleProvider` interface is ready; Binance is
  the primary path.
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
     Every difference must be *intentionally* ignored. Currently expected:
     `.env` and `data/raw-sample.json`, nothing else.
  `test/repo-hygiene.test.ts` automates most of this and runs with the suite.
- Never present backtest results without trade count, the out-of-sample split,
  and total costs paid. Report numbers and limitations; let the operator draw the
  conclusion.

## Test count convention

Counts are **test cases**, as reported by vitest — never assertions. 183 cases
across 9 files: `data` 45, `rules` 45, `filters` 29, `indicators` 21, `config`
14, `repo-hygiene` 9, `amount` 8, `logger` 8, `db` 4.
