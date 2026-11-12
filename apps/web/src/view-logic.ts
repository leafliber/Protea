import type { RunPhase } from '@protea/protocol';

/** Plugins the page lists: disabled ones stay out unless the operator asked to see them. */
export function visiblePlugins<T extends { enabled: boolean }>(plugins: readonly T[], showDisabled: boolean): T[] {
  return showDisabled ? [...plugins] : plugins.filter((p) => p.enabled);
}

/**
 * What the conversation shows while a batch runs.
 * - `typing`: the bubble with what the assistant is doing.
 * - `wrapping`: a reply of this batch is already on screen and the model is only deciding
 *   whether anything is left; the conversation shows nothing, the header says so.
 * - `none`: nothing to show (idle, another batch, or a reply is being written as a draft).
 */
export function chatActivity(s: { active: boolean; phase: RunPhase; drafts: number; replied: boolean }): 'typing' | 'wrapping' | 'none' {
  if (!s.active) return 'none';
  if (s.replied && s.phase === 'model') return s.drafts > 0 ? 'none' : 'wrapping';
  return s.drafts > 0 ? 'none' : 'typing';
}
