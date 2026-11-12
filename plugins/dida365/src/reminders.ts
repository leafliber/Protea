import type { Host } from '@protea/plugin-sdk';
import type { DidaApi, Task } from './api.js';
import { settingsOf, type Dida365Config, type Settings } from './config.js';
import { PRIORITIES, clip, dateZone, taskWhen, type FormatContext } from './format.js';
import { DAY_MS, dayOf, fromApiTime, instantOf, minuteOf, toApiTime, wallClock } from './time.js';

type DidaHost = Host<Dida365Config>;

/** What the reminders remember between checks (kv `reminders`). */
export interface ReminderState {
  /** End of the last period that was checked completely. */
  lastPollAt?: string;
  lastError?: string;
  /** Day (in the configured zone) of the last overdue summary. */
  lastDigest?: string;
  /** Reported occurrences, `<task id>:<time>` to when it was reported. */
  sent: Record<string, number>;
}

const STATE_KEY = 'reminders';
/** After a pause (the daemon was down, Dida365 unreachable) only this much is caught up. */
const CATCH_UP_MS = DAY_MS;
/** An occurrence reported later than this is called overdue, not due. */
const LATE_MS = 15 * 60_000;
const SENT_KEEP_MS = 3 * DAY_MS;
const DIGEST_ENTRIES = 20;
const TRIGGER_OF = { 2: 'flush', 3: 'debounce', 4: 'piggyback' } as const;
const PRIORITY_NAME: Record<number, string> = Object.fromEntries(Object.entries(PRIORITIES).map(([k, v]) => [v, k]));

/** When a task's time comes: its start (a task with one date starts and ends at the same moment). */
export function taskMoment(t: Task, s: Settings): { ms: number; allDay: boolean } | undefined {
  const at = fromApiTime(t.startDate) ?? fromApiTime(t.dueDate);
  if (at === undefined) return undefined;
  if (!t.isAllDay) return { ms: at, allDay: false };
  // An all-day task is stored as midnight in its own zone; it is reported at the daily time of that day.
  const day = wallClock(at, dateZone(t, s.tz));
  return { ms: instantOf({ ...day, hour: s.reminders.dailyAt.hour, minute: s.reminders.dailyAt.minute, second: 0 }, s.tz), allDay: true };
}

/** Whether a task's last day is before `today` (`YYYY-MM-DD` in the configured zone). */
function overdueBefore(t: Task, today: string, startOfToday: number, tz: string): boolean {
  const end = fromApiTime(t.dueDate) ?? fromApiTime(t.startDate);
  if (end === undefined) return false;
  return t.isAllDay ? dayOf(end, dateZone(t, tz)) < today : end < startOfToday;
}

function describe(t: Task, ctx: FormatContext): string[] {
  const facts = [ctx.projectName(t.projectId) ? `Project: ${ctx.projectName(t.projectId)}` : undefined, t.priority ? `Priority: ${PRIORITY_NAME[t.priority] ?? t.priority}` : undefined, t.tags?.length ? `Tags: ${t.tags.join(', ')}` : undefined, t.repeatFlag ? 'Repeats' : undefined].filter(Boolean);
  const note = clip(t.content || t.desc || '', 400);
  return [...(facts.length ? [facts.join(' · ')] : []), ...(note ? [`Notes: ${note}`] : []), `task_id ${t.id} · project_id ${t.projectId}`];
}

export interface RemindersOptions {
  api: DidaApi;
  now: () => number;
  projectNames(): Promise<ReadonlyMap<string, string>>;
}

/**
 * Turns tasks reaching their time into events. The Open API has no push, so open tasks are read
 * on a timer. An occurrence is marked as reported only after its event is stored, and the checked
 * period advances only after a complete check: a crash or an outage repeats work, never loses it.
 */
export class Reminders {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly o: RemindersOptions) {}

  start(host: DidaHost): void {
    this.stopped = false;
    this.schedule(host, 1000);
  }

  /** The configuration changed: check again soon, with the new settings. */
  restart(host: DidaHost): void {
    if (this.stopped) return;
    this.schedule(host, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async status(host: DidaHost): Promise<string> {
    const s = settingsOf(host);
    if (!s.reminders.enabled) return 'Due-task reminders are off (plugins.dida365.config.reminders.enabled).';
    const state = await host.kv.get<ReminderState>(STATE_KEY);
    const every = `every ${Math.round(s.reminders.intervalMs / 60_000)} min`;
    const last = state?.lastPollAt ? `last complete check ${minuteOf(Date.parse(state.lastPollAt), s.tz)}` : 'no complete check yet';
    return `Due-task reminders are on (${every}; ${last})${state?.lastError ? `; last error: ${state.lastError}` : ''}.`;
  }

  private schedule(host: DidaHost, delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !settingsOf(host).reminders.enabled) return;
    this.timer = setTimeout(() => {
      // A check still in flight schedules the next one itself when it ends.
      if (this.running) return;
      this.running = this.poll(host)
        .catch((err: Error) => host.log.error('reminder check failed', { err: err.message }))
        .finally(() => {
          this.running = undefined;
          this.schedule(host, settingsOf(host).reminders.intervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  /** One check: report what came due since the last one, then the daily overdue summary. */
  async poll(host: DidaHost): Promise<void> {
    const s = settingsOf(host);
    const r = s.reminders;
    if (!r.enabled) return;
    const now = this.o.now();
    const state: ReminderState = (await host.kv.get<ReminderState>(STATE_KEY)) ?? { sent: {} };
    const save = (): Promise<void> => host.kv.set(STATE_KEY, state);
    // The first check only draws the line: what was due before the reminders were on is not news.
    const since = state.lastPollAt ? Math.max(Date.parse(state.lastPollAt), now - CATCH_UP_MS) : now;
    const scope = r.projectIds ? { projectIds: r.projectIds } : {};
    const names = await this.o.projectNames();
    const ctx: FormatContext = { tz: s.tz, projectName: (id) => (id.startsWith('inbox') ? 'Inbox' : names.get(id)) };
    const push = (type: string, text: string, dedupeKey: string, meta: Record<string, unknown>) =>
      host.events.push({ type, ts: new Date(now).toISOString(), level: r.level, trigger: TRIGGER_OF[r.level], text, dedupeKey, meta });

    try {
      // A day on either side: an all-day task sits at midnight of its own zone, hours away from the daily time here.
      const open = (await this.o.api.post<Task[]>('/task/filter', { status: [0], startDate: toApiTime(since - DAY_MS), endDate: toApiTime(now + r.leadMs + DAY_MS), ...scope })) ?? [];
      for (const t of open) {
        if (this.stopped) return;
        if (t.status !== undefined && t.status !== 0) continue;
        const m = taskMoment(t, s);
        if (!m) continue;
        const fireAt = m.allDay ? m.ms : m.ms - r.leadMs;
        const key = `${t.id}:${m.ms}`;
        if (fireAt <= since || fireAt > now || state.sent[key] !== undefined) continue;
        const title = clip(t.title || '(untitled)', 200);
        const head = m.allDay
          ? `Dida365 task for today: ${title}`
          : now - m.ms > LATE_MS
            ? `Dida365 task overdue since ${minuteOf(m.ms, s.tz)}: ${title}`
            : m.ms - now > 60_000
              ? `Dida365 task due in ${Math.round((m.ms - now) / 60_000)} min: ${title}`
              : `Dida365 task due now: ${title}`;
        await push('dida365.task_due', [head, `When: ${taskWhen(t, s.tz)} (${s.tz})`, ...describe(t, ctx)].join('\n'), `due:${key}`, { taskId: t.id, projectId: t.projectId, at: new Date(m.ms).toISOString(), allDay: m.allDay });
        state.sent[key] = now;
        await save();
      }

      const today = dayOf(now, s.tz);
      const clock = wallClock(now, s.tz);
      const startOfToday = instantOf({ ...clock, hour: 0, minute: 0, second: 0 }, s.tz);
      if (r.overdue && state.lastDigest !== today && now >= instantOf({ ...clock, hour: r.dailyAt.hour, minute: r.dailyAt.minute, second: 0 }, s.tz)) {
        const older = ((await this.o.api.post<Task[]>('/task/filter', { status: [0], endDate: toApiTime(startOfToday), ...scope })) ?? []).filter((t) => (t.status === undefined || t.status === 0) && overdueBefore(t, today, startOfToday, s.tz));
        if (older.length > 0) {
          older.sort((a, b) => (fromApiTime(b.dueDate ?? b.startDate) ?? 0) - (fromApiTime(a.dueDate ?? a.startDate) ?? 0));
          const lines = older.slice(0, DIGEST_ENTRIES).map((t) => `- ${clip(t.title || '(untitled)', 160)} — ${taskWhen(t, s.tz)}${ctx.projectName(t.projectId) ? ` · ${ctx.projectName(t.projectId)}` : ''} (task_id ${t.id} · project_id ${t.projectId})`);
          const more = older.length - lines.length;
          await push(
            'dida365.overdue',
            [`${older.length} Dida365 ${older.length === 1 ? 'task is' : 'tasks are'} still open from before today (${today}, ${s.tz}), most recent first:`, ...lines, ...(more > 0 ? [`… and ${more} more.`] : [])].join('\n'),
            `overdue:${today}`,
            { count: older.length, day: today },
          );
        }
        state.lastDigest = today;
      }
    } catch (err) {
      state.lastError = (err as Error).message;
      await save();
      host.log.warn('could not check for due tasks', { err: state.lastError });
      return;
    }
    state.lastPollAt = new Date(now).toISOString();
    delete state.lastError;
    for (const [k, at] of Object.entries(state.sent)) if (now - at > SENT_KEEP_MS) delete state.sent[k];
    await save();
  }
}
