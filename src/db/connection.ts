import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** Idempotent migrations: safe to run on every startup and on an existing DB. */
export function migrate(db: Db): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  );
  const appliedRow = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  const applied = appliedRow?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= applied) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(m.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return Math.max(applied, MIGRATIONS.at(-1)?.version ?? 0);
}

type TxState = { __txDepth?: number };

/** Run fn in a serialized transaction (BEGIN IMMEDIATE). Nested -> savepoint. */
export function withTransaction<T>(db: Db, fn: () => T): T {
  const state = db as unknown as TxState;
  const nested = state.__txDepth ?? 0;
  if (nested === 0) {
    db.exec('BEGIN IMMEDIATE');
    state.__txDepth = 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      state.__txDepth = 0;
    }
  }
  const sp = `sp_${nested}`;
  db.exec(`SAVEPOINT ${sp}`);
  state.__txDepth = nested + 1;
  try {
    const result = fn();
    db.exec(`RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${sp}`);
    db.exec(`RELEASE ${sp}`);
    throw err;
  } finally {
    state.__txDepth = nested;
  }
}
