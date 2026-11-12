import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, type Host } from '@protea/plugin-sdk';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { DidaApi } from '../src/api.js';
import type { Dida365Config, RemindersConfig } from '../src/config.js';
import { createDida365Plugin } from '../src/plugin.js';
import { Reminders, type ReminderState } from '../src/reminders.js';
import { FakeDida, task, type Call } from './fake-dida.js';

const TZ = 'Asia/Shanghai';
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string): number => Date.parse(iso);
const api = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}+0000`;
/** 2026-11-13 10:00 in Shanghai. */
const T0 = at('2026-11-13T02:00:00Z');

const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

/** The reminders on their own, checked by hand at chosen times. */
async function setup(config: RemindersConfig = {}) {
  const dida = new FakeDida();
  // The due check asks for a window of start dates; the overdue summary only for an end.
  const due: Array<Record<string, unknown>> = [];
  const overdue: Array<Record<string, unknown>> = [];
  dida.on('POST', '/task/filter', (c: Call) => ((c.body as { startDate?: string }).startDate ? due : overdue));
  let host!: Host<Dida365Config>;
  const h = new FakeHost(
    definePlugin<Dida365Config>({
      start(x) {
        host = x;
      },
    }),
    { id: 'dida365', levelCap: 2, config: { timeZone: TZ, reminders: { enabled: true, overdue: false, ...config } } },
  );
  hosts.push(h);
  await h.start();
  let clock = T0;
  const reminders = new Reminders({
    api: new DidaApi({ fetch: dida.fetch, base: () => 'https://api.dida365.com', token: () => 'token', timeoutMs: () => 5000 }),
    now: () => clock,
    projectNames: async () => new Map([['p1', 'Work']]),
  });
  const check = async (when: number): Promise<void> => {
    clock = when;
    await reminders.poll(host);
  };
  const state = (): ReminderState => h.kv.get('reminders') as ReminderState;
  return { h, dida, due, overdue, check, state, reminders, host };
}

describe('due-task reminders', () => {
  it('draws a line on the first check, then reports each task once when its time comes', async () => {
    const { h, dida, due, check, state } = await setup();
    due.push(task({ id: 'old', title: 'Long overdue', startDate: api(T0 - 3 * HOUR) }), task({ startDate: api(T0 + 3 * MIN), dueDate: api(T0 + 3 * MIN), isAllDay: false, priority: 5, tags: ['work'], content: 'Three pages,\nwith charts' }));
    await check(T0);
    expect(h.events).toEqual([]);
    expect(state()).toEqual({ sent: {}, lastPollAt: '2026-11-13T02:00:00.000Z' });
    expect(dida.calls[0]?.body).toEqual({ status: [0], startDate: '2026-11-12T02:00:00+0000', endDate: '2026-11-14T02:00:00+0000' });

    await check(T0 + 5 * MIN);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'dida365.task_due',
      level: 3,
      trigger: 'debounce',
      dedupeKey: `due:t1:${T0 + 3 * MIN}`,
      meta: { taskId: 't1', projectId: 'p1', at: '2026-11-13T02:03:00.000Z', allDay: false },
    });
    expect(h.events[0]?.text).toBe(
      ['Dida365 task due now: Write the report', 'When: 2026-11-13 10:03 (Asia/Shanghai)', 'Project: Work · Priority: high · Tags: work', 'Notes: Three pages, with charts', 'task_id t1 · project_id p1'].join('\n'),
    );
    // Still open at the next checks: not reported again.
    await check(T0 + 10 * MIN);
    await check(T0 + 15 * MIN);
    expect(h.events).toHaveLength(1);
    expect(h.violations).toEqual([]);
  });

  it('reports ahead of time with leadMin, and a repeating task again at its next occurrence', async () => {
    const { h, due, check } = await setup({ leadMin: 30, level: 2 });
    due.push(task({ startDate: api(T0 + 40 * MIN), isAllDay: false, repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1' }));
    await check(T0);
    await check(T0 + 5 * MIN);
    expect(h.events).toEqual([]);
    await check(T0 + 12 * MIN);
    expect(h.events.map((e) => [e.text.split('\n')[0], e.level, e.trigger])).toEqual([['Dida365 task due in 28 min: Write the report', 2, 'flush']]);
    expect(h.events[0]?.text).toContain('Project: Work · Repeats');

    // Completed in the app: Dida365 moves the same task to tomorrow.
    due[0] = task({ startDate: api(T0 + 24 * HOUR + 40 * MIN), isAllDay: false, repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1' });
    await check(T0 + 24 * HOUR + 11 * MIN);
    expect(h.events).toHaveLength(2);
    expect(h.events[1]?.dedupeKey).toBe(`due:t1:${T0 + 24 * HOUR + 40 * MIN}`);
    expect(h.violations).toEqual([]);
  });

  it('reports all-day tasks at the daily time of their day', async () => {
    const { h, due, check } = await setup({ dailyAt: '09:00', level: 4 });
    // All day on 2026-11-14 in Shanghai, and all day on 2026-11-14 for a task kept in New York time.
    due.push(task({ id: 'a', title: 'Dentist', startDate: '2026-11-13T16:00:00+0000', isAllDay: true, timeZone: TZ }), task({ id: 'b', title: 'Taxes', startDate: '2026-11-14T05:00:00+0000', isAllDay: true, timeZone: 'America/New_York' }));
    await check(at('2026-11-14T00:55:00Z')); // 08:55
    expect(h.events).toEqual([]);
    await check(at('2026-11-14T01:00:00Z')); // 09:00
    expect(h.events.map((e) => [e.text.split('\n').slice(0, 2).join(' | '), e.level, e.trigger, (e.meta as { allDay: boolean }).allDay])).toEqual([
      ['Dida365 task for today: Dentist | When: 2026-11-14 (all day) (Asia/Shanghai)', 4, 'piggyback', true],
      ['Dida365 task for today: Taxes | When: 2026-11-14 (all day) (Asia/Shanghai)', 4, 'piggyback', true],
    ]);
    expect(h.violations).toEqual([]);
  });

  it('catches up after an outage, but only one day back', async () => {
    const { h, dida, due, check, state } = await setup();
    due.push(task({ startDate: api(T0 + 3 * MIN), isAllDay: false }), task({ id: 't2', title: 'Stand-up', startDate: api(T0 + 20 * MIN), isAllDay: false }));
    await check(T0);
    const down = (): Response => new Response('upstream down', { status: 502 });
    dida.on('POST', '/task/filter', down);
    await check(T0 + 5 * MIN);
    await check(T0 + 10 * MIN);
    // Nothing was reported and the checked period did not move.
    expect(h.events).toEqual([]);
    expect(state()).toMatchObject({ lastPollAt: '2026-11-13T02:00:00.000Z', lastError: 'Dida365 answered 502 to POST /task/filter: upstream down' });

    dida.on('POST', '/task/filter', () => due);
    await check(T0 + 45 * MIN);
    expect(h.events.map((e) => e.text.split('\n')[0])).toEqual(['Dida365 task overdue since 2026-11-13 10:03: Write the report', 'Dida365 task overdue since 2026-11-13 10:20: Stand-up']);
    expect(state().lastError).toBeUndefined();

    // After three days of silence only the last day is looked at: the old task is not news any more.
    due.push(task({ id: 't3', title: 'Missed long ago', startDate: api(T0 + 2 * HOUR), isAllDay: false }), task({ id: 't4', title: 'Missed this morning', startDate: api(T0 + 70 * HOUR), isAllDay: false }));
    await check(T0 + 73 * HOUR);
    expect(h.events.slice(2).map((e) => e.text.split('\n')[0])).toEqual(['Dida365 task overdue since 2026-11-16 08:00: Missed this morning']);
    expect(dida.calls.at(-1)?.body).toMatchObject({ startDate: api(T0 + 73 * HOUR - 48 * HOUR) });
    // Entries of the reported list older than three days are dropped.
    expect(Object.keys(state().sent)).toEqual([`t4:${T0 + 70 * HOUR}`]);
  });

  it('sends one overdue summary a day, at the daily time', async () => {
    const { h, dida, overdue, check, state } = await setup({ overdue: true, dailyAt: '09:00', projectIds: ['p1'] });
    overdue.push(
      task({ id: 'o1', title: 'Send invoice', startDate: '2026-11-12T07:00:00+0000', dueDate: '2026-11-12T07:00:00+0000', isAllDay: false }),
      task({ id: 'o2', title: 'Book flights', projectId: 'inbox9', startDate: '2026-11-09T16:00:00+0000', isAllDay: true, timeZone: TZ }),
      // Not overdue: all day today, a period that ends tomorrow, and one already completed.
      task({ id: 'n1', startDate: '2026-11-12T16:00:00+0000', isAllDay: true, timeZone: TZ }),
      task({ id: 'n2', startDate: '2026-11-10T01:00:00+0000', dueDate: '2026-11-14T01:00:00+0000', isAllDay: false }),
      task({ id: 'n3', startDate: '2026-11-11T01:00:00+0000', status: 2 }),
    );
    await check(at('2026-11-13T00:30:00Z')); // 08:30: too early
    expect(h.events).toEqual([]);
    expect(dida.calls).toHaveLength(1);

    await check(at('2026-11-13T01:05:00Z')); // 09:05
    expect(dida.calls.at(-1)?.body).toEqual({ status: [0], endDate: '2026-11-12T16:00:00+0000', projectIds: ['p1'] });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'dida365.overdue', level: 3, trigger: 'debounce', dedupeKey: 'overdue:2026-11-13', meta: { count: 2, day: '2026-11-13' } });
    expect(h.events[0]?.text).toBe(
      [
        '2 Dida365 tasks are still open from before today (2026-11-13, Asia/Shanghai), most recent first:',
        '- Send invoice — 2026-11-12 15:00 · Work (task_id o1 · project_id p1)',
        '- Book flights — 2026-11-10 (all day) · Inbox (task_id o2 · project_id inbox9)',
      ].join('\n'),
    );
    expect(state().lastDigest).toBe('2026-11-13');

    const calls = dida.calls.length;
    await check(at('2026-11-13T05:00:00Z'));
    expect(h.events).toHaveLength(1);
    expect(dida.calls).toHaveLength(calls + 1); // only the due check

    overdue.length = 1;
    await check(at('2026-11-14T01:00:00Z'));
    expect(h.events.map((e) => e.text.split('\n')[0])).toEqual([expect.any(String), '1 Dida365 task is still open from before today (2026-11-14, Asia/Shanghai), most recent first:']);
    // A day with nothing overdue is quiet.
    overdue.length = 0;
    await check(at('2026-11-15T01:00:00Z'));
    expect(h.events).toHaveLength(2);
    expect(state().lastDigest).toBe('2026-11-15');
    expect(h.violations).toEqual([]);
  });

  it('describes itself for dida_status', async () => {
    const { check, reminders, host, dida } = await setup({ intervalMin: 10 });
    expect(await reminders.status(host)).toBe('Due-task reminders are on (every 10 min; no complete check yet).');
    await check(T0);
    expect(await reminders.status(host)).toBe('Due-task reminders are on (every 10 min; last complete check 2026-11-13 10:00).');
    dida.on('POST', '/task/filter', () => new Response('', { status: 401 }));
    await check(T0 + 10 * MIN);
    expect(await reminders.status(host)).toMatch(/last complete check 2026-11-13 10:00\); last error: Dida365 answered 401 to POST \/task\/filter \(the API token is missing/);
  });
});

describe('reminders inside the plugin', () => {
  async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('checks on a timer once enabled, and stops when switched off', async () => {
    let clock = T0;
    const dida = new FakeDida().on('GET', '/project', [{ id: 'p1', name: 'Work' }]).on('POST', '/task/filter', [task({ startDate: api(T0 + 3 * MIN), isAllDay: false })]);
    const filters = (): number => dida.to('POST', '/task/filter').length;
    const h = new FakeHost(createDida365Plugin({ fetch: dida.fetch, now: () => clock }), { id: 'dida365', levelCap: 2, config: { timeZone: TZ, reminders: { enabled: true, overdue: false, intervalMin: 0.0005 } }, env: { DIDA365_TOKEN: 'token' } });
    hosts.push(h);
    const init = await h.start();
    expect(init.capabilities).toMatchObject({ tools: true, envPrompt: true });
    expect(await h.request('env/prompt', { language: 'en' })).toEqual({ vars: { timeZone: TZ, reminders: true } });

    await waitFor(() => filters() >= 1 && h.kv.get('reminders') !== undefined);
    expect(h.events).toEqual([]);
    clock = T0 + 5 * MIN;
    await waitFor(() => h.events.length === 1);
    expect(h.events[0]).toMatchObject({ type: 'dida365.task_due', level: 3, trigger: 'debounce' });
    expect(h.events[0]?.text.split('\n').slice(0, 3)).toEqual(['Dida365 task due now: Write the report', 'When: 2026-11-13 10:03 (Asia/Shanghai)', 'Project: Work']);
    expect(h.violations).toEqual([]);

    await h.configChanged({ reminders: { enabled: false } });
    await new Promise((r) => setTimeout(r, 100));
    const seen = filters();
    await new Promise((r) => setTimeout(r, 150));
    expect(filters()).toBe(seen);
    expect(await h.request('env/prompt', { language: 'en' })).toEqual({ vars: { timeZone: TZ, reminders: false } });
  });

  it('makes no requests on its own while reminders are off', async () => {
    const dida = new FakeDida();
    const h = new FakeHost(createDida365Plugin({ fetch: dida.fetch }), { id: 'dida365', config: {}, env: { DIDA365_TOKEN: 'token' } });
    hosts.push(h);
    await h.start();
    await new Promise((r) => setTimeout(r, 1200));
    expect(dida.calls).toEqual([]);
  });
});
