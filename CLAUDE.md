# Working on this repository

A Solana RSI/MFI mean-reversion trading bot. **Read these before doing anything
else:**

1. **`docs/STATUS.md`** — what is built, what is outstanding, what is unverified,
   and what the next action is. Start here.
2. **`docs/DECISIONS.md`** — every design decision and its reasoning. Read before
   changing anything; it explains why the code looks the way it does.
3. **`docs/SPEC.md`** — the original requirements. Where the code diverges,
   DECISIONS is authoritative and records why.

## STOP — do not start step 6

The next action is **not yours**. The operator must run the data layer against
real candles on their own machine and report four numbers back. Step 6 (the
backtest engine) is blocked until then. `docs/STATUS.md` has the commands and
the decision rule.

Do not build speculatively while waiting. If asked to continue and the data
review has not happened, say so rather than proceeding.

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
npm test                  # 183 test cases across 9 files
npm run typecheck
npm run config:check -- config/default.yaml
npm run data:fetch -- --symbol JUP --interval 1h --days 90
```

`data:fetch` needs outbound access to `api.binance.com`. It will not run in a
sandboxed environment that blocks that host — that is expected, not a bug.

Anything under `data/` — the SQLite cache and `raw-sample.json` — is generated at
runtime and gitignored. It is never in the repository; its absence in a fresh
clone is correct, not a missing file.

## Branch

`main` is the working branch and the repository default.
