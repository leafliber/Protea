import path from 'node:path';

export type McpTransport = 'stdio' | 'streamable-http' | 'sse';
export type McpTrust = 'low' | 'normal' | 'high';

export type McpAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'oauth'; scopes?: string[]; clientId?: string; clientSecret?: string };

/** One MCP server (`mcp.servers.<id>`); docs/10-architecture/09-mcp-integration.md §2. */
export interface McpServerSettings {
  enabled: boolean;
  transport: McpTransport;
  /** stdio: the executable (`npx`, `uvx`, a path) and its arguments. */
  command?: string;
  args: string[];
  /** stdio: extra environment; values may be `${secret:NAME}`. */
  env: Record<string, string>;
  /** stdio: working directory; default `<data>/plugin-data/mcp/<id>`. */
  cwd?: string;
  /** streamable-http / sse: the endpoint. */
  url?: string;
  /** streamable-http / sse: extra request headers; values may be `${secret:NAME}`. */
  headers: Record<string, string>;
  auth: McpAuth;
  /**
   * How far the server's tools are trusted (the default policy for tools without
   * `readOnlyHint`): low → ask, normal → ask only for `destructiveHint`, high → allow.
   */
  trust: McpTrust;
  /** Globs over the server's own tool names; `deny` wins over `allow`. */
  tools: { allow?: string[]; deny?: string[] };
  toolTimeoutMs: number;
  /** stdio: resident-memory limit of this server's process tree; pluginHost.limits.memoryMb otherwise. */
  memoryMb?: number;
  /** Directories offered as MCP roots, relative to the data directory; default `workspace`. */
  roots?: string[];
  /** Text added to the system prefix as `env:mcp:<id>` (when to use this server). */
  envPrompt?: string;
  /** Replace a tool's description (the server's own text is used otherwise). */
  descriptionOverrides: Record<string, string>;
  /** Resource URIs to subscribe to; updates arrive as L4 events. */
  subscribe: string[];
}

export interface McpSettings {
  servers: Record<string, McpServerSettings>;
  /** Liveness ping for running servers; three misses in a row restart the server. 0 disables. */
  pingIntervalMs: number;
  /** `list_changed` notifications are coalesced over this window before the lists are re-read. */
  listChangedDebounceMs: number;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = { servers: {}, pingIntervalMs: 30_000, listChangedDebounceMs: 500 };

export const MCP_SERVER_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown, what: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw new Error(`${what} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') throw new Error(`${what}.${k} must be a string`);
    out[k] = String(x);
  }
  return out;
}

function stringList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${what} must be a list of strings`);
  return v as string[];
}

/** Fill defaults and check one server entry as written in config.yaml or sent to the API. */
export function normalizeMcpServer(id: string, raw: unknown): McpServerSettings {
  const at = `mcp.servers.${id}`;
  if (!MCP_SERVER_ID.test(id)) throw new Error(`${at}: the id must match ${MCP_SERVER_ID.source}`);
  if (!isObject(raw)) throw new Error(`${at} must be a mapping`);
  const transport = (raw['transport'] ?? (raw['url'] ? 'streamable-http' : 'stdio')) as McpTransport;
  if (!['stdio', 'streamable-http', 'sse'].includes(transport)) throw new Error(`${at}.transport must be stdio, streamable-http or sse`);
  const enabled = raw['enabled'] ?? true;
  if (typeof enabled !== 'boolean') throw new Error(`${at}.enabled must be a boolean`);
  const trust = (raw['trust'] ?? 'normal') as McpTrust;
  if (!['low', 'normal', 'high'].includes(trust)) throw new Error(`${at}.trust must be low, normal or high`);
  const out: McpServerSettings = {
    enabled,
    transport,
    args: stringList(raw['args'], `${at}.args`),
    env: stringMap(raw['env'], `${at}.env`),
    headers: stringMap(raw['headers'], `${at}.headers`),
    auth: { type: 'none' },
    trust,
    tools: {},
    toolTimeoutMs: 60_000,
    descriptionOverrides: stringMap(raw['descriptionOverrides'], `${at}.descriptionOverrides`),
    subscribe: stringList(raw['subscribe'], `${at}.subscribe`),
  };
  if (transport === 'stdio') {
    if (typeof raw['command'] !== 'string' || raw['command'] === '') throw new Error(`${at}.command is required for stdio`);
    out.command = raw['command'];
    if (raw['cwd'] !== undefined && raw['cwd'] !== null) {
      if (typeof raw['cwd'] !== 'string') throw new Error(`${at}.cwd must be a string`);
      out.cwd = raw['cwd'];
    }
  } else {
    const url = raw['url'];
    if (typeof url !== 'string') throw new Error(`${at}.url is required for ${transport}`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${at}.url is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${at}.url must be http(s)`);
    out.url = url;
  }
  const auth = raw['auth'];
  if (auth !== undefined && auth !== null) {
    if (!isObject(auth) || typeof auth['type'] !== 'string') throw new Error(`${at}.auth must be { type: none | bearer | oauth }`);
    if (transport === 'stdio' && auth['type'] !== 'none') throw new Error(`${at}.auth applies to HTTP transports only`);
    if (auth['type'] === 'bearer') {
      if (typeof auth['token'] !== 'string' || auth['token'] === '') throw new Error(`${at}.auth.token is required for bearer`);
      out.auth = { type: 'bearer', token: auth['token'] };
    } else if (auth['type'] === 'oauth') {
      const o: McpAuth = { type: 'oauth' };
      if (auth['scopes'] !== undefined) o.scopes = stringList(auth['scopes'], `${at}.auth.scopes`);
      if (auth['clientId'] !== undefined) o.clientId = String(auth['clientId']);
      if (auth['clientSecret'] !== undefined) o.clientSecret = String(auth['clientSecret']);
      out.auth = o;
    } else if (auth['type'] !== 'none') {
      throw new Error(`${at}.auth.type must be none, bearer or oauth`);
    }
  }
  const tools = raw['tools'];
  if (tools !== undefined && tools !== null) {
    if (!isObject(tools)) throw new Error(`${at}.tools must be { allow?, deny? }`);
    if (tools['allow'] !== undefined) out.tools.allow = stringList(tools['allow'], `${at}.tools.allow`);
    if (tools['deny'] !== undefined) out.tools.deny = stringList(tools['deny'], `${at}.tools.deny`);
  }
  if (raw['toolTimeoutMs'] !== undefined) {
    const t = raw['toolTimeoutMs'];
    if (typeof t !== 'number' || !(t > 0)) throw new Error(`${at}.toolTimeoutMs must be a positive number`);
    out.toolTimeoutMs = t;
  }
  if (raw['memoryMb'] !== undefined && raw['memoryMb'] !== null) {
    const m = raw['memoryMb'];
    if (typeof m !== 'number' || !(m > 0)) throw new Error(`${at}.memoryMb must be a positive number`);
    out.memoryMb = m;
  }
  if (raw['roots'] !== undefined && raw['roots'] !== null) {
    const roots = stringList(raw['roots'], `${at}.roots`);
    if (roots.length === 0) throw new Error(`${at}.roots must name at least one directory`);
    for (const r of roots) if (path.isAbsolute(r) || r.split('/').includes('..')) throw new Error(`${at}.roots must stay inside the data directory (got ${r})`);
    out.roots = roots;
  }
  if (raw['envPrompt'] !== undefined && raw['envPrompt'] !== null) {
    if (typeof raw['envPrompt'] !== 'string') throw new Error(`${at}.envPrompt must be a string`);
    if (raw['envPrompt'].trim()) out.envPrompt = raw['envPrompt'];
  }
  return out;
}

/** Secret names referenced as `${secret:NAME}` anywhere in a server entry. */
export function referencedSecrets(s: McpServerSettings): string[] {
  const found = new Set<string>();
  const scan = (v: string): void => {
    for (const m of v.matchAll(/\$\{secret:([A-Za-z0-9_]+)\}/g)) if (SECRET_NAME.test(m[1] as string)) found.add(m[1] as string);
  };
  for (const v of [...Object.values(s.env), ...Object.values(s.headers), ...s.args]) scan(v);
  if (s.auth.type === 'bearer') scan(s.auth.token);
  if (s.auth.type === 'oauth' && s.auth.clientSecret) scan(s.auth.clientSecret);
  return [...found].sort();
}
