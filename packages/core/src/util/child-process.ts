import { execFile } from 'node:child_process';
import fs from 'node:fs';

/**
 * Non-secret variables every child process (plugins, MCP servers, the shell tool) inherits
 * on top of its minimal environment: tool caches on the data volume (the image points them
 * at /data/cache), locale, CA bundles and the egress proxy.
 */
export const PASSTHROUGH_ENV = [
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SYSTEMROOT',
  'npm_config_cache',
  'npm_config_update_notifier',
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
] as const;

export function passthroughEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASSTHROUGH_ENV) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Resource limits for plugin and MCP processes (docs/10-architecture/14-security-and-permissions.md §6). */
export interface ProcessLimits {
  /** Resident memory of the process and its descendants; above it the process is restarted. null: no limit. */
  memoryMb: number | null;
  /** RLIMIT_NOFILE (soft) set before exec. null: inherited. */
  openFiles: number | null;
  /** How often memory is sampled. */
  checkMs: number;
}

export const DEFAULT_PROCESS_LIMITS: ProcessLimits = { memoryMb: 512, openFiles: 1024, checkMs: 15_000 };

/**
 * Wrap a command so the file-descriptor limit applies before it starts: `sh -c 'ulimit …;
 * exec "$0" "$@"'`. The shell replaces itself, so the pid is the command's. No-op on Windows
 * or without a limit.
 */
export function withLimits(command: string, args: readonly string[], limits: Pick<ProcessLimits, 'openFiles'>): { command: string; args: string[] } {
  if (process.platform === 'win32' || limits.openFiles === null) return { command, args: [...args] };
  const n = Math.max(64, Math.floor(limits.openFiles));
  // Both limits: Node.js raises its soft limit to the hard one at startup, so a soft limit alone
  // would not hold. Lowering the hard limit is allowed without privileges; when the requested
  // value is above the current hard limit, only the soft one is tried (and failing that, nothing).
  return { command: '/bin/sh', args: ['-c', `ulimit -n ${n} 2>/dev/null || ulimit -S -n ${n} 2>/dev/null; exec "$0" "$@"`, command, ...args] };
}

interface ProcInfo {
  ppid: number;
  rssKb: number;
}

function readProcTable(): Map<number, ProcInfo> | null {
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  const table = new Map<number, ProcInfo>();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const status = fs.readFileSync(`/proc/${n}/status`, 'utf8');
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? NaN);
      const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      if (Number.isInteger(ppid)) table.set(Number(n), { ppid, rssKb });
    } catch {
      // The process exited while we looked.
    }
  }
  return table;
}

function psTable(): Promise<Map<number, ProcInfo> | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const table = new Map<number, ProcInfo>();
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), rssKb: Number(m[3]) });
      }
      resolve(table);
    });
  });
}

/** Resident memory of the processes with these pids and all their descendants, in bytes (null if unknown). */
export async function treeRss(pids: readonly number[]): Promise<Map<number, number> | null> {
  const table = process.platform === 'linux' ? readProcTable() : await psTable();
  if (!table) return null;
  const children = new Map<number, number[]>();
  for (const [pid, p] of table) children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid]);
  const out = new Map<number, number>();
  for (const root of pids) {
    if (!table.has(root)) continue;
    let kb = 0;
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      kb += table.get(pid)?.rssKb ?? 0;
      stack.push(...(children.get(pid) ?? []));
    }
    out.set(root, kb * 1024);
  }
  return out;
}

/**
 * Samples the memory of supervised processes and reports the ones over their limit; the
 * owner (plugin host, MCP manager) restarts them through its crash path.
 */
export class MemoryWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly o: {
      limits: () => ProcessLimits;
      /** id → pid of the processes to watch right now. */
      targets: () => Array<{ id: string; pid: number }>;
      onExceeded: (id: string, rssBytes: number, limitBytes: number) => void;
      /** Latest sample per id (metrics, status). */
      onSample?: (samples: Map<string, number>) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), Math.max(1000, this.o.limits().checkMs));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const targets = this.o.targets();
      if (targets.length === 0) return;
      const rss = await treeRss(targets.map((t) => t.pid));
      if (!rss) return;
      const samples = new Map<string, number>();
      const limitMb = this.o.limits().memoryMb;
      for (const t of targets) {
        const bytes = rss.get(t.pid);
        if (bytes === undefined) continue;
        samples.set(t.id, bytes);
        if (limitMb !== null && bytes > limitMb * 1024 * 1024) this.o.onExceeded(t.id, bytes, limitMb * 1024 * 1024);
      }
      this.o.onSample?.(samples);
    } finally {
      this.running = false;
    }
  }
}
