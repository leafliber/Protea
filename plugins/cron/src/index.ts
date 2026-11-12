import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { isoInZone, newId, parseDateTime, type InprocPlugin, type PluginContext, type ToolSpec } from '@protea/core';
import type { ScheduleInfo, ScheduleInput, SchedulePreview, Trigger } from '@protea/protocol';

export interface ScheduleSpec {
  id: string;
  name: string;
  cron?: string;
  /** One-time fire instant, ISO 8601 with offset. */
  at?: string;
  note?: string;
  level: 3 | 4;
  createdBy: 'config' | 'assistant' | 'operator';
  createdAt: string;
  /** False while paused. Absent in records from before pausing existed: enabled. */
  enabled?: boolean;
  /** A `sleep_until` of the assistant. */
  wake?: boolean;
}

/** When a schedule last fired and how often, kept apart from the schedule so config-defined ones have it too. */
interface FireStat {
  lastFiredAt: string;
  fires: number;
}

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A cron expression in words, for the shapes people actually write: every N minutes or hours,
 * a time every day, on weekdays, on some days of the week, on a day of the month. Null for
 * the rest: the expression itself is then the honest description.
 */
export function describeCron(expr: string, language: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const zh = language.toLowerCase().startsWith('zh');
  const num = (v: string): number | null => (/^\d+$/.test(v) ? Number(v) : null);
  if (mon !== '*') return null;
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*' && dom === '*' && dow === '*') return zh ? `每 ${everyMin[1]} 分钟` : `Every ${everyMin[1]} minutes`;
  const m = num(min);
  if (m === null) return null;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  const at = (h: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if ((everyHour || hour === '*') && dom === '*' && dow === '*') {
    const n = everyHour ? Number(everyHour[1]) : 1;
    const past = m === 0 ? '' : zh ? `的第 ${m} 分` : `, at minute ${m}`;
    return n === 1 ? (zh ? `每小时${past || '整点'}` : `Every hour${past || ' on the hour'}`) : zh ? `每 ${n} 小时${past}` : `Every ${n} hours${past}`;
  }
  const h = num(hour);
  if (h === null) return null;
  if (dom === '*' && dow === '*') return zh ? `每天 ${at(h)}` : `Every day at ${at(h)}`;
  if (dom === '*') {
    if (dow === '1-5') return zh ? `每个工作日 ${at(h)}` : `Weekdays at ${at(h)}`;
    if (dow === '0,6' || dow === '6,0' || dow === '6,7') return zh ? `每个周末 ${at(h)}` : `Weekends at ${at(h)}`;
    const days = dow.split(',').map(num);
    if (days.some((d) => d === null || d > 7)) return null;
    const names = (days as number[]).map((d) => (zh ? `周${WEEKDAYS_ZH[d % 7]}` : WEEKDAYS_EN[d % 7]));
    return zh ? `每${names.join('、')} ${at(h)}` : `${names.join(', ')} at ${at(h)}`;
  }
  const d = num(dom);
  if (d !== null && dow === '*') return zh ? `每月 ${d} 日 ${at(h)}` : `Day ${d} of every month at ${at(h)}`;
  return null;
}

/** setTimeout cannot wait longer than ~24.8 days; longer waits are re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_DYNAMIC = 200;
const KV_PREFIX = 'schedule:';
const STAT_PREFIX = 'fired:';

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
  private readonly stats = new Map<string, FireStat>();
  /** Told whenever a schedule is added, changed, removed or fires (the console's live view). */
  onChange: ((id: string) => void) | null = null;

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
    for (const [key, value] of ctx.kv.entries<unknown>()) {
      if (key.startsWith(KV_PREFIX)) this.specs.set((value as ScheduleSpec).id, value as ScheduleSpec);
      else if (key.startsWith(STAT_PREFIX)) this.stats.set(key.slice(STAT_PREFIX.length), value as FireStat);
    }
    for (const spec of this.specs.values()) this.arm(spec);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.specs.clear();
    this.stats.clear();
    this.ctx = null;
  }

  list(): ScheduleSpec[] {
    return [...this.specs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private humanOf(spec: Pick<ScheduleSpec, 'cron' | 'at'>): string {
    const ctx = this.requireCtx();
    if (spec.at !== undefined) return spec.at.slice(0, 16).replace('T', ' ');
    return describeCron(spec.cron as string, ctx.language) ?? `cron ${spec.cron}`;
  }

  private info(spec: ScheduleSpec): ScheduleInfo {
    const ctx = this.requireCtx();
    const enabled = spec.enabled !== false;
    const next = enabled ? this.nextFire(spec, ctx.clock.now()) : null;
    const stat = this.stats.get(spec.id);
    return {
      id: spec.id,
      name: spec.name,
      ...(spec.cron !== undefined ? { cron: spec.cron } : {}),
      ...(spec.at !== undefined ? { at: spec.at } : {}),
      ...(spec.note !== undefined ? { note: spec.note } : {}),
      level: spec.level,
      enabled,
      kind: spec.wake ? 'wake' : spec.at !== undefined ? 'once' : 'recurring',
      createdBy: spec.createdBy,
      createdAt: spec.createdAt,
      human: this.humanOf(spec),
      ...(next !== null ? { nextAt: isoInZone(next, ctx.timezone) } : {}),
      ...(stat ? { lastFiredAt: stat.lastFiredAt } : {}),
      fires: stat?.fires ?? 0,
      readOnly: spec.createdBy === 'config',
    };
  }

  /** The schedules as the console shows them: the next to fire first, paused ones last. */
  infos(): ScheduleInfo[] {
    if (!this.ctx) return [];
    return [...this.specs.values()].map((s) => this.info(s)).sort((a, b) => (a.nextAt ?? '9').localeCompare(b.nextAt ?? '9') || a.name.localeCompare(b.name));
  }

  infoOf(id: string): ScheduleInfo | undefined {
    const spec = this.specs.get(id);
    return spec && this.ctx ? this.info(spec) : undefined;
  }

  /** Check a rule without saving it: how it reads, and when it fires next. */
  preview(input: { cron?: string; at?: string }, count = 5): SchedulePreview {
    const ctx = this.requireCtx();
    const spec = this.makeSpec({ name: 'preview', ...input }, 'operator', 'preview');
    if (spec.at !== undefined) return { human: this.humanOf(spec), next: [spec.at] };
    return { human: this.humanOf(spec), next: new Cron(spec.cron as string, { timezone: ctx.timezone, paused: true }).nextRuns(count).map((d) => isoInZone(d.getTime(), ctx.timezone)) };
  }

  /** A schedule made in the console. */
  create(input: ScheduleInput): ScheduleInfo {
    const ctx = this.requireCtx();
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('a schedule needs a name');
    const spec = this.makeSpec({ name: input.name.trim(), ...(input.cron ? { cron: input.cron } : {}), ...(input.at ? { at: input.at } : {}), ...(input.note?.trim() ? { note: input.note } : {}), ...(input.level === 4 ? { level: 4 as const } : {}) }, 'operator');
    if (spec.at !== undefined && Date.parse(spec.at) < ctx.clock.now() - 60_000) throw new Error(`${input.at} is in the past`);
    if (input.enabled === false) spec.enabled = false;
    this.add(spec);
    return this.info(spec);
  }

  /**
   * Change a schedule in place: its id, creator and history stay. `by` is who changed it; the
   * assistant is told when the operator changes one of its own, so it does not count on a
   * schedule that no longer fires as it set it.
   */
  update(id: string, patch: ScheduleInput, by: 'assistant' | 'operator'): ScheduleInfo {
    const ctx = this.requireCtx();
    const old = this.specs.get(id);
    if (!old) throw new Error(`no schedule ${id}`);
    if (old.createdBy === 'config') throw new Error(`${id} is defined in config.yaml; change it there`);
    const rule = patch.cron !== undefined || patch.at !== undefined;
    const next = this.makeSpec(
      {
        name: patch.name?.trim() || old.name,
        ...(rule ? { ...(patch.cron ? { cron: patch.cron } : {}), ...(patch.at ? { at: patch.at } : {}) } : { ...(old.cron !== undefined ? { cron: old.cron } : {}), ...(old.at !== undefined ? { at: old.at } : {}) }),
        ...((patch.note !== undefined ? patch.note : old.note) ? { note: (patch.note !== undefined ? patch.note : old.note) as string } : {}),
        level: patch.level ?? old.level,
      },
      old.createdBy,
      id,
    );
    next.createdAt = old.createdAt;
    if (old.wake) next.wake = true;
    if ((patch.enabled ?? old.enabled !== false) === false) next.enabled = false;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.specs.set(id, next);
    ctx.kv.set(KV_PREFIX + id, next);
    this.arm(next);
    this.changed(id);
    if (by === 'operator' && old.createdBy === 'assistant') {
      const what = next.enabled === false && old.enabled !== false ? 'paused' : next.enabled !== false && old.enabled === false ? 'resumed' : 'changed';
      this.tellAssistant(`The operator ${what} your schedule "${next.name}" (${id}) in the console. It is now: ${this.line(next)}.`, id);
    }
    return this.info(next);
  }

  /** Delete a schedule from the console. */
  removeBy(id: string, by: 'operator'): boolean {
    const spec = this.specs.get(id);
    if (!spec) return false;
    if (spec.createdBy === 'config') throw new Error(`${id} is defined in config.yaml; remove it there`);
    this.remove(id);
    if (by === 'operator' && spec.createdBy === 'assistant') this.tellAssistant(`The operator deleted your schedule "${spec.name}" (${id}) in the console. It will not fire.`, id);
    return true;
  }

  /** Fire a schedule now, without touching its timing. */
  runNow(id: string): boolean {
    const ctx = this.requireCtx();
    const spec = this.specs.get(id);
    if (!spec) return false;
    this.emit(spec, ctx.clock.now(), true);
    return true;
  }

  private tellAssistant(text: string, id: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const res = ctx.pushEvent({ type: 'schedule.changed', ts: isoInZone(ctx.clock.now(), ctx.timezone), origin: 'internal', level: 4, trigger: 'piggyback', text, meta: { scheduleId: id } });
    if (!res.ok) ctx.log.warn({ schedule: id, errors: res.errors }, 'schedule notice rejected');
  }

  private changed(id: string): void {
    try {
      this.onChange?.(id);
    } catch {
      // A listener's failure is not the schedule's.
    }
  }

  /** One schedule as a line of a tool result. */
  private line(s: ScheduleSpec): string {
    const ctx = this.requireCtx();
    const next = s.enabled === false ? null : this.nextFire(s, ctx.clock.now());
    return `${s.cron !== undefined ? `cron ${s.cron}` : `at ${s.at}`}, L${s.level}, ${s.enabled === false ? 'paused' : next !== null ? `next ${isoInZone(next, ctx.timezone)}` : 'will not fire again'}`;
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
    if (spec.createdBy !== 'config') ctx.kv.set(KV_PREFIX + spec.id, spec);
    this.arm(spec);
    this.changed(spec.id);
  }

  remove(id: string): boolean {
    const spec = this.specs.get(id);
    if (!spec) return false;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.specs.delete(id);
    this.stats.delete(id);
    this.ctx?.kv.delete(KV_PREFIX + id);
    this.ctx?.kv.delete(STAT_PREFIX + id);
    this.changed(id);
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
    if (!ctx || spec.enabled === false) return;
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
    this.emit(spec, plannedMs, false);
    if (spec.at !== undefined) this.remove(spec.id);
    else this.arm(spec, plannedMs + 1000);
  }

  /** Push the tick. `manual`: the operator ran it from the console, outside its timing. */
  private emit(spec: ScheduleSpec, plannedMs: number, manual: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const kind = manual ? 'run now by the operator' : spec.cron !== undefined ? `cron ${spec.cron}` : 'one-time';
    const by = spec.createdBy === 'assistant' ? 'you' : spec.createdBy === 'operator' ? 'the operator' : 'config';
    // Run by hand, it is wanted now: it does not wait to ride along with something else.
    const trigger: Trigger = manual ? 'flush' : spec.level === 4 ? 'piggyback' : spec.at !== undefined ? 'flush' : 'debounce';
    const res = ctx.pushEvent({
      type: 'cron.tick',
      ts: isoInZone(plannedMs, ctx.timezone),
      origin: 'internal',
      level: manual ? 3 : spec.level,
      trigger,
      text: `Schedule "${spec.name}" fired (${kind}, created by ${by}).${spec.note ? `\nNote: ${spec.note}` : ''}`,
      dedupeKey: `${spec.id}@${manual ? 'manual:' : ''}${plannedMs}`,
      meta: { scheduleId: spec.id, name: spec.name, ...(manual ? { manual: true } : {}) },
    });
    if (!res.ok) ctx.log.warn({ schedule: spec.id, errors: res.errors }, 'tick rejected');
    const stat: FireStat = { lastFiredAt: isoInZone(ctx.clock.now(), ctx.timezone), fires: (this.stats.get(spec.id)?.fires ?? 0) + 1 };
    this.stats.set(spec.id, stat);
    ctx.kv.set(STAT_PREFIX + spec.id, stat);
    this.changed(spec.id);
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
        spec.wake = true;
        this.add(spec);
        return `will wake at ${spec.at} (schedule ${spec.id})`;
      },
    };

    const create: ToolSpec<{ name: string; cron?: string; at?: string; note?: string; level?: 3 | 4 }> = {
      name: 'schedule_create',
      description:
        'Create a schedule that fires cron.tick events: one-time with `at`, or recurring with a five-field `cron` expression. Level 4 schedules only ride along with other deliveries. ' +
        'The owner sees and can change schedules in the console: give it a name they will recognise, and put in `note` what you will need to know when it fires.',
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
      description: 'List all schedules: rule, level, whether paused, and when each fires next.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      flags: { readOnly: true },
      handler: () => {
        const specs = this.list();
        if (specs.length === 0) return 'no schedules';
        return specs.map((s) => `${s.id} "${s.name}" ${this.line(s)}, by ${s.createdBy === 'assistant' ? 'you' : s.createdBy}${s.note ? ` — ${s.note}` : ''}`).join('\n');
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
        if (spec.createdBy === 'operator') return { text: `${input.id} was made by the operator in the console; ask the owner to remove it there`, failed: true };
        this.remove(input.id);
        return `deleted ${input.id}`;
      },
    };

    const update: ToolSpec<{ id: string; name?: string; cron?: string; at?: string; note?: string; level?: 3 | 4; enabled?: boolean }> = {
      name: 'schedule_update',
      description: 'Change a schedule you created, in place: its name, its rule (`cron` or `at`), its note, its level, or pause and resume it with `enabled`. Give only what changes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          cron: { type: 'string' },
          at: { type: 'string', description: 'YYYY-MM-DDTHH:MM, optionally with an offset.' },
          note: { type: 'string', maxLength: 2000 },
          level: { type: 'integer', enum: [3, 4] },
          enabled: { type: 'boolean', description: 'false pauses the schedule, true resumes it.' },
        },
      },
      handler: ({ id, ...patch }) => {
        const spec = this.specs.get(id);
        if (!spec) return { text: `no schedule ${id}`, failed: true };
        if (spec.createdBy !== 'assistant') return { text: `${id} was made ${spec.createdBy === 'config' ? 'in config.yaml' : 'by the operator in the console'}; it cannot be changed here`, failed: true };
        if (patch.cron !== undefined && patch.at !== undefined) return { text: 'give at most one of cron or at', failed: true };
        try {
          this.update(id, patch, 'assistant');
          return `updated ${id}: ${this.line(this.specs.get(id) as ScheduleSpec)}`;
        } catch (err) {
          return { text: (err as Error).message, failed: true };
        }
      },
    };

    return [sleepUntil, create, list, update, del] as unknown as ToolSpec<never>[];
  }

  envPromptVars(): Record<string, unknown> {
    return {};
  }
}
