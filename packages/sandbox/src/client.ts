import net from 'node:net';
import { RPC_ERRORS, RpcError, RpcPeer } from '@protea/protocol';
import { SANDBOX_METHODS as M, SANDBOX_PROTOCOL_VERSION, type HelloResult, type JobEnded, type JobInfo, type JobStartParams, type ShellRunParams, type ShellRunResult } from './protocol.js';

export interface SandboxClientOptions {
  socket: string;
  /** A job ended; also called for the ones that ended while nobody was connected. */
  onJobEnded?: (e: JobEnded) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** How long a call waits for the connection before it fails. */
  connectWaitMs?: number;
}

const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const CANCEL_WAIT_MS = 10_000;

/**
 * The plugin's side of the socket: keeps one connection, reconnects with a backoff, and
 * reports a sandbox that is not there in words the model can act on. Everything that comes back
 * is untrusted output of the sandbox.
 */
export class SandboxClient {
  private peer: RpcPeer | null = null;
  private sock: net.Socket | null = null;
  private stopped = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError = 'not connected yet';
  private hello: HelloResult | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly o: SandboxClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sock?.destroy();
    this.peer?.close();
    this.peer = null;
    this.sock = null;
    this.hello = null;
    this.wake();
  }

  get connected(): boolean {
    return this.hello !== null;
  }

  get problem(): string | null {
    return this.connected ? null : this.lastError;
  }

  get workspace(): string | undefined {
    return this.hello?.workspace;
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    const delay = BACKOFF_MS[Math.min(this.attempts++, BACKOFF_MS.length - 1)] as number;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref();
  }

  private connect(): void {
    if (this.stopped || this.sock) return;
    const sock = net.createConnection(this.o.socket);
    this.sock = sock;
    const peer = new RpcPeer({
      write: (line) => {
        if (!sock.destroyed) sock.write(line);
      },
      onProtocolError: (message) => this.o.log?.('sandbox protocol error', { message }),
    });
    peer.handle(M.jobEnded, (p) => this.o.onJobEnded?.(p as JobEnded));
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFERED_BYTES) {
        sock.destroy(new Error('the sandbox sent an oversized message'));
        return;
      }
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        peer.receive(line);
      }
    });
    sock.once('connect', () => {
      peer
        .request<HelloResult>(M.hello, undefined, { timeoutMs: 10_000 })
        .then((hello) => {
          if (hello.protocolVersion !== SANDBOX_PROTOCOL_VERSION) {
            this.lastError = `the sandbox speaks protocol ${hello.protocolVersion}, this plugin ${SANDBOX_PROTOCOL_VERSION}: use the same image for both containers`;
            sock.destroy();
            return;
          }
          this.peer = peer;
          this.hello = hello;
          this.attempts = 0;
          this.o.log?.('connected to the sandbox', { instance: hello.instance });
          this.wake();
          for (const e of hello.unacked) this.o.onJobEnded?.(e);
        })
        .catch((err: Error) => {
          this.lastError = err.message;
          sock.destroy();
        });
    });
    sock.on('error', (err: NodeJS.ErrnoException) => {
      this.lastError = err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? `nothing is listening on ${this.o.socket}` : err.message;
    });
    sock.once('close', () => {
      peer.close(new Error('the sandbox connection was lost'));
      if (this.sock === sock) {
        this.sock = null;
        this.peer = null;
        this.hello = null;
      }
      this.retry();
    });
  }

  private async ready(): Promise<RpcPeer> {
    if (this.peer) return this.peer;
    if (this.stopped) throw new Error('the sandbox client is stopped');
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.o.connectWaitMs ?? 2000);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    if (!this.peer) throw new Error(`the sandbox is not reachable: ${this.lastError}. Start it with the Compose profile "sandbox".`);
    return this.peer;
  }

  /** A foreground command. Cancelling asks the agent to stop it, so the partial output still comes back. */
  async run(params: ShellRunParams, signal?: AbortSignal): Promise<ShellRunResult> {
    const peer = await this.ready();
    const call = peer.request<ShellRunResult>(M.shellRun, params);
    if (!signal) return call;
    const onAbort = (): void => {
      peer.notify(M.shellCancel, { runId: params.runId });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await call;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async reset(session: string): Promise<void> {
    await (await this.ready()).request(M.sessionReset, { session }, { timeoutMs: CANCEL_WAIT_MS });
  }

  async jobStart(params: JobStartParams): Promise<JobInfo> {
    return (await this.ready()).request<JobInfo>(M.jobStart, params, { timeoutMs: CANCEL_WAIT_MS });
  }

  async jobList(): Promise<JobInfo[]> {
    return (await (await this.ready()).request<{ jobs: JobInfo[] }>(M.jobList, undefined, { timeoutMs: CANCEL_WAIT_MS })).jobs;
  }

  async jobLogs(id: string, tailBytes: number): Promise<{ job: JobInfo; text: string }> {
    return (await this.ready()).request(M.jobLogs, { id, tailBytes }, { timeoutMs: CANCEL_WAIT_MS });
  }

  async jobStop(id: string): Promise<JobInfo> {
    return (await this.ready()).request<JobInfo>(M.jobStop, { id }, { timeoutMs: 15_000 });
  }

  async jobAck(ids: string[]): Promise<void> {
    await this.peer?.request(M.jobAck, { ids }, { timeoutMs: CANCEL_WAIT_MS }).catch((err: unknown) => {
      if (!(err instanceof RpcError && err.code === RPC_ERRORS.Closed)) throw err;
    });
  }
}
