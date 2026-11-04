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

/** "72h", "3d", "90m" or a bare number of hours. */
export function parseHours(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/.exec(s.trim());
  if (!m) throw new Error(`--since must look like 72h, 3d or 90m, got ${s}`);
  const n = Number(m[1]);
  const hours = m[2] === 'm' ? n / 60 : m[2] === 'd' ? n * 24 : n;
  if (!(hours > 0) || hours > 24 * 90) throw new Error('--since must be more than 0 and at most 90 days');
  return hours;
}

export interface DiagFlags {
  since?: string;
  runs?: number;
  content?: boolean;
  recordings?: boolean;
  transcripts?: boolean;
  out?: string;
  url?: string;
  token?: string;
  offline?: boolean;
}

async function copyOut(src: string, out: string): Promise<string> {
  const dest = fs.existsSync(out) && fs.statSync(out).isDirectory() ? path.join(out, path.basename(src)) : out;
  await fs.promises.copyFile(src, dest);
  return dest;
}

/**
 * `protea diag`: a diagnostics bundle (.tar.gz) to attach to a bug report. The running daemon
 * builds it (with live status, metrics and effective config); without one it is built offline
 * from the data directory. Conversation content only with --content / --transcripts / --recordings.
 */
export async function diagCommand(dataDir: string, f: DiagFlags): Promise<number> {
  const { createDiagnostics, diagnosticsDir, SecretStore } = await import('@protea/core');
  const opts = {
    ...(f.since !== undefined ? { sinceHours: parseHours(f.since) } : {}),
    ...(f.runs !== undefined ? { runs: f.runs } : {}),
    ...(f.content ? { content: true } : {}),
    ...(f.recordings ? { recordings: true } : {}),
    ...(f.transcripts ? { transcripts: true } : {}),
  };
  let file: string | null = null;
  let bytes = 0;
  let files = 0;
  let live = false;
  if (!f.offline) {
    const { api, resolveClient } = await import('./client.js');
    try {
      const c = resolveClient({ url: localUrl(dataDir, f.url), ...(f.token !== undefined ? { token: f.token } : {}), dataDir });
      const r = await api<{ name: string; bytes: number; manifest: { files: unknown[] } }>(c, 'POST', '/api/diagnostics', opts);
      live = true;
      bytes = r.bytes;
      files = r.manifest.files.length;
      const local = path.join(diagnosticsDir(dataDir), r.name);
      if (fs.existsSync(local)) file = f.out ? await copyOut(local, f.out) : local;
      else {
        // A daemon on another machine: download the archive.
        const res = await fetch(`${c.url}/api/diagnostics/${r.name}`, { headers: { authorization: `Bearer ${c.token}` } });
        if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
        const dest = f.out ? (fs.existsSync(f.out) && fs.statSync(f.out).isDirectory() ? path.join(f.out, r.name) : f.out) : r.name;
        await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()));
        file = dest;
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!/cannot reach the daemon|no admin token/.test(msg)) throw err;
      console.log(yellow(`${msg.split('\n')[0]}; building the bundle offline (no live status or metrics)`));
    }
  }
  if (!file) {
    const secrets = new SecretStore(path.join(dataDir, 'secrets'));
    const { VERSION } = await import('@protea/daemon');
    const r = await createDiagnostics({ dataDir, version: VERSION, redact: (t) => secrets.redactJsonText(t), ...opts });
    file = f.out ? await copyOut(r.path, f.out) : r.path;
    bytes = r.bytes;
    files = r.manifest.files.length;
  }
  console.log(green(`diagnostics bundle: ${file}`));
  console.log(dim(`${files} files, ${size(bytes)}${live ? ', with live status and metrics' : ''}; no secrets`));
  console.log(
    dim(
      f.content || f.transcripts || f.recordings
        ? 'includes conversation content (event text / notes / transcripts / recordings): share it with care'
        : 'metadata only: event text, notes and transcripts are left out (add --content / --transcripts to include them)',
    ),
  );
  if (process.env['PROTEA_IMAGE'] && file.startsWith('/data/')) console.log(dim(`copy it out of the container: docker cp <container>:${file} .`));
  return 0;
}
