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
import { CronPlugin } from '../src/index.js';

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
    gateway: new EventGateway({ store, owner, log: silentLogger(), clock: systemClock }),
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
    expect((await h.call('schedule_list', {})).text).toContain('"standup" cron 30 9 * * 1-5 L3 by assistant — daily standup');
    expect((await h.call('schedule_delete', { id })).text).toBe(`deleted ${id}`);
  });
});
