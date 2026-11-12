import type { Level } from '@protea/protocol';

export type JsonSchema = Record<string, unknown>;

export interface ToolFlags {
  /** A successful call ends the turn (no further model call in this batch). */
  endsTurn?: boolean;
  /** No later tool in the same message starts until this one returns. */
  barrierAfter?: boolean;
  /** The handler honours its AbortSignal and returns a partial receipt when cancelled. */
  interruptible?: boolean;
  /** Safe to run in parallel with anything. */
  readOnly?: boolean;
  /** Changes the outside world; subject to permission policy (M2). */
  sideEffect?: boolean;
  /** Left out of a fork's default tools; a fork gets it only when its tool list names it. */
  forkOptIn?: boolean;
}

export interface ToolContext {
  signal: AbortSignal;
  callId: string;
  sessionId: string;
  batchId: string;
  batchLevel: Level;
  /** The tools this session may call (a fork's list); absent when every tool is allowed. */
  allowed?: ReadonlySet<string>;
}

export interface ToolOutcome {
  text: string;
  failed?: boolean;
  partial?: boolean;
  endsTurn?: boolean;
  /** Stored images that go to the model with the text (dropped on a failed call). */
  images?: Array<{ handle: string; mime: string }>;
}

export interface ToolSpec<I = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  flags?: ToolFlags;
  timeoutMs?: number;
  /** May be deferred behind the provider's tool search when there are many tools (MCP tools). */
  deferrable?: boolean;
  /** The schema comes from elsewhere (an MCP server): if it does not compile, skip local validation. */
  externalSchema?: boolean;
  /**
   * Part of the client-side tool search (`mcp_search`, `mcp_call`): sent to the model only while
   * some tools are held back for a provider that cannot search them itself, and callable by any
   * session that has such a tool.
   */
  clientSearch?: boolean;
  /**
   * The call is really a call of another tool: the dispatcher runs that tool, under its own
   * name, schema, permission policy and audit, and answers this call with its result.
   */
  redirect?(input: I): { name: string; input: unknown } | { error: string };
  /**
   * Counted against this outbound limit (a connector's id) whoever owns the tool: `chat_send`
   * counts against the platform it sends to.
   */
  outboundKey?(input: I): string;
  /** A provider-defined tool type with this name (e.g. Anthropic `memory_20250818`); providers that know it declare the type instead of the schema. */
  providerType?: string;
  handler(input: I, ctx: ToolContext): Promise<ToolOutcome | string> | ToolOutcome | string;
}

export interface ToolDef extends ToolSpec {
  /** "core" or the plugin id that declared the tool. */
  owner: string;
}
