export interface HandoffSettings {
  /** At the start of a batch, hand off when the next request would exceed this many input tokens. */
  softTokens: number;
  /** Before any request, hand off above this; null = the model's context window − max output − a margin. */
  hardTokens: number | null;
  /** Share of softTokens carried into the new conversation verbatim (the most recent messages). */
  keepRatio: number;
  /** Output budget of the notes request. */
  notesMaxTokens: number;
  /** Largest rendered history sent to the notes model; older parts are cut first. */
  notesInputTokens: number;
  /** Entries kept in the "Recent handoffs" list of memory/INDEX.md. */
  recentInIndex: number;
}

export const DEFAULT_HANDOFF: HandoffSettings = {
  softTokens: 200_000,
  hardTokens: null,
  keepRatio: 1 / 3,
  notesMaxTokens: 8_000,
  notesInputTokens: 150_000,
  recentInIndex: 5,
};
