/** Out-of-process plugin contract: manifest and protocol messages (docs/30-specs/02, 03). */
import type { EventInput, Level, TerminalOutcome, Trigger } from './events.js';
import type { ApprovalView, PermissionMode } from './control.js';
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

/** Options the owner can tap instead of typing (docs/10-architecture/17-chat-and-console.md). */
export interface ChatChoices {
  options: Array<{ label: string; detail?: string }>;
  /** Several options can be chosen at once. */
  multiple?: boolean;
}

/** A stored inline widget, as a platform is told about it. */
export interface ChatWidgetRef {
  id: string;
  title: string;
  /** Its page in the web console; present when `control.publicUrl` is set. */
  url?: string;
}

/** `meta.answer` of a `chat.message`: the owner chose among the options of the message `to`. */
export interface ChatAnswer {
  /** The `callId` of the `chat_send` that offered the options. */
  to: string;
  labels: string[];
}

/** Structured parts of a reply that are still being written while its text streams. */
export const CHAT_PENDING = ['images', 'choices', 'widget'] as const;
export type ChatPending = (typeof CHAT_PENDING)[number];

/** How often a platform takes draft updates when it does not say (ms), and the least it may ask for. */
export const CHAT_DRAFT_INTERVAL_MS = 1000;
export const CHAT_DRAFT_MIN_INTERVAL_MS = 250;

/** A connector that is a chat platform: `chat_send` can reach the owner through it (docs/30-specs/02-plugin-manifest.md). */
export interface ChatPlatformDecl {
  displayName?: string;
  markdown?: ChatMarkdown;
  /** Longest single message the platform shows; longer text is the plugin's to split. */
  maxChars?: number;
  /** It can send images (`chat/send` carries `images`). */
  images?: boolean;
  /** It shows tappable options and pushes the answer back as a `chat.message` with `meta.answer`. */
  choices?: boolean;
  /** It shows inline widgets, or a way to open one. */
  widgets?: boolean;
  /** It shows a reply while it is written (`chat/draft`) and can withdraw what it showed. */
  drafts?: { minIntervalMs?: number };
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
  /** How a call reads in an approval request. */
  approval?: ApprovalPresentation;
}

/** A text, or one per language (`{ zh, en }`); `en` is the fallback. */
export type Localized = string | Record<string, string>;

/**
 * How a tool's call reads when the owner is asked to approve it. Declarative: names of
 * input properties, never code.
 */
export interface ApprovalPresentation {
  /** What the call does: "Run a command". */
  title?: Localized;
  /** The input property that matters most (the command, the recipient). */
  target?: string;
  /** Other input properties to show, in this order, with their labels. */
  fields?: Record<string, Localized>;
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
  /** Takes `chat/draft` notifications (with `chat.drafts` in the manifest). */
  chatDrafts?: boolean;
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
  /** One readable line about the call (redacted). */
  summary: string;
  reason?: string;
  expiresAt: string;
  /** The request as a person reads it; render this rather than `summary`. */
  view?: ApprovalView;
  /** The owner may also allow the call's tool family for up to this long; absent when grants are off. */
  grantMaxMs?: number;
}

/** `approvals/resolved` (notification): a request this plugin showed is no longer open. */
export interface ApprovalResolvedParams {
  id: string;
  state: 'approved' | 'denied' | 'expired';
  /** Who decided (`<plugin>:<senderKey>` or `console:<role>`); absent when it expired. */
  by?: string;
}

/** `chat/send`: deliver this to the owner on the plugin's platform. */
export interface ChatSendParams {
  text: string;
  /** Platform message id to reply to (the `correlation` of the owner's `chat.message`). */
  replyTo?: string;
  sessionId?: string;
  batchId?: string;
  /** Id of this message: its drafts carried it, and an answer to its choices names it. */
  callId?: string;
  /** Only for a platform that declares `images`. */
  images?: Array<{ handle: string; mime: string }>;
  /** Only for a platform that declares `choices`. */
  choices?: ChatChoices;
  /** Only for a platform that declares `widgets`. */
  widget?: ChatWidgetRef;
}

/**
 * `chat/draft` (notification): a reply while the model is still writing it. `text` is all of it so
 * far. Either a `chat/send` with the same `callId` follows and replaces the preview, or `discarded`
 * withdraws it. Never stored and never external output.
 */
export type ChatDraftParams = { callId: string; batchId: string } & ({ state: 'writing'; text: string; pending?: ChatPending[] } | { state: 'discarded' });

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
  /** What the owner said with the decision; it reaches the assistant. */
  note?: string;
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

/** `speech/transcribe`: the owner's voice to text, through the speech service the operator set up. */
export interface SpeechTranscribeParams {
  dataBase64: string;
  /** audio/webm, audio/ogg, audio/wav, audio/silk…; SILK (QQ, WeChat) is decoded by the host. */
  mime: string;
  /** ISO-639-1 hint; unset: speech.language. */
  language?: string;
}

/** Not a failure of the call: `not_configured` means nobody set up speech-to-text (use the platform's own text, if any). */
export type SpeechTranscribeResult = { ok: true; text: string; ms: number } | { ok: false; code: 'not_configured' | 'too_large' | 'unsupported' | 'failed'; error: string };

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
  approvalsResolved: 'approvals/resolved',
  chatSend: 'chat/send',
  chatDraft: 'chat/draft',
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
  speechTranscribe: 'speech/transcribe',
  /** `{ ready }`: whether speech-to-text is set up, before downloading a recording for it. */
  speechStatus: 'speech/status',
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
