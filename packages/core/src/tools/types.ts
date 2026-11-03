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
}

export interface ToolContext {
  signal: AbortSignal;
  callId: string;
  sessionId: string;
  batchId: string;
  batchLevel: Level;
}

export interface ToolOutcome {
  text: string;
  failed?: boolean;
  partial?: boolean;
  endsTurn?: boolean;
}

export interface ToolSpec<I = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  flags?: ToolFlags;
  timeoutMs?: number;
  handler(input: I, ctx: ToolContext): Promise<ToolOutcome | string> | ToolOutcome | string;
}

export interface ToolDef extends ToolSpec {
  /** "core" or the plugin id that declared the tool. */
  owner: string;
}
