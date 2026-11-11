/** `chat` in config.yaml (docs/30-specs/04-config-reference.md). */
export interface ChatSettings {
  /** Whether `chat_send` may carry an inline widget. */
  widgets: boolean;
  /** Largest widget code. */
  widgetMaxKb: number;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { widgets: true, widgetMaxKb: 64 };
