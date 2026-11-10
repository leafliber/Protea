/** Out-of-process plugin contract: manifest and protocol messages (docs/30-specs/02, 03). */
import type { EventInput, Level, TerminalOutcome, Trigger } from './events.js';
import type { PermissionMode } from './control.js';
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
  /** Injected when set, but the plugin also starts without them (a sign-in fills them in). */
  optionalSecrets?: string[];
  configSchema?: string;
  envPrompt?: string;
  /** Directory of skills the plugin ships (default `skills/`), relative to the plugin. */
  skills?: string;
  /** Present on a chat platform; the plugin must also advertise the `chat` capability and answer `chat/send`. */
  chat?: ChatPlatformDecl;
  /** Present on a plugin an operator signs in to; it must also advertise the `login` capability. */
  login?: PluginLoginDecl;
  healthcheck?: { intervalMs?: number; timeoutMs?: number };
  resources?: { maxMemoryMb?: number; maxCpu?: number; maxFds?: number };
  homepage?: string;
  repository?: string;
  license?: string;
}

/** Formatting a chat platform shows. */
export const CHAT_MARKDOWN = ['none', 'basic', 'full'] as const;
export type ChatMarkdown = (typeof CHAT_MARKDOWN)[number];

/** A connector that is a chat platform: `chat_send` can reach the owner through it (docs/30-specs/02-plugin-manifest.md). */
export interface ChatPlatformDecl {
  displayName?: string;
  markdown?: ChatMarkdown;
  /** Longest single message the platform shows; longer text is the plugin's to split. */
  maxChars?: number;
}

/** How an operator signs in to a plugin (docs/30-specs/02-plugin-manifest.md). */
export const PLUGIN_LOGIN_METHODS = ['qr'] as const;
export type PluginLoginMethod = (typeof PLUGIN_LOGIN_METHODS)[number];

export interface PluginLoginDecl {
  method: PluginLoginMethod;
}

/**
 * `idle`: not signed in and nothing in progress. `waiting` and `scanned`: a QR code is on offer.
 * `need_code`: the phone shows a number the operator has to type (`login/submit`).
 * `connected`: signed in. `already_bound`: the service says this account is already linked and
 * issued no new credentials. `failed`: the attempt is over; `message` says why.
 */
export const PLUGIN_LOGIN_STATES = ['idle', 'waiting', 'scanned', 'need_code', 'connected', 'already_bound', 'failed'] as const;
export type PluginLoginState = (typeof PLUGIN_LOGIN_STATES)[number];

export interface PluginLoginStatus {
  state: PluginLoginState;
  /** The text to encode as a QR code; the host renders it. */
  qr?: string;
  expiresAt?: string;
  message?: string;
  /** Who is signed in, for display. */
  account?: string;
}

export interface LoginSubmitParams {
  code: string;
}

/** `login/complete`: the sign-in succeeded. Only accepted while a sign-in the host started is open. */
export interface LoginCompleteParams {
  /** Stored in the secret store; every name must be declared in the manifest. */
  secrets: Record<string, string>;
  /** Becomes the owner on this plugin (`owner.identities`), replacing its previous owner. */
  ownerSenderKey?: string;
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
  /** Can send the owner a chat message (`chat/send`). */
  chat?: boolean;
  /** Webhook names served under `/hooks/<name>` (`http/request`). */
  hooks?: string[];
  /** Answers `login/*`: an operator can sign in to it from the console. */
  login?: boolean;
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

/** An image a tool returns: first stored with `blob/put`. */
export interface ToolImageRef {
  handle: string;
}

export interface ToolCallResult {
  text: string;
  failed?: boolean;
  partial?: boolean;
  endsTurn?: boolean;
  meta?: Record<string, unknown>;
  /** Images that go to the model with the text (not on a failed call). */
  images?: ToolImageRef[];
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

/** `chat/send`: deliver this to the owner on the plugin's platform. */
export interface ChatSendParams {
  text: string;
  /** Platform message id to reply to (the `correlation` of the owner's `chat.message`). */
  replyTo?: string;
  sessionId?: string;
  batchId?: string;
}

export interface ChatSendResult {
  ok: boolean;
  /** Platform ids of what was sent (a long text may take several messages). */
  messageIds?: string[];
  /** ok: false: why, in words the model can act on. */
  error?: string;
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
  /** With an approval: also allow this tool family for this long (capped by permissions.grantMaxMs). */
  grantMs?: number;
}

/** `permissions/mode`: read the permission mode, or change it with `mode`. */
export interface PermissionModeParams {
  /** Who asked; must resolve to the owner for this plugin. */
  senderKey: string;
  mode?: PermissionMode;
  /** With `mode`: a temporary mode for this long. Without it the mode becomes the baseline. */
  forMs?: number;
}

/** `blob/put`: store an image. Only images are accepted; the type is read from the bytes. */
export interface BlobPutParams {
  dataBase64: string;
  /** What the plugin believes it is; the bytes decide. */
  mime?: string;
}

export interface BlobPutResult {
  handle: string;
  mime: string;
  size: number;
}

export interface BlobGetParams {
  handle: string;
}

export interface BlobGetResult {
  dataBase64: string;
  mime: string;
  size: number;
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
  chatSend: 'chat/send',
  httpRequest: 'http/request',
  loginStart: 'login/start',
  loginStatus: 'login/status',
  loginSubmit: 'login/submit',
  loginCancel: 'login/cancel',
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
  permissionsMode: 'permissions/mode',
  blobPut: 'blob/put',
  blobGet: 'blob/get',
  loginComplete: 'login/complete',
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
