export interface ToolSearchSettings {
  /**
   * auto: defer the tools that may be deferred (MCP servers and plugins not set to always load)
   * once there are more than `threshold` tools, or once their definitions take more than
   * `thresholdTokens`; always: defer whenever possible; never.
   */
  mode: 'auto' | 'always' | 'never';
  threshold: number;
  /** Estimated tokens of all deferrable tool definitions past which they are deferred; 0 turns this test off. */
  thresholdTokens: number;
  /** The most-called tools of each owner (an MCP server or a plugin) stay loaded. */
  keepPerOwner: number;
}

export const DEFAULT_TOOL_SEARCH: ToolSearchSettings = { mode: 'auto', threshold: 40, thresholdTokens: 8000, keepPerOwner: 3 };
