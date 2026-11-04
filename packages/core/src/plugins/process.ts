import { spawn, type ChildProcess } from 'node:child_process';
import {
  HOST_TO_PLUGIN,
  PLUGIN_PROTOCOL_VERSION,
  RpcPeer,
  lineSplitter,
  type ApprovalRequestParams,
  type HealthResult,
  type HttpRequestParams,
  type HttpResponse,
  type InitializeParams,
  type InitializeResult,
  type RpcHandler,
  type RunPhaseParams,
  type SettledParams,
  type ToolCallParams,
  type ToolCallResult,
  type ToolDecl,
} from '@protea/protocol';
import type { Logger } from '../observability/logger.js';
import { sleep } from '../util/abort.js';
import { errorMessage } from '../util/errors.js';

export interface ProcessPluginOptions {
  id: string;
  exec: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  log: Logger;
  /** plugin → host methods. */
  handlers: Record<string, RpcHandler>;
  initializeTimeoutMs: number;
  health: { intervalMs: number; timeoutMs: number };
  /** The process went away without being asked to (crash, kill, failed health checks). */
  onUnexpectedExit: (reason: string) => void;
}

export interface StartedPlugin {
  init: InitializeResult;
  tools: ToolDecl[];
}

/** One run of an out-of-process plugin: a child process speaking JSON-RPC over stdio. */
export class ProcessPlugin {
  private child: ChildProcess | null = null;
  private readonly peer: RpcPeer;
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private stopping = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthFailures = 0;
  private inflight = 0;
  private callSeq = 0;
  private stderrTail = '';

  constructor(private readonly o: ProcessPluginOptions) {
    this.peer = new RpcPeer({
      write: (line) => {
        const stdin = this.child?.stdin;
        if (stdin && !stdin.destroyed) stdin.write(line);
      },
      onProtocolError: (msg, detail) => o.log.warn({ detail }, `protocol error: ${msg}`),
    });
    for (const [method, handler] of Object.entries(o.handlers)) this.peer.handle(method, handler);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Tool calls currently running in the plugin. */
  get busyCalls(): number {
    return this.inflight;
  }

  /** Last lines the plugin wrote to stderr (for error reports). */
  get stderr(): string {
    return this.stderrTail.trim();
  }

  async start(params: Omit<InitializeParams, 'protocolVersion'>): Promise<StartedPlugin> {
    const o = this.o;
    const child = spawn(o.exec, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (err) => {
        this.stderrTail += `\n${err.message}`;
        resolve({ code: -1, signal: null });
      });
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on(
      'data',
      lineSplitter((line) => this.peer.receive(line), { onOverflow: () => o.log.warn('plugin sent an oversized message; dropped') }),
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      for (const line of chunk.split('\n')) if (line.trim()) o.log.debug({ stream: 'stderr' }, line);
    });
    child.stdin?.on('error', () => {}); // EPIPE after the child died; the exit handler reports it
    void this.exited.then(({ code, signal }) => {
      this.peer.close(new Error(`plugin ${o.id} exited (${signal ?? `code ${code}`})`));
      this.stopHealth();
      if (!this.stopping) o.onUnexpectedExit(`process exited (${signal ?? `code ${code}`})${this.stderr ? `: ${this.stderr.split('\n').at(-1)}` : ''}`);
    });

    try {
      const init = await Promise.race([
        this.peer.request<InitializeResult>(HOST_TO_PLUGIN.initialize, { protocolVersion: PLUGIN_PROTOCOL_VERSION, ...params }, {
          timeoutMs: o.initializeTimeoutMs,
        }),
        this.exited.then(() => {
          throw new Error(`exited during initialize${this.stderr ? `: ${this.stderr.split('\n').slice(-3).join(' | ')}` : ''}`);
        }),
      ]);
      if (init.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
        throw new Error(`speaks protocol ${init.protocolVersion}, the host speaks ${PLUGIN_PROTOCOL_VERSION}`);
      }
      const tools = init.capabilities.tools ? (await this.peer.request<{ tools: ToolDecl[] }>(HOST_TO_PLUGIN.toolsList, {}, { timeoutMs: o.initializeTimeoutMs })).tools : [];
      await this.peer.request(HOST_TO_PLUGIN.start, {}, { timeoutMs: o.initializeTimeoutMs });
      this.startHealth();
      return { init, tools: Array.isArray(tools) ? tools : [] };
    } catch (err) {
      await this.kill();
      throw err;
    }
  }

  private startHealth(): void {
    const { intervalMs, timeoutMs } = this.o.health;
    if (intervalMs <= 0) return;
    this.healthTimer = setInterval(() => {
      this.peer
        .request<HealthResult>(HOST_TO_PLUGIN.health, {}, { timeoutMs })
        .then((h) => {
          this.healthFailures = 0;
          if (h && h.ok === false) this.o.log.warn({ detail: h.detail }, 'plugin reports unhealthy');
        })
        .catch(() => {
          this.healthFailures++;
          this.o.log.warn({ failures: this.healthFailures }, 'health check failed');
          if (this.healthFailures >= 3) {
            this.stopHealth();
            this.child?.kill('SIGKILL'); // the exit handler reports the crash
          }
        });
    }, intervalMs);
    this.healthTimer.unref();
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  async callTool(name: string, input: unknown, context: ToolCallParams['context'], signal: AbortSignal): Promise<ToolCallResult> {
    const callId = `c${++this.callSeq}`;
    const onAbort = (): void => this.peer.notify(HOST_TO_PLUGIN.toolsCancel, { callId });
    signal.addEventListener('abort', onAbort, { once: true });
    this.inflight++;
    try {
      return await this.peer.request<ToolCallResult>(HOST_TO_PLUGIN.toolsCall, { callId, name, input, context });
    } finally {
      this.inflight--;
      signal.removeEventListener('abort', onAbort);
    }
  }

  async envPrompt(language: string): Promise<Record<string, unknown> | null> {
    const r = await this.peer.request<{ vars: Record<string, unknown> | null }>(HOST_TO_PLUGIN.envPrompt, { language }, { timeoutMs: 5000 });
    return r?.vars ?? null;
  }

  configChanged(patch: Record<string, unknown>, full: Record<string, unknown>): Promise<unknown> {
    return this.peer.request(HOST_TO_PLUGIN.configChanged, { patch, full }, { timeoutMs: 10_000 });
  }

  settled(events: SettledParams['events']): void {
    this.peer.notify(HOST_TO_PLUGIN.eventsSettled, { events });
  }

  runPhase(p: RunPhaseParams): void {
    this.peer.notify(HOST_TO_PLUGIN.runPhase, p);
  }

  approvalRequest(p: ApprovalRequestParams): Promise<{ delivered: boolean }> {
    return this.peer.request(HOST_TO_PLUGIN.approvalsRequest, p, { timeoutMs: 15_000 });
  }

  http(p: HttpRequestParams): Promise<HttpResponse> {
    return this.peer.request(HOST_TO_PLUGIN.httpRequest, p, { timeoutMs: 15_000 });
  }

  /** A raw request (conformance checks and the development host). */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    return this.peer.request<T>(method, params, { timeoutMs });
  }

  /** Ask the plugin to stop; escalate to SIGTERM after `deadlineMs`, then SIGKILL after 5 s. Reports how it ended. */
  async stop(reason: string, deadlineMs: number): Promise<'exited' | 'terminated' | 'killed' | 'not running'> {
    if (!this.child || !this.exited) return 'not running';
    this.stopping = true;
    this.stopHealth();
    const exited = this.exited;
    try {
      await Promise.race([this.peer.request(HOST_TO_PLUGIN.stop, { reason, deadlineMs }, { timeoutMs: deadlineMs }), exited]);
    } catch (err) {
      this.o.log.debug({ err: errorMessage(err) }, 'stop request did not complete');
    }
    if (await this.waitExit(exited, deadlineMs)) return 'exited';
    this.o.log.warn('plugin did not exit after stop; sending SIGTERM');
    this.child.kill('SIGTERM');
    if (await this.waitExit(exited, 5000)) return 'terminated';
    this.o.log.warn('plugin ignored SIGTERM; killing it');
    this.child.kill('SIGKILL');
    await exited;
    return 'killed';
  }

  /** Kill immediately (failed start, health failure, shutdown deadline passed). */
  /** Kill the process as if it had crashed (memory limit): the exit goes through onUnexpectedExit. */
  crash(): void {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  async kill(): Promise<void> {
    if (!this.child || !this.exited) return;
    this.stopping = true;
    this.stopHealth();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.exited;
  }

  private async waitExit(exited: Promise<unknown>, ms: number): Promise<boolean> {
    return Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
  }
}
