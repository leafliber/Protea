export interface ToolSearchSettings {
  /** auto: defer MCP tools once the tool count passes `threshold`; always: defer whenever possible; never. */
  mode: 'auto' | 'always' | 'never';
  threshold: number;
  /** The most-called tools of each MCP server stay loaded. */
  keepPerServer: number;
}

export const DEFAULT_TOOL_SEARCH: ToolSearchSettings = { mode: 'auto', threshold: 40, keepPerServer: 3 };
