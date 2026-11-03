/** Out-of-process plugin contract: manifest and protocol messages (docs/30-specs/02, 03). */
import type { EventInput, Level, TerminalOutcome, Trigger } from './events.js';
import type { RunPhase } from './session.js';

export const PLUGIN_API_VERSION = 1;
export const PLUGIN_PROTOCOL_VERSION = 1;

export const PLUGIN_KINDS = ['source', 'connector', 'tool', 'mcp', 'skill', 'provider'] as const;
export type PluginKindName = (typeof PLUGIN_KINDS)[number];

/** protea.plugin.json */
export interface PluginManifest {
  id: string;
  kind: PluginKindName;
  api: number;
  version: string;
  displayName?: string;
  description?: string;
  runtime?: {
    exec: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    inproc?: boolean;
    /** Used instead of exec/args when the host runs in development mode (sources instead of a build). */
    dev?: { exec?: string; args?: string[] };
  };
  level?: Level;
  triggers?: Trigger[];
  tools?: string[];
  /** Tools whose default permission policy is `ask`. */
  sideEffectTools?: string[];
  secrets?: string[];
  configSchema?: string;
  envPrompt?: string;
  healthcheck?: { intervalMs?: number; timeoutMs?: number };
  resources?: { maxMemoryMb?: number; maxCpu?: number; maxFds?: number };
  homepage?: string;
  repository?: string;
  license?: string;
}

export interface ToolDecl {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  flags?: { endsTurn?: boolean; barrierAfter?: boolean; interruptible?: boolean; readOnly?: boolean; sideEffect?: boolean };
  timeoutMs?: number;
}

// —— host → plugin ——

export interface InitializeParams {
  protocolVersion: number;
  pluginId: string;
  config: Record<string, unknown>;
  /** Read-write directory of the plugin (`<data>/plugin-data/<id>`). */
  dataDir: string;
  /** The daemon's data directory, for plugins that watch shared folders (e.g. `<data>/inbox`). */
  hostDataDir: string;
  timezone: string;
  language: string;
  hostCapabilities: string[];
  modelFacts: { mainModel: string };
  levelCap: Level;
  allowedTriggers: Trigger[];
}

export interface PluginCapabilities {
  tools?: boolean;
  events?: boolean;
  envPrompt?: boolean;
  runPhase?: boolean;
  settled?: boolean;
  shutdownVerify?: boolean;
  /** Can deliver approval requests to the owner (`approvals/request`). */
  approvals?: boolean;
  /** Webhook names served under `/hooks/<name>` (`http/request`). */
  hooks?: string[];
}

export interface InitializeResult {
  protocolVersion: number;
  capabilities: PluginCapabilities;
  displayName?: string;
}

export interface StopParams {
  reason: string;
  deadlineMs: number;
}

export interface ConfigChangedParams {
  patch: Record<string, unknown>;
  full: Record<string, unknown>;
}

export interface ToolCallParams {
  callId: string;
  name: string;
  input: unknown;
  context: { sessionId: string; batchId: string; batchLevel: Level; correlation?: string };
}

export interface ToolCallResult {
  text: string;
  failed?: boolean;
  partial?: boolean;
  endsTurn?: boolean;
  meta?: Record<string, unknown>;
}

export interface EnvPromptResult {
  vars: Record<string, unknown> | null;
}

export interface SettledParams {
  events: Array<{ cursor: number; outcome: TerminalOutcome }>;
}

export interface RunPhaseParams {
  phase: RunPhase;
  batchId?: string;
}

export interface HealthResult {
  ok: boolean;
  detail?: string;
}

export interface ApprovalRequestParams {
  id: string;
  tool: string;
  /** Redacted, size-limited summary of the input. */
  summary: string;
  reason?: string;
  expiresAt: string;
}

export interface HttpRequestParams {
  hook: string;
  method: string;
  /** Path below `/hooks/<hook>`, starting with "/" (or empty). */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Raw body, base64. */
  bodyBase64: string;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

// —— plugin → host ——

export type PushParams = EventInput;

export interface PushResultMsg {
  cursor: number;
  effectiveLevel: Level;
  effectiveTrigger: Trigger;
  deduped: boolean;
  warnings: string[];
}

export interface LogParams {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: Record<string, unknown>;
}

export interface ApprovalDecideParams {
  id: string;
  decision: 'approve' | 'deny';
  /** Who decided; must resolve to the owner for this plugin. */
  senderKey: string;
}

export const HOST_TO_PLUGIN = {
  initialize: 'initialize',
  start: 'start',
  stop: 'stop',
  configChanged: 'config/changed',
  toolsList: 'tools/list',
  toolsCall: 'tools/call',
  toolsCancel: 'tools/cancel',
  envPrompt: 'env/prompt',
  eventsSettled: 'events/settled',
  runPhase: 'run/phase',
  health: 'health',
  shutdownVerify: 'shutdown/verify',
  approvalsRequest: 'approvals/request',
  httpRequest: 'http/request',
} as const;

export const PLUGIN_TO_HOST = {
  eventsPush: 'events/push',
  eventsWithdraw: 'events/withdraw',
  eventsPromote: 'events/promote',
  eventsQuery: 'events/query',
  log: 'log',
  kvGet: 'kv/get',
  kvSet: 'kv/set',
  kvDelete: 'kv/delete',
  ownerResolve: 'owner/resolve',
  secretsExists: 'secrets/exists',
  approvalsDecide: 'approvals/decide',
} as const;

/** Lifecycle states (docs/10-architecture/07-plugin-system.md §4). */
export const PLUGIN_STATES = [
  'invalid',
  'loaded',
  'starting',
  'running',
  'draining',
  'stopped',
  'crashed',
  'failed',
] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];
