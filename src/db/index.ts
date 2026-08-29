/**
 * SQLite setup. One database holds the candle cache, trade log and bot state so
 * that a restart resumes rather than restarts (spec §3).
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = '2';

export type Db = Database.Database;

function schemaSql(): string {
  // Resolves both from src/ (tsx) and dist/ (compiled).
  for (const candidate of [join(HERE, 'schema.sql'), join(HERE, '..', '..', 'src', 'db', 'schema.sql')]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error('db/schema.sql not found');
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schemaSql());

  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version');

  if (row === undefined) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      SCHEMA_VERSION,
    );
  } else if (row.value !== SCHEMA_VERSION) {
    throw new Error(
      `Database schema is v${row.value} but this build expects v${SCHEMA_VERSION}. ` +
        'Refusing to open — migrate explicitly rather than risk silent corruption.',
    );
  }

  return db;
}
