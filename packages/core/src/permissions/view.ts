import type { ApprovalPresentation, ApprovalView, Localized } from '@protea/protocol';
import type { ToolDef } from '../tools/types.js';
import { grantFamily } from './policy.js';

/** How much of one value an approval request shows. */
const VALUE_CHARS = 300;
const TARGET_CHARS = 600;
const MAX_FIELDS = 6;
/** The redacted input kept for "show everything". */
export const INPUT_CHARS = 8_000;

const pick = (t: Localized | undefined, language: string): string | undefined => (t === undefined ? undefined : typeof t === 'string' ? t : (t[language] ?? t['en'] ?? Object.values(t)[0]));

/**
 * One line of plain text. Line breaks become a visible mark, so nothing in a tool's input
 * can pass for another line of the request (a forged "approved", a second field).
 */
export function oneLineValue(v: unknown, max = VALUE_CHARS): string {
  let text: string;
  if (typeof v === 'string') text = v;
  else if (v === null || v === undefined) text = '';
  else if (Array.isArray(v)) text = v.every((x) => x === null || typeof x !== 'object') ? v.map(String).join(', ') : `[${v.length}]`;
  else if (typeof v === 'object') text = JSON.stringify(v) ?? '';
  else text = String(v);
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\r?\n|\r/g, ' \u23ce ').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** "tg_send_chat" → "Tg send chat"; "mcp__github__create_issue" → "Create issue". */
function nameAsTitle(name: string): string {
  const words = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').split(/[_-]+/).filter(Boolean);
  const text = words.join(' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : name;
}

function familyLabel(def: Pick<ToolDef, 'name' | 'owner'>, title: string, language: string): string {
  const zh = language.startsWith('zh');
  if (def.owner === 'core' || def.owner === 'mcp') return zh ? `"${title}"` : `"${title}"`;
  if (def.owner.startsWith('mcp:')) return zh ? `MCP 服务器 ${def.owner.slice(4)} 的工具` : `the tools of the MCP server ${def.owner.slice(4)}`;
  return zh ? `${def.owner} 插件的工具` : `the tools of the ${def.owner} plugin`;
}

export interface ViewOptions {
  language: string;
  redact: (text: string) => string;
  /** The tool's title from elsewhere (an MCP server's annotation). */
  title?: string;
}

/**
 * The request the owner reads: a title, the value that matters, a few more arguments. What a
 * tool declares (`approval`) wins; without it the scalar arguments are shown in schema order.
 */
export function approvalView(def: Pick<ToolDef, 'name' | 'owner' | 'inputSchema'> & { approval?: ApprovalPresentation }, input: unknown, o: ViewOptions): ApprovalView {
  const p = def.approval ?? {};
  const args: Record<string, unknown> = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const show = (v: unknown, max?: number): string => oneLineValue(o.redact(typeof v === 'string' ? v : oneLineValue(v, 10_000)), max);
  const title = oneLineValue(pick(p.title, o.language) ?? o.title ?? nameAsTitle(def.name), 80);

  let targetKey = p.target !== undefined && args[p.target] !== undefined ? p.target : undefined;
  const fields: ApprovalView['fields'] = [];
  if (p.fields) {
    for (const [key, label] of Object.entries(p.fields)) {
      if (key === targetKey || args[key] === undefined || args[key] === '') continue;
      fields.push({ label: oneLineValue(pick(label, o.language) ?? key, 40), value: show(args[key]) });
    }
  } else {
    // No declaration: schema order when there is a schema, then whatever else was passed.
    const schemaKeys = Object.keys(((def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>);
    const keys = [...schemaKeys.filter((k) => k in args), ...Object.keys(args).filter((k) => !schemaKeys.includes(k))];
    const scalar = (k: string): boolean => args[k] === null || typeof args[k] !== 'object';
    // Strings say more than flags and numbers.
    const ordered = [...keys.filter((k) => typeof args[k] === 'string'), ...keys.filter((k) => scalar(k) && typeof args[k] !== 'string'), ...keys.filter((k) => !scalar(k))];
    if (targetKey === undefined && typeof args[ordered[0] ?? ''] === 'string') targetKey = ordered[0];
    for (const key of ordered) {
      if (key === targetKey || args[key] === undefined || args[key] === '') continue;
      fields.push({ label: oneLineValue(key, 40), value: show(args[key]) });
    }
  }
  const more = fields.length - MAX_FIELDS;
  const target = targetKey !== undefined ? show(args[targetKey], TARGET_CHARS) : '';
  return {
    title,
    ...(target ? { target } : {}),
    fields: more > 0 ? [...fields.slice(0, MAX_FIELDS - 1), { label: '…', value: o.language.startsWith('zh') ? `还有 ${more + 1} 项` : `${more + 1} more` }] : fields,
    family: { id: grantFamily(def), label: familyLabel(def, title, o.language) },
  };
}

/** The request on one line, for lists, logs and plugins that show nothing else. */
export function viewSummary(v: ApprovalView): string {
  return v.target ? `${v.title}: ${v.target}` : [v.title, ...v.fields.slice(0, 2).map((f) => `${f.label} ${f.value}`)].join(' · ');
}

/** The redacted input as JSON, clipped. */
export function inputText(input: unknown, redact: (text: string) => string): string {
  const json = redact(JSON.stringify(input ?? null, null, 2) ?? 'null');
  return json.length > INPUT_CHARS ? `${json.slice(0, INPUT_CHARS)}\n… [${json.length - INPUT_CHARS} more characters]` : json;
}
