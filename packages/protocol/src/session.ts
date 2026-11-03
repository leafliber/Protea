/** Session, transcript and model-facing shapes. */

export type RunPhase = 'idle' | 'delivering' | 'model' | 'tools' | 'backoff' | 'handoff';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelRole = 'main' | 'fork' | 'cheap';

/**
 * Content blocks use the Anthropic Messages shape as the canonical form.
 * Blocks are stored and replayed byte-for-byte, so unknown block types
 * (thinking, compaction, server tools, ...) round-trip untouched.
 */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface TextBlock extends ContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock extends ContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock extends ContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === 'text' && typeof b['text'] === 'string';
}

export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string';
}

export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === 'tool_result' && typeof b['tool_use_id'] === 'string';
}

export type BatchReason = 'window' | 'flush' | 'resume';
export type BatchEndReason =
  | 'end_turn'
  | 'ends_turn'
  | 'max_tokens'
  | 'refusal'
  | 'round_limit'
  | 'model_error'
  /** Cancelled by an `interrupt` event; the interrupting events start the next batch. */
  | 'interrupted'
  | 'aborted';

/** How a running turn was cut short (docs/10-architecture/04-scheduling-and-preemption.md §4). */
export type CancelKind = 'preempt' | 'interrupt';

export const FORK_STATES = ['queued', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const;
export type ForkState = (typeof FORK_STATES)[number];

export function isForkTerminal(s: ForkState): boolean {
  return s === 'completed' || s === 'cancelled' || s === 'failed';
}
