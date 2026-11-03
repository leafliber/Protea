import crypto from 'node:crypto';

const MAX_TOOL_NAME = 64;

/** Owner id of a server's tools in the tool registry. */
export function mcpOwner(server: string): string {
  return `mcp:${server}`;
}

/**
 * The name the model sees: `mcp__<server>__<tool>` (the Claude Code convention). Characters
 * the API does not accept become "_"; names over 64 characters are shortened with a hash
 * suffix so they stay unique and stable.
 */
export function mcpToolName(server: string, tool: string): string {
  const prefix = `mcp__${server}__`;
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = prefix + clean;
  if (full.length <= MAX_TOOL_NAME && clean === tool) return full;
  const hash = crypto.createHash('sha256').update(tool).digest('hex').slice(0, 6);
  const room = MAX_TOOL_NAME - prefix.length - hash.length - 1;
  if (room < 1) throw new Error(`MCP server id "${server}" is too long for tool names`);
  return `${prefix}${clean.slice(0, room)}_${hash}`;
}
