import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ErrorCode,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Prompt,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { EventInput, McpServerState, McpServerStatus, McpToolInfo } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { SecretStore } from '../config/secrets.js';
import type { SystemSegment } from '../providers/types.js';
import type { Logger } from '../observability/logger.js';
import type { PolicyDecision } from '../permissions/policy.js';
import type { PluginHostSettings } from '../plugins/settings.js';
import type { PromptSkill, PromptSource } from '../skills/registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDef, ToolOutcome, ToolSpec } from '../tools/types.js';
import { sleep } from '../util/abort.js';
import { DEFAULT_PROCESS_LIMITS, MemoryWatchdog, passthroughEnv, withLimits } from '../util/child-process.js';
import { errorMessage } from '../util/errors.js';
import { matchesAny } from '../util/glob.js';
import type { Clock } from '../util/time.js';
import { mcpOwner, mcpToolName } from './names.js';
import { FileOAuthProvider } from './oauth.js';
import { serverWarnings } from './presets.js';
import type { McpServerSettings, McpSettings } from './settings.js';

type Supervision = Pick<PluginHostSettings, 'restartBackoffMs' | 'maxCrashes' | 'stableAfterMs' | 'initializeTimeoutMs' | 'drainTimeoutMs'> &
  Partial<Pick<PluginHostSettings, 'limits'>>;

export interface McpManagerOptions {
  tools: ToolRegistry;
  bus: Bus;
  log: Logger;
  clock: Clock;
  dataDir: string;
  version: string;
  secrets?: SecretStore;
  settings: () => McpSettings;
  supervision: () => Supervision;
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'>) => void;
  /** An event from a server (resource updates), with source `mcp:<id>`. */
  pushEvent: (server: string, input: Omit<EventInput, 'ts' | 'origin'>) => void;
  /** Stores an image a server returned (base64); without it images stay lines of text. */
  keepImage?: (data: string, server: string) => { handle: string; mime: string } | { reason: string };
  /** Where the browser returns after an OAuth authorization (`<control>/api/mcp/oauth/callback`). */
  redirectUrl: () => string;
}

interface Entry {
  id: string;
  settings: McpServerSettings;
  state: McpServerState;
  error?: string;
  client: Client | null;
  transport: Transport | null;
  /** The transport that started an OAuth authorization; finishes it once the code arrives. */
  authTransport?: StreamableHTTPClientTransport | SSEClientTransport;
  oauth?: FileOAuthProvider;
  authorizeUrl?: string;
  closing: boolean;
  /** Bumped on every start and stop; callbacks from an older connection are ignored. */
  generation: number;
  tools: McpToolInfo[];
  prompts: Prompt[];
  resources: boolean;
  server?: { name: string; version: string };
  /** What the server says about itself in `initialize` (clipped). */
  instructions?: string;
  pid?: number;
  crashes: number;
  restarts: number;
  startedAt: number;
  busy: number;
  latencies: number[];
  stderr: string[];
  /** Resident memory of the server process tree at the last sample (stdio). */
  rssBytes?: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  listTimers: Partial<Record<'tools' | 'prompts' | 'resources', ReturnType<typeof setTimeout>>>;
  op: Promise<void>;
}

const RESOURCE_OWNER = 'mcp';
const STDERR_TAIL = 20;
const MAX_PAGES = 50;
/** How much of a server's `instructions` is kept. */
const MAX_INSTRUCTIONS_CHARS = 2000;
const LOG_LEVELS = { debug: 'debug', info: 'info', notice: 'info', warning: 'warn', error: 'error', critical: 'error', alert: 'error', emergency: 'error' } as const;

/** Tool input schemas from servers may name a draft or carry ids that clash across tools. */
function cleanSchema(schema: Tool['inputSchema']): Record<string, unknown> {
  const { $schema: _s, $id: _i, ...rest } = schema as Record<string, unknown>;
  return { ...rest, type: 'object' };
}

interface ContentLike {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
  resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
}

function base64Bytes(b64: string | undefined): number {
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

function contentText(c: ContentLike): string {
  switch (c.type) {
    case 'text':
      return c.text ?? '';
    case 'image':
    case 'audio':
      return `[${c.type} ${c.mimeType ?? ''}, ${base64Bytes(c.data)} bytes]`;
    case 'resource_link':
      return `[resource link: ${c.uri ?? ''}${c.name ? ` (${c.name})` : ''}]`;
    case 'resource': {
      const r = c.resource;
      if (!r) return '[resource]';
      if (typeof r.text === 'string') return `[resource ${r.uri}]\n${r.text}`;
      return `[resource ${r.uri}, ${r.mimeType ?? 'binary'}, ${base64Bytes(r.blob)} bytes]`;
    }
    default:
      return `[${c.type} content]`;
  }
}

/** Keeps an image a server returned; without it, or on refusal, the image stays a line of text. */
export type McpImageSink = (data: string) => { handle: string; mime: string } | { reason: string };

/** A CallToolResult as tool-result text and stored images. */
export function renderCallResult(r: Record<string, unknown>, keepImage?: McpImageSink): ToolOutcome {
  const content = Array.isArray(r['content']) ? (r['content'] as ContentLike[]) : [];
  const images: Array<{ handle: string; mime: string }> = [];
  const render = (c: ContentLike): string => {
    if (c.type !== 'image' || !keepImage || typeof c.data !== 'string') return contentText(c);
    const kept = keepImage(c.data);
    if ('reason' in kept) return `${contentText(c)} (not shown: ${kept.reason})`;
    images.push(kept);
    return '';
  };
  let text = content.map(render).filter((t) => t !== '').join('\n');
  if (!text && images.length > 0) return r['isError'] === true ? { text: `[${images.length} image(s)]`, failed: true } : { text: `[${images.length} image(s)]`, images };
  if (!text && r['structuredContent'] !== undefined) text = JSON.stringify(r['structuredContent']);
  if (!text && r['toolResult'] !== undefined) text = JSON.stringify(r['toolResult']);
  if (!text) text = '(no content)';
  if (r['isError'] === true) return { text, failed: true };
  return images.length > 0 ? { text, images } : { text };
}

function isConnectionClosed(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.ConnectionClosed;
}

/**
 * The MCP client side (docs/10-architecture/09-mcp-integration.md): one connection per
 * configured server over stdio, Streamable HTTP or SSE, supervised like an out-of-process
 * plugin (backoff restarts, `maxCrashes` → failed, pings). Tools register as
 * `mcp__<server>__<tool>`; prompts feed the Skills catalog; resources are reachable through
 * `mcp_resource_list` / `mcp_resource_read`. Tool-list changes reach the model at the next
 * request, which is always built at a turn boundary.
 */
export class McpManager implements PromptSource {
  private deferredProbe: ((toolName: string) => boolean) | null = null;
  private readonly entries = new Map<string, Entry>();
  /** Removed servers still stopping; a server re-added under the same id starts after that. */
  private readonly retiring = new Map<string, Entry>();
  private stopping = false;

  private readonly watchdog: MemoryWatchdog;

  constructor(private readonly o: McpManagerOptions) {
    this.watchdog = new MemoryWatchdog({
      limits: () => o.supervision().limits ?? DEFAULT_PROCESS_LIMITS,
      targets: () =>
        [...this.entries.values()].flatMap((e) =>
          e.state === 'running' && e.pid !== undefined ? [{ id: e.id, pid: e.pid, ...(e.settings.memoryMb !== undefined ? { memoryMb: e.settings.memoryMb } : {}) }] : [],
        ),
      onSample: (samples) => {
        for (const [id, bytes] of samples) {
          const e = this.entries.get(id);
          if (e) e.rssBytes = bytes;
        }
      },
      onExceeded: (id, bytes, limit) => {
        const e = this.entries.get(id);
        if (!e || e.state !== 'running') return;
        const reason = `memory limit exceeded (${Math.round(bytes / 1048576)} MB > ${Math.round(limit / 1048576)} MB)`;
        o.log.error({ mcp: id, rssMb: Math.round(bytes / 1048576), limitMb: Math.round(limit / 1048576) }, 'MCP server over its memory limit; restarting it');
        const gen = e.generation;
        void this.serialize(e, () => this.lost(e, gen, reason));
      },
    });
    this.watchdog.start();
  }

  /** Make the running servers match `servers` (config load and every hot reload). */
  async apply(servers: Record<string, McpServerSettings>): Promise<void> {
    const ops: Promise<void>[] = [];
    for (const [id, s] of Object.entries(servers)) {
      const e = this.entries.get(id);
      if (!e) {
        const n = this.newEntry(id, s);
        const old = this.retiring.get(id);
        if (old) n.op = old.op;
        this.entries.set(id, n);
        if (s.enabled) ops.push(this.serialize(n, () => this.startEntry(n)));
        else this.emit(n);
        continue;
      }
      if (JSON.stringify(e.settings) === JSON.stringify(s)) continue;
      e.settings = s;
      ops.push(
        this.serialize(e, async () => {
          await this.stopEntry(e, s.enabled ? 'reconfigured' : 'disabled');
          e.crashes = 0;
          if (s.enabled) await this.startEntry(e);
        }),
      );
    }
    for (const [id, e] of [...this.entries]) {
      if (id in servers) continue;
      this.entries.delete(id);
      this.retiring.set(id, e);
      ops.push(
        this.serialize(e, async () => {
          await this.stopEntry(e, 'removed');
          if (this.retiring.get(id) === e) this.retiring.delete(id);
        }),
      );
    }
    await Promise.all(ops);
  }

  status(): McpServerStatus[] {
    return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => this.statusOf(e));
  }

  get(id: string): McpServerStatus | undefined {
    const e = this.entries.get(id);
    return e ? this.statusOf(e) : undefined;
  }

  /** Every tool the server lists, including those `tools.allow` / `tools.deny` filter out. */
  toolsOf(id: string): McpToolInfo[] | undefined {
    return this.entries.get(id)?.tools;
  }

  restart(id: string): Promise<McpServerStatus> {
    const e = this.must(id);
    return this.serialize(e, async () => {
      await this.stopEntry(e, 'restart requested');
      e.crashes = 0;
      if (e.settings.enabled) await this.startEntry(e);
    }).then(() => this.statusOf(e));
  }

  /**
   * Start (or resume) the OAuth authorization of a server: returns the URL the owner has to
   * open, or none when the server is already authorized.
   */
  async authorize(id: string): Promise<{ authorizeUrl?: string; state: McpServerState }> {
    const e = this.must(id);
    if (e.settings.auth.type !== 'oauth') throw new Error(`MCP server ${id} does not use OAuth`);
    if (e.state !== 'auth_required' || !e.authorizeUrl) {
      await this.serialize(e, async () => {
        await this.stopEntry(e, 'authorization requested');
        e.crashes = 0;
        await this.startEntry(e);
      });
    }
    return { ...(e.authorizeUrl ? { authorizeUrl: e.authorizeUrl } : {}), state: e.state };
  }

  /** The browser came back from the authorization server. */
  async finishAuth(state: string, code: string): Promise<McpServerStatus> {
    const e = [...this.entries.values()].find((x) => x.oauth && x.oauth.pendingState() === state);
    if (!e || !e.oauth) throw new Error('no MCP authorization is waiting for this state');
    const oauth = e.oauth;
    if (e.authTransport) await e.authTransport.finishAuth(code);
    else await auth(oauth, { serverUrl: e.settings.url as string, authorizationCode: code });
    await this.serialize(e, async () => {
      await this.stopEntry(e, 'authorized');
      e.crashes = 0;
      if (e.settings.enabled) await this.startEntry(e);
    });
    return this.statusOf(e);
  }

  /** What a running server says about itself (`initialize` instructions), by tool owner (`mcp:<id>`). */
  instructionsOf(owner: string): string | undefined {
    const e = this.entries.get(owner.startsWith('mcp:') ? owner.slice(4) : owner);
    return e?.state === 'running' ? e.instructions : undefined;
  }

  /** Lets the status say how many of a server's tools are deferred (decided by the tool exposure). */
  setDeferredProbe(probe: ((toolName: string) => boolean) | null): void {
    this.deferredProbe = probe;
  }

  /** `env:mcp:<id>` segments of running servers that have an operator-written envPrompt. */
  envSegments(): SystemSegment[] {
    return [...this.entries.values()]
      .filter((e) => e.state === 'running' && e.settings.envPrompt)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((e) => ({ id: `env:mcp:${e.id}`, text: (e.settings.envPrompt as string).trim() }));
  }

  /** Default policy from annotations and trust (docs/10-architecture/09-mcp-integration.md §6). */
  policyFor(def: ToolDef): PolicyDecision | null {
    if (!def.owner.startsWith('mcp:')) return null;
    const id = def.owner.slice(4);
    const e = this.entries.get(id);
    const info = e?.tools.find((t) => t.name === def.name);
    if (!e || !info) return null;
    if (info.readOnly) return { policy: 'allow', rule: `readOnlyHint of MCP server ${id}` };
    if (e.settings.trust === 'low') return { policy: 'ask', rule: `MCP server ${id} has trust low` };
    if (e.settings.trust === 'normal' && info.destructive) return { policy: 'ask', rule: `destructiveHint of MCP server ${id}` };
    return null;
  }

  // —— Prompts as skills ——

  prompts(): PromptSkill[] {
    const out: PromptSkill[] = [];
    for (const e of this.entries.values()) {
      if (e.state !== 'running') continue;
      for (const p of e.prompts) {
        out.push({
          server: e.id,
          prompt: p.name,
          description: p.description ?? p.title ?? '',
          arguments: (p.arguments ?? []).map((a) => ({
            name: a.name,
            ...(a.description ? { description: a.description } : {}),
            ...(a.required ? { required: true } : {}),
          })),
        });
      }
    }
    return out;
  }

  async render(server: string, prompt: string, args: Record<string, string>, signal: AbortSignal): Promise<string> {
    const e = this.running(server);
    const r = await (e.client as Client).getPrompt({ name: prompt, arguments: args }, { signal });
    const parts: string[] = [];
    if (r.description) parts.push(r.description);
    for (const m of r.messages) parts.push(`[${m.role}]\n${contentText(m.content as ContentLike)}`);
    return parts.join('\n\n');
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    this.watchdog.stop();
    await Promise.all([...this.retiring.values()].map((e) => e.op));
    await Promise.all([...this.entries.values()].map((e) => this.serialize(e, () => this.stopEntry(e, 'shutdown'))));
  }

  // —— Lifecycle ——

  private newEntry(id: string, settings: McpServerSettings): Entry {
    return {
      id,
      settings,
      state: 'loaded',
      client: null,
      transport: null,
      closing: false,
      generation: 0,
      tools: [],
      prompts: [],
      resources: false,
      crashes: 0,
      restarts: 0,
      startedAt: 0,
      busy: 0,
      latencies: [],
      stderr: [],
      restartTimer: null,
      pingTimer: null,
      listTimers: {},
      op: Promise.resolve(),
    };
  }

  private must(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown MCP server ${id}`);
    return e;
  }

  private running(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown MCP server ${id}`);
    if (e.state !== 'running' || !e.client) throw new Error(`MCP server ${id} is not running (${e.state})`);
    return e;
  }

  /** Lifecycle operations on one server run one at a time. */
  private serialize<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const run = e.op.then(fn, fn);
    e.op = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private emit(e: Entry): void {
    this.o.bus.emit('mcp.changed', this.statusOf(e));
  }

  private statusOf(e: Entry): McpServerStatus {
    const avg = e.latencies.length ? Math.round(e.latencies.reduce((a, b) => a + b, 0) / e.latencies.length) : undefined;
    const probe = this.deferredProbe;
    const deferred = probe && e.state === 'running' ? e.tools.filter((t) => !t.filtered && probe(t.name)).length : 0;
    return {
      id: e.id,
      transport: e.settings.transport,
      state: e.state,
      enabled: e.settings.enabled,
      trust: e.settings.trust,
      origin: 'config',
      ...(e.server ? { server: e.server } : {}),
      tools: e.tools.filter((t) => !t.filtered).map((t) => t.name),
      prompts: e.prompts.length,
      resources: e.resources,
      ...(e.pid !== undefined ? { pid: e.pid } : {}),
      ...(e.pid !== undefined && e.rssBytes !== undefined ? { memoryBytes: e.rssBytes } : {}),
      ...(e.restarts ? { restarts: e.restarts } : {}),
      ...(e.error ? { error: e.error } : {}),
      ...(e.authorizeUrl && e.state === 'auth_required' ? { authorizeUrl: e.authorizeUrl } : {}),
      ...(avg !== undefined ? { avgLatencyMs: avg } : {}),
      ...(serverWarnings(e.settings.args).length > 0 ? { warnings: serverWarnings(e.settings.args) } : {}),
      ...(e.instructions ? { instructions: e.instructions } : {}),
      ...(e.settings.alwaysLoad ? { alwaysLoad: true } : {}),
      ...(deferred > 0 ? { deferredTools: deferred } : {}),
    };
  }

  /** Resolve `${secret:NAME}` references inside a string. */
  private resolve(value: string): string {
    return value.replace(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g, (_, name: string) => {
      const v = this.o.secrets?.get(name);
      if (v === undefined) throw new Error(`secret ${name} is not set`);
      return v;
    });
  }

  private transportFor(e: Entry, log: Logger): Transport {
    const s = e.settings;
    if (s.transport === 'stdio') {
      const cwd = s.cwd ? path.resolve(this.o.dataDir, s.cwd) : path.join(this.o.dataDir, 'plugin-data', 'mcp', e.id);
      fs.mkdirSync(cwd, { recursive: true });
      const env: Record<string, string> = { ...getDefaultEnvironment(), ...passthroughEnv() };
      for (const [k, v] of Object.entries(s.env)) env[k] = this.resolve(v);
      const limited = withLimits(s.command as string, s.args.map((a) => this.resolve(a)), this.o.supervision().limits ?? DEFAULT_PROCESS_LIMITS);
      const t = new StdioClientTransport({
        command: limited.command,
        args: limited.args,
        env,
        cwd,
        stderr: 'pipe',
      });
      let partial = '';
      t.stderr?.on('data', (chunk: Buffer) => {
        const lines = (partial + chunk.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          e.stderr.push(line);
          if (e.stderr.length > STDERR_TAIL) e.stderr.shift();
          log.debug({ stderr: line }, 'server stderr');
        }
      });
      return t;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers)) headers[k] = this.resolve(v);
    if (s.auth.type === 'bearer') headers['Authorization'] = `Bearer ${this.resolve(s.auth.token)}`;
    let authProvider: FileOAuthProvider | undefined;
    if (s.auth.type === 'oauth') {
      const a = s.auth;
      authProvider = new FileOAuthProvider({
        file: path.join(this.o.dataDir, 'secrets', 'mcp-oauth', `${e.id}.json`),
        redirectUrl: this.o.redirectUrl(),
        ...(a.scopes ? { scopes: a.scopes } : {}),
        ...(a.clientId ? { clientId: a.clientId } : {}),
        ...(a.clientSecret ? { clientSecret: this.resolve(a.clientSecret) } : {}),
        onAuthorize: (url) => {
          e.authorizeUrl = url.href;
        },
      });
      e.oauth = authProvider;
    }
    const url = new URL(s.url as string);
    const opts = { requestInit: { headers }, ...(authProvider ? { authProvider } : {}) };
    const t = s.transport === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
    if (authProvider) e.authTransport = t;
    return t;
  }

  private async startEntry(e: Entry): Promise<void> {
    if (this.stopping) return;
    const gen = ++e.generation;
    const sup = this.o.supervision();
    const log = this.o.log.child({ mcp: e.id });
    e.state = 'starting';
    e.startedAt = 0;
    e.stderr = [];
    delete e.error;
    delete e.authorizeUrl;
    delete e.pid;
    this.emit(e);
    let transport: Transport;
    try {
      transport = this.transportFor(e, log);
    } catch (err) {
      // A configuration problem (missing secret): restarting would not help.
      e.state = 'failed';
      e.error = errorMessage(err);
      log.error({ err: e.error }, 'MCP server not started');
      this.emit(e);
      return;
    }
    const client = new Client({ name: 'protea', version: this.o.version }, { capabilities: { roots: { listChanged: false } } });
    this.wire(e, client, gen, log);
    e.client = client;
    e.transport = transport;
    try {
      await client.connect(transport, { timeout: sup.initializeTimeoutMs });
    } catch (err) {
      if (gen !== e.generation) return;
      await this.closeQuietly(e);
      if (err instanceof UnauthorizedError || (e.settings.auth.type === 'oauth' && e.authorizeUrl)) {
        e.state = 'auth_required';
        e.error = 'authorization required';
        log.warn({ authorizeUrl: e.authorizeUrl }, 'MCP server needs authorization');
        this.emit(e);
        this.o.pushInternal({
          type: 'mcp.auth_required',
          level: 2,
          trigger: 'flush',
          text: `MCP server ${e.id} needs the owner's authorization before its tools can be used.${e.authorizeUrl ? ` The owner can open ${e.authorizeUrl}` : ''} (or run: protea mcp auth ${e.id}).`,
        });
        return;
      }
      return this.crashed(e, `could not start: ${errorMessage(err)}${this.stderrHint(e)}`);
    }
    if (gen !== e.generation) return;
    if (transport instanceof StdioClientTransport && transport.pid !== null) e.pid = transport.pid;
    const info = client.getServerVersion();
    if (info) e.server = { name: info.name, version: info.version };
    const instructions = client.getInstructions()?.trim();
    if (instructions) e.instructions = instructions.slice(0, MAX_INSTRUCTIONS_CHARS);
    else delete e.instructions;
    const caps = client.getServerCapabilities() ?? {};
    try {
      await this.refreshTools(e);
      e.prompts = caps.prompts ? await this.listPrompts(client) : [];
      e.resources = !!caps.resources;
      if (caps.resources?.subscribe) for (const uri of e.settings.subscribe) await client.subscribeResource({ uri });
    } catch (err) {
      if (gen !== e.generation) return;
      await this.closeQuietly(e);
      return this.crashed(e, `listing failed: ${errorMessage(err)}`);
    }
    if (gen !== e.generation) return;
    e.state = 'running';
    e.startedAt = this.o.clock.now();
    this.syncResourceTools();
    this.startPing(e, gen, log);
    log.info({ tools: e.tools.length, prompts: e.prompts.length, server: e.server }, 'MCP server running');
    this.emit(e);
  }

  private wire(e: Entry, client: Client, gen: number, log: Logger): void {
    client.onclose = () => {
      if (gen !== e.generation || e.closing) return;
      void this.serialize(e, () => this.lost(e, gen, `the server closed the connection${this.stderrHint(e)}`));
    };
    client.onerror = (err) => log.debug({ err: errorMessage(err) }, 'MCP transport error');
    const roots = (e.settings.roots ?? ['workspace']).map((r) => path.join(this.o.dataDir, r));
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: roots.map((dir) => {
        fs.mkdirSync(dir, { recursive: true });
        return { uri: pathToFileURL(dir).href, name: path.basename(dir) };
      }),
    }));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.listChanged(e, gen, 'tools'));
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => this.listChanged(e, gen, 'prompts'));
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.listChanged(e, gen, 'resources'));
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      if (gen !== e.generation) return;
      this.o.pushEvent(e.id, {
        type: `mcp.${e.id}.resource_updated`,
        level: 4,
        trigger: 'piggyback',
        text: `MCP server ${e.id}: resource ${n.params.uri} was updated. Read it with mcp_resource_read if it matters.`,
        dedupeKey: `resource:${n.params.uri}:${Math.floor(this.o.clock.now() / 60_000)}`,
      });
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      const level = LOG_LEVELS[n.params.level] ?? 'info';
      log[level]({ logger: n.params.logger, data: n.params.data }, 'server log');
    });
  }

  private listChanged(e: Entry, gen: number, what: 'tools' | 'prompts' | 'resources'): void {
    if (gen !== e.generation) return;
    const prev = e.listTimers[what];
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      delete e.listTimers[what];
      void this.serialize(e, async () => {
        if (gen !== e.generation || e.state !== 'running' || !e.client) return;
        try {
          if (what === 'tools') await this.refreshTools(e);
          if (what === 'prompts') e.prompts = await this.listPrompts(e.client);
          this.o.log.info({ mcp: e.id, what }, 'MCP list changed');
          this.emit(e);
        } catch (err) {
          this.o.log.warn({ mcp: e.id, what, err: errorMessage(err) }, 'could not re-read the list');
        }
      });
    }, this.o.settings().listChangedDebounceMs);
    t.unref();
    e.listTimers[what] = t;
  }

  private async refreshTools(e: Entry): Promise<void> {
    const client = e.client as Client;
    const listed: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.listTools(cursor ? { cursor } : undefined);
      listed.push(...r.tools);
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    const { allow, deny } = e.settings.tools;
    const infos: McpToolInfo[] = [];
    const specs: ToolSpec<never>[] = [];
    for (const t of listed.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const readOnly = t.annotations?.readOnlyHint === true;
      const filtered = (allow !== undefined && !matchesAny(t.name, allow)) || (deny !== undefined && matchesAny(t.name, deny));
      const name = mcpToolName(e.id, t.name);
      const description = e.settings.descriptionOverrides[t.name] ?? (t.description || t.title || `${t.name} (MCP server ${e.id})`);
      infos.push({
        name,
        mcpName: t.name,
        description,
        readOnly,
        destructive: !readOnly && t.annotations?.destructiveHint === true,
        ...(filtered ? { filtered: true } : {}),
      });
      if (filtered) continue;
      const spec: ToolSpec<Record<string, unknown>> = {
        name,
        description,
        inputSchema: cleanSchema(t.inputSchema),
        flags: readOnly ? { readOnly: true, interruptible: true } : { sideEffect: true, interruptible: true },
        timeoutMs: e.settings.toolTimeoutMs,
        deferrable: e.settings.alwaysLoad !== true,
        externalSchema: true,
        handler: (input, ctx) => this.callTool(e, t.name, input, ctx.signal),
      };
      specs.push(spec as unknown as ToolSpec<never>);
    }
    this.o.tools.replaceOwner(mcpOwner(e.id), specs, `the MCP server ${e.id} no longer offers it`);
    e.tools = infos;
  }

  private async listPrompts(client: Client): Promise<Prompt[]> {
    const out: Prompt[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.listPrompts(cursor ? { cursor } : undefined);
      out.push(...r.prompts);
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  private async callTool(e: Entry, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const client = e.client;
    if (!client || e.state !== 'running') {
      return { text: `MCP server ${e.id} is not running (${e.state}${e.error ? `: ${e.error}` : ''})`, failed: true };
    }
    const started = this.o.clock.now();
    e.busy++;
    try {
      const r = await client.callTool({ name, arguments: input ?? {} }, undefined, {
        signal,
        timeout: e.settings.toolTimeoutMs + 5_000,
        resetTimeoutOnProgress: true,
      });
      return renderCallResult(r as Record<string, unknown>, this.o.keepImage ? (data) => (this.o.keepImage as NonNullable<McpManagerOptions['keepImage']>)(data, e.id) : undefined);
    } catch (err) {
      if (signal.aborted) throw err; // the dispatcher words the timeout or cancellation
      if (isConnectionClosed(err)) return { text: `failed: the MCP server ${e.id} exited during the call; it restarts on its own, so you may retry`, failed: true };
      return { text: `MCP server ${e.id}: ${errorMessage(err)}`, failed: true };
    } finally {
      e.busy--;
      e.latencies.push(this.o.clock.now() - started);
      if (e.latencies.length > 20) e.latencies.shift();
    }
  }

  private startPing(e: Entry, gen: number, log: Logger): void {
    const interval = this.o.settings().pingIntervalMs;
    if (interval <= 0) return;
    let misses = 0;
    let inflight = false;
    e.pingTimer = setInterval(() => {
      if (inflight || gen !== e.generation || e.state !== 'running' || !e.client) return;
      inflight = true;
      e.client
        .ping({ timeout: Math.min(10_000, interval) })
        .then(
          () => {
            misses = 0;
          },
          (err: unknown) => {
            misses++;
            log.warn({ misses, err: errorMessage(err) }, 'MCP ping failed');
            if (misses >= 3) void this.serialize(e, () => this.lost(e, gen, 'it did not answer three pings in a row'));
          },
        )
        .finally(() => {
          inflight = false;
        });
    }, interval);
    e.pingTimer.unref();
  }

  /** The connection went away on its own. */
  private async lost(e: Entry, gen: number, reason: string): Promise<void> {
    if (gen !== e.generation || (e.state !== 'running' && e.state !== 'starting')) return;
    this.o.log.warn({ mcp: e.id, reason }, 'MCP server connection lost');
    await this.closeQuietly(e);
    this.crashed(e, reason);
  }

  private crashed(e: Entry, reason: string): void {
    this.clearTimers(e);
    this.o.tools.unregisterOwner(mcpOwner(e.id), `the MCP server ${e.id} is down (${reason}); it restarts on its own`);
    e.prompts = [];
    e.resources = false;
    this.syncResourceTools();
    const sup = this.o.supervision();
    if (e.startedAt > 0 && this.o.clock.now() - e.startedAt >= sup.stableAfterMs) e.crashes = 0;
    e.crashes++;
    e.error = reason;
    delete e.pid;
    if (e.crashes >= sup.maxCrashes) {
      e.state = 'failed';
      this.o.log.error({ mcp: e.id, crashes: e.crashes, reason }, 'MCP server failed');
      this.emit(e);
      this.o.pushInternal({
        type: 'mcp.failed',
        level: 2,
        trigger: 'flush',
        text: `MCP server ${e.id} failed ${e.crashes} times in a row and is no longer restarted (${reason}). Its tools are unavailable until the owner restarts it.`,
      });
      return;
    }
    e.state = 'crashed';
    this.emit(e);
    this.o.pushInternal({ type: 'mcp.crashed', level: 4, trigger: 'store', text: `MCP server ${e.id} went down (${reason}); restarting.` });
    const delays = sup.restartBackoffMs;
    const delay = delays[Math.min(e.crashes - 1, delays.length - 1)] ?? 1000;
    e.restartTimer = setTimeout(() => {
      e.restartTimer = null;
      void this.serialize(e, async () => {
        if (e.state !== 'crashed') return;
        e.restarts++;
        await this.startEntry(e);
      });
    }, delay);
    e.restartTimer.unref();
  }

  private async stopEntry(e: Entry, reason: string): Promise<void> {
    this.clearTimers(e);
    e.generation++;
    const wasUp = e.client !== null;
    this.o.tools.unregisterOwner(mcpOwner(e.id), `the MCP server ${e.id} was ${reason === 'removed' ? 'removed' : `stopped (${reason})`}`);
    if (wasUp) {
      e.state = 'draining';
      this.emit(e);
      const deadline = this.o.clock.now() + this.o.supervision().drainTimeoutMs;
      while (e.busy > 0 && this.o.clock.now() < deadline) await sleep(25);
      await this.closeQuietly(e);
    }
    e.prompts = [];
    e.resources = false;
    delete e.pid;
    this.syncResourceTools();
    if (e.state !== 'failed' || reason !== 'shutdown') e.state = 'stopped';
    this.o.log.info({ mcp: e.id, reason }, 'MCP server stopped');
    this.emit(e);
  }

  private clearTimers(e: Entry): void {
    if (e.restartTimer) clearTimeout(e.restartTimer);
    if (e.pingTimer) clearInterval(e.pingTimer);
    for (const t of Object.values(e.listTimers)) if (t) clearTimeout(t);
    e.restartTimer = null;
    e.pingTimer = null;
    e.listTimers = {};
  }

  private async closeQuietly(e: Entry): Promise<void> {
    const client = e.client;
    e.client = null;
    e.transport = null;
    if (!client) return;
    e.closing = true;
    try {
      await client.close();
    } catch (err) {
      this.o.log.debug({ mcp: e.id, err: errorMessage(err) }, 'MCP close failed');
    } finally {
      e.closing = false;
    }
  }

  private stderrHint(e: Entry): string {
    const tail = e.stderr.slice(-3).join(' | ');
    return tail ? `; stderr: ${tail.slice(0, 500)}` : '';
  }

  // —— Resources ——

  /** `mcp_resource_list` / `mcp_resource_read` exist while some running server offers resources. */
  private syncResourceTools(): void {
    const any = [...this.entries.values()].some((e) => e.state === 'running' && e.resources);
    const have = this.o.tools.namesOf(RESOURCE_OWNER).length > 0;
    if (any === have) return;
    this.o.tools.replaceOwner(RESOURCE_OWNER, any ? this.resourceTools() : [], 'no running MCP server offers resources');
  }

  private resourceTools(): ToolSpec<never>[] {
    const list: ToolSpec<{ server: string; cursor?: string }> = {
      name: 'mcp_resource_list',
      description: 'List the resources (files, records, documents) an MCP server offers, with their URIs.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['server'],
        properties: { server: { type: 'string', description: 'MCP server id.' }, cursor: { type: 'string', description: 'Next page.' } },
      },
      flags: { readOnly: true },
      handler: async (input, ctx) => {
        const e = this.resourceServer(input.server);
        if (typeof e === 'string') return { text: e, failed: true };
        const client = e.client as Client;
        const r = await client.listResources(input.cursor ? { cursor: input.cursor } : undefined, { signal: ctx.signal });
        const lines = r.resources.map((x) => `${x.uri}${x.name ? ` — ${x.name}` : ''}${x.mimeType ? ` (${x.mimeType})` : ''}${x.description ? `: ${x.description}` : ''}`);
        try {
          const tpl = await client.listResourceTemplates(undefined, { signal: ctx.signal });
          for (const t of tpl.resourceTemplates) lines.push(`template ${t.uriTemplate}${t.name ? ` — ${t.name}` : ''}${t.description ? `: ${t.description}` : ''}`);
        } catch {
          // templates are optional
        }
        if (r.nextCursor) lines.push(`(more: call again with cursor "${r.nextCursor}")`);
        return lines.length ? lines.join('\n') : '(no resources)';
      },
    };
    const read: ToolSpec<{ server: string; uri: string }> = {
      name: 'mcp_resource_read',
      description: 'Read one resource of an MCP server by its URI.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['server', 'uri'],
        properties: { server: { type: 'string', description: 'MCP server id.' }, uri: { type: 'string' } },
      },
      flags: { readOnly: true },
      handler: async (input, ctx) => {
        const e = this.resourceServer(input.server);
        if (typeof e === 'string') return { text: e, failed: true };
        const r = await (e.client as Client).readResource({ uri: input.uri }, { signal: ctx.signal });
        const parts = r.contents.map((c) =>
          'text' in c && typeof c.text === 'string' ? c.text : `[${c.mimeType ?? 'binary'} ${base64Bytes((c as { blob?: string }).blob)} bytes]`,
        );
        return parts.join('\n') || '(empty)';
      },
    };
    return [list, read] as unknown as ToolSpec<never>[];
  }

  private resourceServer(id: string): Entry | string {
    const e = this.entries.get(id);
    const offering = [...this.entries.values()].filter((x) => x.state === 'running' && x.resources).map((x) => x.id);
    if (!e || e.state !== 'running' || !e.client) return `MCP server ${id} is not running. Servers with resources: ${offering.join(', ') || 'none'}`;
    if (!e.resources) return `MCP server ${id} offers no resources. Servers with resources: ${offering.join(', ') || 'none'}`;
    return e;
  }
}
