export interface BoardSettings {
  /** Open items the whiteboard holds. */
  maxItems: number;
  /** Characters of the rendered whiteboard. */
  maxChars: number;
}

export const DEFAULT_BOARD: BoardSettings = { maxItems: 60, maxChars: 6_000 };
