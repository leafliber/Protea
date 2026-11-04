import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, prepareDatabase } from '@protea/core';
import { defaultDataDir } from './client.js';
import { dim, green, yellow } from './format.js';

/**
 * Commands that work on the data directory itself and run where it lives (inside the
 * container: `docker exec protea protea …`): migrate, healthcheck, backup, restore, replay.
 */

/**
 * `docker exec` runs as root by default; files the CLI writes in /data must still belong to
 * the daemon's user. With PROTEA_RUN_AS=uid:gid (set in the image) a root CLI switches to it.
 */
export function dropPrivileges(env: NodeJS.ProcessEnv = process.env): void {
  const spec = env['PROTEA_RUN_AS'];
  if (!spec || env['PROTEA_ALLOW_ROOT'] === '1' || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const [u, g] = spec.split(':');
  const uid = Number(u);
  const gid = Number(g ?? u);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error(`PROTEA_RUN_AS must be uid:gid, got ${spec}`);
  process.setgroups?.([gid]);
  process.setgid?.(gid);
  process.setuid?.(uid);
  if (env['HOME'] === '/root') env['HOME'] = env['PROTEA_HOME'] ?? '/home/protea';
}

/** `protea migrate`: the entrypoint's schema step (prints one line; throws on failure). */
export async function migrateCommand(dataDir = defaultDataDir()): Promise<number> {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'protea.db');
  const fresh = !fs.existsSync(file);
  try {
    const r = await prepareDatabase(file, path.join(dataDir, 'backups'));
    if (r.applied.length === 0) console.log(dim(`database schema v${r.to} is current`));
    else if (fresh) console.log(dim(`created the database (schema v${r.to})`));
    else console.log(green(`migrated the database v${r.from} → v${r.to} (${r.applied.join(', ')}); the old file was saved as ${path.relative(dataDir, r.snapshot ?? '')}`));
    return 0;
  } catch (err) {
    throw new Error(
      `database migration failed: ${(err as Error).message}\n` +
        `The database was left unchanged. To roll back, run the previous image; if a newer image already migrated it, restore a backup (protea restore) or the snapshot in ${path.join(dataDir, 'backups')}.`,
    );
  }
}

/** The control API base URL on this machine: --url, $PROTEA_URL, or control.listen of the data directory. */
export function localUrl(dataDir: string, url: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (url ?? env['PROTEA_URL']) return (url ?? env['PROTEA_URL'] ?? '').replace(/\/$/, '');
  let listen = '0.0.0.0:7788';
  try {
    listen = loadConfig(dataDir, env).config.control.listen;
  } catch {
    // An invalid config.yaml fails the daemon itself; the default port is the best guess here.
  }
  const i = listen.lastIndexOf(':');
  const host = listen.slice(0, i).replace(/^\[|\]$/g, '');
  const port = listen.slice(i + 1);
  const local = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${port}`;
}

function size(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** `protea backup`: an online backup (works while the daemon runs), or a Git push of the text. */
export async function backupCommand(
  dataDir: string,
  o: { to?: string; includeWorkspace?: boolean; includeRuns?: boolean; archive?: boolean },
): Promise<number> {
  const { createBackup, gitBackup, isGitTarget } = await import('@protea/core');
  if (o.to && isGitTarget(o.to)) {
    const r = await gitBackup({ dataDir, url: o.to });
    console.log(r.commit ? green(`pushed ${r.changed} change(s) to ${o.to} (${r.commit.slice(0, 10)})`) : dim(`nothing changed since the last push to ${o.to}`));
    console.log(dim('the Git backup holds config.yaml, persona/, memory/ and skills/; use a directory backup for the database'));
    return 0;
  }
  const { VERSION } = await import('@protea/daemon');
  const r = await createBackup({
    dataDir,
    version: VERSION,
    ...(o.to ? { to: o.to } : {}),
    ...(o.includeWorkspace ? { includeWorkspace: true } : {}),
    ...(o.includeRuns ? { includeRuns: true } : {}),
    ...(o.archive ? { archive: true } : {}),
  });
  console.log(green(`backup written to ${r.path}`));
  console.log(dim(`${r.manifest.files} files, ${size(r.manifest.bytes)}, schema v${r.manifest.schema}; not included: ${r.manifest.excluded.join(', ')}`));
  return 0;
}

/** `protea restore <backup>`: the daemon must be stopped; replaced files are moved aside, never deleted. */
export async function restoreCommand(dataDir: string, from: string | undefined, force: boolean): Promise<number> {
  if (!from) throw new Error('restore needs a backup directory or .tar.gz, e.g. protea restore /data/backups/protea-backup-…');
  const { restoreBackup } = await import('@protea/core');
  const r = restoreBackup({ from, dataDir, force });
  console.log(green(`restored ${r.restored.join(', ')} into ${dataDir} (backup of ${r.manifest.createdAt}, schema v${r.manifest.schema})`));
  if (r.movedAside) console.log(yellow(`the previous files were moved to ${r.movedAside}`));
  console.log(dim('secrets are not part of backups: set them again if this is a new machine (protea secrets set NAME)'));
  return 0;
}

/** `protea replay`: re-run a range of events offline (see apps/daemon/src/replay.ts). */
export async function replayCommand(
  dataDir: string,
  o: { from?: number; to?: number; provider?: string; run?: string; out?: string },
): Promise<number> {
  const provider = o.provider ?? 'recorded';
  if (provider !== 'recorded' && provider !== 'echo' && provider !== 'config') throw new Error('--provider must be recorded, echo or config');
  if (provider === 'config') console.log(yellow('replaying against the configured model: this makes real (paid) API calls'));
  const { replay } = await import('@protea/daemon');
  const r = await replay({
    dataDir,
    provider,
    ...(o.from !== undefined ? { from: o.from } : {}),
    ...(o.to !== undefined ? { to: o.to } : {}),
    ...(o.run ? { run: o.run } : {}),
    ...(o.out ? { out: o.out } : {}),
    onBatch: (b) => console.log(dim(`batch ${b.index}/${b.total}: ${b.events} event(s) (originally ${b.batchId})`)),
  });
  console.log(green(`replayed ${r.batches} batch(es), ${r.events} event(s) with ${r.modelCalls} model call(s); ${r.skipped} event(s) in the range never reached the model`));
  console.log(`tools: ${r.tools.recorded} answered from the recording, ${r.tools.ran} read-only ran offline, ${r.tools.stubbed} stubbed`);
  if (r.remaining && Object.values(r.remaining).some((n) => n > 0)) {
    console.log(yellow(`recorded responses left over: ${JSON.stringify(r.remaining)} (the replay took a different path, or the range is narrower than the recording)`));
  }
  console.log(`transcript: ${r.transcript}`);
  return 0;
}

/** `protea healthcheck`: exit 0 when /healthz answers (the image's HEALTHCHECK). */
export async function healthcheckCommand(dataDir: string, url: string | undefined): Promise<number> {
  const base = localUrl(dataDir, url);
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) return 0;
    console.error(`${base}/healthz answered ${res.status}`);
  } catch (err) {
    console.error(`${base}/healthz: ${(err as Error).message}`);
  }
  return 1;
}
