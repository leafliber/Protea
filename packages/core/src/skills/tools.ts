import type { ToolSpec } from '../tools/types.js';
import type { SkillRegistry } from './registry.js';

/** `skill_load` and `skill_read` (docs/30-specs/07-skill-format.md §4). */
export function skillTools(skills: SkillRegistry): ToolSpec<never>[] {
  const load: ToolSpec<{ name: string; arguments?: Record<string, string> }> = {
    name: 'skill_load',
    description:
      'Load a skill from the Skills catalog: returns its instructions and the files it ships. Load the matching skill before starting a task it covers. MCP prompt skills (mcp:<server>/<prompt>) may take arguments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Skill name as listed in the catalog.' },
        arguments: { type: 'object', additionalProperties: { type: 'string' }, description: 'Arguments for an MCP prompt skill.' },
      },
    },
    flags: { readOnly: true },
    handler: (input, ctx) =>
      skills.load(input.name, {
        sessionId: ctx.sessionId,
        callId: ctx.callId,
        signal: ctx.signal,
        ...(input.arguments ? { arguments: input.arguments } : {}),
      }),
  };
  const read: ToolSpec<{ name: string; path: string }> = {
    name: 'skill_read',
    description: "Read a file from a skill's directory (references, templates, scripts), or list a subdirectory.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'path'],
      properties: {
        name: { type: 'string', description: 'Skill name.' },
        path: { type: 'string', description: 'Path relative to the skill directory, e.g. "references/format.md".' },
      },
    },
    flags: { readOnly: true },
    handler: (input) => skills.read(input.name, input.path),
  };
  return [load, read] as unknown as ToolSpec<never>[];
}
