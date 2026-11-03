import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { LEVELS, type Level } from '@protea/protocol';
import { isValidTimeZone } from '../util/time.js';
import { defaultConfig, STARTER_CONFIG_YAML } from './defaults.js';
import type { ProteaConfig } from './types.js';

export interface LoadedConfig {
  config: ProteaConfig;
  /** Layers that contributed, lowest first. */
  sources: string[];
  warnings: string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Objects merge recursively; arrays and scalars replace. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function camel(segment: string): string {
  return segment.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function parseEnvValue(raw: string): Json {
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return raw;
  }
}

/** PROTEA_A__B_C=1 → { a: { bC: 1 } }. Only variables with "__" are config paths. */
export function envOverlay(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('PROTEA_') || raw === undefined) continue;
    const rest = key.slice('PROTEA_'.length);
    if (!rest.includes('__') || rest.startsWith('SECRET_')) continue;
    const segs = rest.split('__').map(camel);
    let node = out;
    segs.forEach((seg, i) => {
      if (i === segs.length - 1) {
        node[seg] = parseEnvValue(raw);
      } else {
        if (!isPlainObject(node[seg])) node[seg] = {};
        node = node[seg] as Record<string, unknown>;
      }
    });
  }
  return out;
}

function validate(cfg: ProteaConfig, warnings: string[]): void {
  if (!isValidTimeZone(cfg.daemon.timezone)) {
    warnings.push(`daemon.timezone "${cfg.daemon.timezone}" is not a valid IANA zone; using UTC`);
    cfg.daemon.timezone = 'UTC';
  }
  for (const l of LEVELS) {
    const s = cfg.scheduler.levels[l as Level];
    if (!s) throw new Error(`scheduler.levels.${l} is missing`);
    if (s.debounceMs !== null && (typeof s.debounceMs !== 'number' || s.debounceMs < 0)) {
      throw new Error(`scheduler.levels.${l}.debounceMs must be a non-negative number or null`);
    }
  }
  const { soft, hard } = cfg.session.rounds;
  if (!(soft > 0 && hard >= soft)) throw new Error('session.rounds requires 0 < soft <= hard');
  if (!Array.isArray(cfg.owner.identities)) throw new Error('owner.identities must be a list');
  if (!['5m', '1h'].includes(cfg.providers.anthropic.cacheTtl)) throw new Error('providers.anthropic.cacheTtl must be 5m or 1h');
  for (const [id, p] of Object.entries(cfg.plugins)) {
    if (typeof p.enabled !== 'boolean') throw new Error(`plugins.${id}.enabled must be a boolean`);
    p.config ??= {};
  }
}

export function loadConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const warnings: string[] = [];
  const sources = ['defaults'];
  let config = defaultConfig();

  const file = path.join(dataDir, 'config.yaml');
  if (fs.existsSync(file)) {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (doc !== null && doc !== undefined) {
      if (!isPlainObject(doc)) throw new Error(`${file}: top level must be a mapping`);
      config = deepMerge(config, doc);
    }
    sources.push(file);
  } else {
    fs.writeFileSync(file, STARTER_CONFIG_YAML);
    sources.push(`${file} (created)`);
  }

  const overlay = envOverlay(env);
  if (Object.keys(overlay).length > 0) {
    config = deepMerge(config, overlay);
    sources.push('environment');
  }

  validate(config, warnings);
  return { config, sources, warnings };
}
