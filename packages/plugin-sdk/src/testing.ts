import {
  HOST_TO_PLUGIN,
  LEVEL_TRIGGERS,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_TO_HOST,
  RpcPeer,
  type ApprovalDecideParams,
  type ChatSendParams,
  type ChatSendResult,
  type EventInput,
  type HttpRequestParams,
  type HttpResponse,
  type InitializeResult,
  type Level,
  type LogParams,
  type PushResultMsg,
  type SettledParams,
  type ToolCallResult,
  type ToolDecl,
  type Trigger,
} from '@protea/protocol';
import { servePlugin, type PluginDefinition } from './plugin.js';

export interface FakeHostOptions {
  id?: string;
  config?: Record<string, unknown>;
  levelCap?: Level;
  dataDir?: string;
  hostDataDir?: string;
  /** Which senderKeys the fake owner registry recognises. */
  owners?: string[];
  env?: Record<string, string>;
}

const TYPE_RE = /^[a-z0-9-]+\.[a-z0-9_.-]+$/;

/**
 * An in-memory host for testing plugins without the daemon (docs/30-specs/03-plugin-protocol.md §7).
 * It records pushed events and checks them the way the real gate would flag them.
 */
export class FakeHost {
  readonly events: Array<EventInput & { cursor: number }> = [];
  /** Problems the real host would correct or reject (level above the cap, disallowed trigger, ...). */
  readonly violations: string[] = [];
  readonly logs: LogParams[] = [];
  readonly kv = new Map<string, unknown>();
  readonly decisions: ApprovalDecideParams[] = [];
  capabilities: InitializeResult['capabilities'] = {};
  private readonly host: RpcPeer;
  private cursor = 0;
  private readonly dedupe = new Map<string, number>();

  constructor(
    def: PluginDefinition<any>,
    private readonly o: FakeHostOptions = {},
  ) {
    let plugin: RpcPeer | null = null;
    // Deliver asynchronously in both directions, like a pipe.
    this.host = new RpcPeer({ write: (line) => queueMicrotask(() => plugin?.receive(line.trimEnd())) });
    plugin = new RpcPeer({ write: (line) => queueMicrotask(() => this.host.receive(line.trimEnd())) });
    servePlugin(plugin, def, { env: o.env ?? {} });

    const levelCap = o.levelCap ?? 4;
    this.host
      .handle(PLUGIN_TO_HOST.eventsPush, (p) => this.push(p as EventInput, levelCap))
      .handle(PLUGIN_TO_HOST.log, (p) => {
        this.logs.push(p as LogParams);
      })
      .handle(PLUGIN_TO_HOST.kvGet, (p) => ({ value: this.kv.get((p as { key: string }).key) }))
      .handle(PLUGIN_TO_HOST.kvSet, (p) => {
        const { key, value } = p as { key: string; value: unknown };
        this.kv.set(key, value);
        return {};
      })
      .handle(PLUGIN_TO_HOST.kvDelete, (p) => {
        this.kv.delete((p as { key: string }).key);
        return {};
      })
      .handle(PLUGIN_TO_HOST.ownerResolve, (p) => ({
        role: (o.owners ?? []).includes((p as { senderKey: string }).senderKey) ? 'owner' : 'unknown',
      }))
      .handle(PLUGIN_TO_HOST.approvalsDecide, (p) => {
        const d = p as ApprovalDecideParams;
        this.decisions.push(d);
        const owner = (o.owners ?? []).includes(d.senderKey);
        return owner ? { ok: true, state: d.decision === 'approve' ? 'approved' : 'denied' } : { ok: false, message: 'not the owner' };
      })
      .handle(PLUGIN_TO_HOST.eventsPromote, () => ({ ok: true }))
      .handle(PLUGIN_TO_HOST.eventsWithdraw, () => ({ ok: true }));
  }

  private push(e: EventInput, levelCap: Level): PushResultMsg {
    const where = `event ${e.type ?? '?'}`;
    if (typeof e.type !== 'string' || !TYPE_RE.test(e.type)) this.violations.push(`${where}: type must look like "<source>.<name>"`);
    if (typeof e.text !== 'string') this.violations.push(`${where}: text must be a string`);
    if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) this.violations.push(`${where}: ts must be an ISO 8601 time`);
    if (e.level < levelCap) this.violations.push(`${where}: level ${e.level} exceeds the cap ${levelCap}`);
    const allowed = LEVEL_TRIGGERS[Math.max(e.level, levelCap) as Level] ?? [];
    if (!allowed.includes(e.trigger)) this.violations.push(`${where}: trigger ${e.trigger} is not allowed at level ${e.level}`);
    if (e.origin === 'internal') this.violations.push(`${where}: plugins may not emit origin "internal"`);
    if (e.dedupeKey !== undefined) {
      const seen = this.dedupe.get(e.dedupeKey);
      if (seen !== undefined) {
        return { cursor: seen, effectiveLevel: e.level, effectiveTrigger: e.trigger, deduped: true, warnings: [] };
      }
    }
    const cursor = ++this.cursor;
    if (e.dedupeKey !== undefined) this.dedupe.set(e.dedupeKey, cursor);
    this.events.push({ ...e, cursor });
    return { cursor, effectiveLevel: Math.max(e.level, levelCap) as Level, effectiveTrigger: e.trigger as Trigger, deduped: false, warnings: [] };
  }

  /** initialize + start. */
  async start(): Promise<InitializeResult> {
    const levelCap = this.o.levelCap ?? 4;
    const result = await this.host.request<InitializeResult>(HOST_TO_PLUGIN.initialize, {
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
      pluginId: this.o.id ?? 'test',
      config: this.o.config ?? {},
      dataDir: this.o.dataDir ?? '/tmp/protea-fake-plugin',
      hostDataDir: this.o.hostDataDir ?? '/tmp/protea-fake-host',
      timezone: 'UTC',
      language: 'en',
      hostCapabilities: [],
      modelFacts: { mainModel: 'fake' },
      levelCap,
      allowedTriggers: [...new Set((Object.entries(LEVEL_TRIGGERS) as Array<[string, readonly Trigger[]]>).filter(([l]) => Number(l) >= levelCap).flatMap(([, t]) => t))],
    });
    this.capabilities = result.capabilities;
    await this.host.request(HOST_TO_PLUGIN.start, {});
    return result;
  }

  async tools(): Promise<ToolDecl[]> {
    return (await this.host.request<{ tools: ToolDecl[] }>(HOST_TO_PLUGIN.toolsList, {})).tools;
  }

  callTool(name: string, input: unknown, opts: { signal?: AbortSignal; callId?: string } = {}): Promise<ToolCallResult> {
    const callId = opts.callId ?? `call_${Math.random().toString(36).slice(2)}`;
    opts.signal?.addEventListener('abort', () => this.host.notify(HOST_TO_PLUGIN.toolsCancel, { callId }), { once: true });
    return this.host.request<ToolCallResult>(HOST_TO_PLUGIN.toolsCall, {
      callId,
      name,
      input,
      context: { sessionId: 'main', batchId: 'b_test', batchLevel: 1 },
    });
  }

  /** What `chat_send` would ask of this platform. */
  chatSend(req: ChatSendParams): Promise<ChatSendResult> {
    return this.host.request<ChatSendResult>(HOST_TO_PLUGIN.chatSend, req);
  }

  settled(events: SettledParams['events']): void {
    this.host.notify(HOST_TO_PLUGIN.eventsSettled, { events });
  }

  configChanged(patch: Record<string, unknown>): Promise<unknown> {
    const full = { ...(this.o.config ?? {}), ...patch };
    this.o.config = full;
    return this.host.request(HOST_TO_PLUGIN.configChanged, { patch, full });
  }

  http(req: Partial<HttpRequestParams> & { hook: string; body?: string }): Promise<HttpResponse> {
    return this.host.request<HttpResponse>(HOST_TO_PLUGIN.httpRequest, {
      method: 'POST',
      path: '',
      query: {},
      headers: {},
      bodyBase64: Buffer.from(req.body ?? '').toString('base64'),
      ...req,
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.host.request<T>(method, params);
  }

  /** Stop the plugin; calling it again is a no-op. */
  async stop(reason = 'test end'): Promise<void> {
    if (this.host.isClosed) return;
    await this.host.request(HOST_TO_PLUGIN.stop, { reason, deadlineMs: 1000 });
    this.host.close();
  }
}
