import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RPC_ERRORS, RpcError, RpcPeer } from '@protea/protocol';
import { commandEnv, runCommand } from './exec.js';
import {
  SANDBOX_METHODS as M,
  SANDBOX_PROTOCOL_VERSION,
  type HelloResult,
  type JobEnded,
  type JobInfo,
  type JobStartParams,
  type ShellRunParams,
  type ShellRunResult,
} from './protocol.js';

export interface SandboxAgentOptions {
  socket: string;
  home: string;
  workspace: string;
  shell?: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs a command with the session's state and, unless `next` is empty, leaves the state it
 * ended with in that directory. The agent adopts it only if the command ended by itself.
 * Arguments: state directory, next directory, default directory, explicit directory, command.
 */
const WRAPPER = `
__protea_state=$1; __protea_next=$2; __protea_home=$3; __protea_dir=$4; __protea_cmd=$5; shift 5
if [ -f "$__protea_state/env.sh" ]; then source "$__protea_state/env.sh" >/dev/null 2>&1; fi
if [ -n "$__protea_dir" ]; then cd -- "$__protea_dir" || exit 127
elif [ -f "$__protea_state/cwd" ] && cd -- "$(cat "$__protea_state/cwd")" 2>/dev/null; then :
else cd -- "$__protea_home" || exit 127; fi
__protea_save() {
  __protea_rc=$?
  set +eu
  trap - EXIT
  umask 077
  unset -f __protea_save
  if mkdir -p -- "$__protea_next" 2>/dev/null; then
    pwd -P > "$__protea_next/cwd" 2>/dev/null
    {
      for __protea_n in $(compgen -e); do
        case "$__protea_n" in BASHOPTS|SHELLOPTS|BASH_*|OLDPWD|PWD|SHLVL|_) continue ;; esac
        printf 'export %s=%q\\n' "$__protea_n" "\${!__protea_n}"
      done
      declare -f
    } > "$__protea_next/env.sh" 2>/dev/null
  fi
  exit "$__protea_rc"
}
if [ -n "$__protea_next" ]; then trap __protea_save EXIT; else unset -f __protea_save; fi
eval "$__protea_cmd"
`;

/** The largest shell state kept between commands. */
const MAX_STATE_BYTES = 1024 * 1024;
const FORK_STATE_TTL_MS = 7 * 86_400_000;
const KILL_GRACE_MS = 2000;
const KEPT_FINISHED_JOBS = 50;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** How long after the shell ends a command may keep the output pipes open. */
const EXIT_GRACE_MS = 300;
const TAIL_BYTES = 4096;

interface JobRuntime {
  child: ChildProcess;
  write: (chunk: Buffer) => void;
  stopping: boolean;
}

interface JobIndex {
  instance: string;
  nextId: number;
  jobs: Array<JobInfo & { acked: boolean }>;
}

/** A file's last bytes as text. */
function readTail(file: string, bytes: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, bytes);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      return buf.toString('utf8').replace(/^�+/, '');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function sessionKey(s: unknown): string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(s) || s.startsWith('.')) throw new RpcError(RPC_ERRORS.InvalidParams, 'invalid session');
  return s;
}

/**
 * The process inside the sandbox container: one unix socket, foreground commands with state
 * carried between them, and background jobs (ADR-0013). It holds no secrets and trusts its
 * only client; what it returns is treated by that client as untrusted output.
 */
export class SandboxAgent {
  private server: net.Server | null = null;
  private readonly peers = new Set<RpcPeer>();
  private readonly running = new Map<string, JobRuntime>();
  private readonly root: string;
  private readonly shell: string;
  private index!: JobIndex;
  private pruner: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(private readonly o: SandboxAgentOptions) {
    this.root = path.join(o.home, '.protea');
    this.shell = o.shell ?? '/bin/bash';
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.o.log?.(msg, fields);
  }

  private get indexFile(): string {
    return path.join(this.root, 'jobs', 'index.json');
  }

  private logFile(id: string, n = 0): string {
    return path.join(this.root, 'jobs', `${id}.log${n ? `.${n}` : ''}`);
  }

  private sessionDir(key: string): string {
    return path.join(this.root, 'sessions', key);
  }

  private persist(): void {
    try {
      const tmp = `${this.indexFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.index));
      fs.renameSync(tmp, this.indexFile);
    } catch (err) {
      // A full disk must not take the agent, and with it every running job, down.
      this.log('could not save the job index', { err: (err as Error).message });
    }
  }

  private loadIndex(): void {
    fs.mkdirSync(path.join(this.root, 'jobs'), { recursive: true, mode: 0o700 });
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as JobIndex;
    } catch {
      this.index = { instance: crypto.randomBytes(6).toString('hex'), nextId: 1, jobs: [] };
    }
    // Nothing survives a restart of the agent: its jobs went with the container.
    const at = new Date().toISOString();
    for (const j of this.index.jobs) {
      if (j.state !== 'running') continue;
      j.state = 'lost';
      j.endedAt = at;
      j.acked = false;
    }
    this.persist();
  }

  /** Listen on the socket. Replaces a stale socket file from a previous run. */
  async start(): Promise<void> {
    this.loadIndex();
    this.pruneSessions();
    this.pruner = setInterval(() => this.pruneSessions(), 3_600_000);
    this.pruner.unref();
    fs.mkdirSync(this.o.workspace, { recursive: true });
    fs.mkdirSync(path.dirname(this.o.socket), { recursive: true });
    fs.rmSync(this.o.socket, { force: true });
    const server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.o.socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(this.o.socket, 0o600);
    this.server = server;
    this.log('sandbox agent listening', { socket: this.o.socket, instance: this.index.instance });
  }

  /** Close the socket and end the jobs. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pruner) clearInterval(this.pruner);
    for (const r of this.running.values()) this.signal(r, 'SIGTERM');
    for (const p of this.peers) p.close();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(this.o.socket, { force: true });
    for (const r of this.running.values()) this.signal(r, 'SIGKILL');
  }

  private signal(r: JobRuntime, sig: NodeJS.Signals): void {
    try {
      if (r.child.pid !== undefined) process.kill(-r.child.pid, sig);
    } catch {
      // Already gone.
    }
  }

  private accept(sock: net.Socket): void {
    const runs = new Map<string, AbortController>();
    const peer = new RpcPeer({
      write: (line) => {
        if (!sock.destroyed) sock.write(line);
      },
      onProtocolError: (message) => this.log('protocol error', { message }),
    });
    this.bind(peer, runs);
    this.peers.add(peer);
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFERED_BYTES) {
        sock.destroy();
        return;
      }
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        peer.receive(line);
      }
    });
    const closed = (): void => {
      this.peers.delete(peer);
      peer.close();
      // Nobody is left to read the answer. Jobs keep running: that is what they are for.
      for (const c of runs.values()) c.abort();
    };
    sock.on('close', closed);
    sock.on('error', () => sock.destroy());
  }

  private bind(peer: RpcPeer, runs: Map<string, AbortController>): void {
    peer
      .handle(M.hello, (): HelloResult => ({
        protocolVersion: SANDBOX_PROTOCOL_VERSION,
        instance: this.index.instance,
        workspace: this.o.workspace,
        home: this.o.home,
        unacked: this.index.jobs.filter((j) => j.state !== 'running' && !j.acked).map((j) => this.ended(j)),
      }))
      .handle(M.shellRun, async (p) => {
        const params = p as ShellRunParams;
        const c = new AbortController();
        runs.set(params.runId, c);
        try {
          return await this.run(params, c.signal);
        } finally {
          runs.delete(params.runId);
        }
      })
      .handle(M.shellCancel, (p) => {
        runs.get((p as { runId: string }).runId)?.abort();
      })
      .handle(M.sessionReset, (p) => {
        fs.rmSync(this.sessionDir(sessionKey((p as { session: unknown }).session)), { recursive: true, force: true });
        return {};
      })
      .handle(M.jobStart, (p) => this.startJob(p as JobStartParams))
      .handle(M.jobList, () => ({ jobs: this.index.jobs.map(({ acked: _a, ...j }) => j).reverse() }))
      .handle(M.jobLogs, (p) => this.jobLogs(p as { id: string; tailBytes: number }))
      .handle(M.jobStop, (p) => this.stopJob((p as { id: string }).id))
      .handle(M.jobAck, (p) => {
        const ids = new Set((p as { ids: string[] }).ids);
        for (const j of this.index.jobs) if (ids.has(j.id)) j.acked = true;
        this.persist();
        return {};
      });
  }

  private env(extra?: Record<string, string>): Record<string, string> {
    const home = this.o.home;
    const from = this.o.env ?? process.env;
    const env = commandEnv(home, extra ?? {}, from);
    // Everything a command installs lands in the home volume, so it is still there after a restart.
    Object.assign(env, {
      PATH: [path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), env['PATH']].join(':'),
      npm_config_prefix: path.join(home, '.npm-global'),
      npm_config_cache: path.join(home, '.cache/npm'),
      npm_config_update_notifier: 'false',
      UV_CACHE_DIR: path.join(home, '.cache/uv'),
      UV_TOOL_DIR: path.join(home, '.local/share/uv/tools'),
      UV_TOOL_BIN_DIR: path.join(home, '.local/bin'),
      UV_PYTHON_INSTALL_DIR: path.join(home, '.local/share/uv/python'),
      PIP_CACHE_DIR: path.join(home, '.cache/pip'),
    });
    return env;
  }

  private explicitCwd(cwd: string | undefined): string {
    if (!cwd) return '';
    const dir = path.resolve(this.o.workspace, cwd);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new RpcError(RPC_ERRORS.InvalidParams, `${cwd} is not a directory`);
    return dir;
  }

  private async run(p: ShellRunParams, signal: AbortSignal): Promise<ShellRunResult> {
    const key = sessionKey(p.session);
    const state = this.sessionDir(key);
    const dir = this.explicitCwd(p.cwd);
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    const next = path.join(state, `.next-${crypto.randomBytes(4).toString('hex')}`);
    const r = await runCommand({
      shell: this.shell,
      args: ['-c', WRAPPER, 'protea-sh', state, next, this.o.workspace, dir, p.command],
      command: p.command,
      cwd: this.o.workspace,
      env: this.env(p.env),
      timeoutMs: p.timeoutMs,
      ...(p.stdin !== undefined ? { stdin: p.stdin } : {}),
      captureBytes: p.captureBytes,
      signal,
      exitGraceMs: EXIT_GRACE_MS,
    });
    const cwd = !r.timedOut && !r.aborted && r.signal === null ? this.adopt(state, next) : null;
    fs.rmSync(next, { recursive: true, force: true });
    return { ...r, ...(cwd ? { cwd } : {}) };
  }

  /** Make the state a command ended with the session's state. Returns its directory. */
  private adopt(state: string, next: string): string | null {
    try {
      const size = (f: string): number => fs.statSync(path.join(next, f)).size;
      if (size('env.sh') > MAX_STATE_BYTES || size('cwd') > 8192) return null;
      const cwd = fs.readFileSync(path.join(next, 'cwd'), 'utf8').trimEnd();
      fs.renameSync(path.join(next, 'env.sh'), path.join(state, 'env.sh'));
      fs.renameSync(path.join(next, 'cwd'), path.join(state, 'cwd'));
      return cwd;
    } catch {
      return null; // `exec` or a replaced EXIT trap: the command left no state.
    }
  }

  private startJob(p: JobStartParams): JobInfo {
    const key = sessionKey(p.session);
    const active = this.index.jobs.filter((j) => j.state === 'running').length;
    if (active >= p.maxRunning) throw new RpcError(RPC_ERRORS.InvalidRequest, `${active} jobs are already running (limit ${p.maxRunning}); stop one first`);
    const state = this.sessionDir(key);
    const dir = this.explicitCwd(p.cwd);
    const id = `j${this.index.nextId++}`;
    const env = this.env(p.env);
    fs.mkdirSync(env['TMPDIR'] as string, { recursive: true });
    const child = spawn(this.shell, ['-c', WRAPPER, 'protea-job', state, '', this.o.workspace, dir, p.command], {
      cwd: this.o.workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const job: JobInfo & { acked: boolean } = {
      id,
      ...(p.name ? { name: p.name } : {}),
      command: p.command,
      session: key,
      cwd: dir || this.o.workspace,
      state: 'running',
      startedAt: new Date().toISOString(),
      acked: false,
    };
    const rt: JobRuntime = { child, stopping: false, write: this.logWriter(id, p.logBytes) };
    child.stdout?.on('data', rt.write);
    child.stderr?.on('data', rt.write);
    child.once('error', (err) => {
      rt.write(Buffer.from(`${err.message}\n`));
      this.finishJob(job, rt, null, null);
    });
    child.once('close', (code, signal) => this.finishJob(job, rt, code, signal));
    this.running.set(id, rt);
    this.index.jobs.push(job);
    this.persist();
    const { acked: _a, ...info } = job;
    return info;
  }

  /** Appends to the job's log; two generations, so the log never holds more than `limit` bytes. */
  private logWriter(id: string, limit: number): (chunk: Buffer) => void {
    const file = this.logFile(id);
    const generation = Math.max(4096, Math.floor(limit / 2));
    let written = 0;
    let fd = fs.openSync(file, 'a', 0o600);
    return (chunk) => {
      try {
        if (written + chunk.length > generation) {
          fs.closeSync(fd);
          fs.renameSync(file, this.logFile(id, 1));
          fd = fs.openSync(file, 'a', 0o600);
          written = 0;
        }
        fs.writeSync(fd, chunk.length > generation ? chunk.subarray(chunk.length - generation) : chunk);
        written += Math.min(chunk.length, generation);
      } catch (err) {
        this.log('could not write a job log', { job: id, err: (err as Error).message });
      }
    };
  }

  private finishJob(job: JobInfo & { acked: boolean }, rt: JobRuntime, code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.running.has(job.id)) return;
    this.running.delete(job.id);
    // Shutting down: left as running, so the next start reports it as lost.
    if (this.stopping) return;
    // What it left behind in its group goes too, so an ended job holds no ports.
    this.signal(rt, 'SIGKILL');
    job.state = rt.stopping ? 'stopped' : 'exited';
    job.endedAt = new Date().toISOString();
    job.exitCode = code;
    job.signal = signal;
    // Stopping it was the assistant's own doing; there is nothing to tell it.
    job.acked = rt.stopping;
    this.pruneJobs();
    this.persist();
    if (!job.acked) for (const p of this.peers) p.notify(M.jobEnded, this.ended(job));
  }

  private ended(job: JobInfo & { acked?: boolean }): JobEnded {
    const { acked: _a, ...info } = job;
    return { instance: this.index.instance, job: info, tail: this.readLogTail(job.id, TAIL_BYTES) };
  }

  private readLogTail(id: string, bytes: number): string {
    const current = readTail(this.logFile(id), bytes);
    if (Buffer.byteLength(current) >= bytes) return current;
    return readTail(this.logFile(id, 1), bytes - Buffer.byteLength(current)) + current;
  }

  private jobLogs(p: { id: string; tailBytes: number }): { job: JobInfo; text: string } {
    const job = this.index.jobs.find((j) => j.id === p.id);
    if (!job) throw new RpcError(RPC_ERRORS.InvalidParams, `no job ${p.id}`);
    const { acked: _a, ...info } = job;
    return { job: info, text: this.readLogTail(p.id, p.tailBytes) };
  }

  private async stopJob(id: string): Promise<JobInfo> {
    const job = this.index.jobs.find((j) => j.id === id);
    if (!job) throw new RpcError(RPC_ERRORS.InvalidParams, `no job ${id}`);
    const rt = this.running.get(id);
    if (rt) {
      rt.stopping = true;
      this.signal(rt, 'SIGTERM');
      const killer = setTimeout(() => this.signal(rt, 'SIGKILL'), KILL_GRACE_MS);
      await new Promise<void>((resolve) => rt.child.once('close', () => resolve()));
      clearTimeout(killer);
    }
    const { acked: _a, ...info } = job;
    return info;
  }

  private pruneJobs(): void {
    const finished = this.index.jobs.filter((j) => j.state !== 'running' && j.acked);
    for (const j of finished.slice(0, Math.max(0, finished.length - KEPT_FINISHED_JOBS))) {
      fs.rmSync(this.logFile(j.id), { force: true });
      fs.rmSync(this.logFile(j.id, 1), { force: true });
      this.index.jobs.splice(this.index.jobs.indexOf(j), 1);
    }
  }

  /** A fork's shell state is of no use once the fork is gone. */
  private pruneSessions(): void {
    const dir = path.join(this.root, 'sessions');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const before = Date.now() - FORK_STATE_TTL_MS;
    for (const n of names) {
      if (n === 'main') continue;
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).mtimeMs < before) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Went away meanwhile.
      }
    }
  }
}
