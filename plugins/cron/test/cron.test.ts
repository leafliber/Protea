import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Bus,
  EventStore,
  EventGateway, PluginHost,
  KvRepo,
  OwnerRegistry,
  ToolRegistry,
  openDatabase,
  silentLogger,
  systemClock,
  type Db,
  type ToolContext,
} from '@protea/core';
import { CronPlugin, describeCron } from '../src/index.js';

const T0 = Date.UTC(2026, 10, 3, 0, 0, 0); // 08:00 in Asia/Shanghai
const ctx: ToolContext = { signal: new AbortController().signal, callId: 'c', sessionId: 'main', batchId: 'b', batchLevel: 1 };

let db: Db;
let dir: string;

function host(config: Record<string, unknown> = {}) {
  const bus = new Bus();
  const store = new EventStore(db, bus, { runId: 'r', clock: systemClock });
  const tools = new ToolRegistry();
  const owner = new OwnerRegistry([]);
  const plugins = new PluginHost({
    store,
    bus,
    gateway: new EventGateway({ store, owner, log: silentLogger(), clock: systemClock, timezone: 'Asia/Shanghai' }),
    owner,
    kv: new KvRepo(db),
    tools,
    log: silentLogger(),
    clock: systemClock,
    dataDir: dir,
    timezone: 'Asia/Shanghai',
  });
  const cron = new CronPlugin();
  plugins.register(cron, config);
  const call = async (name: string, input: unknown) => {
    const t = tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    const r = await t.handler(input as never, ctx);
    return typeof r === 'string' ? { text: r } : r;
  };
  return { store, plugins, cron, call, ticks: () => store.query({ type: 'cron.tick' }) };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-cron-'));
  db = openDatabase(path.join(dir, 'p.db')).db;
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('CronPlugin', () => {
  it('wakes the assistant at the requested local time with its note', async () => {
    const h = host();
    await h.plugins.startAll();
    const r = await h.call('sleep_until', { until: '2026-11-03T08:30', note: 'check the build' });
    expect(r.text).toMatch(/^will wake at 2026-11-03T08:30:00\+08:00/);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(h.ticks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const [tick] = h.ticks();
    expect(tick).toMatchObject({ origin: 'internal', effLevel: 3, effTrigger: 'flush', ts: '2026-11-03T08:30:00+08:00' });
    expect(tick?.text).toContain('Note: check the build');
    expect(h.cron.list()).toHaveLength(0);
  });

  it('fires recurring config schedules on their cron boundaries', async () => {
    const h = host({ schedules: [{ name: 'brief', cron: '*/15 * * * *', note: 'morning brief' }] });
    await h.plugins.startAll();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const ticks = h.ticks();
    expect(ticks.map((t) => t.ts)).toEqual(['2026-11-03T08:15:00+08:00', '2026-11-03T08:30:00+08:00']);
    expect(ticks[0]).toMatchObject({ effTrigger: 'debounce', dedupeKey: `cfg:brief@${T0 + 15 * 60_000}` });
  });

  it('fires an overdue one-time schedule once after a restart, never twice', async () => {
    const first = host();
    await first.plugins.startAll();
    await first.call('schedule_create', { name: 'pay rent', at: '2026-11-03T08:10' });
    await first.plugins.stopAll();
    vi.setSystemTime(T0 + 60 * 60_000); // down for an hour

    const second = host();
    await second.plugins.startAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.ticks()).toHaveLength(1);
    expect(second.ticks()[0]?.ts).toBe('2026-11-03T08:10:00+08:00');

    // Simulate a crash between pushing the tick and forgetting the schedule.
    const kv = new KvRepo(db);
    const spec = { ...(second.ticks()[0]?.meta as { scheduleId: string }), id: (second.ticks()[0]?.meta as { scheduleId: string }).scheduleId };
    kv.set('plugin:cron', `schedule:${spec.id}`, { id: spec.id, name: 'pay rent', at: '2026-11-03T08:10:00+08:00', level: 3, createdBy: 'assistant', createdAt: 'x' });
    await second.plugins.stopAll();
    const third = host();
    await third.plugins.startAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(third.ticks()).toHaveLength(1); // deduplicated by schedule id + planned instant
  });

  it('validates schedules and protects config-defined ones', async () => {
    const h = host({ schedules: [{ name: 'brief', cron: '0 7 * * *' }] });
    await h.plugins.startAll();
    expect((await h.call('schedule_create', { name: 'x', cron: '0 7 * * *', at: '2026-11-04T07:00' })).failed).toBe(true);
    expect((await h.call('schedule_create', { name: 'x', cron: 'every day' })).text).toMatch(/invalid cron/);
    expect((await h.call('sleep_until', { until: '2026-11-02T08:00' })).text).toMatch(/in the past/);
    expect((await h.call('schedule_delete', { id: 'cfg:brief' })).text).toMatch(/config.yaml/);
    const created = await h.call('schedule_create', { name: 'standup', cron: '30 9 * * 1-5', note: 'daily standup' });
    const id = /created (\S+)/.exec(created.text)?.[1] as string;
    expect((await h.call('schedule_list', {})).text).toMatch(/"standup" cron 30 9 \* \* 1-5, L3, next 2026-\d\d-\d\dT09:30:00\+08:00, by you — daily standup/);
    expect((await h.call('schedule_delete', { id })).text).toBe(`deleted ${id}`);
  });

  it('lets the operator add, pause, change, run and delete schedules, and tells the assistant about its own', async () => {
    const h = host({ schedules: [{ name: 'brief', cron: '0 7 * * *' }] });
    const changed: string[] = [];
    h.cron.onChange = (id) => changed.push(id);
    await h.plugins.startAll();
    const notices = () => h.store.query({ type: 'schedule.changed' });

    // The operator's own schedule: no notice to the assistant, and the assistant cannot change it.
    const mine = h.cron.create({ name: 'weekly report', cron: '30 17 * * 5', note: 'remind me' });
    expect(mine).toMatchObject({ createdBy: 'operator', kind: 'recurring', enabled: true, readOnly: false, fires: 0, human: 'Fri at 17:30', nextAt: '2026-11-06T17:30:00+08:00' });
    expect((await h.call('schedule_update', { id: mine.id, enabled: false })).text).toMatch(/made by the operator/);
    expect((await h.call('schedule_delete', { id: mine.id })).text).toMatch(/made by the operator/);
    expect(() => h.cron.create({ name: 'late', at: '2026-11-02T08:00' })).toThrow(/in the past/);
    expect(() => h.cron.update('cfg:brief', { enabled: false }, 'operator')).toThrow(/config.yaml/);
    expect(h.cron.infoOf('cfg:brief')).toMatchObject({ readOnly: true, createdBy: 'config', human: 'Every day at 07:00' });
    expect(notices()).toHaveLength(0);

    // The assistant's schedule, paused by the operator: it stops firing and the assistant is told.
    const created = await h.call('schedule_create', { name: 'standup', cron: '*/15 * * * *', note: 'daily standup' });
    const id = /created (\S+)/.exec(created.text)?.[1] as string;
    expect(h.cron.update(id, { enabled: false }, 'operator')).toMatchObject({ enabled: false, createdBy: 'assistant' });
    expect(h.cron.infoOf(id)?.nextAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(h.ticks()).toHaveLength(0);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ effLevel: 4, origin: 'internal' });
    expect(notices()[0]?.text).toMatch(/^The operator paused your schedule "standup" \(\S+\) in the console\. It is now: cron \*\/15 \* \* \* \*, L3, paused\.$/);
    expect((await h.call('schedule_list', {})).text).toMatch(/"standup" cron \*\/15 \* \* \* \*, L3, paused, by you/);

    // Resumed with another rule: it keeps its id and fires on the new rule.
    expect(h.cron.update(id, { enabled: true, cron: '0 * * * *', name: 'hourly' }, 'operator')).toMatchObject({ id, name: 'hourly', enabled: true, human: 'Every hour on the hour' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.ticks().map((t) => t.ts)).toEqual(['2026-11-03T09:00:00+08:00']);
    expect(h.cron.infoOf(id)).toMatchObject({ fires: 1, note: 'daily standup' });

    // Run by hand: a tick now, marked as such, and the timing is untouched.
    expect(h.cron.runNow('cfg:brief')).toBe(true);
    const manual = h.ticks().at(-1);
    expect(manual).toMatchObject({ effTrigger: 'flush', meta: { scheduleId: 'cfg:brief', manual: true } });
    expect(manual?.text).toContain('run now by the operator');
    expect(h.cron.infoOf('cfg:brief')).toMatchObject({ fires: 1, nextAt: '2026-11-04T07:00:00+08:00' });
    expect(h.cron.runNow('nope')).toBe(false);

    // Its own schedule the assistant may change in place.
    expect((await h.call('schedule_update', { id, note: 'new note', level: 4 })).text).toMatch(/^updated \S+: cron 0 \* \* \* \*, L4, next /);
    expect(notices()).toHaveLength(2); // the resume above; the assistant's own change tells nobody

    expect(h.cron.removeBy(id, 'operator')).toBe(true);
    expect(notices().at(-1)?.text).toMatch(/^The operator deleted your schedule "hourly"/);
    expect(h.cron.removeBy(id, 'operator')).toBe(false);
    expect(changed).toContain(id);
    expect(h.cron.preview({ cron: '0 9 * * 1-5' })).toEqual({ human: 'Weekdays at 09:00', next: ['2026-11-04T09:00:00+08:00', '2026-11-05T09:00:00+08:00', '2026-11-06T09:00:00+08:00', '2026-11-09T09:00:00+08:00', '2026-11-10T09:00:00+08:00'] });
    expect(() => h.cron.preview({ cron: '61 * * * *' })).toThrow(/invalid cron/);
  });

  it('keeps pauses and run counts across a restart, and reads schedules from before they existed', async () => {
    const first = host();
    await first.plugins.startAll();
    const created = await first.call('schedule_create', { name: 'ping', cron: '*/10 * * * *' });
    const id = /created (\S+)/.exec(created.text)?.[1] as string;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    first.cron.update(id, { enabled: false }, 'operator');
    // A record written by an older version: no `enabled`, no stats.
    new KvRepo(db).set('plugin:cron', 'schedule:old', { id: 'old', name: 'old one', cron: '0 12 * * *', level: 3, createdBy: 'assistant', createdAt: 'x' });
    await first.plugins.stopAll();

    const second = host();
    await second.plugins.startAll();
    expect(second.cron.infoOf(id)).toMatchObject({ enabled: false, fires: 1 });
    expect(second.cron.infoOf('old')).toMatchObject({ enabled: true, fires: 0, kind: 'recurring', human: 'Every day at 12:00' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(second.ticks()).toHaveLength(1);
  });
});

describe('describeCron', () => {
  it.each([
    ['*/5 * * * *', '每 5 分钟', 'Every 5 minutes'],
    ['0 */6 * * *', '每 6 小时', 'Every 6 hours'],
    ['15 * * * *', '每小时的第 15 分', 'Every hour, at minute 15'],
    ['0 7 * * *', '每天 07:00', 'Every day at 07:00'],
    ['30 9 * * 1-5', '每个工作日 09:30', 'Weekdays at 09:30'],
    ['0 10 * * 6,0', '每个周末 10:00', 'Weekends at 10:00'],
    ['0 8 * * 1,3', '每周一、周三 08:00', 'Mon, Wed at 08:00'],
    ['0 9 1 * *', '每月 1 日 09:00', 'Day 1 of every month at 09:00'],
  ])('reads %s', (expr, zh, en) => {
    expect(describeCron(expr, 'zh')).toBe(zh);
    expect(describeCron(expr, 'en')).toBe(en);
  });

  it('leaves what it cannot put plainly to the expression itself', () => {
    for (const expr of ['0 9 * 1 *', '0 9 1-7 * 1', '0,30 9 * * *', 'not cron']) expect(describeCron(expr, 'zh')).toBeNull();
  });
});
