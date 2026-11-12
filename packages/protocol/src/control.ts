/** Control API request/response shapes (docs/30-specs/05-control-api.md). */
import type { EventEnvelope, EventState, Level, TerminalOutcome, Trigger } from './events.js';
import type { PluginLoginStatus, PluginState } from './plugin.js';
import type { ChatAnswer, ChatChoices, ChatMarkdown, ChatPending } from './plugin.js';
import type { BatchEndReason, BatchReason, CancelKind, ContentBlock, Effort, ForkState, ModelRole, RunPhase, TranscriptMessage } from './session.js';

/** M5: who a control API request acts as. `readonly` may only read (and never memory, persona or secrets). */
export type ControlRole = 'admin' | 'readonly';

export interface PushEventRequest {
  text: string;
  level?: Level;
  trigger?: Trigger;
  tags?: string[];
}

export interface PushEventResponse {
  cursor: number;
  effectiveLevel: Level;
  effectiveTrigger: Trigger;
  deduped: boolean;
  warnings: string[];
}

/** POST /api/chat/messages: the owner writes in the web chat. */
export interface ChatMessageRequest {
  text: string;
  /** Images stored with POST /api/blobs. */
  images?: BlobImageRef[];
  /** The message answers the choices of a reply. */
  answer?: ChatAnswer;
  /** `interrupt` stops what is running and handles this first. */
  trigger?: 'flush' | 'interrupt';
}

/** A chat platform that is running (`chat_send` can reach it). */
export interface ChatPlatformInfo {
  id: string;
  displayName: string;
  markdown: ChatMarkdown;
  maxChars?: number;
  images: boolean;
  choices: boolean;
  widgets: boolean;
  drafts: boolean;
}

/** What a reply carries besides its text (the `meta` column of `outputs`). */
export interface ChatReplyParts {
  /** The `chat_send` call that sent it. */
  callId?: string;
  images?: BlobImageRef[];
  choices?: ChatChoices;
  widget?: { id: string; title: string };
}

/** GET /api/widgets/:id. The code is model-written and only ever runs inside the sandbox frame. */
export interface WidgetResponse {
  id: string;
  title: string;
  code: string;
}

/**
 * One line of a conversation (GET /api/chat): the owner's message (a `chat.message` event),
 * an assistant reply (`chat_send`) or a notice (approval requests).
 */
export interface ChatItem extends ChatReplyParts {
  /** `e<cursor>` for a message, `o<id>` for a reply or notice. */
  key: string;
  kind: 'owner' | 'reply' | 'notice';
  /** Chat platform it belongs to (`webchat`, `telegram`, …). */
  platform: string;
  at: string;
  text: string;
  /** owner: the event. */
  cursor?: number;
  state?: EventState;
  /** owner: who sent it (`console:<user>`, `api:admin`). */
  sender?: string;
  /** owner: it answers the choices of a reply. */
  answer?: ChatAnswer;
  /** reply / notice: the output channel (`chat`, `approvals`; `console` on replies from before the split). */
  channel?: string;
  batchId?: string;
}

/** How a batch that a chat item belongs to went. */
export interface ChatBatch {
  id: string;
  endReason: BatchEndReason | null;
  endedAt: string | null;
  /** Sources of the events it delivered (`console`, `cron`, …). */
  sources: string[];
  /** It sent at least one chat reply. */
  replied: boolean;
  /** model_error: what failed. */
  error?: string;
}

export interface ChatHistoryResponse {
  /** Oldest first. */
  items: ChatItem[];
  batches: ChatBatch[];
  /** Pass as `before` for the page of older items; null when there are none. */
  before: string | null;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** cache_read / (input + cache_read + cache_write); null when no calls. */
  cacheHitRatio: number | null;
}

/** `GET /api/plugins/:id/login`: the plugin's sign-in state, with its QR code rendered. */
export interface PluginLoginView extends Omit<PluginLoginStatus, 'state' | 'qr'> {
  /** `unavailable`: the plugin is not running, so nobody can answer. */
  state: PluginLoginStatus['state'] | 'unavailable';
  qr?: { text: string; svg: string; terminal: string };
}

export interface PluginStatus {
  id: string;
  kind: string;
  state: PluginState;
  /** Operator intent (`plugins.<id>.enabled`); a failed start does not change it. */
  enabled: boolean;
  /** `inproc` (built into the daemon), `builtin` (shipped out-of-process) or `data` (installed into the data volume). */
  origin: 'inproc' | 'builtin' | 'data';
  version?: string;
  tools: string[];
  /**
   * Its tools always load up front (`plugins.<id>.alwaysLoad`; unset, connectors and in-process
   * plugins do). Otherwise they may be deferred behind tool search.
   */
  alwaysLoad: boolean;
  /** How many of its tools are deferred right now. */
  deferredTools?: number;
  pid?: number;
  /** Resident memory of the plugin process and its children at the last sample (out-of-process plugins). */
  memoryBytes?: number;
  restarts?: number;
  error?: string;
}

export type McpServerState = PluginState | 'auth_required';

export interface McpToolInfo {
  /** Name the model sees: `mcp__<server>__<tool>`. */
  name: string;
  /** The server's own name for the tool. */
  mcpName: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  /** Excluded by `tools.allow` / `tools.deny`. */
  filtered?: boolean;
}

export interface McpServerStatus {
  id: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  state: McpServerState;
  enabled: boolean;
  trust: 'low' | 'normal' | 'high';
  /** `config` (mcp.servers) or `plugin` (a `kind: mcp` plugin directory). */
  origin: 'config' | 'plugin';
  server?: { name: string; version: string };
  tools: string[];
  prompts: number;
  resources: boolean;
  pid?: number;
  /** Resident memory of the server process and its children at the last sample (stdio servers). */
  memoryBytes?: number;
  restarts?: number;
  error?: string;
  /** Pending OAuth authorization: open this URL to grant access. */
  authorizeUrl?: string;
  /** Mean latency of the recent tool calls (ms). */
  avgLatencyMs?: number;
  /** What the operator should know about its settings (the console keeps showing it). */
  warnings?: string[];
  /** What the server says about itself (`initialize` instructions, clipped). */
  instructions?: string;
  /** Its tools are never deferred (`alwaysLoad`). */
  alwaysLoad?: boolean;
  /** How many of its tools the model has to look up before calling them. */
  deferredTools?: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** builtin (shipped), user (data/skills), plugin (a plugin's skills/), mcp (an MCP prompt, read-only). */
  origin: 'builtin' | 'user' | 'plugin' | 'mcp';
  owner?: string;
  version?: string;
  enabled: boolean;
  /** Valid and shown in the catalog (enabled, and its required tools exist). */
  listed: boolean;
  errors: string[];
  warnings: string[];
  allowedTools: string[];
  requiresTools: string[];
  level?: Level;
  loads: number;
  lastLoadedAt?: string;
}

/**
 * An approval request as a person reads it: what is about to happen, not the raw arguments.
 * Every value is plain text on one line, redacted and clipped; none of it is markup.
 */
export interface ApprovalView {
  /** What the call does, in the daemon's language: "Run a command". */
  title: string;
  /** The one value that matters most: the command, the recipient, the path. */
  target?: string;
  /** The other arguments worth reading, a handful at most. */
  fields: Array<{ label: string; value: string }>;
  /** The assistant's own sentence: what this is for. */
  reason?: string;
  /** Why the automatic review passed the call on. */
  held?: string;
  /** What "do not ask again for a while" would cover. */
  family: { id: string; label: string };
}

export interface ApprovalInfo {
  id: string;
  tool: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'used';
  /** One readable line (title and target). */
  summary: string;
  reason?: string;
  view?: ApprovalView;
  /** The redacted input as JSON, clipped, for whoever wants to read all of it. */
  input?: string;
  /** The platforms that showed the request to the owner. */
  deliveredTo?: string[];
  /** What the owner said with the decision. */
  note?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** The time-limited grant this approval created. */
  grantId?: string;
}

/** A schedule of the cron plugin, as the console shows it. */
export interface ScheduleInfo {
  id: string;
  name: string;
  /** Five-field cron expression (recurring). */
  cron?: string;
  /** The instant a one-time schedule fires, ISO 8601 with offset. */
  at?: string;
  /** What the assistant reads when it fires. */
  note?: string;
  level: 3 | 4;
  /** A paused schedule keeps its place and does not fire. */
  enabled: boolean;
  /** `wake` is a `sleep_until` of the assistant. */
  kind: 'once' | 'recurring' | 'wake';
  createdBy: 'config' | 'assistant' | 'operator';
  createdAt: string;
  /** The rule in words ("每个工作日 07:00"); the cron expression when it has no plain reading. */
  human: string;
  /** When it fires next; absent while paused or when it never fires again. */
  nextAt?: string;
  lastFiredAt?: string;
  fires: number;
  /** Defined in config.yaml: it can be run, not changed. */
  readOnly: boolean;
}

/** POST /api/schedules, PATCH /api/schedules/:id. */
export interface ScheduleInput {
  name?: string;
  cron?: string;
  at?: string;
  note?: string;
  level?: 3 | 4;
  enabled?: boolean;
}

/** POST /api/schedules/preview. */
export interface SchedulePreview {
  human: string;
  /** The next few firing times, ISO 8601 with offset. */
  next: string[];
}

/** One firing of a schedule (GET /api/schedules/:id/runs). */
export interface ScheduleRun {
  cursor: number;
  at: string;
  state: EventState;
  batchId?: string;
  /** Fired by hand from the console. */
  manual?: boolean;
}

export const PERMISSION_MODES = ['ask', 'auto', 'bypass', 'locked'] as const;
/** Who clears a call whose policy is `ask`: the owner, a judge model, nobody needs to, or nothing may. */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PermissionModeInfo {
  /** The mode in effect now. */
  mode: PermissionMode;
  /** The mode in config.yaml, in effect when no temporary mode is set. */
  baseline: PermissionMode;
  override?: { mode: PermissionMode; until: string; by: string; setAt: string };
  /** Auto mode stopped itself after too many holds; `mode` is `ask` until a mode is set again. */
  paused?: { at: string; reason: string };
  /** Reviews since the mode was last set. */
  auto: { since: string; allowed: number; held: number; judge: { model: string; ready: boolean; problem?: string } };
  /** The longest bypass; 0 means bypass is off. */
  bypassMaxMs: number;
}

/** `POST /api/permissions/mode`. Without `forMs` the mode becomes the baseline (not allowed for bypass). */
export interface SetPermissionModeRequest {
  mode: PermissionMode;
  forMs?: number;
}

/** A time-limited approval of a whole tool family (one plugin's tools, one MCP server's, or a single core tool). */
export type ChangeKind = 'mcp' | 'skill' | 'plugin';
/** `add` installs a plugin or a skill, or declares an MCP server; `configure` is for plugins only. */
export type ChangeAction = 'add' | 'update' | 'remove' | 'enable' | 'disable' | 'configure';
/**
 * `applied`: approved and done. `failed`: approved, but applying it failed. `stale`: approved,
 * but the target had changed since the proposal, so nothing was applied.
 */
export type ChangeState = 'pending' | 'applied' | 'rejected' | 'failed' | 'stale' | 'expired' | 'withdrawn';

/**
 * A change to the assistant's capabilities that the assistant proposed. Only an administrator
 * decides it, through the control API (docs/20-decisions/ADR-0019).
 */
export interface ChangeRequestInfo {
  id: string;
  kind: ChangeKind;
  action: ChangeAction;
  /** The MCP server id, skill name or plugin id. */
  target: string;
  state: ChangeState;
  /** One line, written by Core, saying what would change. */
  summary: string;
  /** Why, in the assistant's words. */
  reason: string;
  createdAt: string;
  expiresAt: string;
  sessionId?: string;
  batchId?: string;
  decidedAt?: string;
  decidedBy?: string;
  /** What the reviewer wrote with the decision. */
  note?: string;
  /** What applying it led to, or why it was not applied. */
  result?: string;
}

export interface ChangeRequestDetail extends ChangeRequestInfo {
  /** The target as it was when proposed, and as it would be, as text to compare; null when there is none. */
  before: string | null;
  after: string | null;
  warnings: string[];
  /** Where the staged files came from. */
  source?: string;
  /** The files that would be installed (readable through `/api/changes/:id/file` while pending). */
  files?: Array<{ path: string; size: number }>;
  /** Secrets the change refers to, and whether each has a value. */
  secrets?: Array<{ name: string; set: boolean }>;
  /** Pending, but the target changed since: approving would apply nothing. */
  stale?: boolean;
}

export interface ApprovalGrantInfo {
  id: string;
  family: string;
  approvalId: string;
  decidedBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  active: boolean;
}

/** Why a conversation was compacted. */
export type HandoffKind = 'idle' | 'capacity' | 'requested' | 'overflow';

export const BOARD_SECTIONS = ['goals', 'todo', 'notes'] as const;
export type BoardSection = (typeof BOARD_SECTIONS)[number];

/** One line of the whiteboard. Closed items stay in the table for review. */
export interface BoardItem {
  id: string;
  section: BoardSection;
  text: string;
  due?: string;
  state: 'open' | 'done' | 'dropped';
  outcome?: string;
  /** Batch that added it. */
  source?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/** A change to the whiteboard, from the `board` tool or the control API. `due: ""` clears the date. */
export type BoardCommand =
  | { command: 'add'; section: BoardSection; text: string; due?: string }
  | { command: 'update'; id: string; section?: BoardSection; text?: string; due?: string }
  | { command: 'done'; id: string; outcome?: string }
  | { command: 'drop'; id: string; outcome?: string };

export interface BoardResponse {
  rev: number;
  items: BoardItem[];
  /** Most recently closed items, with `?closed=1`. */
  closed?: BoardItem[];
}

/** The daily consolidation of the memory directory. */
export interface DreamStatus {
  enabled: boolean;
  /** Stopped after repeated failures; a manual run clears it. */
  disabled: boolean;
  running: boolean;
  /** Earliest local time of each day's run. */
  at: string;
  /** Local date of the latest run. */
  date?: string;
  forkId?: string;
  startedAt?: string;
  endedAt?: string;
  result?: 'completed' | 'failed' | 'cancelled';
  summary?: string;
  failures: number;
}

export interface StatusResponse {
  runId: string;
  version: string;
  startedAt: string;
  uptimeSec: number;
  phase: RunPhase;
  batchId: string | null;
  pending: Record<Level, number>;
  /** `id`: the default provider profile ("none" before one is configured). */
  provider: { id: string; protocol?: ProviderProtocolName; mainModel: string; ready: boolean; problem?: string };
  /** True until the first admin account exists (the console shows the setup page). */
  setupRequired?: boolean;
  plugins: PluginStatus[];
  mcp: McpServerStatus[];
  skills: { listed: number; rejected: number };
  /**
   * Tools the model can call, how many of them it has to look up first, and how it does:
   * `native` is the provider's tool search, `client` is `tool_search` / `tool_call`.
   */
  tools: { total: number; deferred: number; search?: 'native' | 'client' };
  /**
   * M4: the main conversation's size. `estimatedTokens` is the last response's usage plus an
   * estimate of what came after; a handoff starts when it passes `softTokens` at a batch start or `hardTokens` anytime.
   */
  context: { transcript: string; handoffs: number; estimatedTokens: number; softTokens: number; hardTokens: number; lastCompaction?: { at: string; kind: HandoffKind; dropped: number; kept: number } };
  /** M4: files in the memory directory, the whiteboard and the daily consolidation; `persona`: whether hooks are loaded (or why not). */
  memory: { files: number; board: { open: number; rev: number }; dream: DreamStatus };
  persona: { hooks: boolean; problem?: string };
  usage24h: UsageTotals;
  /** M5: delivery paused by the operator (who), and sources in preemption cooldown. */
  scheduler: { paused: string | null; cooldowns: Array<{ source: string; untilMs: number }> };
  /** Non-terminal forks first, then the most recently ended ones. */
  forks: ForkInfo[];
  budget: BudgetStatus;
  /** Chat platforms that are running, and where the owner last wrote. */
  chat: { platforms: ChatPlatformInfo[]; last?: string };
}

export interface ForkInfo {
  id: string;
  state: ForkState;
  level: Level;
  model: ModelRole;
  goal: string;
  rounds: number;
  createdAt: string;
  endedAt?: string;
  pauseReason?: string;
  summary?: string;
  error?: string;
  /** How many pieces of work it was given (the goal, then each follow-up). */
  tasks?: number;
  /** An idle fork is released at this time unless it gets follow-up work first. */
  idleUntil?: string;
}

export interface LevelBudget {
  /** Rolling 24 h spend attributed to this level. */
  spentUsd: number;
  tokens: number;
  /** null when the pool is unlimited. */
  limitUsd: number | null;
  usedRatio: number | null;
  /** Events whose delivery the budget changed (L2 → piggyback, L3/L4 → store) and that are still waiting. */
  held?: number;
  /** The owner lifted enforcement for this level until then. */
  releasedUntil?: string;
}

export interface BudgetStatus {
  /** `budget.enforce`: exhausted pools change how new events are scheduled. */
  enforced: boolean;
  dailyUsd: number | null;
  /** Global cap over the rolling 24 h (only L0/L1 are delivered past it); null: none. */
  hardDailyUsd: number | null;
  /** Total spend over the rolling 24 h. */
  spentUsd: number;
  hardCapReached: boolean;
  hardCapReleasedUntil?: string;
  levels: Record<Level, LevelBudget>;
}

/** Scheduling interventions, all of which are also recorded as internal events. */
export type SchedulerAction =
  | { kind: CancelKind; cursor: number; source: string; level: Level; batchId: string; batchLevel: Level; phase: RunPhase }
  | { kind: 'aged'; cursors: number[] }
  | { kind: 'storm_cooldown'; source: string; untilMs: number }
  | { kind: 'fork_yield'; forkIds: string[]; batchId: string }
  | { kind: 'fork_resume'; forkIds: string[] }
  /** M5: operator interventions through the control API. */
  | { kind: 'paused' | 'resumed'; by: string }
  | { kind: 'discarded'; cursors: number[]; levels: Level[]; by: string };

export interface BatchStartedData {
  batchId: string;
  level: Level;
  reason: BatchReason;
  cursors: number[];
}

/** Sizes of what one model request carries (`model.request`). */
export interface ContextSummary {
  segments: Array<{ id: string; tokens: number }>;
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  estimatedTokens: number;
  tools: number;
  deferredTools: number;
  messages: number;
  /** The cached prefix changed since the previous request. */
  prefixChanged: boolean;
}

export interface ModelRequestTrace {
  sessionId: string;
  batchId: string;
  attempt: number;
  round?: number;
  role?: ModelRole;
  model?: string;
  context?: ContextSummary;
}

/** Part of a reply as it streams; coalesced, not stored. */
export interface ModelDeltaTrace {
  sessionId: string;
  batchId: string;
  round?: number;
  kind: 'text' | 'thinking';
  text: string;
}

/**
 * A `chat_send` reply while the model is still writing it. Provisional and never stored: the
 * `output` with the same `callId` replaces it, `discarded` withdraws it. A fragment continues the
 * text at `offset`; one that does not line up came after a gap and should be ignored.
 */
export type ChatDraftUpdate = { batchId: string; callId: string; platform: string } & ({ state: 'writing'; offset: number; text: string; pending?: ChatPending[] } | { state: 'discarded' });

/** A finished model reply. Thinking carries its summary text only, never the signature. */
export interface ModelResponseTrace {
  sessionId: string;
  batchId: string;
  round?: number;
  at: string;
  model: string;
  stopReason: string;
  content: ContentBlock[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

/** One tool call, once when it starts and once when it ends (also when it was refused). */
/** A stored image shown by the console (GET /api/blobs/:handle). */
export interface BlobImageRef {
  handle: string;
  mime: string;
}

export type ToolCallTrace = { sessionId: string; batchId: string; callId: string; name: string; at: string } & (
  | { phase: 'start'; input: unknown }
  | { phase: 'end'; ms: number; isError: boolean; result: string; truncated: boolean; images?: BlobImageRef[] }
);

export type TraceMessage =
  | { topic: 'model.request'; data: ModelRequestTrace }
  | { topic: 'model.delta'; data: ModelDeltaTrace }
  | { topic: 'model.response'; data: ModelResponseTrace }
  | { topic: 'tool.call'; data: ToolCallTrace };

/** One step of a batch, rebuilt from its transcript and outputs (GET /api/batches/:id/trace). */
export type BatchTraceStep =
  | { kind: 'events'; at: string; cursors: number[] }
  | { kind: 'model'; at: string; round: number; content: ContentBlock[]; model?: string; stopReason?: string; usage?: ModelResponseTrace['usage'] }
  | { kind: 'tool_result'; at: string; callId: string; name: string; text: string; isError: boolean; images?: BlobImageRef[] }
  | { kind: 'output'; at: string; plugin: string; channel?: string; text: string }
  | { kind: 'mark'; at: string; mark: string; detail: Record<string, unknown> };

export interface BatchTraceResponse {
  batch: BatchInfo;
  events: EventEnvelope[];
  steps: BatchTraceStep[];
}

/** GET /api/sessions/:id/context: what the next model request of this session would carry. */
export interface SessionContextResponse {
  sessionId: string;
  role: ModelRole;
  effort: Effort;
  model: string;
  system: Array<{ id: string; text: string; tokens: number }>;
  tools: Array<{ name: string; description: string; owner?: string; tokens: number; deferred: boolean }>;
  /** A page of the merged messages, oldest first. */
  messages: TranscriptMessage[];
  from: number;
  totalMessages: number;
  totals: { systemTokens: number; toolTokens: number; messageTokens: number; estimatedTokens: number };
  /** main: where a handoff starts. */
  limits?: { softTokens: number; hardTokens: number };
  /** Share of the prompt read from the cache on the last call of this run. */
  cacheHitRatio?: number | null;
}

export type StreamMessage =
  | { topic: 'event'; data: EventEnvelope }
  | { topic: 'settled'; data: { cursors: number[]; outcome: TerminalOutcome; batchId?: string } }
  | { topic: 'phase'; data: { phase: RunPhase; batchId?: string; round?: number } }
  | { topic: 'batch.started'; data: BatchStartedData }
  | { topic: 'batch.extended'; data: { batchId: string; cursors: number[]; level: Level } }
  | { topic: 'batch.ended'; data: { batchId: string; endReason: BatchEndReason; rounds: number } }
  | { topic: 'output'; data: { plugin: string; channel?: string; text: string; at: string; id?: number; batchId?: string } & ChatReplyParts }
  /** Only on `/ws` (group `chat`) and on `/api/stream?drafts=1`. */
  | { topic: 'chat.draft'; data: ChatDraftUpdate }
  | { topic: 'scheduler'; data: SchedulerAction }
  | { topic: 'fork'; data: ForkInfo }
  | { topic: 'change'; data: ChangeRequestInfo }
  | { topic: 'mcp'; data: McpServerStatus }
  | { topic: 'skills'; data: { names: string[] } }
  /** M4: the main session handed off to a new transcript. */
  | { topic: 'handoff'; data: { from: string; to: string; notes: string; dropped: number; kept: number } }
  | { topic: 'plugin'; data: PluginStatus }
  | { topic: 'approval'; data: ApprovalInfo }
  | { topic: 'schedule'; data: { id: string } }
  | { topic: 'permission'; data: PermissionModeInfo };

export type StreamTopic = StreamMessage['topic'];

/** M5: one model call, as recorded (the WebSocket `usage` topic). */
export interface UsageInfo {
  at: string;
  model: string;
  role: ModelRole;
  sessionId: string;
  batchId?: string;
  level?: Level;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  stopReason?: string;
}

/** M5: a log line (pino JSON): time is epoch ms, level 10–60. */
export type LogRecord = Record<string, unknown> & { time: number; level: number; msg: string };

/** WebSocket-only messages beside the stream projection. */
export type WsExtraMessage =
  | { topic: 'hello'; data: { runId: string; role: ControlRole } }
  | { topic: 'subscribed'; data: { topics: WsTopic[] } }
  | { topic: 'promoted'; data: EventEnvelope }
  | { topic: 'persona'; data: { files: string[] } }
  | { topic: 'usage'; data: UsageInfo }
  | { topic: 'log'; data: LogRecord }
  | { topic: 'error'; data: { message: string } };

export type WsServerMessage = StreamMessage | TraceMessage | WsExtraMessage;

/**
 * WebSocket `/ws` subscription groups (docs/30-specs/05-control-api.md): each covers some
 * server message topics.
 */
export const WS_TOPICS = {
  events: ['event', 'settled', 'promoted'],
  phase: ['phase', 'batch.started', 'batch.extended', 'batch.ended'],
  scheduler: ['scheduler'],
  output: ['output'],
  /** Replies as they are written: only the chat window subscribes. */
  chat: ['chat.draft'],
  changes: ['fork', 'plugin', 'approval', 'schedule', 'change', 'permission', 'mcp', 'skills', 'handoff', 'persona'],
  usage: ['usage'],
  logs: ['log'],
  /** The run stream: heavy, so only pages that show it subscribe. */
  trace: ['model.request', 'model.delta', 'model.response', 'tool.call'],
} as const satisfies Record<string, ReadonlyArray<WsServerMessage['topic']>>;
export type WsTopic = keyof typeof WS_TOPICS;

/** Replies to one client; they belong to no subscription group. */
type WsReplyTopic = 'hello' | 'subscribed' | 'error';
type Expect<T extends true> = T;
/** Compile-time check: ws.ts drops a message without a group, so every other topic must have one. */
type _EveryWsTopicHasAGroup = Expect<[Exclude<WsServerMessage['topic'], (typeof WS_TOPICS)[WsTopic][number] | WsReplyTopic>] extends [never] ? true : false>;

/** Client → server. Each message replaces the subscription; `since` replays stored events first. */
export interface WsClientMessage {
  subscribe: WsTopic[];
  since?: number;
  logFilter?: { level?: string | number; component?: string; plugin?: string; q?: string };
}

/** M5: `GET /api/batches` rows. */
export interface BatchInfo {
  id: string;
  level: Level;
  reason: BatchReason;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  rounds: number;
  endReason: BatchEndReason | null;
}

/** M5: `GET /api/config`. */
export interface ConfigResponse {
  /** Effective configuration; secret values that appear in it are replaced with [REDACTED:<NAME>]. */
  config: Record<string, unknown>;
  /** Layers, lowest first. */
  layers: string[];
  /** Where each leaf comes from (dotted path → defaults | file | environment). */
  sources: Record<string, 'defaults' | 'file' | 'environment'>;
  /** Top-level sections applied without a restart. */
  hot: string[];
}

export interface SecretInfo {
  name: string;
  source: 'env' | 'file';
  /** A file exists but the environment value wins. */
  shadowedFile: boolean;
}

/** Wire protocols of model providers (docs/10-architecture/12-model-providers.md §3). */
/** Wire protocols a provider profile can speak (docs/10-architecture/12-model-providers.md §3). */
export const PROVIDER_PROTOCOLS = ['anthropic', 'openai-chat', 'openai-responses', 'echo'] as const;
export type ProviderProtocolName = (typeof PROVIDER_PROTOCOLS)[number];

/** A provider profile as the console shows it: its settings (never the key) and its state. */
export interface ProviderProfileInfo {
  id: string;
  /** The complete settings (config.yaml providers.profiles.<id> with defaults filled in). */
  profile: Record<string, unknown> & {
    label: string | null;
    protocol: ProviderProtocolName;
    baseUrl: string | null;
    apiKeySecret: string | null;
    models: Record<ModelRole, string>;
  };
  /** The endpoint actually used (baseUrl or the protocol's default). */
  endpoint: string | null;
  /** Roles this profile serves now. */
  roles: ModelRole[];
  /** Whether the key secret has a value, and where it comes from. */
  key: { required: boolean; set: boolean; source: 'env' | 'file' | null };
  ready: boolean;
  problem?: string;
}

export interface ProviderPresetInfo {
  id: string;
  label: string;
  protocol: ProviderProtocolName;
  baseUrl: string | null;
  noKey?: boolean;
  models?: Partial<Record<ModelRole, string>>;
  anthropic?: Record<string, unknown>;
  openai?: Record<string, unknown>;
  note?: string;
}

export interface ProvidersResponse {
  default: string | null;
  roles: Partial<Record<ModelRole, string>>;
  profiles: ProviderProfileInfo[];
  presets: ProviderPresetInfo[];
  protocols: Array<{ id: ProviderProtocolName; label: string; defaultUrl: string | null }>;
  /** A new profile's complete defaults per protocol (for the console's form). */
  defaults: Record<ProviderProtocolName, Record<string, unknown>>;
  /** Overall readiness (what /api/status reports). */
  ready: boolean;
  problem?: string;
}

/** PUT /api/providers/:id. `apiKey`: a string stores it, null removes the stored key, absent keeps it. */
export interface PutProviderRequest {
  profile: Record<string, unknown>;
  apiKey?: string | null;
  /** Make this profile the default (the first profile always becomes the default). */
  makeDefault?: boolean;
}

/** POST /api/providers/test and /api/providers/models: a saved profile (`id`) or an unsaved one (`profile`). */
export interface ProbeProviderRequest {
  id: string;
  profile?: Record<string, unknown>;
  apiKey?: string;
  role?: ModelRole;
}

export type ProbeProviderResponse =
  | { ok: true; ms: number; model: string; reply?: string; stopReason?: string; models?: string[] }
  | { ok: false; ms: number; kind: string; error: string; status?: number };

/** A console account (never its password). */
export interface AccountInfo {
  id: number;
  username: string;
  role: ControlRole;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface WhoAmIResponse {
  role: ControlRole;
  via: 'bearer' | 'cookie';
  username?: string;
}
