import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where a plugin or skill to install comes from (control API `POST /api/plugins`, `POST /api/skills`). */
export type SourceSpec =
  | { source: 'path'; path: string; subdir?: string }
  | { source: 'git'; url: string; ref?: string; subdir?: string }
  | { source: 'tarball'; url: string; subdir?: string };

export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

/** Normalize a request body: `{ path }`, `{ gitUrl, ref? }` or `{ source, url | path, ref?, subdir? }`. */
export function parseSourceSpec(body: Record<string, unknown>): SourceSpec {
  const str = (k: string): string | undefined => (typeof body[k] === 'string' && (body[k] as string).trim() ? (body[k] as string).trim() : undefined);
  const subdir = str('subdir');
  const extra = subdir ? { subdir } : {};
  const source = str('source') ?? (str('gitUrl') ? 'git' : str('path') ? 'path' : undefined);
  if (source === 'path') {
    const p = str('path') ?? str('url');
    if (!p) throw new Error('path is required');
    return { source, path: p, ...extra };
  }
  if (source === 'git') {
    const url = str('url') ?? str('gitUrl');
    if (!url) throw new Error('url is required');
    if (!/^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(url)) throw new Error('git url must be https://, ssh://, git://, file:// or user@host:path');
    const ref = str('ref');
    if (ref !== undefined && !/^[\w./-]+$/.test(ref)) throw new Error('invalid ref');
    return { source, url, ...(ref ? { ref } : {}), ...extra };
  }
  if (source === 'tarball') {
    const url = str('url');
    if (!url || !/^https?:\/\//.test(url)) throw new Error('tarball url must be http(s)://');
    return { source, url, ...extra };
  }
  throw new Error('source must be path, git or tarball');
}

function within(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error(`subdir escapes the source: ${rel}`);
  return full;
}

/** Fail on symlinks that leave the tree (a tarball or repository must not point at the host). */
function checkTree(root: string): void {
  const real = fs.realpathSync(root);
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        const target = path.resolve(dir, fs.readlinkSync(p));
        if (target !== real && !target.startsWith(`${real}${path.sep}`)) throw new Error(`symlink leaves the source: ${path.relative(root, p)}`);
      } else if (ent.isDirectory() && ent.name !== '.git') walk(p);
    }
  };
  walk(real);
}

/**
 * Bring a source to a local directory. Remote sources go to a fresh temporary directory
 * that `cleanup()` removes; a path source is used in place.
 */
export async function fetchSource(spec: SourceSpec, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ dir: string; cleanup: () => void }> {
  if (spec.source === 'path') {
    const dir = within(path.resolve(spec.path), spec.subdir ?? '.');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
    return { dir, cleanup: () => undefined };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-src-'));
  const cleanup = (): void => fs.rmSync(tmp, { recursive: true, force: true });
  const timeout = opts.timeoutMs ?? 120_000;
  try {
    let root: string;
    if (spec.source === 'git') {
      root = path.join(tmp, 'repo');
      const args = ['clone', '--depth', '1', '--quiet', ...(spec.ref ? ['--branch', spec.ref] : []), '--', spec.url, root];
      try {
        await run('git', args, { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...(opts.signal ? { signal: opts.signal } : {}) });
      } catch (err) {
        const e = err as { stderr?: string; message: string; code?: string };
        if (e.code === 'ENOENT') throw new Error('git is not installed');
        throw new Error(`git clone failed: ${(e.stderr ?? e.message).trim().split('\n').slice(-2).join(' ')}`);
      }
    } else {
      const res = await fetch(spec.url, { signal: opts.signal ?? AbortSignal.timeout(timeout), redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_TARBALL_BYTES) throw new Error(`tarball is larger than ${MAX_TARBALL_BYTES / 1024 / 1024} MB`);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_TARBALL_BYTES) throw new Error(`tarball is larger than ${MAX_TARBALL_BYTES / 1024 / 1024} MB`);
        chunks.push(Buffer.from(chunk));
      }
      const file = path.join(tmp, 'source.tgz');
      fs.writeFileSync(file, Buffer.concat(chunks));
      const out = path.join(tmp, 'out');
      fs.mkdirSync(out);
      try {
        await run('tar', ['-xzf', file, '-C', out, '--no-same-owner', '--no-same-permissions'], { timeout });
      } catch (err) {
        throw new Error(`could not extract the tarball: ${((err as { stderr?: string }).stderr ?? (err as Error).message).trim()}`);
      }
      // npm-style tarballs wrap everything in one top directory ("package/").
      const entries = fs.readdirSync(out);
      root = entries.length === 1 && fs.statSync(path.join(out, entries[0] as string)).isDirectory() ? path.join(out, entries[0] as string) : out;
    }
    checkTree(root);
    const dir = within(root, spec.subdir ?? '.');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`no directory ${spec.subdir ?? '.'} in the source`);
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
