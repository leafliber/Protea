import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { definePlugin, type Host, type PluginDefinition } from '@protea/plugin-sdk';

export interface ShellConfig {
  timeoutSec?: number;
  maxOutputKb?: number;
  shell?: string;
  maxConcurrent?: number;
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  ms: number;
}

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Inherited from the plugin's own (already minimal) environment: tool caches, locale, proxy. */
const INHERIT = [
  'LANG',
  'LC_ALL',
  'TZ',
  'npm_config_cache',
  'UV_CACHE_DIR',
  'UV_TOOL_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'PIP_CACHE_DIR',
  'XDG_CACHE_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];
const KILL_GRACE_MS = 2000;

/**
 * The environment of a command (docs/10-architecture/14-security-and-permissions.md §6): a
 * whitelist, HOME and TMPDIR inside the workspace, plus the configured plain values. Nothing
 * named like a secret or a Protea variable gets through, even from the config.
 */
export function commandEnv(workspace: string, extra: Record<string, string> = {}, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERIT) {
    const v = from[k];
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, { PATH: from['PATH'] ?? SAFE_PATH, HOME: workspace, TMPDIR: path.join(workspace, '.tmp'), TERM: 'dumb' });
  for (const [k, v] of Object.entries(extra)) {
    if (/^PROTEA_|TOKEN|SECRET|PASSWORD|API_?KEY/i.test(k)) continue;
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

/** A directory inside the workspace (no escape through `..` or a symlink). */
export function resolveCwd(workspace: string, rel: string | undefined): string {
  const root = fs.realpathSync(workspace);
  if (!rel) return root;
  const target = path.resolve(root, rel);
  if (!fs.existsSync(target)) throw new Error(`cwd ${rel} does not exist in the workspace`);
  const real = fs.realpathSync(target);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`cwd ${rel} is outside the workspace`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`cwd ${rel} is not a directory`);
  return real;
}

/** Keep the head and the tail of long output (the middle is usually the least useful). */
export function clipOutput(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString('utf8').replace(/�$/, '');
  const tail = buf.subarray(buf.length - half).toString('utf8').replace(/^�/, '');
  return `${head}\n… [${buf.length - 2 * half} bytes cut] …\n${tail}`;
}

/**
 * Run one command in its own process group, so a timeout or cancel kills everything it
 * started. Collects at most `captureBytes` of each stream (the rest is counted, not kept).
 */
export function runCommand(o: {
  shell: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
  captureBytes: number;
  signal?: AbortSignal;
}): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    fs.mkdirSync(o.env['TMPDIR'] ?? path.join(o.cwd, '.tmp'), { recursive: true });
    const child = spawn(o.shell, ['-c', o.command], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], sizes: { stdout: 0, stderr: 0 } };
    const collect = (k: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = o.captureBytes - out.sizes[k];
      if (room > 0) out[k].push(room >= chunk.length ? chunk : chunk.subarray(0, room));
      out.sizes[k] += chunk.length;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin ?? '');
    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };
    const stop = (): void => {
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal?.removeEventListener('abort', onAbort);
      // Whatever the command left running in its group goes too.
      killGroup('SIGKILL');
      const text = (k: 'stdout' | 'stderr'): string => {
        const s = Buffer.concat(out[k]).toString('utf8');
        return out.sizes[k] > o.captureBytes ? `${s}\n… [${out.sizes[k] - o.captureBytes} more bytes not captured]` : s;
      };
      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        stdout: text('stdout'),
        stderr: spawnError ? `${text('stderr')}${spawnError.message}` : text('stderr'),
        ms: Date.now() - t0,
      });
    };
    child.once('error', (err) => finish(null, null, err));
    child.once('close', (code, sig) => finish(code, sig));
  });
}

export function formatResult(r: RunResult, maxBytes: number, timeoutSec: number): { text: string; failed: boolean; partial: boolean } {
  const status = r.timedOut
    ? `timed out after ${timeoutSec}s (process group killed)`
    : r.aborted
      ? 'stopped: the turn was interrupted'
      : r.signal
        ? `killed by ${r.signal}`
        : `exit code ${r.exitCode}`;
  const parts = [`${status} · ${(r.ms / 1000).toFixed(1)}s`];
  const body: string[] = [];
  if (r.stdout.trim()) body.push(`--- stdout ---\n${r.stdout.replace(/\n$/, '')}`);
  if (r.stderr.trim()) body.push(`--- stderr ---\n${r.stderr.replace(/\n$/, '')}`);
  if (body.length === 0) body.push('(no output)');
  parts.push(clipOutput(body.join('\n'), maxBytes));
  return { text: parts.join('\n'), failed: r.timedOut || r.signal !== null || (r.exitCode ?? 1) !== 0, partial: r.aborted };
}

export function createShellPlugin(): PluginDefinition<ShellConfig> {
  let running = 0;
  const workspaceOf = (host: Host<ShellConfig>): string => {
    const ws = path.join(host.hostDataDir, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  };
  const settings = (host: Host<ShellConfig>) => ({
    timeoutSec: host.config.timeoutSec ?? 120,
    maxOutputKb: host.config.maxOutputKb ?? 64,
    shell: host.config.shell ?? '/bin/sh',
    maxConcurrent: host.config.maxConcurrent ?? 2,
    env: host.config.env ?? {},
  });

  return definePlugin<ShellConfig>({
    displayName: 'Shell',
    envPromptVars: (host) => {
      const s = settings(host);
      return { workspace: workspaceOf(host), timeoutSec: s.timeoutSec, maxOutputKb: s.maxOutputKb };
    },
    tools: [
      {
        name: 'sh_run',
        description:
          'Run a non-interactive shell command in the workspace directory and return its exit code and output. Each call starts a fresh shell; files persist in the workspace. No secrets are in the environment. Long output is cut in the middle; a command that runs past the timeout is killed with everything it started.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['command'],
          properties: {
            command: { type: 'string', minLength: 1, maxLength: 20_000, description: 'Shell command line (sh -c).' },
            cwd: { type: 'string', description: 'Directory relative to the workspace (default: the workspace).' },
            timeoutSec: { type: 'integer', minimum: 1, description: 'Shorter timeout for this call (capped by the configured one).' },
            stdin: { type: 'string', maxLength: 1_000_000, description: 'Text written to standard input.' },
          },
        },
        flags: { sideEffect: true, interruptible: true },
        // The dispatcher's own timeout must outlast the command's.
        timeoutMs: 3_660_000,
        handler: async (i: { command: string; cwd?: string; timeoutSec?: number; stdin?: string }, ctx, host) => {
          const s = settings(host);
          if (running >= s.maxConcurrent) return { text: `not run: ${running} commands are already running (maxConcurrent ${s.maxConcurrent}); wait for them`, failed: true };
          const ws = workspaceOf(host);
          let cwd: string;
          try {
            cwd = resolveCwd(ws, i.cwd);
          } catch (err) {
            return { text: `not run: ${(err as Error).message}`, failed: true };
          }
          const timeoutSec = Math.min(i.timeoutSec ?? s.timeoutSec, s.timeoutSec);
          const maxBytes = s.maxOutputKb * 1024;
          running++;
          try {
            host.log.info('running a command', { callId: ctx.callId, cwd: path.relative(ws, cwd) || '.', chars: i.command.length });
            const r = await runCommand({
              shell: s.shell,
              command: i.command,
              cwd,
              env: commandEnv(ws, s.env),
              timeoutMs: timeoutSec * 1000,
              ...(i.stdin !== undefined ? { stdin: i.stdin } : {}),
              captureBytes: maxBytes * 4,
              signal: ctx.signal,
            });
            host.log.info('command finished', { callId: ctx.callId, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, ms: r.ms });
            return formatResult(r, maxBytes, timeoutSec);
          } finally {
            running--;
          }
        },
      },
    ],
  });
}
