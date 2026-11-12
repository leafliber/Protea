export interface ToolSearchSettings {
  /**
   * auto: defer MCP tools once there are more than `threshold` tools, or once the MCP tool
   * definitions take more than `thresholdTokens`; always: defer whenever possible; never.
   */
  mode: 'auto' | 'always' | 'never';
  threshold: number;
  /** Estimated tokens of all MCP tool definitions past which they are deferred; 0 turns this test off. */
  thresholdTokens: number;
  /** The most-called tools of each MCP server stay loaded. */
  keepPerServer: number;
}

export const DEFAULT_TOOL_SEARCH: ToolSearchSettings = { mode: 'auto', threshold: 40, thresholdTokens: 8000, keepPerServer: 3 };
