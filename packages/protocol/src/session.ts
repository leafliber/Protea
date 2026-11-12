/** Session, transcript and model-facing shapes. */

export type RunPhase = 'idle' | 'delivering' | 'model' | 'tools' | 'backoff' | 'handoff';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const MODEL_ROLES = ['main', 'fork', 'cheap', 'judge'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

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

/** Where an image is: transcripts hold a reference, only requests to a provider hold the bytes (ADR-0014). */
export type ImageSource = { type: 'blob'; handle: string; media_type: string } | { type: 'base64'; media_type: string; data: string };

export interface ImageBlock extends ContentBlock {
  type: 'image';
  source: ImageSource;
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

export function isImageBlock(b: ContentBlock): b is ImageBlock {
  return b.type === 'image' && typeof b['source'] === 'object' && b['source'] !== null;
}

/** The transcript form of a stored image. */
export function blobImageBlock(handle: string, mime: string): ImageBlock {
  return { type: 'image', source: { type: 'blob', handle, media_type: mime } };
}

/** The stored images among blocks, tool results included: what the console shows. */
export function blobImagesIn(blocks: readonly ContentBlock[]): Array<{ handle: string; mime: string }> {
  const out: Array<{ handle: string; mime: string }> = [];
  for (const b of blocks) {
    if (isImageBlock(b) && b.source.type === 'blob') out.push({ handle: b.source.handle, mime: b.source.media_type });
    else if (isToolResultBlock(b) && Array.isArray(b.content)) out.push(...blobImagesIn(b.content));
  }
  return out;
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
  | 'aborted'
  /** The conversation did not fit the context even after a handoff (M4). */
  | 'context_overflow';

/** How a running turn was cut short (docs/10-architecture/04-scheduling-and-preemption.md §4). */
export type CancelKind = 'preempt' | 'interrupt';

/**
 * `idle`: the fork reported its result and waits for follow-up work with its conversation kept;
 * it is released (`completed`) when none arrives in time.
 */
export const FORK_STATES = ['queued', 'running', 'paused', 'idle', 'completed', 'cancelled', 'failed'] as const;
export type ForkState = (typeof FORK_STATES)[number];

export function isForkTerminal(s: ForkState): boolean {
  return s === 'completed' || s === 'cancelled' || s === 'failed';
}
