import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LATEST_VERSION, runMigrations } from './migrations.js';

export type Db = Database.Database;

/**
 * Open (creating if needed) the hub database.
 *
 * WAL + synchronous=NORMAL is the right trade here: we accept losing the last
 * few milliseconds of writes on power loss, in exchange for snapshot writes
 * that never stall the PTY read loop. A hard kill still leaves a recoverable
 * database, which the restore path depends on.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export { LATEST_VERSION, runMigrations };
