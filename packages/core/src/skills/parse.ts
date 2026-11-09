import YAML from 'yaml';
import type { Level } from '@protea/protocol';
import { estimateTokens } from '../util/tokens.js';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_DESCRIPTION = 1024;
/** Bodies above this many (estimated) tokens load with a warning. */
export const BODY_TOKEN_WARN = 5000;

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  /** Tools the skill suggests (names or globs); not enforced, but used to filter a fork's tools. */
  allowedTools: string[];
  /** Protea extension (`metadata.requires-tools`): hidden from the catalog until these tools exist. */
  requiresTools: string[];
  /** Protea extension (`metadata.level`): suggested level for a fork that runs the skill. */
  level?: Level;
  version?: string;
  metadata: Record<string, unknown>;
}

export interface ParsedSkill {
  meta: SkillMeta | null;
  body: string;
  errors: string[];
  warnings: string[];
}

function toolList(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.flatMap((x) => x.split(/[\s,]+/)).filter(Boolean);
  return null;
}

/**
 * Parse a SKILL.md (Agent Skills format, docs/30-specs/07-skill-format.md §2).
 * `dirName` is the skill's directory; the name must equal it (null skips that check).
 */
export function parseSkillFile(text: string, dirName: string | null): ParsedSkill {
  const errors: string[] = [];
  const warnings: string[] = [];
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { meta: null, body: src, errors: ['SKILL.md has no YAML frontmatter (it must start with a "---" line)'], warnings };
  const body = src.slice(m[0].length).replace(/^\n+/, '');
  let fm: unknown;
  try {
    fm = YAML.parse(m[1] as string);
  } catch (err) {
    return { meta: null, body, errors: [`the frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}`], warnings };
  }
  if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) {
    return { meta: null, body, errors: ['the frontmatter must be a mapping'], warnings };
  }
  const f = fm as Record<string, unknown>;
  const name = f['name'];
  if (typeof name !== 'string' || name === '') errors.push('name is missing');
  else if (!SKILL_NAME.test(name)) errors.push(`name "${name}" must match ${SKILL_NAME.source}`);
  else if (dirName !== null && name !== dirName) errors.push(`name "${name}" does not match the directory name "${dirName}"`);
  let description = f['description'];
  if (typeof description !== 'string' || description.trim() === '') {
    errors.push('description is missing or empty');
    description = '';
  } else if (description.length > MAX_DESCRIPTION) {
    warnings.push(`description is ${description.length} characters; truncated to ${MAX_DESCRIPTION}`);
    description = description.slice(0, MAX_DESCRIPTION);
  }
  const allowed = toolList(f['allowed-tools']);
  if (allowed === null) errors.push('allowed-tools must be a string or a list of tool names');
  const metadata = f['metadata'] ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) errors.push('metadata must be a mapping');
  const md = (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata : {}) as Record<string, unknown>;
  const requires = toolList(md['requires-tools']);
  if (requires === null) errors.push('metadata.requires-tools must be a string or a list of tool names');
  let level: Level | undefined;
  if (md['level'] !== undefined) {
    const l = Number(md['level']);
    if ([1, 2, 3, 4].includes(l)) level = l as Level;
    else warnings.push('metadata.level must be 1-4; ignored');
  }
  if (body.trim() === '') warnings.push('the body is empty');
  const tokens = estimateTokens(body);
  if (tokens > BODY_TOKEN_WARN) warnings.push(`the body is about ${tokens} tokens; keep it under ${BODY_TOKEN_WARN} and move details into references/`);
  if (errors.length > 0) return { meta: null, body, errors, warnings };
  const meta: SkillMeta = {
    name: name as string,
    description: (description as string).trim(),
    allowedTools: allowed ?? [],
    requiresTools: requires ?? [],
    metadata: md,
  };
  if (typeof f['license'] === 'string') meta.license = f['license'];
  if (level !== undefined) meta.level = level;
  if (md['version'] !== undefined && md['version'] !== null) meta.version = String(md['version']);
  return { meta, body, errors, warnings };
}
