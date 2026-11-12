import fs from 'node:fs';
import path from 'node:path';
import {
  HOST_TO_PLUGIN,
  PLUGIN_TO_HOST,
  RPC_ERRORS,
  RpcError,
  type ApprovalDecideParams,
  type PermissionModeParams,
  type ApprovalInfo,
  type ApprovalRequestParams,
  type ApprovalResolvedParams,
  type BlobGetParams,
  type BlobGetResult,
  type BlobPutParams,
  type BlobPutResult,
  type EventInput,
  type EventState,
  type HttpRequestParams,
  type HttpResponse,
  type Level,
  type LogParams,
  type LoginCompleteParams,
  type PluginCapabilities,
  type PluginLoginStatus,
  type PluginState,
  type PluginStatus,
  type RpcHandler,
  type SettledParams,
  type TerminalOutcome,
  type ToolDecl,
} from '@protea/protocol';
import type { BlobStore } from '../blobs/store.js';
import type { Bus } from '../bus.js';
import type { ChatHub } from '../chat/hub.js';
import type { PluginSettings } from '../config/types.js';
import type { SecretStore } from '../config/secrets.js';
import { kvNamespace, type KvRepo } from '../db/repos.js';
import type { SourceCaps } from '../events/gate.js';
import { CORE_SOURCE, type EventGateway } from '../events/gateway.js';
import type { OwnerRegistry } from '../events/owner.js';
import type { OutputLog } from '../events/outputs.js';
import type { EventStore } from '../events/store.js';
import type { Logger } from '../observability/logger.js';
import type { ApprovalService } from '../permissions/approvals.js';
import { PermissionModeError, type PermissionModes } from '../permissions/modes.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDef, ToolSpec } from '../tools/types.js';
import { sleep } from '../util/abort.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import type { InprocPlugin, PluginContext } from './inproc.js';
import { allowedTriggers, discoverPlugins, loadManifest, type LoadedManifest, type PluginOrigin } from './manifest.js';
import { ProcessPlugin } from './process.js';
import { DEFAULT_PLUGIN_HOST_SETTINGS, type PluginHostSettings } from './settings.js';
import { MemoryWatchdog, passthroughEnv, withLimits } from '../util/child-process.js';

export interface PluginHostOptions {
  store: EventStore;
  bus: Bus;
  gateway: EventGateway;
  owner: OwnerRegistry;
  kv: KvRepo;
  tools: ToolRegistry;
  log: Logger;
  clock: Clock;
  dataDir: string;
  timezone: string;
  language?: string;
  settings?: Partial<PluginHostSettings>;
  secrets?: SecretStore;
  mainModel?: () => string;
  /** Directories scanned for out-of-process plugins; later roots override earlier ones. */
  roots?: Array<{ dir: string; origin: LoadedManifest['origin'] }>;
  /** Development mode: run sources (`runtime.dev`) and load TypeScript through this Node loader. */
  dev?: { loader: string };
  /** Prepended to PYTHONPATH of Python plugins (the bundled `protea_plugin` SDK). */
  pythonPath?: string;
  /** Operator intent changed through the host (enable/disable/install): persist it. */
  onEnabledChanged?: (id: string, enabled: boolean) => void;
  /** A data-volume plugin was uninstalled: drop its configuration group. */
  onUninstalled?: (id: string) => void;
  /** Keeps what plugins send to the operator (notices in the conversation). */
  outputs?: OutputLog;
  /** Stored images (`blob/put`, `blob/get`, images in tool results). */
  blobs?: BlobStore;
  /** Chat platforms register here when they start; `chat_send` routes to them. */
  chat?: ChatHub;
  /** A sign-in finished (`ownerSenderKey` set) or was undone (null): update who the owner is on this plugin. */
  onOwnerSignIn?: (id: string, ownerSenderKey: string | null) => void;
}

interface Entry {
  id: string;
  kind: string;
  origin: PluginOrigin;
  enabled: boolean;
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;
  inproc?: InprocPlugin;
  loaded?: LoadedManifest;
  proc: ProcessPlugin | null;
  capabilities: PluginCapabilities;
  envVars: Record<string, unknown> | null;
  crashes: number;
  restarts: number;
  startedAt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  pendingSettled: SettledParams['events'];
  /** Lifecycle operations on one plugin run one at a time. */
  op: Promise<void>;
  /** Why the host killed the running process (memory limit); reported as the crash reason. */
  killReason?: string | null;
  /** Resident memory of the process tree at the last sample. */
  rssBytes?: number;
  /** Until when `login/complete` is accepted: set when the host starts a sign-in. */
  loginOpenUntil?: number;
}

/** Where a plugin's environment prompt comes from (consumed by SystemSegments). */
export interface EnvPromptSource {
  id: string;
  envPromptFile?: string;
  envPromptVars(): Record<string, unknown> | null;
}

const SECRET_REF = /^\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/;
const MAX_PENDING_SETTLED = 1000;
/** A sign-in the operator started stays open this long; longer than any plugin waits for a scan. */
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_RPC_TIMEOUT_MS = 20_000;

function shallowPatch(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) patch[k] = next[k] ?? null;
  }
  return patch;
}

/**
 * Runs every plugin — built-in in-process ones and out-of-process ones speaking the
 * stdio protocol (docs/10-architecture/07-plugin-system.md). Handles discovery, the
 * lifecycle state machine, supervision with backoff restarts, draining, and hot operations.
 * Plugin events go to the store through the EventGateway.
 */
export class PluginHost {
  private readonly entries = new Map<string, Entry>();
  private readonly settings: PluginHostSettings;
  private approvals: ApprovalService | null = null;
  private modes: PermissionModes | null = null;
  private started = false;
  private stopping = false;
  private readonly watchdog: MemoryWatchdog;

  constructor(private readonly o: PluginHostOptions) {
    this.settings = { ...DEFAULT_PLUGIN_HOST_SETTINGS, ...o.settings };
    this.watchdog = new MemoryWatchdog({
      limits: () => this.settings.limits,
      targets: () =>
        [...this.entries.values()].flatMap((e) => (e.state === 'running' && e.proc?.pid !== undefined ? [{ id: e.id, pid: e.proc.pid }] : [])),
      onSample: (samples) => {
        for (const [id, bytes] of samples) {
          const e = this.entries.get(id);
          if (e) e.rssBytes = bytes;
        }
      },
      onExceeded: (id, bytes, limit) => {
        const e = this.entries.get(id);
        if (!e?.proc || e.state !== 'running' || e.killReason) return;
        e.killReason = `memory limit exceeded (${Math.round(bytes / 1048576)} MB > ${Math.round(limit / 1048576)} MB)`;
        this.o.log.error({ plugin: id, rssMb: Math.round(bytes / 1048576), limitMb: Math.round(limit / 1048576) }, 'plugin over its memory limit; restarting it');
        e.proc.crash();
      },
    });
    o.bus.on('event.settled', (s) => {
      const bySource = new Map<string, Array<{ cursor: number }>>();
      for (const e of s.events) bySource.set(e.source, [...(bySource.get(e.source) ?? []), { cursor: e.cursor }]);
      for (const [source, events] of bySource) this.deliverSettled(source, events, s.outcome);
    });
    o.bus.on('session.phase', (p) => {
      if (p.sessionId !== 'main') return;
      for (const e of this.entries.values()) {
        if (e.state === 'running' && e.capabilities.runPhase) e.proc?.runPhase({ phase: p.phase, ...(p.batchId !== undefined ? { batchId: p.batchId } : {}) });
      }
    });
  }

  attachApprovals(approvals: ApprovalService): void {
    this.approvals = approvals;
  }

  attachPermissionModes(modes: PermissionModes): void {
    this.modes = modes;
  }

  // —— Registration and discovery ——

  /** A plugin compiled into the daemon (console, cron). */
  register(plugin: InprocPlugin, config: Record<string, unknown> = {}, enabled = true): void {
    if (this.entries.has(plugin.id) || plugin.id === CORE_SOURCE) throw new Error(`plugin id "${plugin.id}" is taken`);
    this.entries.set(plugin.id, this.newEntry(plugin.id, plugin.kind, 'inproc', { enabled, config }, { inproc: plugin }));
  }

  private newEntry(id: string, kind: string, origin: PluginOrigin, s: PluginSettings, extra: Partial<Entry>): Entry {
    return {
      id,
      kind,
      origin,
      enabled: s.enabled,
      config: s.config ?? {},
      state: 'loaded',
      proc: null,
      capabilities: {},
      envVars: null,
      crashes: 0,
      restarts: 0,
      startedAt: 0,
      restartTimer: null,
      pendingSettled: [],
      op: Promise.resolve(),
      ...extra,
    };
  }

  /**
   * Bring the out-of-process entries in line with what is on disk: add new plugins,
   * reload changed ones, remove deleted ones. `settingsOf` gives the configured
   * enabled/config for an id. Safe to call repeatedly (the file watcher does).
   */
  async rescan(settingsOf: (id: string) => PluginSettings | undefined): Promise<void> {
    const found = discoverPlugins(this.o.roots ?? []);
    const ops: Promise<void>[] = [];
    for (const [id, loaded] of found) {
      const e = this.entries.get(id);
      if (e?.inproc) {
        this.o.log.warn({ plugin: id, dir: loaded.dir }, 'a plugin directory uses the id of a built-in in-process plugin; ignored');
        continue;
      }
      for (const w of loaded.warnings) this.o.log.warn({ plugin: id }, `manifest: ${w}`);
      if (!e) {
        const s = settingsOf(id) ?? { enabled: false, config: {} };
        const entry = this.newEntry(id, loaded.manifest?.kind ?? 'unknown', loaded.origin, s, { loaded });
        this.setInvalid(entry);
        this.entries.set(id, entry);
        this.emit(entry);
        this.o.log.info({ plugin: id, origin: loaded.origin, state: entry.state }, 'plugin discovered');
        if (this.started && entry.enabled && entry.state === 'loaded') ops.push(this.start(id));
        continue;
      }
      if (e.loaded?.hash === loaded.hash && e.loaded.dir === loaded.dir) continue;
      ops.push(
        this.serialize(e, async () => {
          const wasRunning = e.state === 'running' || e.state === 'starting';
          if (wasRunning) await this.stopEntry(e, 'reloading');
          e.loaded = loaded;
          e.origin = loaded.origin;
          e.kind = loaded.manifest?.kind ?? e.kind;
          e.state = 'loaded';
          delete e.error;
          this.setInvalid(e);
          this.o.log.info({ plugin: id }, 'plugin manifest changed');
          if ((wasRunning || this.started) && e.enabled && e.state === 'loaded') await this.startEntry(e, false);
          else this.emit(e);
        }),
      );
    }
    for (const e of [...this.entries.values()]) {
      if (e.inproc || found.has(e.id)) continue;
      ops.push(
        this.serialize(e, async () => {
          await this.stopEntry(e, 'removed');
          this.entries.delete(e.id);
          this.o.log.info({ plugin: e.id }, 'plugin directory removed');
          this.o.bus.emit('plugin.changed', { ...this.statusOf(e), state: 'stopped' });
        }),
      );
    }
    await Promise.all(ops);
  }

  private setInvalid(e: Entry): void {
    if (e.loaded && e.loaded.errors.length > 0) {
      e.state = 'invalid';
      e.error = e.loaded.errors.join('; ');
    }
  }

  /**
   * A plugin's configuration with its schema (null for in-process plugins and plugins without
   * one). Values of `x-secret` keys that are not `${secret:…}` references are masked.
   */
  configOf(id: string): { config: Record<string, unknown>; schema: Record<string, unknown> | null; coldKeys: string[] } | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    const schema = e.loaded?.configSchema ?? null;
    const props = (schema?.['properties'] ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.config)) {
      const secret = props[k]?.['x-secret'] === true;
      config[k] = secret && !(typeof v === 'string' && /^\$\{secret:[A-Z][A-Z0-9_]*\}$/.test(v)) ? '********' : v;
    }
    return { config, schema, coldKeys: e.loaded?.coldKeys ?? [] };
  }

  /** Manifest facts for the console (display name, description, triggers, declared secrets). */
  manifestOf(id: string): Record<string, unknown> | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.inproc) return { id, kind: e.kind, displayName: id, builtIn: true };
    const m = e.loaded?.manifest as unknown as Record<string, unknown> | undefined;
    if (!m) return { id, kind: e.kind, errors: e.loaded?.errors ?? [] };
    const pick = ['id', 'kind', 'version', 'displayName', 'description', 'runtime', 'level', 'triggers', 'secrets', 'optionalSecrets', 'login', 'hooks', 'skills', 'capabilities'];
    return { ...Object.fromEntries(pick.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])), dir: e.loaded?.dir, errors: e.loaded?.errors ?? [], warnings: e.loaded?.warnings ?? [] };
  }

  get(id: string): PluginStatus | undefined {
    const e = this.entries.get(id);
    return e ? this.statusOf(e) : undefined;
  }

  /** Where a plugin's files are (none for an in-process plugin). */
  dirOf(id: string): string | undefined {
    return this.entries.get(id)?.loaded?.dir;
  }

  status(): PluginStatus[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id)).map((e) => this.statusOf(e));
  }

  private statusOf(e: Entry): PluginStatus {
    const version = e.loaded?.manifest?.version;
    const pid = e.proc?.pid;
    return {
      id: e.id,
      kind: e.kind,
      state: e.state,
      enabled: e.enabled,
      origin: e.origin,
      tools: this.o.tools.namesOf(e.id),
      ...(version !== undefined ? { version } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(pid !== undefined && e.rssBytes !== undefined ? { memoryBytes: e.rssBytes } : {}),
      ...(e.restarts > 0 ? { restarts: e.restarts } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
    };
  }

  /** Running plugins' environment prompt sources, sorted by id. */
  envSources(): EnvPromptSource[] {
    const out: EnvPromptSource[] = [];
    for (const e of [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (e.state !== 'running') continue;
      if (e.inproc) {
        const p = e.inproc;
        out.push({ id: p.id, ...(p.envPromptFile ? { envPromptFile: p.envPromptFile } : {}), envPromptVars: () => (p.envPromptVars ? p.envPromptVars() : {}) });
      } else if (e.loaded?.envPromptFile) {
        const vars = e.envVars;
        out.push({ id: e.id, envPromptFile: e.loaded.envPromptFile, envPromptVars: () => vars });
      }
    }
    return out;
  }

  /** Skill directories shipped by enabled out-of-process plugins (manifest `skills`, default `skills/`). */
  skillRoots(): Array<{ dir: string; origin: 'plugin'; owner: string }> {
    const out: Array<{ dir: string; origin: 'plugin'; owner: string }> = [];
    for (const e of [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!e.enabled || !e.loaded?.manifest) continue;
      out.push({ dir: path.resolve(e.loaded.dir, e.loaded.manifest.skills ?? 'skills'), origin: 'plugin', owner: e.id });
    }
    return out;
  }

  /** Tools whose default policy is `ask` (manifest `sideEffectTools`). */
  isAskByDefault(def: ToolDef): boolean {
    const e = this.entries.get(def.owner);
    const list = e?.loaded?.manifest?.sideEffectTools ?? e?.inproc?.sideEffectTools ?? [];
    return list.includes(def.name);
  }

  // —— Lifecycle ——

  private serialize(e: Entry, fn: () => Promise<void>): Promise<void> {
    const run = e.op.then(fn, fn);
    e.op = run.catch((err: unknown) => {
      this.o.log.error({ plugin: e.id, err: errorMessage(err) }, 'plugin operation failed');
    });
    return run;
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no plugin ${id}`);
    return e;
  }

  private emit(e: Entry): void {
    this.o.bus.emit('plugin.changed', this.statusOf(e));
  }

  /** Start every enabled plugin. A failing plugin is marked failed; the others still start. */
  async startAll(): Promise<void> {
    this.started = true;
    this.watchdog.start();
    const ids = [...this.entries.values()]
      .filter((e) => e.enabled && (e.state === 'loaded' || e.state === 'stopped'))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => e.id);
    await Promise.all(ids.map((id) => this.start(id)));
  }

  start(id: string): Promise<void> {
    const e = this.entry(id);
    return this.serialize(e, () => this.startEntry(e, false));
  }

  stop(id: string, reason = 'stopped'): Promise<void> {
    const e = this.entry(id);
    return this.serialize(e, () => this.stopEntry(e, reason));
  }

  async enable(id: string, persist = true): Promise<PluginStatus> {
    const e = this.entry(id);
    if (!e.enabled) {
      e.enabled = true;
      if (persist) this.o.onEnabledChanged?.(id, true);
    }
    if (e.state !== 'running' && e.state !== 'starting') await this.start(id);
    return this.statusOf(e);
  }

  async disable(id: string, persist = true): Promise<PluginStatus> {
    const e = this.entry(id);
    if (e.enabled) {
      e.enabled = false;
      if (persist) this.o.onEnabledChanged?.(id, false);
    }
    await this.stop(id, 'disabled');
    return this.statusOf(e);
  }

  /** Stop, re-read the manifest and code, and start again (if enabled). */
  async reload(id: string): Promise<PluginStatus> {
    const e = this.entry(id);
    await this.serialize(e, async () => {
      await this.stopEntry(e, 'reloading');
      if (e.loaded) {
        e.loaded = loadManifest(e.loaded.dir, e.loaded.origin);
        e.kind = e.loaded.manifest?.kind ?? e.kind;
        e.state = 'loaded';
        delete e.error;
        this.setInvalid(e);
      }
      e.crashes = 0;
      if (e.enabled && e.state !== 'invalid') await this.startEntry(e, false);
      else this.emit(e);
    });
    return this.statusOf(e);
  }

  /** Start a failed (or stopped) plugin again, clearing its crash count. */
  async restart(id: string): Promise<PluginStatus> {
    const e = this.entry(id);
    e.crashes = 0;
    await this.serialize(e, async () => {
      await this.stopEntry(e, 'restarting');
      await this.startEntry(e, false);
    });
    return this.statusOf(e);
  }

  /** Copy a plugin directory into the data volume and load it (enable it unless told not to). */
  async install(srcDir: string, opts: { enable?: boolean } = {}): Promise<PluginStatus> {
    const src = path.resolve(srcDir);
    const probe = loadManifest(src, 'data');
    if (probe.errors.length > 0 || !probe.manifest) throw new Error(`invalid plugin: ${probe.errors.join('; ')}`);
    const id = probe.manifest.id;
    const existing = this.entries.get(id);
    if (existing?.inproc) throw new Error(`plugin id "${id}" belongs to a built-in plugin`);
    if (existing?.origin === 'data') throw new Error(`plugin ${id} is already installed; uninstall it first or reload it`);
    const dest = path.join(this.o.dataDir, 'plugins', id);
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Copy next to the target and rename, so the directory watcher never sees half a plugin.
    const staging = path.join(path.dirname(dest), `.install-${id}-${process.pid}-${Date.now()}`);
    try {
      fs.cpSync(src, staging, { recursive: true, filter: (p) => path.basename(p) !== '.git' });
      fs.renameSync(staging, dest);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    const loaded = loadManifest(dest, 'data');
    const enable = opts.enable ?? true;
    if (existing) {
      // A data-volume install overrides the built-in with the same id.
      await this.serialize(existing, async () => {
        await this.stopEntry(existing, 'replaced');
        existing.loaded = loaded;
        existing.origin = 'data';
        existing.kind = loaded.manifest?.kind ?? existing.kind;
        existing.state = 'loaded';
        delete existing.error;
        this.setInvalid(existing);
      });
    } else {
      const e = this.newEntry(id, loaded.manifest?.kind ?? 'unknown', 'data', { enabled: false, config: {} }, { loaded });
      this.setInvalid(e);
      this.entries.set(id, e);
    }
    this.o.log.info({ plugin: id, dir: dest }, 'plugin installed');
    if (enable) return this.enable(id);
    this.emit(this.entry(id));
    return this.statusOf(this.entry(id));
  }

  /** Remove a disabled data-volume plugin: its directory, configuration group and (optionally) data. */
  async uninstall(id: string, opts: { keepData?: boolean } = {}): Promise<void> {
    const e = this.entry(id);
    if (e.origin !== 'data' || !e.loaded) throw new Error(`plugin ${id} is not installed in the data volume`);
    if (e.enabled || e.state === 'running' || e.state === 'starting' || e.state === 'draining') {
      throw new Error(`plugin ${id} must be disabled before it is uninstalled`);
    }
    await this.serialize(e, async () => {
      await this.stopEntry(e, 'uninstalled');
      fs.rmSync(e.loaded?.dir as string, { recursive: true, force: true });
      if (!opts.keepData) fs.rmSync(path.join(this.o.dataDir, 'plugin-data', id), { recursive: true, force: true });
      this.entries.delete(id);
    });
    this.o.onUninstalled?.(id);
    this.o.log.info({ plugin: id, keepData: !!opts.keepData }, 'plugin uninstalled');
    this.o.bus.emit('plugin.changed', { ...this.statusOf(e), state: 'stopped' });
  }

  /** Apply configuration from the config file (hot reload): enabled flag and plugin config. */
  async applySettings(id: string, s: PluginSettings | undefined): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    const next = s ?? { enabled: e.origin === 'inproc', config: {} };
    if (JSON.stringify(next.config ?? {}) !== JSON.stringify(e.config)) await this.updateConfig(id, next.config ?? {});
    if (next.enabled && !e.enabled) await this.enable(id, false);
    if (!next.enabled && e.enabled) await this.disable(id, false);
  }

  /**
   * New plugin configuration. Hot keys go to the plugin as `config/changed`; a change of
   * a key marked `x-hot: false` (or any change for an in-process plugin) reloads it.
   */
  async updateConfig(id: string, config: Record<string, unknown>): Promise<PluginStatus> {
    const e = this.entry(id);
    const validate = e.loaded?.validateConfig;
    if (validate && !validate(config)) {
      throw new Error(`invalid config for ${id}: ${(validate.errors ?? []).map((x) => `${x.instancePath || '/'} ${x.message ?? ''}`).join('; ')}`);
    }
    const patch = shallowPatch(e.config, config);
    if (Object.keys(patch).length === 0) return this.statusOf(e);
    e.config = config;
    if (e.state !== 'running') return this.statusOf(e);
    const cold = e.inproc ? Object.keys(patch) : Object.keys(patch).filter((k) => e.loaded?.coldKeys.includes(k));
    if (cold.length > 0) {
      this.o.log.info({ plugin: id, keys: cold }, 'configuration change needs a reload');
      return this.reload(id);
    }
    await this.serialize(e, async () => {
      if (!e.proc) return;
      await e.proc.configChanged(this.resolveSecrets(patch), this.resolveSecrets(config));
      await this.refreshEnvVars(e);
    });
    this.o.log.info({ plugin: id, keys: Object.keys(patch) }, 'configuration updated');
    return this.statusOf(e);
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    this.watchdog.stop();
    await Promise.all([...this.entries.values()].map((e) => this.serialize(e, () => this.stopEntry(e, 'shutdown'))));
  }

  private async startEntry(e: Entry, supervised: boolean): Promise<void> {
    if (e.state === 'running' || e.state === 'invalid' || this.stopping) return;
    if (e.restartTimer) clearTimeout(e.restartTimer);
    e.restartTimer = null;
    e.startedAt = this.o.clock.now();
    e.state = 'starting';
    delete e.error;
    this.emit(e);
    try {
      if (e.inproc) await this.startInproc(e);
      else await this.startProcess(e);
    } catch (err) {
      const reason = errorMessage(err);
      this.o.tools.unregisterOwner(e.id, `plugin ${e.id} failed to start`);
      this.o.chat?.unregister(e.id, `plugin ${e.id} failed to start`);
      if (supervised) {
        this.onCrash(e, `restart failed: ${reason}`);
        return;
      }
      e.state = 'failed';
      e.error = reason;
      this.o.log.error({ plugin: e.id, err: reason }, 'plugin failed to start');
      this.emit(e);
      return;
    }
    e.state = 'running';
    this.o.log.info({ plugin: e.id, pid: e.proc?.pid, tools: this.o.tools.namesOf(e.id).length }, 'plugin started');
    this.emit(e);
    if (e.pendingSettled.length > 0) {
      const pending = e.pendingSettled.splice(0);
      e.proc?.settled(pending);
    }
  }

  private async startInproc(e: Entry): Promise<void> {
    const p = e.inproc as InprocPlugin;
    await p.start(this.contextFor(e));
    try {
      this.o.tools.registerAll(p.id, p.tools?.() ?? []);
    } catch (err) {
      await p.stop();
      throw err;
    }
    if (p.chat) this.o.chat?.register({ ...p.chat, id: p.id, send: (req) => (p.chat as NonNullable<InprocPlugin['chat']>).send(req) });
  }

  /** An out-of-process platform declares itself twice, in the manifest and at initialize. */
  private registerChat(e: Entry, log: Logger): void {
    const decl = e.loaded?.manifest?.chat;
    if (!decl && !e.capabilities.chat) return;
    if (!decl || !e.capabilities.chat) {
      log.warn('a chat platform needs both the manifest block "chat" and the "chat" capability; not registered');
      return;
    }
    // Drafts, like the platform itself, are declared twice. With one half missing the platform still works, without previews.
    const { drafts, ...rest } = decl;
    const takesDrafts = drafts !== undefined && e.capabilities.chatDrafts === true;
    if ((drafts !== undefined) !== (e.capabilities.chatDrafts === true)) {
      log.warn('drafts need both "chat.drafts" in the manifest and the "chatDrafts" capability; this platform gets no drafts');
    }
    this.o.chat?.register({
      ...rest,
      ...(takesDrafts ? { drafts } : {}),
      id: e.id,
      send: (req) => {
        if (!e.proc || e.state !== 'running') return { ok: false, error: `plugin ${e.id} is not running` };
        return e.proc.chatSend(req);
      },
      ...(takesDrafts
        ? {
            draft: (d) => {
              if (e.proc && e.state === 'running') e.proc.chatDraft(d);
            },
          }
        : {}),
    });
  }

  private async startProcess(e: Entry): Promise<void> {
    const loaded = e.loaded as LoadedManifest;
    const m = loaded.manifest;
    if (!m || loaded.errors.length > 0) throw new Error(loaded.errors.join('; ') || 'invalid manifest');
    if (loaded.validateConfig && !loaded.validateConfig(e.config)) {
      throw new Error(`invalid config: ${(loaded.validateConfig.errors ?? []).map((x) => `${x.instancePath || '/'} ${x.message ?? ''}`).join('; ')}`);
    }
    const secrets: Record<string, string> = {};
    for (const name of m.secrets ?? []) {
      const v = this.o.secrets?.get(name);
      if (v === undefined) throw new Error(`secret ${name} is not set`);
      secrets[name] = v;
    }
    for (const name of m.optionalSecrets ?? []) {
      const v = this.o.secrets?.get(name);
      if (v !== undefined) secrets[name] = v;
    }
    const config = this.resolveSecrets(e.config);
    const runtime = m.runtime as NonNullable<typeof m.runtime>;
    const dataDir = path.join(this.o.dataDir, 'plugin-data', e.id);
    fs.mkdirSync(dataDir, { recursive: true });
    const subst = (v: string): string => v.replaceAll('${pluginDir}', loaded.dir).replaceAll('${dataDir}', dataDir);
    let exec = runtime.exec;
    let args = runtime.args ?? [];
    // Built-ins run from source in development; installed plugins always run as shipped.
    if (this.o.dev && runtime.dev && e.origin === 'builtin') {
      exec = runtime.dev.exec ?? exec;
      args = runtime.dev.args ?? args;
    }
    if (exec === 'node') {
      exec = process.execPath;
      if (this.o.dev) args = ['--conditions=source', '--import', this.o.dev.loader, ...args];
    }
    const env: Record<string, string> = passthroughEnv();
    for (const k of ['PATH', 'HOME']) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, {
      TZ: this.o.timezone,
      PROTEA_PLUGIN_ID: e.id,
      PROTEA_PLUGIN_DATA_DIR: dataDir,
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    });
    for (const [k, v] of Object.entries(runtime.env ?? {})) env[k] = subst(v);
    if (this.o.pythonPath) env['PYTHONPATH'] = [this.o.pythonPath, env['PYTHONPATH']].filter(Boolean).join(path.delimiter);
    Object.assign(env, secrets);

    const log = this.o.log.child({ plugin: e.id });
    const limited = withLimits(exec, args.map(subst), this.settings.limits);
    e.killReason = null;
    const proc = new ProcessPlugin({
      id: e.id,
      exec: limited.command,
      args: limited.args,
      cwd: runtime.cwd ? path.resolve(loaded.dir, runtime.cwd) : loaded.dir,
      env,
      log,
      handlers: this.handlersFor(e, log),
      initializeTimeoutMs: this.settings.initializeTimeoutMs,
      health: { intervalMs: m.healthcheck?.intervalMs ?? 30_000, timeoutMs: m.healthcheck?.timeoutMs ?? 5_000 },
      onUnexpectedExit: (reason) => {
        if (e.proc !== proc) return;
        void this.serialize(e, async () => {
          if (e.proc === proc && (e.state === 'running' || e.state === 'starting')) this.onCrash(e, e.killReason ?? reason);
        });
      },
    });
    e.proc = proc;
    const caps = this.capsFor(e);
    let started;
    try {
      started = await proc.start({
        pluginId: e.id,
        config,
        dataDir,
        hostDataDir: this.o.dataDir,
        timezone: this.o.timezone,
        language: this.o.language ?? 'en',
        hostCapabilities: ['events', 'kv', 'owner', 'approvals', 'hooks', 'chat', 'blobs', 'login'],
        modelFacts: { mainModel: this.o.mainModel?.() ?? '' },
        levelCap: caps.maxLevel,
        allowedTriggers: allowedTriggers(m),
      });
    } catch (err) {
      e.proc = null;
      throw err;
    }
    e.capabilities = started.init.capabilities ?? {};
    const declared = new Set(m.tools ?? []);
    const specs: ToolSpec<never>[] = [];
    for (const d of started.tools) {
      if (!d || typeof d.name !== 'string' || typeof d.description !== 'string' || typeof d.inputSchema !== 'object') {
        log.warn({ tool: (d as { name?: unknown })?.name }, 'ignoring a malformed tool declaration');
        continue;
      }
      if (!declared.has(d.name)) log.warn({ tool: d.name }, 'tool is not declared in the manifest');
      specs.push(this.toolSpec(e, d));
    }
    try {
      this.o.tools.registerAll(e.id, specs);
    } catch (err) {
      await proc.kill();
      e.proc = null;
      throw err;
    }
    this.registerChat(e, log);
    await this.refreshEnvVars(e);
  }

  private async refreshEnvVars(e: Entry): Promise<void> {
    if (!e.proc) return;
    if (!e.capabilities.envPrompt) {
      e.envVars = {};
      return;
    }
    try {
      e.envVars = await e.proc.envPrompt(this.o.language ?? 'en');
    } catch (err) {
      this.o.log.warn({ plugin: e.id, err: errorMessage(err) }, 'env/prompt failed; using no variables');
      e.envVars = {};
    }
    this.emit(e);
  }

  private onCrash(e: Entry, reason: string): void {
    const ranMs = this.o.clock.now() - e.startedAt;
    this.o.tools.unregisterOwner(e.id, `plugin ${e.id} crashed`);
    this.o.chat?.unregister(e.id, `plugin ${e.id} crashed`);
    e.proc = null;
    if (ranMs >= this.settings.stableAfterMs) e.crashes = 0;
    e.crashes++;
    e.error = reason;
    if (e.crashes >= this.settings.maxCrashes) {
      e.state = 'failed';
      e.error = `crashed ${e.crashes} times in a row; last: ${reason}`;
      this.o.log.error({ plugin: e.id, crashes: e.crashes, reason }, 'plugin failed: too many crashes');
      this.emit(e);
      this.o.gateway.pushInternal({
        type: 'plugin.failed',
        level: 2,
        trigger: 'flush',
        text: `Plugin ${e.id} crashed ${e.crashes} times in a row and was stopped (${reason}). Its tools are unavailable until an operator restarts it.`,
        correlation: e.id,
      });
      return;
    }
    const delays = this.settings.restartBackoffMs;
    const delay = delays[Math.min(e.crashes - 1, delays.length - 1)] ?? 1000;
    e.state = 'crashed';
    this.o.log.warn({ plugin: e.id, reason, crashes: e.crashes, restartInMs: delay }, 'plugin crashed; restarting');
    this.emit(e);
    this.o.gateway.pushInternal({
      type: 'plugin.crashed',
      level: 4,
      trigger: 'store',
      text: `Plugin ${e.id} crashed (${reason}); restarting in ${Math.round(delay / 1000)}s (crash ${e.crashes} of ${this.settings.maxCrashes}).`,
      correlation: e.id,
    });
    e.restartTimer = setTimeout(() => {
      e.restartTimer = null;
      e.restarts++;
      void this.serialize(e, () => (e.state === 'crashed' ? this.startEntry(e, true) : Promise.resolve()));
    }, delay);
  }

  private async stopEntry(e: Entry, reason: string): Promise<void> {
    if (e.restartTimer) clearTimeout(e.restartTimer);
    e.restartTimer = null;
    if (e.state === 'crashed' || e.state === 'failed') {
      if (reason !== 'shutdown') e.state = 'stopped';
      this.emit(e);
      return;
    }
    if (e.state !== 'running' && e.state !== 'starting') return;
    e.state = 'draining';
    this.emit(e);
    this.o.tools.unregisterOwner(e.id, `plugin ${e.id} is ${reason === 'disabled' ? 'disabled' : `stopped (${reason})`}`);
    this.o.chat?.unregister(e.id, `plugin ${e.id} is ${reason === 'disabled' ? 'disabled' : `stopped (${reason})`}`);
    if (e.inproc) {
      try {
        await e.inproc.stop();
      } catch (err) {
        this.o.log.warn({ plugin: e.id, err: errorMessage(err) }, 'plugin stop failed');
      }
    } else if (e.proc) {
      const proc = e.proc;
      const deadline = this.o.clock.now() + this.settings.drainTimeoutMs;
      while (proc.busyCalls > 0 && this.o.clock.now() < deadline) await sleep(25);
      if (proc.busyCalls > 0) this.o.log.warn({ plugin: e.id, calls: proc.busyCalls }, 'tool calls still running at the drain deadline');
      await proc.stop(reason, this.settings.stopTimeoutMs);
      e.proc = null;
    }
    e.state = 'stopped';
    this.o.log.info({ plugin: e.id, reason }, 'plugin stopped');
    this.emit(e);
  }

  // —— Plugin ↔ Core ——

  private capsFor(e: Entry): SourceCaps {
    if (e.inproc) {
      const p = e.inproc;
      return {
        source: p.id,
        maxLevel: p.levelCap,
        ...(p.triggers ? { triggers: p.triggers } : {}),
        ...(p.mayEmitInternal ? { mayEmitInternal: true } : {}),
      };
    }
    const m = e.loaded?.manifest;
    return {
      source: e.id,
      maxLevel: (m?.level ?? 4) as Level,
      ...(m?.triggers ? { triggers: m.triggers } : {}),
    };
  }

  private resolveSecrets<T>(value: T): T {
    if (typeof value === 'string') {
      const m = SECRET_REF.exec(value);
      if (!m) return value;
      const v = this.o.secrets?.get(m[1] as string);
      if (v === undefined) throw new Error(`secret ${m[1]} referenced in the plugin config is not set`);
      return v as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.resolveSecrets(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.resolveSecrets(v)])) as T;
    }
    return value;
  }

  private toolSpec(e: Entry, d: ToolDecl): ToolSpec<never> {
    const spec: ToolSpec<unknown> = {
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      ...(d.flags ? { flags: d.flags } : {}),
      ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}),
      ...(d.approval && typeof d.approval === 'object' ? { approval: d.approval } : {}),
      handler: async (input, ctx) => {
        const proc = e.proc;
        if (!proc || e.state !== 'running') return { text: `plugin ${e.id} is not running`, failed: true };
        try {
          const r = await proc.callTool(d.name, input, { sessionId: ctx.sessionId, batchId: ctx.batchId, batchLevel: ctx.batchLevel }, ctx.signal);
          return {
            text: typeof r?.text === 'string' ? r.text : JSON.stringify(r ?? null),
            ...(r?.failed ? { failed: true } : {}),
            ...(r?.partial ? { partial: true } : {}),
            ...(r?.endsTurn ? { endsTurn: true } : {}),
            ...this.toolImages(e, r?.images),
          };
        } catch (err) {
          return { text: `plugin ${e.id}: ${errorMessage(err)}`, failed: true };
        }
      },
    };
    return spec as unknown as ToolSpec<never>;
  }

  /** The stored images a plugin's result names; the store says what they are, the plugin's word is not taken. */
  private toolImages(e: Entry, refs: unknown): { images?: Array<{ handle: string; mime: string }> } {
    if (!Array.isArray(refs) || refs.length === 0 || !this.o.blobs) return {};
    const images: Array<{ handle: string; mime: string }> = [];
    for (const ref of refs as Array<{ handle?: unknown }>) {
      const info = typeof ref?.handle === 'string' ? this.o.blobs.info(ref.handle) : null;
      if (info) images.push({ handle: info.handle, mime: info.mime });
      else this.o.log.warn({ plugin: e.id }, 'a tool result names an image that is not stored');
    }
    return images.length > 0 ? { images } : {};
  }

  private handlersFor(e: Entry, log: Logger): Record<string, RpcHandler> {
    const kv = kvNamespace(this.o.kv, `plugin:${e.id}`);
    const caps = (): SourceCaps => this.capsFor(e);
    const own = (cursor: unknown): number => {
      const c = Number(cursor);
      const ev = Number.isInteger(c) ? this.o.store.get(c) : undefined;
      if (!ev || ev.source !== e.id) throw new RpcError(RPC_ERRORS.InvalidParams, `event #${String(cursor)} is not from ${e.id}`);
      return c;
    };
    const str = (v: unknown, what: string): string => {
      if (typeof v !== 'string' || v === '') throw new RpcError(RPC_ERRORS.InvalidParams, `${what} must be a non-empty string`);
      return v;
    };
    return {
      [PLUGIN_TO_HOST.eventsPush]: (params) => {
        const r = this.o.gateway.push(caps(), params as EventInput);
        if (!r.ok) throw new RpcError(RPC_ERRORS.InvalidParams, (r.errors ?? []).join('; '));
        return { cursor: r.cursor, effectiveLevel: r.effectiveLevel, effectiveTrigger: r.effectiveTrigger, deduped: r.deduped, warnings: r.warnings };
      },
      [PLUGIN_TO_HOST.eventsPromote]: (params) => {
        const p = params as { cursor: unknown; trigger: unknown };
        const cursor = own(p.cursor);
        if (p.trigger !== 'flush' && p.trigger !== 'piggyback') throw new RpcError(RPC_ERRORS.TriggerNotAllowed, 'trigger must be flush or piggyback');
        const ev = this.o.store.promote(cursor, p.trigger);
        return { ok: !!ev, ...(ev ? { effectiveTrigger: ev.effTrigger } : {}) };
      },
      [PLUGIN_TO_HOST.eventsWithdraw]: (params) => {
        const cursor = own((params as { cursor: unknown }).cursor);
        const ev = this.o.store.get(cursor);
        if (ev?.state !== 'pending' && ev?.state !== 'archived') return { ok: false };
        return { ok: this.o.store.settle([cursor], 'withdrawn').length === 1 };
      },
      [PLUGIN_TO_HOST.eventsQuery]: (params) => {
        const p = (params ?? {}) as { filter?: { type?: string; states?: EventState[]; sinceCursor?: number }; limit?: number };
        return {
          events: this.o.store.query({
            source: e.id,
            limit: Math.min(p.limit ?? 50, 200),
            order: 'desc',
            ...(p.filter?.type !== undefined ? { type: p.filter.type } : {}),
            ...(p.filter?.states !== undefined ? { states: p.filter.states } : {}),
            ...(p.filter?.sinceCursor !== undefined ? { sinceCursor: p.filter.sinceCursor } : {}),
          }),
        };
      },
      [PLUGIN_TO_HOST.log]: (params) => {
        const p = params as LogParams;
        const level = (['trace', 'debug', 'info', 'warn', 'error'] as const).includes(p?.level) ? p.level : 'info';
        log[level](p?.fields ?? {}, String(p?.msg ?? ''));
      },
      [PLUGIN_TO_HOST.kvGet]: (params) => ({ value: kv.get(str((params as { key: unknown }).key, 'key')) ?? null }),
      [PLUGIN_TO_HOST.kvSet]: (params) => {
        const p = params as { key: unknown; value: unknown };
        kv.set(str(p.key, 'key'), p.value ?? null);
        return {};
      },
      [PLUGIN_TO_HOST.kvDelete]: (params) => {
        kv.delete(str((params as { key: unknown }).key, 'key'));
        return {};
      },
      [PLUGIN_TO_HOST.ownerResolve]: (params) => ({
        role: this.o.owner.resolve(e.id, str((params as { senderKey: unknown }).senderKey, 'senderKey')) ?? 'unknown',
      }),
      [PLUGIN_TO_HOST.secretsExists]: (params) => {
        const name = str((params as { name: unknown }).name, 'name');
        const declared = [...(e.loaded?.manifest?.secrets ?? []), ...(e.loaded?.manifest?.optionalSecrets ?? [])];
        return { exists: declared.includes(name) && this.o.secrets?.get(name) !== undefined };
      },
      [PLUGIN_TO_HOST.blobPut]: (params) => {
        const blobs = this.o.blobs;
        if (!blobs) throw new RpcError(RPC_ERRORS.Internal, 'blobs are not available');
        const p = params as BlobPutParams;
        const r = blobs.putImage(Buffer.from(str(p.dataBase64, 'dataBase64'), 'base64'), e.id);
        if (!r.ok) throw new RpcError(RPC_ERRORS.InvalidParams, r.reason);
        return { handle: r.blob.handle, mime: r.blob.mime, size: r.blob.size } satisfies BlobPutResult;
      },
      [PLUGIN_TO_HOST.blobGet]: (params) => {
        const blobs = this.o.blobs;
        if (!blobs) throw new RpcError(RPC_ERRORS.Internal, 'blobs are not available');
        const handle = str((params as BlobGetParams).handle, 'handle');
        const found = blobs.get(handle);
        if (!found) throw new RpcError(RPC_ERRORS.InvalidParams, `${handle} is not stored`);
        return { dataBase64: found.bytes.toString('base64'), mime: found.mime, size: found.size } satisfies BlobGetResult;
      },
      [PLUGIN_TO_HOST.approvalsDecide]: (params) => {
        const p = params as ApprovalDecideParams;
        const senderKey = str(p.senderKey, 'senderKey');
        if (this.o.owner.resolve(e.id, senderKey) !== 'owner') {
          throw new RpcError(RPC_ERRORS.Unauthorized, 'only the owner can decide approvals');
        }
        if (!this.approvals) throw new RpcError(RPC_ERRORS.Internal, 'approvals are not available');
        if (p.decision !== 'approve' && p.decision !== 'deny') throw new RpcError(RPC_ERRORS.InvalidParams, 'decision must be approve or deny');
        return this.approvals.decide(str(p.id, 'id'), p.decision, `${e.id}:${senderKey}`, {
          ...(p.grantMs !== undefined ? { grantMs: Number(p.grantMs) } : {}),
          ...(typeof p.note === 'string' && p.note.trim() ? { note: p.note } : {}),
        });
      },
      [PLUGIN_TO_HOST.loginComplete]: (params) => this.completeLogin(e, params as LoginCompleteParams, log),
      [PLUGIN_TO_HOST.permissionsMode]: async (params) => {
        const p = params as PermissionModeParams;
        const senderKey = str(p.senderKey, 'senderKey');
        if (this.o.owner.resolve(e.id, senderKey) !== 'owner') {
          throw new RpcError(RPC_ERRORS.Unauthorized, 'only the owner can read or change the permission mode');
        }
        if (!this.modes) throw new RpcError(RPC_ERRORS.Internal, 'permission modes are not available');
        if (p.mode === undefined) return this.modes.info();
        try {
          return await this.modes.set(p.mode, { by: `${e.id}:${senderKey}`, ...(p.forMs !== undefined ? { forMs: Number(p.forMs) } : {}) });
        } catch (err) {
          if (err instanceof PermissionModeError) throw new RpcError(RPC_ERRORS.InvalidParams, err.message);
          throw err;
        }
      },
    };
  }

  private deliverSettled(source: string, events: Array<{ cursor: number }>, outcome: TerminalOutcome): void {
    const e = this.entries.get(source);
    if (!e) return;
    if (e.inproc) {
      if (e.state !== 'running' || !e.inproc.onEventsSettled) return;
      try {
        e.inproc.onEventsSettled(events, outcome);
      } catch (err) {
        this.o.log.warn({ plugin: source, err: errorMessage(err) }, 'onEventsSettled threw');
      }
      return;
    }
    const items = events.map((x) => ({ cursor: x.cursor, outcome }));
    if (e.state === 'running' && e.proc) {
      if (e.capabilities.settled) e.proc.settled(items);
      return;
    }
    // Not running (crashed, restarting): replay once it is back.
    e.pendingSettled.push(...items);
    if (e.pendingSettled.length > MAX_PENDING_SETTLED) e.pendingSettled.splice(0, e.pendingSettled.length - MAX_PENDING_SETTLED);
  }

  /** The running plugins that can show an approval request. */
  approvalPlatforms(): string[] {
    return [...this.entries.values()].filter((e) => e.state === 'running' && (e.inproc?.onApprovalRequest || (e.proc && e.capabilities.approvals))).map((e) => e.id);
  }

  /**
   * Show an approval request to the owner. Without `platforms` every running channel that can
   * show it gets it. With `platforms` only those do; when none of them takes it (not running,
   * or the platform refused), the others are tried, so a request is never lost to a closed
   * chat window. Returns the channels that showed it.
   */
  async requestApproval(a: ApprovalInfo, platforms?: readonly string[]): Promise<string[]> {
    const grantMaxMs = this.approvals?.grantMax() ?? 0;
    const params: ApprovalRequestParams = {
      id: a.id,
      tool: a.tool,
      summary: a.summary,
      expiresAt: a.expiresAt,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      ...(a.view ? { view: a.view } : {}),
      ...(grantMaxMs > 0 ? { grantMaxMs } : {}),
    };
    const send = async (ids: readonly string[]): Promise<string[]> => {
      const delivered: string[] = [];
      await Promise.all(
        ids.map(async (id) => {
          const e = this.entries.get(id);
          if (!e || e.state !== 'running') return;
          try {
            if (e.inproc?.onApprovalRequest) {
              if ((await e.inproc.onApprovalRequest(params)).delivered) delivered.push(e.id);
            } else if (e.proc && e.capabilities.approvals) {
              if ((await e.proc.approvalRequest(params)).delivered) delivered.push(e.id);
            }
          } catch (err) {
            this.o.log.warn({ plugin: e.id, approval: a.id, err: errorMessage(err) }, 'approval request delivery failed');
          }
        }),
      );
      return delivered;
    };
    const all = this.approvalPlatforms();
    if (!platforms?.length) return send(all);
    const chosen = all.filter((id) => platforms.includes(id));
    const delivered = await send(chosen);
    if (delivered.length > 0) return delivered;
    // Asked again on new platforms while others already show it: nothing to fall back to.
    if (a.deliveredTo?.length) return delivered;
    return send(all.filter((id) => !chosen.includes(id)));
  }

  /** A request was decided or expired: the channels that showed it take it down. */
  approvalResolved(a: ApprovalInfo): void {
    if (a.state !== 'approved' && a.state !== 'denied' && a.state !== 'expired') return;
    const params: ApprovalResolvedParams = { id: a.id, state: a.state, ...(a.decidedBy !== undefined ? { by: a.decidedBy } : {}) };
    for (const id of a.deliveredTo ?? []) {
      const e = this.entries.get(id);
      if (!e || e.state !== 'running') continue;
      try {
        if (e.inproc) e.inproc.onApprovalResolved?.(params);
        else if (e.proc && e.capabilities.approvals) e.proc.approvalResolved(params);
      } catch (err) {
        this.o.log.warn({ plugin: e.id, approval: a.id, err: errorMessage(err) }, 'could not tell a plugin that a request was settled');
      }
    }
  }

  // —— Sign-in (docs/30-specs/03-plugin-protocol.md §3) ——

  /** True when the plugin's manifest offers a sign-in. */
  supportsLogin(id: string): boolean {
    return this.entries.get(id)?.loaded?.manifest?.login !== undefined;
  }

  private loginTarget(id: string): { e: Entry; proc: ProcessPlugin } {
    const e = this.entry(id);
    if (e.loaded?.manifest?.login === undefined) throw new Error(`plugin ${id} has no sign-in`);
    if (e.state !== 'running' || !e.proc) throw new Error(`plugin ${id} is not running; enable it first`);
    if (!e.capabilities.login) throw new Error(`plugin ${id} declares a sign-in but does not answer one`);
    return { e, proc: e.proc };
  }

  async loginStart(id: string): Promise<PluginLoginStatus> {
    const { e, proc } = this.loginTarget(id);
    e.loginOpenUntil = this.o.clock.now() + LOGIN_WINDOW_MS;
    try {
      return await proc.request<PluginLoginStatus>(HOST_TO_PLUGIN.loginStart, {}, LOGIN_RPC_TIMEOUT_MS);
    } catch (err) {
      delete e.loginOpenUntil;
      throw err;
    }
  }

  loginStatus(id: string): Promise<PluginLoginStatus> {
    return this.loginTarget(id).proc.request<PluginLoginStatus>(HOST_TO_PLUGIN.loginStatus, {}, LOGIN_RPC_TIMEOUT_MS);
  }

  loginSubmit(id: string, code: string): Promise<PluginLoginStatus> {
    return this.loginTarget(id).proc.request<PluginLoginStatus>(HOST_TO_PLUGIN.loginSubmit, { code }, LOGIN_RPC_TIMEOUT_MS);
  }

  async loginCancel(id: string): Promise<PluginLoginStatus> {
    const { e, proc } = this.loginTarget(id);
    delete e.loginOpenUntil;
    return proc.request<PluginLoginStatus>(HOST_TO_PLUGIN.loginCancel, {}, LOGIN_RPC_TIMEOUT_MS);
  }

  /** Forget the credentials a sign-in stored and who it made the owner; a running plugin restarts without them. */
  async logout(id: string): Promise<PluginStatus> {
    const e = this.entry(id);
    const m = e.loaded?.manifest;
    if (m?.login === undefined) throw new Error(`plugin ${id} has no sign-in`);
    delete e.loginOpenUntil;
    for (const name of m.optionalSecrets ?? []) {
      if (this.o.secrets?.delete(name).fromEnv) this.o.log.warn({ plugin: id, secret: name }, 'this secret is still set in the environment, so the plugin stays signed in');
    }
    this.o.onOwnerSignIn?.(id, null);
    if (e.state === 'running') await this.restart(id);
    return this.statusOf(e);
  }

  /** The plugin reports a finished sign-in: keep its credentials, name the owner, restart it with them. */
  private completeLogin(e: Entry, p: LoginCompleteParams, log: Logger): { ok: true } {
    if (e.loginOpenUntil === undefined || this.o.clock.now() > e.loginOpenUntil) throw new RpcError(RPC_ERRORS.Unauthorized, 'no sign-in is in progress');
    const m = e.loaded?.manifest;
    const declared = new Set([...(m?.secrets ?? []), ...(m?.optionalSecrets ?? [])]);
    const entries = Object.entries(p?.secrets ?? {});
    if (entries.length === 0) throw new RpcError(RPC_ERRORS.InvalidParams, 'a sign-in must hand over at least one secret');
    for (const [name, value] of entries) {
      if (!declared.has(name)) throw new RpcError(RPC_ERRORS.InvalidParams, `secret ${name} is not declared in the manifest`);
      if (typeof value !== 'string' || value.trim() === '') throw new RpcError(RPC_ERRORS.InvalidParams, `secret ${name} must be a non-empty string`);
    }
    // A sign-in names one person; "*" would make everyone on this platform the owner.
    if (p.ownerSenderKey !== undefined && (typeof p.ownerSenderKey !== 'string' || p.ownerSenderKey === '' || p.ownerSenderKey.includes('*'))) {
      throw new RpcError(RPC_ERRORS.InvalidParams, 'ownerSenderKey must name one sender');
    }
    const secrets = this.o.secrets;
    if (!secrets) throw new RpcError(RPC_ERRORS.Internal, 'the secret store is not available');
    delete e.loginOpenUntil;
    for (const [name, value] of entries) secrets.set(name, value);
    if (p.ownerSenderKey !== undefined) this.o.onOwnerSignIn?.(e.id, p.ownerSenderKey);
    log.info({ secrets: entries.map(([name]) => name), owner: p.ownerSenderKey !== undefined }, 'sign-in completed; restarting the plugin with its credentials');
    // After the reply went out: the plugin is still waiting for it.
    setImmediate(() => {
      this.restart(e.id).catch((err: unknown) => log.error({ err: errorMessage(err) }, 'could not restart the plugin after its sign-in'));
    });
    return { ok: true };
  }

  /** Forward `/hooks/<name>` to the running plugin that serves it; undefined if none does. */
  async hook(name: string, req: Omit<HttpRequestParams, 'hook'>): Promise<HttpResponse | undefined> {
    for (const e of this.entries.values()) {
      if (e.state === 'running' && e.proc && e.capabilities.hooks?.includes(name)) return e.proc.http({ hook: name, ...req });
    }
    return undefined;
  }

  private contextFor(e: Entry): PluginContext {
    const p = e.inproc as InprocPlugin;
    const caps = this.capsFor(e);
    const log = this.o.log.child({ plugin: p.id });
    return {
      id: p.id,
      config: e.config,
      dataDir: path.join(this.o.dataDir, 'plugin-data', p.id),
      timezone: this.o.timezone,
      language: this.o.language ?? 'en',
      log,
      kv: kvNamespace(this.o.kv, `plugin:${p.id}`),
      clock: this.o.clock,
      pushEvent: (input) => this.o.gateway.push(caps, input),
      emitOutput: (out) => {
        const at = new Date(this.o.clock.now()).toISOString();
        let id: number | undefined;
        try {
          id = this.o.outputs?.record({
            at,
            plugin: p.id,
            text: out.text,
            ...(out.channel !== undefined ? { channel: out.channel } : {}),
            ...(out.sessionId !== undefined ? { sessionId: out.sessionId } : {}),
            ...(out.batchId !== undefined ? { batchId: out.batchId } : {}),
          }).id;
        } catch (err) {
          log.warn({ err: errorMessage(err) }, 'could not store an output');
        }
        this.o.bus.emit('plugin.output', {
          plugin: p.id,
          text: out.text,
          at,
          ...(out.channel !== undefined ? { channel: out.channel } : {}),
          ...(id !== undefined ? { id } : {}),
          ...(out.batchId !== undefined ? { batchId: out.batchId } : {}),
        });
      },
      resolveSender: (senderKey) => this.o.owner.resolve(p.id, senderKey) ?? 'unknown',
    };
  }
}
