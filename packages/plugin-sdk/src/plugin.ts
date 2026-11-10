import {
  HOST_TO_PLUGIN,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_TO_HOST,
  RPC_ERRORS,
  RpcError,
  type ApprovalRequestParams,
  type ChatSendParams,
  type ChatSendResult,
  type ConfigChangedParams,
  type EventInput,
  type HealthResult,
  type HttpRequestParams,
  type HttpResponse,
  type InitializeParams,
  type InitializeResult,
  type Level,
  type LogParams,
  type PluginCapabilities,
  type PushResultMsg,
  type RpcPeer,
  type RunPhaseParams,
  type SettledParams,
  type StopParams,
  type ToolCallParams,
  type ToolCallResult,
  type ToolDecl,
  type Trigger,
} from '@protea/protocol';

/** What a plugin can ask of the host. Mirrors docs/10-architecture/07-plugin-system.md §6. */
export interface Host<C = Record<string, unknown>> {
  readonly id: string;
  /** Current configuration; replaced before onConfigChanged runs. */
  readonly config: C;
  readonly dataDir: string;
  readonly hostDataDir: string;
  readonly timezone: string;
  readonly language: string;
  readonly levelCap: Level;
  readonly allowedTriggers: readonly Trigger[];
  readonly mainModel: string;
  events: {
    push(input: EventInput): Promise<PushResultMsg>;
    promote(cursor: number, trigger: 'flush' | 'piggyback'): Promise<{ ok: boolean }>;
    withdraw(cursor: number): Promise<{ ok: boolean }>;
  };
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  log: Record<LogParams['level'], (msg: string, fields?: Record<string, unknown>) => void>;
  owner: { resolve(senderKey: string): Promise<'owner' | 'unknown'> };
  approvals: {
    decide(id: string, decision: 'approve' | 'deny', senderKey: string): Promise<{ ok: boolean; state?: string; message?: string }>;
  };
  /** A secret the manifest declared; the host injects it into the environment at start. */
  secret(name: string): string | undefined;
}

export interface ToolContext {
  signal: AbortSignal;
  callId: string;
  context: ToolCallParams['context'];
}

export interface PluginTool<I = any, C = Record<string, unknown>> extends Omit<ToolDecl, 'name'> {
  name: string;
  handler(input: I, ctx: ToolContext, host: Host<C>): Promise<ToolCallResult | string> | ToolCallResult | string;
}

export interface PluginDefinition<C = Record<string, unknown>> {
  displayName?: string;
  /** Extra capabilities beyond what the defined hooks imply. */
  capabilities?: Partial<PluginCapabilities>;
  start?(host: Host<C>): void | Promise<void>;
  stop?(host: Host<C>, reason: string): void | Promise<void>;
  tools?: PluginTool<any, C>[] | ((host: Host<C>) => PluginTool<any, C>[]);
  envPromptVars?(host: Host<C>): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  onConfigChanged?(host: Host<C>, patch: Record<string, unknown>, full: C): void | Promise<void>;
  onEventsSettled?(host: Host<C>, events: SettledParams['events']): void | Promise<void>;
  onRunPhase?(host: Host<C>, p: RunPhaseParams): void;
  health?(host: Host<C>): HealthResult | Promise<HealthResult>;
  shutdownVerify?(host: Host<C>): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Deliver an approval request to the owner. Declaring it advertises the `approvals` capability. */
  onApprovalRequest?(host: Host<C>, req: ApprovalRequestParams): Promise<{ delivered: boolean }> | { delivered: boolean };
  /** Makes the plugin a chat platform (with the manifest block `chat`): `chat_send` reaches the owner through it. */
  chat?: { send(host: Host<C>, req: ChatSendParams): Promise<ChatSendResult> | ChatSendResult };
  /** Webhook names this plugin serves under `/hooks/<name>`, decided from the initial config. */
  hooks?(config: C): string[];
  onHttpRequest?(host: Host<C>, req: HttpRequestParams): Promise<HttpResponse> | HttpResponse;
}

/** Identity helper that gives a plugin definition its types. */
export function definePlugin<C = Record<string, unknown>>(def: PluginDefinition<C>): PluginDefinition<C> {
  return def;
}

export interface ServeOptions {
  /** Called once the host asked the plugin to stop and the reply went out. */
  onStopped?: () => void;
  env?: Record<string, string | undefined>;
}

/**
 * Bind a plugin definition to an RPC peer: answers host requests and exposes the Host API.
 * Transport-independent; `runPlugin` connects it to stdio, the FakeHost to memory.
 */
export function servePlugin<C>(peer: RpcPeer, def: PluginDefinition<C>, opts: ServeOptions = {}): void {
  let init: InitializeParams | null = null;
  let config = {} as C;
  const calls = new Map<string, AbortController>();
  const env = opts.env ?? {};

  const host: Host<C> = {
    get id() {
      return init?.pluginId ?? '';
    },
    get config() {
      return config;
    },
    get dataDir() {
      return init?.dataDir ?? '';
    },
    get hostDataDir() {
      return init?.hostDataDir ?? '';
    },
    get timezone() {
      return init?.timezone ?? 'UTC';
    },
    get language() {
      return init?.language ?? 'en';
    },
    get levelCap() {
      return init?.levelCap ?? 4;
    },
    get allowedTriggers() {
      return init?.allowedTriggers ?? [];
    },
    get mainModel() {
      return init?.modelFacts.mainModel ?? '';
    },
    events: {
      push: (input) => peer.request<PushResultMsg>(PLUGIN_TO_HOST.eventsPush, input),
      promote: (cursor, trigger) => peer.request(PLUGIN_TO_HOST.eventsPromote, { cursor, trigger }),
      withdraw: (cursor) => peer.request(PLUGIN_TO_HOST.eventsWithdraw, { cursor }),
    },
    kv: {
      get: async <T>(key: string) => ((await peer.request<{ value?: T }>(PLUGIN_TO_HOST.kvGet, { key })).value ?? undefined) as T | undefined,
      set: async (key, value) => {
        await peer.request(PLUGIN_TO_HOST.kvSet, { key, value });
      },
      delete: async (key) => {
        await peer.request(PLUGIN_TO_HOST.kvDelete, { key });
      },
    },
    log: Object.fromEntries(
      (['trace', 'debug', 'info', 'warn', 'error'] as const).map((level) => [
        level,
        (msg: string, fields?: Record<string, unknown>) => peer.notify(PLUGIN_TO_HOST.log, { level, msg, ...(fields ? { fields } : {}) }),
      ]),
    ) as Host<C>['log'],
    owner: {
      resolve: async (senderKey) => (await peer.request<{ role: 'owner' | 'unknown' }>(PLUGIN_TO_HOST.ownerResolve, { senderKey })).role,
    },
    approvals: {
      decide: (id, decision, senderKey) => peer.request(PLUGIN_TO_HOST.approvalsDecide, { id, decision, senderKey }),
    },
    secret: (name) => env[name],
  };

  const toolList = (): PluginTool<any, C>[] => (typeof def.tools === 'function' ? def.tools(host) : (def.tools ?? []));
  const needInit = (): void => {
    if (!init) throw new RpcError(RPC_ERRORS.InvalidRequest, 'not initialized');
  };

  peer
    .handle(HOST_TO_PLUGIN.initialize, (params): InitializeResult => {
      init = params as InitializeParams;
      config = init.config as C;
      const hooks = def.hooks?.(config) ?? [];
      return {
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        capabilities: {
          tools: def.tools !== undefined,
          events: true,
          envPrompt: def.envPromptVars !== undefined,
          settled: def.onEventsSettled !== undefined,
          runPhase: def.onRunPhase !== undefined,
          shutdownVerify: def.shutdownVerify !== undefined,
          ...(def.onApprovalRequest ? { approvals: true } : {}),
          ...(def.chat ? { chat: true } : {}),
          ...(hooks.length > 0 ? { hooks } : {}),
          ...def.capabilities,
        },
        ...(def.displayName ? { displayName: def.displayName } : {}),
      };
    })
    .handle(HOST_TO_PLUGIN.start, async () => {
      needInit();
      await def.start?.(host);
      return {};
    })
    .handle(HOST_TO_PLUGIN.stop, async (params) => {
      const p = params as StopParams;
      for (const c of calls.values()) c.abort('stopping');
      await def.stop?.(host, p?.reason ?? 'stop');
      if (opts.onStopped) setImmediate(opts.onStopped);
      return {};
    })
    .handle(HOST_TO_PLUGIN.configChanged, async (params) => {
      const p = params as ConfigChangedParams;
      config = p.full as C;
      await def.onConfigChanged?.(host, p.patch, config);
      return {};
    })
    .handle(HOST_TO_PLUGIN.toolsList, () => ({
      tools: toolList().map(({ handler: _h, ...decl }): ToolDecl => decl),
    }))
    .handle(HOST_TO_PLUGIN.toolsCall, async (params) => {
      const p = params as ToolCallParams;
      const tool = toolList().find((t) => t.name === p.name);
      if (!tool) throw new RpcError(RPC_ERRORS.ToolNotFound, `no tool ${p.name}`);
      const ac = new AbortController();
      calls.set(p.callId, ac);
      try {
        const out = await tool.handler(p.input, { signal: ac.signal, callId: p.callId, context: p.context }, host);
        return typeof out === 'string' ? { text: out } : out;
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), failed: true } satisfies ToolCallResult;
      } finally {
        calls.delete(p.callId);
      }
    })
    .handle(HOST_TO_PLUGIN.chatSend, async (params): Promise<ChatSendResult> => {
      needInit();
      if (!def.chat) throw new RpcError(RPC_ERRORS.MethodNotFound, 'this plugin is not a chat platform');
      try {
        return await def.chat.send(host, params as ChatSendParams);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })
    .handle(HOST_TO_PLUGIN.toolsCancel, (params) => {
      calls.get((params as { callId: string }).callId)?.abort('cancelled');
    })
    .handle(HOST_TO_PLUGIN.envPrompt, async () => ({ vars: def.envPromptVars ? await def.envPromptVars(host) : null }))
    .handle(HOST_TO_PLUGIN.eventsSettled, async (params) => {
      await def.onEventsSettled?.(host, (params as SettledParams).events);
    })
    .handle(HOST_TO_PLUGIN.runPhase, (params) => {
      def.onRunPhase?.(host, params as RunPhaseParams);
    })
    .handle(HOST_TO_PLUGIN.health, async () => (def.health ? await def.health(host) : { ok: true }))
    .handle(HOST_TO_PLUGIN.shutdownVerify, async () => ({ snapshot: def.shutdownVerify ? await def.shutdownVerify(host) : {} }))
    .handle(HOST_TO_PLUGIN.approvalsRequest, async (params) => {
      if (!def.onApprovalRequest) throw new RpcError(RPC_ERRORS.MethodNotFound, 'approvals are not supported');
      return def.onApprovalRequest(host, params as ApprovalRequestParams);
    })
    .handle(HOST_TO_PLUGIN.httpRequest, async (params) => {
      if (!def.onHttpRequest) throw new RpcError(RPC_ERRORS.MethodNotFound, 'hooks are not supported');
      return def.onHttpRequest(host, params as HttpRequestParams);
    });
}
