# Status

Updated as the last action of every completed step. Read `docs/DECISIONS.md`
first for *why*; this file is *what*.

**Last updated:** phase 1, end of step 2 (data layer + intrabar stops), plus
docs, the `.gitignore` fixes, the repo-hygiene test, and the merge to `main`.
Verified by clean clone and tree-versus-index diff: 183 cases pass from a fresh
checkout.

**`main` is the working branch.** Clone it and you have everything.

---

## Where we are

**Phase 1, steps 1–5 of 10 complete.** Nothing here can place a trade: there is
no execution layer, and no code path submits a transaction.

```
✓ 1. Scaffold, config schema + validation, SQLite, .gitignore with .env
✓ 2. Data layer — Binance provider, caching, gap detection, JUP/SOL synthesis
✓ 3. Indicator engine with warm-up gating and reference-value tests
✓ 4. Filter stack, each filter independently tested
✓ 5. Rules engine (entry/exit) against synthetic candle series
□ 6. Backtest engine with realistic cost modelling      ← NEXT, but see BLOCKED
□ 7. STOP — report results, await operator review
□ 8. Paper trading mode
□ 9. STOP — run for weeks, await operator review
□ 10. Live execution layer, on explicit approval only
```

Steps 3–5 were built before step 2 — the operator's instruction skipped it by
mistake, and it was filled in afterwards. Nothing depends on the order, because
everything above the data layer operates on `Candle[]`.

**183 test cases across 9 files. Typecheck clean** (`strict`, `noImplicitAny`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).

## BLOCKED: step 6 waits on a real-data review

Step 6 must not start until the operator has run the data layer against real
candles locally and reported back. What to run and what to look for is in the
README under "Reviewing the data layer against real candles".

Four numbers decide whether step 6 can proceed as designed:

| Signal | Expected | If not |
|---|---|---|
| Bar coverage | near 100% | Binance history is thinner than assumed for that pair |
| Gap count | near zero for a CEX | the interval-alignment assumption is wrong |
| Rejected candles | zero | real data violates an invariant asserted in `validate.ts` |
| **Range widening** | as low as possible | **build the 1m-aggregated synthesis path before concluding anything about MFI** |

## UNVERIFIED — read before trusting the data layer

**The Binance provider has never made a real request.** `api.binance.com` is
egress-blocked in the build container, so every provider test runs against an
injected mock. Pagination, the weight budget, 429/418 backoff and row parsing are
verified against a *model* of the API, not the API itself.

The failure path is known-good: a blocked host aborts loudly
(`Binance returned 403 ... Host not in allowlist`) with no silent fallback.

`npm run data:fetch` writes `data/raw-sample.json` — the verbatim first response
rows plus this build's parse of row 0. If anything looks wrong, that file is the
ground truth to send back.

Also unverified: no backtest has run, so no strategy result of any kind exists.
**No claim about profitability has been made or should be inferred.**

## Built and tested

| Area | Module | Notes |
|---|---|---|
| Config | `src/config/` | zod schema, all-problems-at-once errors, live-trading gate |
| Persistence | `src/db/` | candle cache, positions, rejected signals, regime events, token state |
| Data | `src/data/` | Binance provider, repository + fetch log, validation, gap detection, ratio synthesis |
| Indicators | `src/indicators/` | RSI, MFI, ATR; warm-up gating; `{value, reliable, reason}` |
| Filters | `src/filters/` | relative strength, cost floor, position sizing, regime, tier gates |
| Rules | `src/rules/` | entry conditions, intrabar exits, portfolio limits |
| CLI | `src/cli/` | `config:check`, `data:fetch` |

## Deliberately not built

- **Tier B / memecoins** — deferred; see DECISIONS §3. `TierBSafetyProvider`
  throws `NotImplementedError`; `tier: B` is rejected at config load.
- **GeckoTerminal provider** — the `CandleProvider` interface is ready for it;
  Binance is the primary path.
- **Birdeye** — skipped entirely; free tier too thin, and unnecessary once Tier B
  was deferred.
- **Dashboard** (spec §14) — not started. Comes after a backtest exists.
- **Execution layer** (phase 3) — not started, and must not be until phases 1
  and 2 are reviewed.

## Outstanding requirements for step 6

Carried forward from the spec and from decisions made since:

- Fills at the **next candle's open**, never the signal candle's close.
  Look-ahead bias is the most common way backtests lie.
- **Stop fills use the intrabar rule** already implemented in `rules/exit.ts` —
  the backtest must not reintroduce close-only stops.
- **Maximum Favorable Excursion distribution per signal.** Required output: the
  median MFE per token becomes the empirical expected move, replacing the ATR
  bootstrap (DECISIONS §4).
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

- Commit and push after **every completed step**, not at the end of a batch.
  The build container is ephemeral; unpushed work does not exist.
- Push **before** answering any operator question.
- If mid-step and the operator goes quiet, commit work-in-progress to a branch.
- Update this file as the **last action of every step**.
- After a push that adds files, run **both** checks — they catch different
  things, and a successful `git push` proves a commit was transferred, not that
  it contained what you think it did (DECISIONS §15):
  1. **Clean clone.** Clone the branch into an empty directory and run the
     documented setup end to end. Catches anything whose absence breaks a build
     or an import.
  2. **Tree-versus-index diff.** Compare every file on disk against
     `git ls-files`, and confirm each difference is *intentionally* ignored.
     Catches what a clean clone cannot: a doc, a config example, or a module
     nothing imports yet.
     ```bash
     find . -type f -not -path './.git/*' -not -path './node_modules/*' \
       | sed 's|^\./||' | sort > /tmp/tree.txt
     git ls-files | sort > /tmp/index.txt
     comm -23 /tmp/tree.txt /tmp/index.txt   # on disk, not tracked
     comm -13 /tmp/tree.txt /tmp/index.txt   # tracked, missing from disk
     ```
  `test/repo-hygiene.test.ts` automates most of this and runs with the suite.
- Never present backtest results without trade count, the out-of-sample split,
  and total costs paid. Report numbers and limitations; let the operator draw
  the conclusion.
