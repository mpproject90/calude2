-- Schema v2. Everything persists: a restart must not lose open position state
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
