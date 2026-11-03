import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { isoInZone, newId, parseDateTime, type InprocPlugin, type PluginContext, type ToolSpec } from '@protea/core';
import type { Trigger } from '@protea/protocol';

export interface ScheduleSpec {
  id: string;
  name: string;
  cron?: string;
  /** One-time fire instant, ISO 8601 with offset. */
  at?: string;
  note?: string;
  level: 3 | 4;
  createdBy: 'config' | 'assistant';
  createdAt: string;
}

/** setTimeout cannot wait longer than ~24.8 days; longer waits are re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_DYNAMIC = 200;
const KV_PREFIX = 'schedule:';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Time-based event source (docs/10-architecture/08-event-source-plugins.md §6).
 * Static schedules come from config; the assistant adds its own through tools.
 * Each firing carries a dedupe key of schedule id + planned instant, so restarts
 * never deliver the same tick twice. Missed recurring ticks are not backfilled;
 * overdue one-time schedules fire once on start.
 */
export class CronPlugin implements InprocPlugin {
  readonly id = 'cron';
  readonly kind = 'source' as const;
  readonly levelCap = 3 as const;
  readonly mayEmitInternal = true;
  readonly envPromptFile = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

  private ctx: PluginContext | null = null;
  private readonly specs = new Map<string, ScheduleSpec>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  start(ctx: PluginContext): void {
    this.ctx = ctx;
    const configured = ctx.config['schedules'];
    if (configured !== undefined && !Array.isArray(configured)) throw new Error('plugins.cron.config.schedules must be a list');
    for (const raw of (configured ?? []) as unknown[]) {
      if (!isRecord(raw) || typeof raw['name'] !== 'string') throw new Error('each schedule needs a name');
      const spec = this.makeSpec(
        {
          name: raw['name'],
          ...(typeof raw['cron'] === 'string' ? { cron: raw['cron'] } : {}),
          ...(typeof raw['at'] === 'string' ? { at: raw['at'] } : {}),
          ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
          ...(raw['level'] === 4 ? { level: 4 as const } : {}),
        },
        'config',
        `cfg:${raw['name']}`,
      );
      this.specs.set(spec.id, spec);
    }
    if (ctx.config['routines'] !== undefined) ctx.log.warn('plugins.cron.config.routines needs forks (M1); ignored');
    for (const [, spec] of ctx.kv.entries<ScheduleSpec>()) this.specs.set(spec.id, spec);
    for (const spec of this.specs.values()) this.arm(spec);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.specs.clear();
    this.ctx = null;
  }

  list(): ScheduleSpec[] {
    return [...this.specs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Validate and normalise a schedule. Throws with a message fit for a tool result. */
  makeSpec(
    input: { name: string; cron?: string; at?: string; note?: string; level?: 3 | 4 },
    createdBy: ScheduleSpec['createdBy'],
    id = newId('s'),
  ): ScheduleSpec {
    const ctx = this.requireCtx();
    if ((input.cron === undefined) === (input.at === undefined)) throw new Error('give exactly one of cron or at');
    const spec: ScheduleSpec = {
      id,
      name: input.name,
      level: input.level ?? 3,
      createdBy,
      createdAt: isoInZone(ctx.clock.now(), ctx.timezone),
    };
    if (input.note !== undefined) spec.note = input.note;
    if (input.cron !== undefined) {
      try {
        if (!new Cron(input.cron, { timezone: ctx.timezone, paused: true }).nextRun()) throw new Error('never fires');
      } catch (err) {
        throw new Error(`invalid cron "${input.cron}": ${(err as Error).message}`);
      }
      spec.cron = input.cron;
    } else if (input.at !== undefined) {
      const t = parseDateTime(input.at, ctx.timezone);
      if (t === null) throw new Error(`invalid time "${input.at}"; use YYYY-MM-DDTHH:MM with an optional offset`);
      spec.at = isoInZone(t, ctx.timezone);
    }
    return spec;
  }

  add(spec: ScheduleSpec): void {
    const ctx = this.requireCtx();
    const dynamic = [...this.specs.values()].filter((s) => s.createdBy === 'assistant').length;
    if (spec.createdBy === 'assistant' && dynamic >= MAX_DYNAMIC) throw new Error(`too many schedules (max ${MAX_DYNAMIC})`);
    this.specs.set(spec.id, spec);
    if (spec.createdBy === 'assistant') ctx.kv.set(KV_PREFIX + spec.id, spec);
    this.arm(spec);
  }

  remove(id: string): boolean {
    const spec = this.specs.get(id);
    if (!spec) return false;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.specs.delete(id);
    this.ctx?.kv.delete(KV_PREFIX + id);
    return true;
  }

  private requireCtx(): PluginContext {
    if (!this.ctx) throw new Error('cron plugin is not running');
    return this.ctx;
  }

  private nextFire(spec: ScheduleSpec, fromMs: number): number | null {
    if (spec.at !== undefined) return Date.parse(spec.at);
    const next = new Cron(spec.cron as string, { timezone: this.requireCtx().timezone, paused: true }).nextRun(new Date(fromMs));
    return next ? next.getTime() : null;
  }

  private arm(spec: ScheduleSpec, fromMs?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.clock.now();
    const next = this.nextFire(spec, fromMs ?? now);
    if (next === null) return;
    const wait = Math.max(0, next - now);
    const timer = setTimeout(() => {
      if (!this.specs.has(spec.id)) return;
      if (wait > MAX_TIMER_MS) this.arm(spec, fromMs);
      else this.fire(spec, next);
    }, Math.min(wait, MAX_TIMER_MS));
    timer.unref?.();
    this.timers.set(spec.id, timer);
  }

  private fire(spec: ScheduleSpec, plannedMs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const kind = spec.cron !== undefined ? `cron ${spec.cron}` : 'one-time';
    const trigger: Trigger = spec.level === 4 ? 'piggyback' : spec.at !== undefined ? 'flush' : 'debounce';
    const res = ctx.pushEvent({
      type: 'cron.tick',
      ts: isoInZone(plannedMs, ctx.timezone),
      origin: 'internal',
      level: spec.level,
      trigger,
      text: `Schedule "${spec.name}" fired (${kind}, created by ${spec.createdBy === 'assistant' ? 'you' : 'config'}).${
        spec.note ? `\nNote: ${spec.note}` : ''
      }`,
      dedupeKey: `${spec.id}@${plannedMs}`,
      meta: { scheduleId: spec.id, name: spec.name },
    });
    if (!res.ok) ctx.log.warn({ schedule: spec.id, errors: res.errors }, 'tick rejected');
    if (spec.at !== undefined) this.remove(spec.id);
    else this.arm(spec, plannedMs + 1000);
  }

  tools(): ToolSpec<never>[] {
    const sleepUntil: ToolSpec<{ until: string; note?: string }> = {
      name: 'sleep_until',
      description:
        'End the current turn and be woken by a cron.tick event at the given time. The note is delivered back to you then.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['until'],
        properties: {
          until: { type: 'string', description: 'YYYY-MM-DDTHH:MM, optionally with an offset.' },
          note: { type: 'string', maxLength: 2000 },
        },
      },
      flags: { endsTurn: true },
      handler: (input) => {
        const ctx = this.requireCtx();
        const t = parseDateTime(input.until, ctx.timezone);
        if (t === null) return { text: `invalid time "${input.until}"`, failed: true };
        if (t < ctx.clock.now() - 60_000) return { text: `${input.until} is in the past`, failed: true };
        const spec = this.makeSpec({ name: 'wake-up', at: input.until, ...(input.note ? { note: input.note } : {}) }, 'assistant');
        this.add(spec);
        return `will wake at ${spec.at} (schedule ${spec.id})`;
      },
    };

    const create: ToolSpec<{ name: string; cron?: string; at?: string; note?: string; level?: 3 | 4 }> = {
      name: 'schedule_create',
      description:
        'Create a schedule that fires cron.tick events: one-time with `at`, or recurring with a five-field `cron` expression. Level 4 schedules only ride along with other deliveries.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          cron: { type: 'string', description: 'e.g. "0 7 * * 1-5"' },
          at: { type: 'string', description: 'YYYY-MM-DDTHH:MM, optionally with an offset.' },
          note: { type: 'string', maxLength: 2000 },
          level: { type: 'integer', enum: [3, 4] },
        },
      },
      handler: (input) => {
        try {
          const spec = this.makeSpec(input, 'assistant');
          this.add(spec);
          return `created ${spec.id} (${spec.cron !== undefined ? `cron ${spec.cron}` : `at ${spec.at}`})`;
        } catch (err) {
          return { text: (err as Error).message, failed: true };
        }
      },
    };

    const list: ToolSpec<Record<string, never>> = {
      name: 'schedule_list',
      description: 'List all schedules.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      flags: { readOnly: true },
      handler: () => {
        const specs = this.list();
        if (specs.length === 0) return 'no schedules';
        return specs
          .map(
            (s) =>
              `${s.id} "${s.name}" ${s.cron !== undefined ? `cron ${s.cron}` : `at ${s.at}`} L${s.level} by ${s.createdBy}${
                s.note ? ` — ${s.note}` : ''
              }`,
          )
          .join('\n');
      },
    };

    const del: ToolSpec<{ id: string }> = {
      name: 'schedule_delete',
      description: 'Delete a schedule you created. Schedules defined in config.yaml cannot be deleted here.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      handler: (input) => {
        const spec = this.specs.get(input.id);
        if (!spec) return { text: `no schedule ${input.id}`, failed: true };
        if (spec.createdBy === 'config') return { text: `${input.id} is defined in config.yaml`, failed: true };
        this.remove(input.id);
        return `deleted ${input.id}`;
      },
    };

    return [sleepUntil, create, list, del] as unknown as ToolSpec<never>[];
  }

  envPromptVars(): Record<string, unknown> {
    return {};
  }
}
