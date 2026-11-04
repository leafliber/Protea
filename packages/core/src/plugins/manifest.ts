import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ValidateFunction } from 'ajv';
import {
  LEVEL_TRIGGERS,
  PLUGIN_API_VERSION,
  PLUGIN_KINDS,
  TRIGGERS,
  type Level,
  type PluginManifest,
  type Trigger,
} from '@protea/protocol';
import { createAjv } from '../events/validate.js';

export const MANIFEST_FILE = 'protea.plugin.json';
export type PluginOrigin = 'inproc' | 'builtin' | 'data';

/** A plugin directory as discovery found it. `errors` non-empty means the plugin is invalid. */
export interface LoadedManifest {
  dir: string;
  origin: Exclude<PluginOrigin, 'inproc'>;
  /** Present when the file parsed; may still have errors. */
  manifest?: PluginManifest;
  /** sha256 of the manifest file, to notice edits. */
  hash: string;
  errors: string[];
  warnings: string[];
  /** Compiled config schema, if the manifest has one. */
  validateConfig?: ValidateFunction;
  /** The schema itself (the console builds a form from it). */
  configSchema?: Record<string, unknown>;
  /** Top-level config keys marked `x-hot: false` (changing them reloads the plugin). */
  coldKeys: string[];
  /** Absolute path of the environment prompt template, if the file exists. */
  envPromptFile?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const TOOL_RE = /^([a-z0-9]{2,4})_[a-z0-9_]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RUNNABLE = new Set(['source', 'connector', 'tool']);
const KNOWN_FIELDS = new Set([
  'id',
  'kind',
  'api',
  'version',
  'displayName',
  'description',
  'runtime',
  'level',
  'triggers',
  'tools',
  'sideEffectTools',
  'secrets',
  'configSchema',
  'envPrompt',
  'skills',
  'healthcheck',
  'resources',
  'mcp',
  'locales',
  'homepage',
  'repository',
  'license',
]);

const ajv = createAjv();
for (const keyword of ['x-hot', 'x-secret', 'x-ui']) ajv.addKeyword({ keyword, schemaType: ['boolean', 'object'] });

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Read and validate `protea.plugin.json` (docs/30-specs/02-plugin-manifest.md §2). */
export function loadManifest(dir: string, origin: LoadedManifest['origin']): LoadedManifest {
  const file = path.join(dir, MANIFEST_FILE);
  const out: LoadedManifest = { dir, origin, hash: '', errors: [], warnings: [], coldKeys: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    out.errors.push(`cannot read ${MANIFEST_FILE}: ${(err as Error).message}`);
    return out;
  }
  out.hash = crypto.createHash('sha256').update(raw).digest('hex');
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    out.errors.push(`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`);
    return out;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    out.errors.push(`${MANIFEST_FILE} must be an object`);
    return out;
  }
  const errors = out.errors;
  for (const k of Object.keys(m)) if (!KNOWN_FIELDS.has(k)) out.warnings.push(`unknown field "${k}" ignored`);

  if (typeof m['id'] !== 'string' || !ID_RE.test(m['id'])) errors.push('id must match ^[a-z0-9][a-z0-9-]{1,31}$');
  if (!PLUGIN_KINDS.includes(m['kind'] as never)) errors.push(`kind must be one of ${PLUGIN_KINDS.join(', ')}`);
  else if (!RUNNABLE.has(m['kind'] as string)) errors.push(`kind "${String(m['kind'])}" is not supported by the plugin host (MCP and Skills arrive in M3)`);
  if (m['api'] !== PLUGIN_API_VERSION) errors.push(`api must be ${PLUGIN_API_VERSION} (got ${JSON.stringify(m['api'])})`);
  if (typeof m['version'] !== 'string' || !SEMVER_RE.test(m['version'])) errors.push('version must be a semantic version');

  const runtime = m['runtime'] as PluginManifest['runtime'] | undefined;
  if (!runtime || typeof runtime !== 'object' || typeof runtime.exec !== 'string' || runtime.exec === '') {
    errors.push('runtime.exec is required');
  } else {
    if (runtime.args !== undefined && !isStringArray(runtime.args)) errors.push('runtime.args must be a list of strings');
    if (runtime.inproc) errors.push('runtime.inproc is reserved for plugins compiled into the daemon');
    if (runtime.env !== undefined && (typeof runtime.env !== 'object' || !Object.values(runtime.env).every((v) => typeof v === 'string'))) {
      errors.push('runtime.env must map names to strings');
    }
    if (runtime.dev !== undefined && runtime.dev.args !== undefined && !isStringArray(runtime.dev.args)) {
      errors.push('runtime.dev.args must be a list of strings');
    }
  }

  const kind = m['kind'];
  const level = m['level'];
  if (kind === 'source' || kind === 'connector') {
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 4) errors.push('level must be 1-4 for sources and connectors');
  } else if (level !== undefined && (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 4)) {
    errors.push('level must be 1-4');
  }
  if (m['triggers'] !== undefined && (!isStringArray(m['triggers']) || !m['triggers'].every((t) => TRIGGERS.includes(t as Trigger)))) {
    errors.push(`triggers must be a list of ${TRIGGERS.join(', ')}`);
  }

  const tools = m['tools'];
  if (tools !== undefined) {
    if (!isStringArray(tools)) errors.push('tools must be a list of names');
    else {
      const prefixes = new Set<string>();
      for (const t of tools) {
        const match = TOOL_RE.exec(t);
        if (!match) errors.push(`tool name "${t}" must match ^[a-z0-9]{2,4}_[a-z0-9_]+$`);
        else prefixes.add(match[1] as string);
      }
      if (prefixes.size > 1) errors.push(`tool names must share one prefix (found ${[...prefixes].join(', ')})`);
      if (new Set(tools).size !== tools.length) errors.push('tool names must be unique');
    }
  }
  const side = m['sideEffectTools'];
  if (side !== undefined) {
    if (!isStringArray(side)) errors.push('sideEffectTools must be a list of names');
    else for (const t of side) if (!isStringArray(tools) || !tools.includes(t)) out.warnings.push(`sideEffectTools lists "${t}", which is not in tools`);
  }
  if (m['secrets'] !== undefined && (!isStringArray(m['secrets']) || !m['secrets'].every((s) => /^[A-Z][A-Z0-9_]{0,63}$/.test(s)))) {
    errors.push('secrets must be a list of UPPER_CASE names');
  }

  if (typeof m['configSchema'] === 'string') {
    const schemaFile = path.resolve(dir, m['configSchema']);
    if (!schemaFile.startsWith(path.resolve(dir) + path.sep)) errors.push('configSchema must be inside the plugin directory');
    else {
      try {
        const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8')) as Record<string, unknown>;
        out.validateConfig = ajv.compile(schema);
        out.configSchema = schema;
        const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
        out.coldKeys = Object.entries(props)
          .filter(([, p]) => p && p['x-hot'] === false)
          .map(([k]) => k);
      } catch (err) {
        errors.push(`configSchema: ${(err as Error).message}`);
      }
    }
  } else if (m['configSchema'] !== undefined) errors.push('configSchema must be a path');

  if (m['skills'] !== undefined) {
    const skillsDir = typeof m['skills'] === 'string' ? path.resolve(dir, m['skills']) : '';
    if (!skillsDir.startsWith(path.resolve(dir) + path.sep)) errors.push('skills must be a directory inside the plugin directory');
  }
  const envPrompt = path.resolve(dir, typeof m['envPrompt'] === 'string' ? m['envPrompt'] : 'ENV_PROMPT.md');
  if (fs.existsSync(envPrompt)) out.envPromptFile = envPrompt;

  out.manifest = m as unknown as PluginManifest;
  return out;
}

/** The triggers a source may request: the manifest's list, or every trigger its level cap allows. */
export function allowedTriggers(m: PluginManifest): Trigger[] {
  const cap = (m.level ?? 4) as Level;
  const byLevel = new Set<Trigger>();
  for (const [l, ts] of Object.entries(LEVEL_TRIGGERS)) if (Number(l) >= cap) for (const t of ts) byLevel.add(t);
  return m.triggers ? m.triggers.filter((t) => byLevel.has(t)) : [...byLevel];
}

/**
 * Scan plugin directories. Later roots override earlier ones with the same id
 * (the data volume overrides built-ins). Directories without a manifest are skipped.
 */
export function discoverPlugins(roots: Array<{ dir: string; origin: LoadedManifest['origin'] }>): Map<string, LoadedManifest> {
  const found = new Map<string, LoadedManifest>();
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const name of fs.readdirSync(root.dir).sort()) {
      if (name.startsWith('.')) continue; // staging directories of an install in progress
      const dir = path.join(root.dir, name);
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, MANIFEST_FILE))) continue;
      const loaded = loadManifest(dir, root.origin);
      const id = loaded.manifest && typeof loaded.manifest.id === 'string' ? loaded.manifest.id : name;
      if (loaded.manifest && loaded.manifest.id !== name) loaded.warnings.push(`directory name "${name}" differs from id "${id}"`);
      found.set(id, loaded);
    }
  }
  return found;
}
