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

export function openDatabase(file: string): { db: Db; migration: MigrationReport } {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const migration = migrate(db);
  return { db, migration };
}
