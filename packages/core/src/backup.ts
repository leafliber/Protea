import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LATEST_SCHEMA, schemaVersion } from './db/database.js';

/**
 * Backup and restore of the data directory (docs/10-architecture/16-deployment.md §8).
 * A backup is a directory (or a .tar.gz of one) holding an online SQLite backup of protea.db,
 * copies of the user data, and manifest.json. Secrets and caches are never included.
 */

export const BACKUP_FORMAT = 1;
/** What a backup holds besides protea.db (each only when it exists). */
export const BACKUP_ITEMS = ['config.yaml', 'sessions', 'memory', 'persona', 'skills', 'plugins', 'plugin-data', 'blobs', 'overrides'] as const;
/** Never copied: secrets (re-set them on the new machine), caches, the lock, earlier backups, the SQLite side files. */
export const BACKUP_EXCLUDED = ['secrets', 'cache', 'protea.lock', 'backups', 'replays', 'protea.db-wal', 'protea.db-shm'] as const;
/** The text a Git backup pushes (reviewable history of persona and memory). */
export const GIT_BACKUP_ITEMS = ['config.yaml', 'persona', 'memory', 'skills'] as const;

export interface BackupManifest {
  format: number;
  createdAt: string;
  protea: string;
  schema: number;
  items: string[];
  files: number;
  bytes: number;
  dbSha256: string;
  excluded: string[];
}

export interface BackupOptions {
  dataDir: string;
  /** Parent directory of the new backup (default <data>/backups). */
  to?: string;
  /** Also copy workspace/ and runs/ (large; off by default). */
  includeWorkspace?: boolean;
  includeRuns?: boolean;
  /** Write <name>.tar.gz instead of a directory. */
  archive?: boolean;
  version: string;
  now?: Date;
}

export interface BackupResult {
  path: string;
  manifest: BackupManifest;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function countTree(p: string): { files: number; bytes: number } {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(p)) {
    const c = countTree(path.join(p, name));
    files += c.files;
    bytes += c.bytes;
  }
  return { files, bytes };
}

const COPY_OPTIONS = {
  recursive: true,
  dereference: false,
  errorOnExist: false,
  force: true,
  filter: (s: string) => !path.basename(s).startsWith('.tmp-'),
};

/** Copy without temp files (`.tmp-*`) and without following symlinks out of the tree. */
function copyItem(src: string, dest: string): void {
  fs.cpSync(src, dest, COPY_OPTIONS);
}

/** The same without blocking the daemon's event loop (backups run inside it). */
function copyItemAsync(src: string, dest: string): Promise<void> {
  return fs.promises.cp(src, dest, COPY_OPTIONS);
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]} failed: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout.trim());
    });
  });
}

export function isGitTarget(to: string): boolean {
  return /^(git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(to) || (/^https?:\/\//.test(to) && to.endsWith('.git'));
}

/** Online backup: safe while the daemon runs (SQLite's backup API copies a consistent snapshot). */
export async function createBackup(o: BackupOptions): Promise<BackupResult> {
  const now = o.now ?? new Date();
  const dbFile = path.join(o.dataDir, 'protea.db');
  if (!fs.existsSync(dbFile)) throw new Error(`${o.dataDir} has no protea.db; is it a Protea data directory?`);
  const parent = path.resolve(o.to ?? path.join(o.dataDir, 'backups'));
  const name = `protea-backup-${stamp(now)}`;
  const dir = path.join(parent, name);
  if (fs.existsSync(dir) || fs.existsSync(`${dir}.tar.gz`)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const db = new Database(dbFile, { fileMustExist: true });
    let schema: number;
    try {
      db.pragma('busy_timeout = 5000');
      schema = schemaVersion(db);
      await db.backup(path.join(dir, 'protea.db'));
    } finally {
      db.close();
    }
    const items: string[] = ['protea.db'];
    const wanted: string[] = [...BACKUP_ITEMS, ...(o.includeWorkspace ? ['workspace'] : []), ...(o.includeRuns ? ['runs'] : [])];
    for (const item of wanted) {
      const src = path.join(o.dataDir, item);
      if (!fs.existsSync(src)) continue;
      await copyItemAsync(src, path.join(dir, item));
      items.push(item);
    }
    let files = 0;
    let bytes = 0;
    for (const item of items) {
      const c = countTree(path.join(dir, item));
      files += c.files;
      bytes += c.bytes;
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: now.toISOString(),
      protea: o.version,
      schema,
      items,
      files,
      bytes,
      dbSha256: sha256(path.join(dir, 'protea.db')),
      excluded: [...BACKUP_EXCLUDED, ...(o.includeWorkspace ? [] : ['workspace']), ...(o.includeRuns ? [] : ['runs'])],
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (!o.archive) return { path: dir, manifest };
    const out = `${dir}.tar.gz`;
    await run('tar', ['-czf', out, '-C', parent, name]);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return { path: out, manifest };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

const git = (cwd: string, args: string[]): Promise<string> => run('git', args, cwd);

/**
 * Push the reviewable text (config.yaml, persona/, memory/, skills/) to a Git repository: a
 * working clone under <data>/cache/backup-git, one commit per run that changed something. The
 * database is not included (binary, and it holds event text); keep directory backups for it.
 */
export async function gitBackup(o: { dataDir: string; url: string; now?: Date }): Promise<{ commit: string | null; changed: number }> {
  const now = o.now ?? new Date();
  const work = path.join(o.dataDir, 'cache', 'backup-git', crypto.createHash('sha256').update(o.url).digest('hex').slice(0, 12));
  if (!fs.existsSync(path.join(work, '.git'))) {
    fs.mkdirSync(path.dirname(work), { recursive: true });
    await git(path.dirname(work), ['clone', '--quiet', o.url, work]);
  } else if ((await git(work, ['branch', '--list'])).length > 0) {
    // An empty remote has no branch to pull yet.
    await git(work, ['pull', '--quiet', '--ff-only']);
  }
  for (const item of GIT_BACKUP_ITEMS) {
    const dest = path.join(work, item);
    await fs.promises.rm(dest, { recursive: true, force: true });
    const src = path.join(o.dataDir, item);
    if (fs.existsSync(src)) await copyItemAsync(src, dest);
    // Conversation archives are private and large; the full backup keeps them.
    if (item === 'memory') await fs.promises.rm(path.join(dest, 'raw'), { recursive: true, force: true });
  }
  await git(work, ['add', '-A']);
  const changed = (await git(work, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
  if (changed === 0) return { commit: null, changed: 0 };
  await git(work, ['-c', 'user.name=Protea', '-c', 'user.email=protea@localhost', 'commit', '--quiet', '-m', `protea backup ${now.toISOString()}`]);
  const commit = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['push', '--quiet', 'origin', 'HEAD']);
  return { commit, changed };
}

function daemonPid(dataDir: string): number | null {
  const file = path.join(dataDir, 'protea.lock');
  if (!fs.existsSync(file)) return null;
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

export interface RestoreResult {
  restored: string[];
  /** Where the replaced files went (only with force on a non-empty data directory). */
  movedAside?: string;
  manifest: BackupManifest;
}

/**
 * Put a backup (directory or .tar.gz) into a data directory. The daemon must be stopped. An
 * existing installation is never deleted: with `force` its files move to
 * <data>/backups/pre-restore-<time>/ first. secrets/ is left as it is.
 */
export function restoreBackup(o: { from: string; dataDir: string; force?: boolean; now?: Date }): RestoreResult {
  const now = o.now ?? new Date();
  const pid = daemonPid(o.dataDir);
  if (pid !== null) throw new Error(`a Protea daemon (pid ${pid}) is using ${o.dataDir}; stop it before restoring`);
  let src = path.resolve(o.from);
  let tmp: string | null = null;
  try {
    if (src.endsWith('.tar.gz') || src.endsWith('.tgz')) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-restore-'));
      const r = spawnSync('tar', ['-xzf', src, '-C', tmp], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`tar failed: ${r.stderr || r.error?.message}`);
      const inner = fs.readdirSync(tmp).filter((n) => fs.statSync(path.join(tmp as string, n)).isDirectory());
      if (inner.length !== 1) throw new Error('the archive should hold exactly one backup directory');
      src = path.join(tmp, inner[0] as string);
    }
    const mf = path.join(src, 'manifest.json');
    if (!fs.existsSync(mf)) throw new Error(`${o.from} is not a Protea backup (no manifest.json)`);
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) as BackupManifest;
    if (manifest.format !== BACKUP_FORMAT) throw new Error(`backup format ${manifest.format} is not supported (expected ${BACKUP_FORMAT})`);
    if (manifest.schema > LATEST_SCHEMA) throw new Error(`the backup's database (schema v${manifest.schema}) is newer than this build (v${LATEST_SCHEMA}); use a newer image`);
    if (sha256(path.join(src, 'protea.db')) !== manifest.dbSha256) throw new Error('protea.db does not match the checksum in manifest.json; the backup is damaged');
    const items = manifest.items.filter((i) => !path.isAbsolute(i) && !i.includes('..') && fs.existsSync(path.join(src, i)));

    fs.mkdirSync(o.dataDir, { recursive: true });
    const present = [...items, 'protea.db-wal', 'protea.db-shm'].filter((i) => fs.existsSync(path.join(o.dataDir, i)));
    let movedAside: string | undefined;
    if (present.length > 0) {
      if (!o.force) throw new Error(`${o.dataDir} already has ${present.join(', ')}; pass --force to move them aside and restore`);
      movedAside = path.join(o.dataDir, 'backups', `pre-restore-${stamp(now)}`);
      fs.mkdirSync(movedAside, { recursive: true });
      for (const i of present) fs.renameSync(path.join(o.dataDir, i), path.join(movedAside, i));
    }
    for (const i of items) copyItem(path.join(src, i), path.join(o.dataDir, i));
    return { restored: items, ...(movedAside ? { movedAside } : {}), manifest };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Backups under <data>/backups (newest first). */
export function listBackups(dataDir: string): Array<{ name: string; path: string; createdAt?: string; bytes?: number; archive: boolean }> {
  const dir = path.join(dataDir, 'backups');
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ name: string; path: string; createdAt?: string; bytes?: number; archive: boolean }> = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name.startsWith('protea-backup-') && name.endsWith('.tar.gz')) {
      // The time is in the name: protea-backup-2026-11-04T03-51-30-187Z.tar.gz.
      const m = /^protea-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.tar\.gz$/.exec(name);
      const createdAt = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : undefined;
      out.push({ name, path: p, bytes: fs.statSync(p).size, archive: true, ...(createdAt ? { createdAt } : {}) });
      continue;
    }
    const mf = path.join(p, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8')) as BackupManifest;
      out.push({ name, path: p, createdAt: m.createdAt, bytes: m.bytes, archive: false });
    } catch {
      // Not a readable backup.
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}
