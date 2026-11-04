import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.js';

export type Db = Database.Database;

export interface MigrationReport {
  from: number;
  to: number;
  applied: string[];
}

export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationReport {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  const from = row.v ?? 0;
  const latest = migrations.at(-1)?.version ?? 0;
  if (from > latest) {
    throw new Error(`database schema v${from} is newer than this build (v${latest}); refusing to start`);
  }
  const applied: string[] = [];
  for (const m of migrations) {
    if (m.version <= from) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    applied.push(`${m.version}_${m.name}`);
  }
  return { from, to: Math.max(from, latest), applied };
}

/** The schema version recorded in a database (0 for a new or empty file). */
export function schemaVersion(db: Db): number {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!t) return 0;
  return (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
}

export const LATEST_SCHEMA = MIGRATIONS.at(-1)?.version ?? 0;

export interface PrepareReport extends MigrationReport {
  /** Copy of the database taken before migrating (only when migrations were pending). */
  snapshot?: string;
}

/**
 * The container entrypoint's migration step (docs/10-architecture/16-deployment.md §5, §7):
 * refuse a database newer than this build, snapshot it with SQLite's online backup when
 * migrations are pending, then migrate. A failed migration rolls back its transaction and
 * leaves the file as it was; the snapshot stays for a manual rollback.
 */
export async function prepareDatabase(file: string, snapshotDir: string, now = new Date()): Promise<PrepareReport> {
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    const from = schemaVersion(db);
    if (from > LATEST_SCHEMA) throw new Error(`database schema v${from} is newer than this build (v${LATEST_SCHEMA}); use a newer image or restore a backup`);
    let snapshot: string | undefined;
    if (from > 0 && from < LATEST_SCHEMA) {
      fs.mkdirSync(snapshotDir, { recursive: true });
      snapshot = path.join(snapshotDir, `protea-v${from}-${now.toISOString().replace(/[:.]/g, '-')}.db`);
      await db.backup(snapshot);
    }
    db.pragma('journal_mode = WAL');
    const report = migrate(db);
    return snapshot ? { ...report, snapshot } : report;
  } finally {
    db.close();
  }
}

export function openDatabase(file: string): { db: Db; migration: MigrationReport } {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const migration = migrate(db);
  return { db, migration };
}
