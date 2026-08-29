# Working on this repository

A Solana trading bot. **Phase 1's RSI/MFI mean-reversion ENTRY hypothesis was
tested exhaustively and REJECTED** (DECISIONS §27–§38, summarized prominently
near the top of both DECISIONS.md and STATUS.md — read that first, not this
paragraph). The project is now pivoting to **manual entry, automated exit**:
the operator picks the token and a limit price; the bot fills it and manages
the exit (take-profit ladder, trailing stop, hard stop, time exit) with no
indicator-driven entry logic. The indicator/filter/funnel/backtest code from
phase 1 is preserved, not deleted — it produced a real, trustworthy negative
result and may be reused for a different hypothesis later. **Read these
before doing anything else:**

1. **`docs/STATUS.md`** — what is built, what is outstanding, what is unverified,
   and what the next action is. Start here.
2. **`docs/DECISIONS.md`** — every design decision and its reasoning. Read before
   changing anything; it explains why the code looks the way it does.
3. **`docs/SPEC.md`** — the original requirements. Where the code diverges,
   DECISIONS is authoritative and records why.

## STOP — phase 2 pivot scope is pending operator confirmation

Phase 1 is concluded: the RSI/MFI entry hypothesis is rejected on real data
(DECISIONS §27–§38). The operator has stated the phase 2 direction (manual
limit-price entry, automated multi-tranche exit) but the detailed scope was
reported back for confirmation before implementation started. **If the
scope has not been explicitly confirmed in the current conversation, do not
start building the pivot** — report the proposed scope and wait, the same
discipline this project has used at every phase gate so far.

Once confirmed: don't rebuild or re-litigate the RSI/MFI mean-reversion
entry hypothesis — it was tested thoroughly and rejected, not abandoned
half-finished. Reuse the preserved indicator/filter/backtest code only if a
genuinely new hypothesis calls for it, and say so explicitly in DECISIONS if
it happens.

## Hard rules

- **Nothing here may place a trade.** There is no execution layer. Do not build
  one — phase 3 requires explicit operator approval after phases 1 and 2 are
  reviewed.
- **Never present the strategy as profitable.** Report numbers and their
  limitations; let the operator conclude. If out-of-sample results are poor, say
  so plainly. A clear negative answer is a successful outcome for this project.
- **Never report backtest results** without trade count, the out-of-sample split,
  and total costs paid.
- **One strategy implementation.** Backtest, paper and live share the same
  indicator, filter and rules code. If they could disagree, the backtest is
  worthless.
- **Do not change the RSI tests to match a figure found online.** The published
  70.53 reference value is wrong; 16700/237 = 70.4641350211 is correct and was
  verified with exact rational arithmetic. See DECISIONS §9.
- **Fail closed.** Missing data, unreliable indicators, unknown liquidity — all
  block trading rather than proceeding on assumption.
- **No floats for on-chain amounts.** Use `TokenAmount` (bigint + decimals).
- **Secrets live in `.env` only.** Never logged, never committed.

## Before you push

The build container is ephemeral and unpushed work does not exist. Commit and
push after every completed step, and push before answering a question.

After a push that adds files, run **both**:

1. **Clean clone** — clone the branch into an empty directory and run the
   documented setup end to end.
2. **Tree-versus-index diff** — see `docs/STATUS.md`. A successful `git push`
   proves a commit was transferred, not that it contained what you think it did.

This is not hypothetical: a `.gitignore` pattern silently excluded the entire
data layer from three consecutive pushes (DECISIONS §15).
`test/repo-hygiene.test.ts` automates most of this and runs with the suite.

## Commands

```bash
npm install
npm test                  # see docs/STATUS.md for the current test count
npm run typecheck
npm run config:check -- config/default.yaml
npm run data:fetch -- --symbol JUP --interval 1h --days 90
npm run data:fetch -- --symbol JUP --provider binance      # alternate, DECISIONS §18
npm run backtest -- --symbol JUP                            # needs data:fetch's cache first
```

`data:fetch` defaults to GeckoTerminal (`api.geckoterminal.com`, free, no key)
since Binance is regionally blocked for this project's operator — see
DECISIONS §18. `--provider binance` needs outbound access to `api.binance.com`
instead. Neither will run in a sandboxed environment that blocks its host —
that is expected, not a bug.

Node is pinned to **22.x** in `package.json`'s `engines` — `better-sqlite3` has
no Node 24 prebuild and needs a C++ toolchain to build from source there.

Anything under `data/` — the SQLite cache and `raw-sample.json` — is generated at
runtime and gitignored. It is never in the repository; its absence in a fresh
clone is correct, not a missing file.

## Branch

`main` is the working branch and the repository default.
