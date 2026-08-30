-- Schema v3. Everything persists: a restart must not lose open position state
-- (spec §3). On-chain amounts are stored as TEXT holding the raw integer
-- (smallest-unit) value — never as REAL — per spec §2.5.
--
-- v1 -> v2 (DECISIONS §29): pool_address added to candles/candle_fetch_log/
-- candle_gaps/rejected_candles. v1 keyed candles on (token, interval,
-- timestamp) alone, which cannot represent two different on-chain pools for
-- the same token/interval — GeckoTerminal pool selection is NOT stable
-- run-to-run (rate-limit-driven candidate exclusion can hand a re-fetch a
-- different pool than last time), and v1's upsert would silently overwrite
-- one pool's validated candles with another's for every overlapping
-- timestamp. Confirmed happening in normal use, not as a theoretical edge
-- case. '' (empty string) means "not a pool-based series" — Binance symbols
-- have no pool address.
--
-- v2 -> v3 (DECISIONS §41): paper_positions/paper_fills/paper_events added
-- for phase 2 paper trading — see the block near the bottom of this file.
-- New tables, not a migration of the existing `positions` table, which was
-- shaped for the phase-1 indicator-driven, single-fill, candle-indexed
-- position model and does not fit the new price-triggered, multi-tranche,
-- wall-clock one.
--
-- v3 -> v4 (DECISIONS §41): paper_feed_stats added — cumulative
-- usable-vs-blind price-feed tallies and the longest blind streak, per
-- symbol, persisted so a Task Scheduler restart doesn't reset the count.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- candles --
-- Keyed by (token, interval, pool_address, timestamp) so two different pools'
-- candles for the same token/interval coexist, visibly distinct, rather than
-- one silently overwriting the other (spec §4, DECISIONS §29).
CREATE TABLE IF NOT EXISTS candles (
  token        TEXT    NOT NULL,
  interval     TEXT    NOT NULL,
  pool_address TEXT    NOT NULL DEFAULT '',  -- '' = not pool-based (e.g. Binance)
  timestamp    INTEGER NOT NULL,          -- bar OPEN time, epoch ms, UTC-aligned
  open         REAL    NOT NULL,
  high         REAL    NOT NULL,
  low          REAL    NOT NULL,
  close        REAL    NOT NULL,
  volume       REAL    NOT NULL,
  provider     TEXT    NOT NULL,
  fetched_at   INTEGER NOT NULL,
  PRIMARY KEY (token, interval, pool_address, timestamp)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles (token, interval, pool_address, timestamp);

-- Ranges we have actually queried, so an empty result is distinguishable from
-- "never fetched". Birdeye omits empty candles entirely, so absence of a row
-- is NOT evidence of absence of data (spec §4).
CREATE TABLE IF NOT EXISTS candle_fetch_log (
  token        TEXT    NOT NULL,
  interval     TEXT    NOT NULL,
  pool_address TEXT    NOT NULL DEFAULT '',
  from_ts      INTEGER NOT NULL,
  to_ts        INTEGER NOT NULL,
  provider     TEXT    NOT NULL,
  fetched_at   INTEGER NOT NULL,
  row_count    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candle_gaps (
  token           TEXT    NOT NULL,
  interval        TEXT    NOT NULL,
  pool_address    TEXT    NOT NULL DEFAULT '',
  after_ts        INTEGER NOT NULL,
  before_ts       INTEGER NOT NULL,
  missing_bars    INTEGER NOT NULL,
  detected_at     INTEGER NOT NULL,
  PRIMARY KEY (token, interval, pool_address, after_ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rejected_candles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT    NOT NULL,
  interval     TEXT    NOT NULL,
  pool_address TEXT    NOT NULL DEFAULT '',
  timestamp    INTEGER NOT NULL,
  reason       TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  rejected_at  INTEGER NOT NULL
);

-- -------------------------------------------------------------- positions --
CREATE TABLE IF NOT EXISTS positions (
  id                 TEXT    PRIMARY KEY,
  mode               TEXT    NOT NULL CHECK (mode IN ('backtest','paper','live')),
  token              TEXT    NOT NULL,
  symbol             TEXT    NOT NULL,
  tier               TEXT    NOT NULL CHECK (tier IN ('A','B')),
  status             TEXT    NOT NULL CHECK (status IN ('open','closed')),
  opened_at          INTEGER NOT NULL,
  opened_candle_ts   INTEGER NOT NULL,
  entry_price        REAL    NOT NULL,
  size_raw           TEXT    NOT NULL,   -- token base units, integer as text
  size_decimals      INTEGER NOT NULL,
  cost_sol_raw       TEXT    NOT NULL,   -- lamports, integer as text
  -- exit path, written at fill time (spec §1: no position without an exit path)
  stop_loss_price    REAL    NOT NULL,
  time_exit_candle_ts INTEGER NOT NULL,
  trailing_armed     INTEGER NOT NULL DEFAULT 0,
  trailing_peak      REAL,
  closed_at          INTEGER,
  closed_candle_ts   INTEGER,
  exit_price         REAL,
  exit_reason        TEXT CHECK (exit_reason IN
                       ('stop_loss','time','rsi_recovery','trailing','safety','manual')),
  realized_pnl_sol_raw TEXT,
  fees_sol_raw       TEXT,
  entry_context      TEXT NOT NULL      -- JSON: indicator + filter values at entry
);

CREATE INDEX IF NOT EXISTS idx_positions_open ON positions (mode, status);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions (token, closed_at);

-- ---------------------------------------------------------------- signals --
-- Every blocked signal with its reason. These logs show what the limits are
-- actually costing or saving (spec §8).
CREATE TABLE IF NOT EXISTS rejected_signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mode        TEXT    NOT NULL,
  token       TEXT    NOT NULL,
  candle_ts   INTEGER NOT NULL,
  filter      TEXT    NOT NULL,          -- which gate rejected it
  reason      TEXT    NOT NULL,
  context     TEXT    NOT NULL,          -- JSON: the computed numbers
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejected_filter ON rejected_signals (mode, filter);

CREATE TABLE IF NOT EXISTS regime_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mode       TEXT    NOT NULL,
  candle_ts  INTEGER NOT NULL,
  enabled    INTEGER NOT NULL,
  reason     TEXT    NOT NULL,
  context    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- Tier B watchlist state — a hard safety failure removes a token from active
-- rotation (spec §6.1) and that must survive a restart.
CREATE TABLE IF NOT EXISTS token_state (
  token             TEXT PRIMARY KEY,
  active            INTEGER NOT NULL DEFAULT 1,
  deactivated_at    INTEGER,
  deactivated_reason TEXT,
  cooldown_until_ts INTEGER,
  last_safety_check INTEGER
) WITHOUT ROWID;

-- ============================================================ v3 (§41) ===
-- Phase 2 paper trading — manual entry, price-triggered, multi-tranche
-- ladder exit. NOT the same shape as the phase-1 `positions` table above
-- (candle-indexed, single-fill, tier-gated CHECK constraints, no
-- 'take_profit' exit reason) — forcing the new ladder position through
-- that table would mean weakening constraints that exist for good reason
-- in the old model, for a position shape (wall-clock time, partial
-- multi-tranche fills, no tier) that genuinely differs. New tables, not a
-- migration of the old one; `positions` stays exactly as phase 1 left it.

-- One row per manually-entered position, mutable — this IS the resumable
-- state a restart reloads from. `status='open'` is unique per symbol: at
-- most one open position per configured token at a time.
CREATE TABLE IF NOT EXISTS paper_positions (
  id                    TEXT    PRIMARY KEY,
  symbol                TEXT    NOT NULL,
  address               TEXT    NOT NULL,
  pool_address          TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('open', 'closed')),
  entry_price           REAL    NOT NULL,
  entry_timestamp       INTEGER NOT NULL,
  original_size_raw     TEXT    NOT NULL,
  remaining_size_raw    TEXT    NOT NULL,
  size_decimals         INTEGER NOT NULL,
  filled_tranche_count  INTEGER NOT NULL DEFAULT 0,
  peak_price            REAL    NOT NULL,
  trailing_armed        INTEGER NOT NULL DEFAULT 0,
  stop_loss_price       REAL    NOT NULL,
  closed_at             INTEGER,
  ladder_config         TEXT    NOT NULL,   -- JSON: the ladder this position is running under
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_positions_open_symbol
  ON paper_positions (symbol) WHERE status = 'open';

-- Immutable record of every simulated fill — the entry AND every exit
-- trigger (take-profit tranche, trailing, stop-loss, time). "This is the
-- record I'll be reading": trigger reason, price, size, modelled cost, and
-- a full snapshot of position state immediately after this fill.
CREATE TABLE IF NOT EXISTS paper_fills (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id       TEXT    NOT NULL REFERENCES paper_positions(id),
  kind              TEXT    NOT NULL CHECK (kind IN ('entry', 'take_profit', 'trailing', 'stop_loss', 'time')),
  tranche_index     INTEGER,
  trigger_price     REAL    NOT NULL,
  fill_price        REAL    NOT NULL,
  size_raw          TEXT    NOT NULL,
  size_decimals     INTEGER NOT NULL,
  gross_pnl_sol_raw TEXT,
  dex_fee_sol_raw   TEXT    NOT NULL,
  fixed_fee_sol_raw TEXT    NOT NULL,
  net_pnl_sol_raw   TEXT,
  position_snapshot TEXT    NOT NULL,   -- JSON, paper_positions-shaped, state AFTER this fill
  filled_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_fills_position ON paper_fills (position_id, filled_at);

-- Operational events that are not fills: stale feed, feed error, malformed
-- response, restart/resume. The audit trail for "did a simulated failure
-- corrupt anything" — read this table, not just scrollback.
CREATE TABLE IF NOT EXISTS paper_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT,
  kind        TEXT    NOT NULL CHECK (kind IN ('stale_feed', 'feed_error', 'restart', 'resume', 'entry_skipped')),
  detail      TEXT    NOT NULL,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_events_kind ON paper_events (kind, occurred_at);

-- ============================================================ v4 (§41) ===
-- Cumulative price-feed reliability counters, one row per symbol.
-- Deliberately NOT derived from paper_events at read time: a "usable,
-- nothing happened" tick has no other row anywhere (only fills and
-- stale/error events are otherwise recorded), so there is no query over
-- existing tables that reconstructs "ticks with a usable price" at all,
-- and a query that DID replay every event row to compute a running
-- longest-blind-streak over a week of 30s polling would grow slower every
-- day it ran. A single upserted row is O(1) per tick, forever.
--
-- Persisted (not in-memory) specifically so a Task Scheduler restart after
-- a crash does not reset the count back to zero — the whole point of
-- tracking this over a week is a number the operator can trust survives
-- exactly the kind of interruption the scheduled task exists to recover
-- from. `blind_streak_started_at` also lets a gap in wall-clock time
-- itself (the task was down between the crash and the restart) count
-- toward the blind streak, not just in-process feed errors — a real stop
-- is exactly as blind during downtime as during a feed error.
CREATE TABLE IF NOT EXISTS paper_feed_stats (
  symbol                        TEXT    PRIMARY KEY,
  usable_count                  INTEGER NOT NULL DEFAULT 0,
  stale_count                   INTEGER NOT NULL DEFAULT 0,
  error_count                   INTEGER NOT NULL DEFAULT 0,
  blind_streak_started_at       INTEGER,   -- NULL when not currently in a blind streak
  longest_blind_streak_ms       INTEGER NOT NULL DEFAULT 0,
  longest_blind_streak_ended_at INTEGER,
  last_tick_at                  INTEGER,
  updated_at                    INTEGER NOT NULL
) WITHOUT ROWID;
