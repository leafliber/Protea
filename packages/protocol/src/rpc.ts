/**
 * JSON-RPC 2.0 over NDJSON (docs/30-specs/03-plugin-protocol.md §1). Transport-agnostic:
 * the owner feeds received lines to `receive()` and supplies `write()` for outgoing ones.
 * Used by the plugin host in Core and by the plugin SDK, so both ends behave the same.
 */

export const RPC_ERRORS = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  LevelExceeded: -32001,
  TriggerNotAllowed: -32002,
  Deduped: -32003,
  ToolNotFound: -32004,
  Cancelled: -32005,
  Draining: -32006,
  Unauthorized: -32007,
  Timeout: -32008,
  Closed: -32009,
} as const;

/** Largest accepted message, in bytes of UTF-8 (4 MB). */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export class RpcError extends Error {
  override readonly name = 'RpcError';
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Id = number | string;

interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RpcHandler = (params: unknown, ctx: { method: string; id?: Id }) => unknown;

export interface RpcPeerOptions {
  write: (line: string) => void;
  /** Called for malformed input and for failures of notification handlers. */
  onProtocolError?: (message: string, detail?: unknown) => void;
  maxMessageBytes?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
}

export class RpcPeer {
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly pending = new Map<Id, Pending>();
  private nextId = 1;
  private closed: Error | null = null;
  private fallback: RpcHandler | null = null;

  constructor(private readonly o: RpcPeerOptions) {}

  /** Register a handler for requests and notifications of `method`. */
  handle(method: string, handler: RpcHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Handler for methods without a specific one (it may throw MethodNotFound). */
  handleUnknown(handler: RpcHandler): this {
    this.fallback = handler;
    return this;
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(RPC_ERRORS.Closed, this.closed.message));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.settle(id)?.reject(new RpcError(RPC_ERRORS.Cancelled, `${method} cancelled`));
      };
      const p: Pending = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      };
      if (opts.timeoutMs !== undefined) {
        p.timer = setTimeout(() => {
          this.settle(id)?.reject(new RpcError(RPC_ERRORS.Timeout, `${method} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, p);
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      } catch (err) {
        this.settle(id)?.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** Feed one received line (without the trailing newline). */
  receive(line: string): void {
    if (line.trim() === '') return;
    const max = this.o.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    if (line.length > max) {
      this.o.onProtocolError?.(`message larger than ${max} bytes dropped`);
      return;
    }
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      this.o.onProtocolError?.('unparseable message', line.slice(0, 200));
      this.send({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.ParseError, message: 'parse error' } });
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.o.onProtocolError?.('message is not an object', line.slice(0, 200));
      return;
    }
    if (typeof msg.method === 'string') {
      void this.dispatch(msg);
      return;
    }
    if (msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const p = this.settle(msg.id);
      if (!p) return; // late answer to a request that timed out or was cancelled
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    this.o.onProtocolError?.('message is neither a request nor a response', line.slice(0, 200));
  }

  /** Reject everything in flight and refuse further traffic. */
  close(reason: Error = new Error('connection closed')): void {
    if (this.closed) return;
    this.closed = reason;
    for (const id of [...this.pending.keys()]) {
      this.settle(id)?.reject(new RpcError(RPC_ERRORS.Closed, reason.message));
    }
  }

  private settle(id: Id): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    p.cleanup();
    return p;
  }

  private send(msg: Message): void {
    if (this.closed && msg.method !== undefined) return;
    this.o.write(`${JSON.stringify(msg)}\n`);
  }

  private async dispatch(msg: Message): Promise<void> {
    const method = msg.method as string;
    const isRequest = msg.id !== undefined && msg.id !== null;
    const handler = this.handlers.get(method) ?? this.fallback;
    try {
      if (!handler) throw new RpcError(RPC_ERRORS.MethodNotFound, `method not found: ${method}`);
      const result = await handler(msg.params, { method, ...(isRequest ? { id: msg.id as Id } : {}) });
      if (isRequest && !this.closed) this.send({ jsonrpc: '2.0', id: msg.id as Id, result: result ?? null });
    } catch (err) {
      const e =
        err instanceof RpcError ? err : new RpcError(RPC_ERRORS.Internal, err instanceof Error ? err.message : String(err));
      if (isRequest) {
        if (!this.closed) {
          this.send({
            jsonrpc: '2.0',
            id: msg.id as Id,
            error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) },
          });
        }
      } else {
        this.o.onProtocolError?.(`notification ${method} failed: ${e.message}`);
      }
    }
  }
}

/** Turn a stream of text chunks into lines; a line longer than `maxBytes` is dropped whole. */
export function lineSplitter(onLine: (line: string) => void, opts: { maxBytes?: number; onOverflow?: () => void } = {}) {
  const max = opts.maxBytes ?? MAX_MESSAGE_BYTES;
  let buf = '';
  let skipping = false;
  return (chunk: string): void => {
    let text = chunk;
    for (;;) {
      const nl = text.indexOf('\n');
      if (nl === -1) {
        if (!skipping) buf += text;
        if (buf.length > max) {
          buf = '';
          skipping = true;
          opts.onOverflow?.();
        }
        return;
      }
      const piece = text.slice(0, nl);
      text = text.slice(nl + 1);
      if (skipping) {
        skipping = false;
        continue;
      }
      const line = buf + piece;
      buf = '';
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  };
}
