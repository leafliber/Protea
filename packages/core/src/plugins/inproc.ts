import type { EventInput, Level, SenderRole, TerminalOutcome, Trigger } from '@protea/protocol';
import type { Bus } from '../bus.js';
import { kvNamespace, type KvNamespace, type KvRepo } from '../db/repos.js';
import { gateEvent, type SourceCaps } from '../events/gate.js';
import type { OwnerRegistry } from '../events/owner.js';
import type { EventStore } from '../events/store.js';
import type { Logger } from '../observability/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';

export type PluginKind = 'source' | 'connector' | 'tool';

export interface PushResult {
  ok: boolean;
  cursor?: number;
  effectiveLevel?: Level;
  effectiveTrigger?: Trigger;
  deduped?: boolean;
  warnings: string[];
  errors?: string[];
}

/** What Core offers an in-process plugin; mirrors the out-of-process protocol (docs/30-specs/03-plugin-protocol.md). */
export interface PluginContext {
  readonly id: string;
  readonly config: Record<string, unknown>;
  readonly dataDir: string;
  readonly timezone: string;
  readonly log: Logger;
  readonly kv: KvNamespace;
  readonly clock: Clock;
  pushEvent(input: EventInput): PushResult;
  emitOutput(o: { channel?: string; text: string }): void;
  resolveSender(senderKey: string): SenderRole;
}

/**
 * Built-in plugins that run inside the daemon (console, cron). Third-party plugins
 * use the out-of-process protocol from M2; this interface keeps the same shape.
 */
export interface InprocPlugin {
  readonly id: string;
  readonly kind: PluginKind;
  readonly levelCap: Level;
  readonly triggers?: readonly Trigger[];
  readonly mayEmitInternal?: boolean;
  /** Absolute path of the plugin's ENV_PROMPT.md template. */
  readonly envPromptFile?: string;
  start(ctx: PluginContext): Promise<void> | void;
  stop(): Promise<void> | void;
  tools?(): ToolSpec<never>[];
  envPromptVars?(): Record<string, unknown> | null;
  onEventsSettled?(events: Array<{ cursor: number }>, outcome: TerminalOutcome): void;
}

interface Entry {
  plugin: InprocPlugin;
  config: Record<string, unknown>;
  state: 'running' | 'stopped' | 'failed';
  error?: string;
}

export interface PluginHostOptions {
  store: EventStore;
  bus: Bus;
  owner: OwnerRegistry;
  kv: KvRepo;
  tools: ToolRegistry;
  log: Logger;
  clock: Clock;
  dataDir: string;
  timezone: string;
}

export const CORE_SOURCE = 'core';

/** Hosts in-process plugins and is the single entry point for events into the store. */
export class InprocPluginHost {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly o: PluginHostOptions) {
    o.bus.on('event.settled', (s) => {
      const bySource = new Map<string, Array<{ cursor: number }>>();
      for (const e of s.events) bySource.set(e.source, [...(bySource.get(e.source) ?? []), { cursor: e.cursor }]);
      for (const [source, events] of bySource) {
        const entry = this.entries.get(source);
        if (entry?.state !== 'running' || !entry.plugin.onEventsSettled) continue;
        try {
          entry.plugin.onEventsSettled(events, s.outcome);
        } catch (err) {
          o.log.warn({ plugin: source, err: errorMessage(err) }, 'onEventsSettled threw');
        }
      }
    });
  }

  register(plugin: InprocPlugin, config: Record<string, unknown> = {}): void {
    if (this.entries.has(plugin.id) || plugin.id === CORE_SOURCE) throw new Error(`plugin id "${plugin.id}" is taken`);
    this.entries.set(plugin.id, { plugin, config, state: 'stopped' });
  }

  get(id: string): InprocPlugin | undefined {
    return this.entries.get(id)?.plugin;
  }

  running(): InprocPlugin[] {
    return [...this.entries.values()].filter((e) => e.state === 'running').map((e) => e.plugin);
  }

  status(): Array<{ id: string; kind: string; state: Entry['state']; error?: string }> {
    return [...this.entries.values()].map((e) => ({
      id: e.plugin.id,
      kind: e.plugin.kind,
      state: e.state,
      ...(e.error !== undefined ? { error: e.error } : {}),
    }));
  }

  /** Start every registered plugin. A failing plugin is marked failed; the others still start. */
  async startAll(): Promise<void> {
    for (const entry of [...this.entries.values()].sort((a, b) => a.plugin.id.localeCompare(b.plugin.id))) {
      const p = entry.plugin;
      try {
        await p.start(this.contextFor(entry));
        for (const spec of p.tools?.() ?? []) this.o.tools.register(p.id, spec);
        entry.state = 'running';
        delete entry.error;
        this.o.log.info({ plugin: p.id }, 'plugin started');
      } catch (err) {
        entry.state = 'failed';
        entry.error = errorMessage(err);
        this.o.tools.unregisterOwner(p.id);
        this.o.log.error({ plugin: p.id, err: entry.error }, 'plugin failed to start');
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state !== 'running') continue;
      try {
        await entry.plugin.stop();
      } catch (err) {
        this.o.log.warn({ plugin: entry.plugin.id, err: errorMessage(err) }, 'plugin stop failed');
      }
      this.o.tools.unregisterOwner(entry.plugin.id);
      entry.state = 'stopped';
    }
  }

  /** Gate and store an event on behalf of a source. */
  push(caps: SourceCaps, input: EventInput): PushResult {
    const gated = gateEvent(input, caps, this.o.owner);
    if (!gated.ok) {
      this.o.log.warn({ source: caps.source, errors: gated.errors }, 'event rejected');
      return { ok: false, warnings: [], errors: gated.errors };
    }
    const { envelope, deduped } = this.o.store.append(gated.event);
    if (gated.warnings.length > 0 && !deduped) {
      this.o.log.warn({ source: caps.source, cursor: envelope.cursor, warnings: gated.warnings }, 'event downgraded');
      if (caps.source !== CORE_SOURCE) {
        this.pushInternal({
          type: 'core.event_downgraded',
          level: 4,
          trigger: 'piggyback',
          text: `Event #${envelope.cursor} from ${caps.source} was adjusted: ${gated.warnings.join('; ')}.`,
          correlation: String(envelope.cursor),
        });
      }
    }
    return {
      ok: true,
      cursor: envelope.cursor,
      effectiveLevel: envelope.effLevel,
      effectiveTrigger: envelope.effTrigger,
      deduped,
      warnings: gated.warnings,
    };
  }

  /** Core's own events: origin internal, may use level 0. */
  pushInternal(input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }): PushResult {
    return this.push(
      { source: CORE_SOURCE, maxLevel: 0, mayEmitInternal: true },
      { ...input, ts: input.ts ?? new Date(this.o.clock.now()).toISOString(), origin: 'internal' },
    );
  }

  private contextFor(entry: Entry): PluginContext {
    const p = entry.plugin;
    const caps: SourceCaps = {
      source: p.id,
      maxLevel: p.levelCap,
      ...(p.triggers ? { triggers: p.triggers } : {}),
      ...(p.mayEmitInternal ? { mayEmitInternal: true } : {}),
    };
    const log = this.o.log.child({ plugin: p.id });
    return {
      id: p.id,
      config: entry.config,
      dataDir: `${this.o.dataDir}/plugin-data/${p.id}`,
      timezone: this.o.timezone,
      log,
      kv: kvNamespace(this.o.kv, `plugin:${p.id}`),
      clock: this.o.clock,
      pushEvent: (input) => this.push(caps, input),
      emitOutput: (out) =>
        this.o.bus.emit('plugin.output', {
          plugin: p.id,
          text: out.text,
          at: new Date(this.o.clock.now()).toISOString(),
          ...(out.channel !== undefined ? { channel: out.channel } : {}),
        }),
      resolveSender: (senderKey) => this.o.owner.resolve(p.id, senderKey) ?? 'unknown',
    };
  }
}
