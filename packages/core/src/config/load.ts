import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { LEVELS, type Level } from '@protea/protocol';
import { normalizeMcpServer } from '../mcp/settings.js';
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
    if (typeof s.maxWaitMs !== 'number' || s.maxWaitMs < 0) {
      throw new Error(`scheduler.levels.${l}.maxWaitMs must be a non-negative number`);
    }
  }
  const storm = cfg.scheduler.preemptStorm;
  if (!(storm.count >= 1 && storm.windowMs > 0 && storm.cooldownMs >= 0)) {
    throw new Error('scheduler.preemptStorm requires count >= 1, windowMs > 0, cooldownMs >= 0');
  }
  const forks = cfg.scheduler.forks;
  if (!(forks.maxConcurrent >= 1 && forks.maxQueued >= 0 && forks.maxTurns >= 1)) {
    throw new Error('scheduler.forks requires maxConcurrent >= 1, maxQueued >= 0, maxTurns >= 1');
  }
  if (forks.yieldLevel !== null && !LEVELS.includes(forks.yieldLevel)) {
    throw new Error('scheduler.forks.yieldLevel must be a level (0-4) or null');
  }
  const budget = cfg.budget;
  if (budget.dailyUsd !== null && !(typeof budget.dailyUsd === 'number' && budget.dailyUsd > 0)) {
    throw new Error('budget.dailyUsd must be a positive number or null');
  }
  for (const l of LEVELS) {
    const share = budget.shares[l as Level];
    if (share !== null && !(typeof share === 'number' && share >= 0)) {
      throw new Error(`budget.shares.${l} must be a non-negative number or null`);
    }
  }
  if (!(budget.warnAt > 0 && budget.warnAt <= 1)) throw new Error('budget.warnAt must be in (0, 1]');
  const policies = ['allow', 'ask', 'deny'];
  const perm = cfg.permissions;
  if (!policies.includes(perm.default)) throw new Error('permissions.default must be allow, ask or deny');
  if (typeof perm.tools !== 'object' || perm.tools === null || Array.isArray(perm.tools)) throw new Error('permissions.tools must be a mapping');
  for (const [k, v] of Object.entries(perm.tools)) {
    if (!policies.includes(v)) throw new Error(`permissions.tools.${k} must be allow, ask or deny`);
  }
  if (!(perm.approvalTtlMs > 0)) throw new Error('permissions.approvalTtlMs must be positive');
  const ph = cfg.pluginHost;
  if (!Array.isArray(ph.restartBackoffMs) || ph.restartBackoffMs.length === 0 || !ph.restartBackoffMs.every((n) => n >= 0)) {
    throw new Error('pluginHost.restartBackoffMs must be a non-empty list of delays');
  }
  if (!(ph.maxCrashes >= 1)) throw new Error('pluginHost.maxCrashes must be at least 1');
  const { soft, hard } = cfg.session.rounds;
  if (!(soft > 0 && hard >= soft)) throw new Error('session.rounds requires 0 < soft <= hard');
  if (!Array.isArray(cfg.owner.identities)) throw new Error('owner.identities must be a list');
  if (!['5m', '1h'].includes(cfg.providers.anthropic.cacheTtl)) throw new Error('providers.anthropic.cacheTtl must be 5m or 1h');
  if (cfg.control.publicUrl !== null) {
    try {
      new URL(cfg.control.publicUrl);
    } catch {
      throw new Error('control.publicUrl must be a URL or null');
    }
  }
  if (!isPlainObject(cfg.mcp.servers)) throw new Error('mcp.servers must be a mapping');
  for (const [id, raw] of Object.entries(cfg.mcp.servers)) cfg.mcp.servers[id] = normalizeMcpServer(id, raw);
  if (!(cfg.mcp.pingIntervalMs >= 0) || !(cfg.mcp.listChangedDebounceMs >= 0)) {
    throw new Error('mcp.pingIntervalMs and mcp.listChangedDebounceMs must be non-negative');
  }
  if (!Array.isArray(cfg.skills.disabled) || !cfg.skills.disabled.every((n) => typeof n === 'string')) {
    throw new Error('skills.disabled must be a list of names');
  }
  if (typeof cfg.skills.mcpPrompts !== 'boolean') throw new Error('skills.mcpPrompts must be a boolean');
  const ts = cfg.context.toolSearch;
  if (!['auto', 'always', 'never'].includes(ts.mode)) throw new Error('context.toolSearch.mode must be auto, always or never');
  if (!(Number.isInteger(ts.threshold) && ts.threshold >= 0)) throw new Error('context.toolSearch.threshold must be a non-negative integer');
  if (!(Number.isInteger(ts.keepPerServer) && ts.keepPerServer >= 0)) throw new Error('context.toolSearch.keepPerServer must be a non-negative integer');
  const h = cfg.context.handoff;
  const posInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;
  if (!posInt(h.softTokens)) throw new Error('context.handoff.softTokens must be a positive integer');
  if (h.hardTokens !== null && !posInt(h.hardTokens)) throw new Error('context.handoff.hardTokens must be a positive integer or null');
  if (h.hardTokens !== null && h.hardTokens < h.softTokens) throw new Error('context.handoff.hardTokens must not be below softTokens');
  if (!(typeof h.keepRatio === 'number' && h.keepRatio > 0 && h.keepRatio < 1)) throw new Error('context.handoff.keepRatio must be between 0 and 1');
  if (!posInt(h.notesMaxTokens) || !posInt(h.notesInputTokens) || !posInt(h.recentInIndex)) {
    throw new Error('context.handoff.notesMaxTokens, notesInputTokens and recentInIndex must be positive integers');
  }
  const c = cfg.context.compaction;
  if (typeof c.enabled !== 'boolean') throw new Error('context.compaction.enabled must be a boolean');
  if (!posInt(c.triggerTokens) || c.triggerTokens < 50_000) throw new Error('context.compaction.triggerTokens must be an integer of at least 50000');
  if (c.instructions !== null && typeof c.instructions !== 'string') throw new Error('context.compaction.instructions must be text or null');
  if (typeof cfg.memory.nativeTool !== 'boolean') throw new Error('memory.nativeTool must be a boolean');
  if (typeof cfg.persona.dir !== 'string' || cfg.persona.dir.trim() === '') throw new Error('persona.dir must be a path');
  const mm = cfg.providers.anthropic.thinkingMismatch;
  if (mm !== null && mm !== 'drop_block' && mm !== 'error') throw new Error('providers.anthropic.thinkingMismatch must be drop_block, error or null');
  for (const [id, p] of Object.entries(cfg.plugins)) {
    if (p.enabled === undefined) p.enabled = false; // plugins without built-in defaults start disabled
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
