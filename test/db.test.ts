import { describe, it, expect } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../src/db/index.js';

describe('database', () => {
  it('creates the schema and stamps a version', () => {
    const db = openDb(':memory:');
    const v = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(v?.value).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('creates every table the bot depends on', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of [
      'candles', 'candle_fetch_log', 'candle_gaps', 'rejected_candles',
      'positions', 'rejected_signals', 'regime_events', 'token_state',
    ]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it('makes the candle cache idempotent on (token, interval, timestamp)', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT OR REPLACE INTO candles
       (token, interval, timestamp, open, high, low, close, volume, provider, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('JUP', '1h', 1_700_000_000_000, 1, 2, 0.5, 1.5, 100, 'test', 0);
    ins.run('JUP', '1h', 1_700_000_000_000, 1, 2, 0.5, 1.5, 100, 'test', 1);
    const n = db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM candles')
      .get();
    expect(n?.c).toBe(1);
    db.close();
  });

  it('constrains exit_reason to the documented set', () => {
    const db = openDb(':memory:');
    const insert = (reason: string) =>
      db.prepare(
        `INSERT INTO positions (id, mode, token, symbol, tier, status, opened_at,
          opened_candle_ts, entry_price, size_raw, size_decimals, cost_sol_raw,
          stop_loss_price, time_exit_candle_ts, entry_context, exit_reason)
         VALUES ('p1','backtest','JUP','JUP','A','closed',0,0,1,'1',9,'1',0.85,48,'{}',?)`,
      ).run(reason);
    expect(() => insert('not_a_reason')).toThrow();
    expect(() => insert('stop_loss')).not.toThrow();
    db.close();
  });
});
