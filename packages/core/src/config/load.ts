import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { LEVELS, type Level } from '@protea/protocol';
import { normalizeMcpServer } from '../mcp/settings.js';
import { normalizeProviders } from '../providers/profiles.js';
import { parseCidr } from '../util/cidr.js';
import { isValidTimeZone } from '../util/time.js';
import { defaultConfig, STARTER_CONFIG_YAML } from './defaults.js';
import { upgradeLegacyProviders } from './legacy.js';
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

/** A config.yaml document with an old providers section read in the profile layout. */
function fileLayer(doc: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  if (!('providers' in doc)) return doc;
  const up = upgradeLegacyProviders(doc['providers']);
  if (!up.upgraded) return doc;
  warnings.push('config.yaml: providers uses the layout before provider profiles; it is read as providers.profiles (the daemon rewrites it at start)');
  return { ...doc, providers: up.providers };
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
  if (!(forks.idleTtlMs >= 0 && Number.isInteger(forks.maxIdle) && forks.maxIdle >= 0)) {
    throw new Error('scheduler.forks requires idleTtlMs >= 0 and a non-negative integer maxIdle');
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
  if (typeof budget.enforce !== 'boolean') throw new Error('budget.enforce must be a boolean');
  if (budget.hardDailyUsd !== null && !(typeof budget.hardDailyUsd === 'number' && budget.hardDailyUsd > 0)) {
    throw new Error('budget.hardDailyUsd must be a positive number or null');
  }
  const policies = ['allow', 'ask', 'deny'];
  const perm = cfg.permissions;
  if (!policies.includes(perm.default)) throw new Error('permissions.default must be allow, ask or deny');
  if (typeof perm.tools !== 'object' || perm.tools === null || Array.isArray(perm.tools)) throw new Error('permissions.tools must be a mapping');
  for (const [k, v] of Object.entries(perm.tools)) {
    if (!policies.includes(v)) throw new Error(`permissions.tools.${k} must be allow, ask or deny`);
  }
  if (!(perm.approvalTtlMs > 0)) throw new Error('permissions.approvalTtlMs must be positive');
  if (!(perm.grantMaxMs >= 0)) throw new Error('permissions.grantMaxMs must not be negative');
  if (perm.mode !== 'ask' && perm.mode !== 'auto' && perm.mode !== 'locked') throw new Error('permissions.mode must be ask, auto or locked (bypass needs a time limit: protea mode bypass --for 30m)');
  const auto = perm.auto;
  for (const k of ['environment', 'allow', 'ask'] as const) if (typeof auto[k] !== 'string') throw new Error(`permissions.auto.${k} must be text`);
  if (!(Number.isInteger(auto.timeoutMs) && auto.timeoutMs >= 1000)) throw new Error('permissions.auto.timeoutMs must be an integer of at least 1000');
  for (const k of ['pauseAfterConsecutive', 'pauseAfterPerHour'] as const) if (!(Number.isInteger(auto[k]) && auto[k] >= 1)) throw new Error(`permissions.auto.${k} must be a positive integer`);
  const vision = cfg.vision;
  if (!(vision.maxImageKb > 0)) throw new Error('vision.maxImageKb must be positive');
  if (!Number.isInteger(vision.maxImagesPerMessage) || vision.maxImagesPerMessage < 0) throw new Error('vision.maxImagesPerMessage must be a non-negative integer');
  if (!(vision.blobRetentionDays >= 0)) throw new Error('vision.blobRetentionDays must not be negative');
  const chat = cfg.chat;
  if (typeof chat.widgets !== 'boolean') throw new Error('chat.widgets must be true or false');
  if (!(Number.isInteger(chat.widgetMaxKb) && chat.widgetMaxKb >= 1 && chat.widgetMaxKb <= 1024)) throw new Error('chat.widgetMaxKb must be an integer from 1 to 1024');
  const ph = cfg.pluginHost;
  if (!Array.isArray(ph.restartBackoffMs) || ph.restartBackoffMs.length === 0 || !ph.restartBackoffMs.every((n) => n >= 0)) {
    throw new Error('pluginHost.restartBackoffMs must be a non-empty list of delays');
  }
  if (!(ph.maxCrashes >= 1)) throw new Error('pluginHost.maxCrashes must be at least 1');
  const lim = ph.limits;
  if (!isPlainObject(lim)) throw new Error('pluginHost.limits must be a mapping');
  if (lim.memoryMb !== null && !(Number.isInteger(lim.memoryMb) && lim.memoryMb >= 32)) throw new Error('pluginHost.limits.memoryMb must be an integer of at least 32, or null');
  if (lim.openFiles !== null && !(Number.isInteger(lim.openFiles) && lim.openFiles >= 64)) throw new Error('pluginHost.limits.openFiles must be an integer of at least 64, or null');
  if (!(Number.isInteger(lim.checkMs) && lim.checkMs >= 1000)) throw new Error('pluginHost.limits.checkMs must be an integer of at least 1000');
  if (ph.outboundPerMinute !== null && !(Number.isInteger(ph.outboundPerMinute) && ph.outboundPerMinute >= 1)) {
    throw new Error('pluginHost.outboundPerMinute must be a positive integer or null');
  }
  const { soft, hard } = cfg.session.rounds;
  if (!(soft > 0 && hard >= soft)) throw new Error('session.rounds requires 0 < soft <= hard');
  if (!Array.isArray(cfg.owner.identities)) throw new Error('owner.identities must be a list');
  if (cfg.control.publicUrl !== null) {
    try {
      new URL(cfg.control.publicUrl);
    } catch {
      throw new Error('control.publicUrl must be a URL or null');
    }
  }
  if (typeof cfg.control.publicMetrics !== 'boolean') throw new Error('control.publicMetrics must be a boolean');
  if (typeof cfg.control.readonlyTokenSecret !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(cfg.control.readonlyTokenSecret)) {
    throw new Error('control.readonlyTokenSecret must be a secret name (UPPER_CASE)');
  }
  if (!Array.isArray(cfg.control.allowCidrs)) throw new Error('control.allowCidrs must be a list of CIDRs');
  for (const c of cfg.control.allowCidrs) {
    try {
      parseCidr(String(c));
    } catch (err) {
      throw new Error(`control.allowCidrs: ${(err as Error).message}`);
    }
  }
  const obs = cfg.observability;
  if (!['off', 'responses', 'full'].includes(obs.recordProvider)) throw new Error('observability.recordProvider must be off, responses or full');
  if (!Number.isInteger(obs.keepRuns) || obs.keepRuns < 1) throw new Error('observability.keepRuns must be an integer of at least 1');
  if (typeof obs.logRotateMb !== 'number' || !(obs.logRotateMb >= 0)) throw new Error('observability.logRotateMb must be a number of MB (0 = never rotate)');
  if (!Number.isInteger(obs.logRotateKeep) || obs.logRotateKeep < 0 || obs.logRotateKeep > 100) throw new Error('observability.logRotateKeep must be an integer from 0 to 100');
  if (typeof obs.logEventText !== 'boolean') throw new Error('observability.logEventText must be true or false');
  if (!Array.isArray(obs.requiredPlugins) || !obs.requiredPlugins.every((p) => typeof p === 'string')) {
    throw new Error('observability.requiredPlugins must be a list of plugin ids');
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
  if (!(Number.isInteger(ts.thresholdTokens) && ts.thresholdTokens >= 0)) throw new Error('context.toolSearch.thresholdTokens must be a non-negative integer');
  if (!(Number.isInteger(ts.keepPerServer) && ts.keepPerServer >= 0)) throw new Error('context.toolSearch.keepPerServer must be a non-negative integer');
  const h = cfg.context.handoff;
  const posInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;
  if (!posInt(h.softTokens)) throw new Error('context.handoff.softTokens must be a positive integer');
  if (h.hardTokens !== null && !posInt(h.hardTokens)) throw new Error('context.handoff.hardTokens must be a positive integer or null');
  if (h.hardTokens !== null && h.hardTokens < h.softTokens) throw new Error('context.handoff.hardTokens must not be below softTokens');
  if (!(typeof h.keepRatio === 'number' && h.keepRatio > 0 && h.keepRatio < 1)) throw new Error('context.handoff.keepRatio must be between 0 and 1');
  if (!posInt(h.notesMaxTokens) || !posInt(h.notesInputTokens)) {
    throw new Error('context.handoff.notesMaxTokens and notesInputTokens must be positive integers');
  }
  const idle = cfg.context.idleCompaction;
  if (typeof idle.enabled !== 'boolean') throw new Error('context.idleCompaction.enabled must be a boolean');
  for (const k of ['minTokens', 'earlyTokens', 'earlyAfterMs', 'coldAfterMs', 'keepTokens', 'minDroppableTokens', 'minIntervalMs'] as const) {
    if (!posInt(idle[k])) throw new Error(`context.idleCompaction.${k} must be a positive integer`);
  }
  if (idle.earlyTokens < idle.minTokens) throw new Error('context.idleCompaction.earlyTokens must not be below minTokens');
  const c = cfg.context.compaction;
  if (typeof c.enabled !== 'boolean') throw new Error('context.compaction.enabled must be a boolean');
  if (!posInt(c.triggerTokens) || c.triggerTokens < 50_000) throw new Error('context.compaction.triggerTokens must be an integer of at least 50000');
  if (c.instructions !== null && typeof c.instructions !== 'string') throw new Error('context.compaction.instructions must be text or null');
  if (typeof cfg.memory.nativeTool !== 'boolean') throw new Error('memory.nativeTool must be a boolean');
  if (!posInt(cfg.memory.board.maxItems) || !posInt(cfg.memory.board.maxChars)) throw new Error('memory.board.maxItems and maxChars must be positive integers');
  const dream = cfg.memory.dream;
  if (typeof dream.enabled !== 'boolean') throw new Error('memory.dream.enabled must be a boolean');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dream.at)) throw new Error('memory.dream.at must be a local time such as 03:30');
  if (!posInt(dream.minIdleMs)) throw new Error('memory.dream.minIdleMs must be a positive integer');
  if (dream.model !== 'main' && dream.model !== 'fork' && dream.model !== 'cheap') throw new Error('memory.dream.model must be main, fork or cheap');
  if (typeof cfg.persona.dir !== 'string' || cfg.persona.dir.trim() === '') throw new Error('persona.dir must be a path');
  const legacy = ['anthropic', 'echo'].filter((k) => k in (cfg.providers as unknown as Record<string, unknown>));
  if (legacy.length > 0) warnings.push(`providers.${legacy.join(' and providers.')} (environment): the old layout is ignored; use providers.profiles`);
  cfg.providers = normalizeProviders(cfg.providers);
  for (const [id, p] of Object.entries(cfg.plugins)) {
    if (p.enabled === undefined) p.enabled = false; // plugins without built-in defaults start disabled
    if (typeof p.enabled !== 'boolean') throw new Error(`plugins.${id}.enabled must be a boolean`);
    p.config ??= {};
  }
}

/**
 * Defaults ← config.yaml ← PROTEA_* environment. `fileDoc` replaces the file's contents
 * (validating a change before it is written); the file is then neither read nor created.
 */
export function loadConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env, opts: { fileDoc?: unknown } = {}): LoadedConfig {
  const warnings: string[] = [];
  const sources = ['defaults'];
  let config = defaultConfig();

  const file = path.join(dataDir, 'config.yaml');
  if ('fileDoc' in opts) {
    const doc = opts.fileDoc;
    if (doc !== null && doc !== undefined) {
      if (!isPlainObject(doc)) throw new Error('config: top level must be a mapping');
      config = deepMerge(config, fileLayer(doc, warnings));
    }
    sources.push(file);
  } else if (fs.existsSync(file)) {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (doc !== null && doc !== undefined) {
      if (!isPlainObject(doc)) throw new Error(`${file}: top level must be a mapping`);
      config = deepMerge(config, fileLayer(doc, warnings));
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

/** Where each leaf of the effective configuration comes from (arrays count as leaves). */
export function configSources(dataDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, 'defaults' | 'file' | 'environment'> {
  const file = path.join(dataDir, 'config.yaml');
  const fileDoc = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8')) as unknown) : null;
  const overlay = envOverlay(env);
  const has = (root: unknown, keys: string[]): boolean => {
    let node = root;
    for (const k of keys) {
      if (!isPlainObject(node) || !(k in node)) return false;
      node = node[k];
    }
    return true;
  };
  const out: Record<string, 'defaults' | 'file' | 'environment'> = {};
  const walk = (node: unknown, keys: string[]): void => {
    if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [k, v] of Object.entries(node)) walk(v, [...keys, k]);
      return;
    }
    out[keys.join('.')] = has(overlay, keys) ? 'environment' : has(fileDoc, keys) ? 'file' : 'defaults';
  };
  walk(loadConfig(dataDir, env, { fileDoc }).config, []);
  return out;
}
