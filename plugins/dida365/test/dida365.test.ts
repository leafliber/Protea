import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { createDida365Plugin, type Dida365Config } from '../src/plugin.js';
import { FakeDida, task } from './fake-dida.js';

const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../protea.plugin.json', import.meta.url)), 'utf8')) as { tools: string[]; sideEffectTools: string[] };
const TOKEN = 'dp_test-token-123';
const TZ = 'Asia/Shanghai';

const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function setup(config: Dida365Config = {}, opts: { now?: () => number; token?: string } = {}) {
  const dida = new FakeDida().on('GET', '/project', [
    { id: 'p1', name: 'Work' },
    { id: 'p2', name: 'Home', groupId: 'g1', viewMode: 'kanban' },
  ]);
  const h = new FakeHost(createDida365Plugin({ fetch: dida.fetch, ...(opts.now ? { now: opts.now } : {}) }), { id: 'dida365', levelCap: 2, config: { timeZone: TZ, ...config }, env: { DIDA365_TOKEN: opts.token ?? TOKEN } });
  hosts.push(h);
  await h.start();
  return { h, dida };
}

describe('tool list', () => {
  it('offers every tool the manifest declares, and asks before each one that changes something', async () => {
    const { h } = await setup();
    const tools = await h.tools();
    expect(tools.map((t) => t.name).sort()).toEqual([...manifest.tools].sort());
    expect(tools.filter((t) => t.flags?.sideEffect).map((t) => t.name).sort()).toEqual([...manifest.sideEffectTools].sort());
    // Everything else only reads.
    expect(tools.filter((t) => !t.flags?.sideEffect).every((t) => t.flags?.readOnly)).toBe(true);
    for (const t of tools) expect(t.inputSchema, t.name).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('says how each call that needs approval reads, naming only inputs the tool has', async () => {
    const { h } = await setup();
    for (const t of (await h.tools()).filter((x) => x.flags?.sideEffect)) {
      const a = t.approval;
      expect(a, t.name).toBeDefined();
      expect(a?.title, t.name).toEqual({ zh: expect.any(String), en: expect.any(String) });
      const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
      for (const key of [...(a?.target ? [a.target] : []), ...Object.keys(a?.fields ?? {})]) expect(props, `${t.name}: ${key}`).toContain(key);
    }
  });

  it('leaves out the tool sets that are switched off, and what they could delete', async () => {
    const { h } = await setup({ toolsets: ['tags', 'focus'] });
    const tools = await h.tools();
    expect(tools.map((t) => t.name)).toEqual(['dida_status', 'dida_tag_list', 'dida_tag_create', 'dida_focus_list', 'dida_focus_create', 'dida_delete']);
    expect((tools.at(-1)?.inputSchema as { properties: { type: { enum: string[] } } }).properties.type.enum).toEqual(['focus']);
    const none = await setup({ toolsets: ['countdowns'] });
    expect((await none.h.tools()).map((t) => t.name)).toEqual(['dida_status', 'dida_countdown_list']);
  });
});

describe('talking to the Open API', () => {
  it('sends the token as a bearer and never shows it', async () => {
    const { h, dida } = await setup();
    dida.on('POST', '/preference', { timeZone: 'Asia/Shanghai' });
    const r = await h.callTool('dida_status', {});
    expect(r.failed).toBeUndefined();
    expect(r.text).toBe(
      ['Connected to https://api.dida365.com. Account time zone: Asia/Shanghai.', 'Times are read and shown in Asia/Shanghai.', 'Tool sets: tasks, projects, tags, focus, habits, countdowns.', 'Due-task reminders are off (plugins.dida365.config.reminders.enabled).'].join('\n'),
    );
    expect(dida.calls[0]).toMatchObject({ method: 'POST', path: '/preference', auth: `Bearer ${TOKEN}` });
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
  });

  it('explains what went wrong when Dida365 refuses', async () => {
    const { h, dida } = await setup();
    dida.on('POST', '/preference', () => new Response(JSON.stringify({ errorCode: 'access_denied', errorMessage: 'token expired' }), { status: 401 }));
    const denied = await h.callTool('dida_status', {});
    expect(denied.failed).toBe(true);
    expect(denied.text).toMatch(/^Not connected to https:\/\/api\.dida365\.com: Dida365 answered 401 to POST \/preference: access_denied: token expired \(the API token is missing, wrong or revoked; .*DIDA365_TOKEN\)$/);
    expect(denied.text).not.toContain(TOKEN);

    const missing = await h.callTool('dida_task_get', { project_id: 'p1', task_id: 'nope' });
    expect(missing).toEqual({ text: 'Dida365 answered 404 to GET /project/p1/task/nope (not found; check the ids)', failed: true });

    dida.on('GET', '/tag', () => {
      throw new TypeError('fetch failed');
    });
    expect(await h.callTool('dida_tag_list', {})).toEqual({ text: 'could not reach Dida365 for GET /tag: fetch failed', failed: true });
  });

  it('does not start without the token, and uses another host when configured', async () => {
    const bare = new FakeHost(createDida365Plugin({ fetch: new FakeDida().fetch }), { id: 'dida365', config: {} });
    hosts.push(bare);
    await expect(bare.start()).rejects.toThrow(/secret DIDA365_TOKEN is not set/);

    const seen: string[] = [];
    const tick = new FakeHost(createDida365Plugin({ fetch: async (url) => (seen.push(String(url)), new Response('[]')) }), { id: 'dida365', config: { apiBase: 'https://api.ticktick.com/' }, env: { DIDA365_TOKEN: TOKEN } });
    hosts.push(tick);
    await tick.start();
    await tick.callTool('dida_countdown_list', {});
    expect(seen).toEqual(['https://api.ticktick.com/open/v1/countdown']);
  });
});

describe('tasks', () => {
  it('creates a task, turning days and wall-clock times into what the API stores', async () => {
    const { h, dida } = await setup();
    dida.on('POST', '/task', (c) => ({ id: 'new1', projectId: 'inbox42', status: 0, ...(c.body as object) }));

    const day = await h.callTool('dida_task_create', { title: 'Renew passport', start: '2026-11-13', priority: 'high', tags: ['admin'], reminders: ['TRIGGER:P0DT9H0M0S'] });
    // A plain day is an all-day task at midnight of the zone; without a project it goes to the inbox.
    expect(dida.to('POST', '/task')[0]?.body).toEqual({ title: 'Renew passport', startDate: '2026-11-12T16:00:00+0000', timeZone: TZ, isAllDay: true, priority: 5, tags: ['admin'], reminders: ['TRIGGER:P0DT9H0M0S'] });
    expect(day.text).toBe(
      ['Created:', '[ ] Renew passport', 'task_id: new1', 'project_id: inbox42 (Inbox)', 'status: open', 'when: 2026-11-13 (all day)', 'time zone: Asia/Shanghai', 'priority: high', 'tags: admin', 'reminders: TRIGGER:P0DT9H0M0S'].join('\n'),
    );

    await h.callTool('dida_task_create', {
      project_id: 'p1',
      title: 'Review',
      start: '2026-11-13T15:00',
      due: '2026-11-13T16:30',
      repeat: 'RRULE:FREQ=WEEKLY;BYDAY=FR',
      repeat_from: 'completed_date',
      items: [{ title: 'Read' }, { title: 'Comment', done: true }],
    });
    expect(dida.to('POST', '/task')[1]?.body).toEqual({
      projectId: 'p1',
      title: 'Review',
      startDate: '2026-11-13T07:00:00+0000',
      dueDate: '2026-11-13T08:30:00+0000',
      timeZone: TZ,
      isAllDay: false,
      repeatFlag: 'RRULE:FREQ=WEEKLY;BYDAY=FR',
      repeatFrom: '1',
      items: [{ title: 'Read' }, { title: 'Comment', status: 1 }],
    });

    // Only an end: the task is dated on that day. Another zone moves the instant, not the wall clock.
    await h.callTool('dida_task_create', { title: 'Call', due: '2026-11-13T09:00', time_zone: 'America/New_York' });
    expect(dida.to('POST', '/task')[2]?.body).toEqual({ title: 'Call', startDate: '2026-11-13T14:00:00+0000', dueDate: '2026-11-13T14:00:00+0000', timeZone: 'America/New_York', isAllDay: false });

    const before = dida.calls.length;
    expect(await h.callTool('dida_task_create', { title: 'x', start: '2026-11-13T15:00', due: '2026-11-13T14:00' })).toEqual({ text: 'due is before start', failed: true });
    expect(await h.callTool('dida_task_create', { title: 'x', start: 'next friday' })).toMatchObject({ failed: true, text: expect.stringContaining('cannot read the time "next friday"') });
    expect(await h.callTool('dida_task_create', { title: 'x', start: '2026-11-13', time_zone: 'Peking' })).toMatchObject({ failed: true, text: expect.stringContaining('not an IANA time zone') });
    // The project names are read once for labelling; nothing was sent for the refused inputs.
    expect(dida.calls.slice(before)).toEqual([]);
  });

  it('puts new tasks into the configured default project', async () => {
    const { h, dida } = await setup({ defaultProjectId: 'p2' });
    dida.on('POST', '/task', (c) => ({ id: 'n', ...(c.body as object) }));
    await h.callTool('dida_task_create', { title: 'Milk' });
    await h.callTool('dida_task_create', { title: 'Slides', project_id: 'p1' });
    expect(dida.to('POST', '/task').map((c) => (c.body as { projectId: string }).projectId)).toEqual(['p2', 'p1']);
  });

  it('updates by sending the whole task back with the changes laid over it', async () => {
    const { h, dida } = await setup();
    const existing = task({
      content: 'Three pages',
      startDate: '2026-11-13T07:00:00.000+0000',
      dueDate: '2026-11-13T08:00:00.000+0000',
      timeZone: TZ,
      isAllDay: false,
      tags: ['work'],
      reminders: ['TRIGGER:PT0S'],
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1',
      priority: 3,
      sortOrder: -1099511627776,
      kind: 'CHECKLIST',
      items: [
        { id: 'i1', title: 'Outline', status: 1, completedTime: '2026-11-12T01:00:00+0000', sortOrder: 0 },
        { id: 'i2', title: 'Draft', status: 0, sortOrder: 1 },
      ],
      etag: 'abc',
      completedTime: undefined,
      focusSummaries: [{ pomoCount: 1 }],
    });
    dida.on('GET', '/project/p1/task/t1', existing).on('POST', '/task/t1', (c) => c.body);

    const r = await h.callTool('dida_task_update', { project_id: 'p1', task_id: 't1', title: 'Write the Q4 report', priority: 'high', due: null, repeat: null, items: [{ id: 'i1', title: 'Outline v2' }, { title: 'Send' }] });
    expect(r.failed).toBeUndefined();
    expect(dida.to('POST', '/task/t1')[0]?.body).toEqual({
      id: 't1',
      projectId: 'p1',
      title: 'Write the Q4 report',
      content: 'Three pages',
      startDate: '2026-11-13T07:00:00.000+0000',
      dueDate: null,
      timeZone: TZ,
      isAllDay: false,
      tags: ['work'],
      reminders: ['TRIGGER:PT0S'],
      repeatFlag: null,
      priority: 5,
      sortOrder: -1099511627776,
      kind: 'CHECKLIST',
      // The kept item keeps what the input did not name; the dropped one is gone; server-side fields are not sent back.
      items: [{ id: 'i1', title: 'Outline v2', status: 1, completedTime: '2026-11-12T01:00:00+0000', sortOrder: 0 }, { title: 'Send' }],
    });
    expect(r.text.split('\n').slice(0, 2)).toEqual(['Updated:', '[ ] Write the Q4 report']);

    // A new time is read in the task's own zone, and a timed task stays timed when only its end moves.
    dida.on('GET', '/project/p1/task/t2', task({ id: 't2', startDate: '2026-11-13T14:00:00+0000', timeZone: 'America/New_York', isAllDay: false }));
    dida.on('POST', '/task/t2', (c) => c.body);
    await h.callTool('dida_task_update', { project_id: 'p1', task_id: 't2', due: '2026-11-14' });
    expect(dida.to('POST', '/task/t2')[0]?.body).toMatchObject({ startDate: '2026-11-13T14:00:00+0000', dueDate: '2026-11-14T05:00:00+0000', isAllDay: false, timeZone: 'America/New_York' });

    expect(await h.callTool('dida_task_update', { project_id: 'p1', task_id: 't1' })).toEqual({ text: 'nothing to change: name at least one field', failed: true });
    expect(await h.callTool('dida_task_update', { project_id: 'p1', task_id: 't1', due: '2026-11-12' })).toEqual({ text: 'due is before start', failed: true });
    expect(dida.to('POST', '/task/t1')).toHaveLength(1);
  });

  it('completes one task directly and many in requests of fifty', async () => {
    const { h, dida } = await setup();
    dida.on('POST', '/project/p1/task/t1/complete').on('POST', '/task/completeTasks', (c) => (c.body as { taskIds: string[] }).taskIds.filter((x) => x !== 'k7'));
    expect((await h.callTool('dida_task_complete', { project_id: 'p1', task_ids: ['t1'] })).text).toBe('Completed task t1.');

    const many = Array.from({ length: 51 }, (_, n) => `k${n}`);
    const r = await h.callTool('dida_task_complete', { project_id: 'p1', task_ids: [...many, 'k0'] });
    expect(dida.to('POST', '/task/completeTasks').map((c) => [(c.body as { projectId: string }).projectId, (c.body as { taskIds: string[] }).taskIds.length])).toEqual([
      ['p1', 50],
      ['p1', 1],
    ]);
    expect(r.text).toMatch(/^Completed 50 of 51 tasks: k0, k1, .*\. Not completed \(wrong project, already done, or no such task\): k7\.$/);

    // Without a project the tasks are taken from the inbox, as the API defines it.
    const inbox = await h.callTool('dida_task_complete', { task_ids: ['k7'] });
    expect(dida.to('POST', '/task/completeTasks').at(-1)?.body).toEqual({ taskIds: ['k7'] });
    expect(inbox).toMatchObject({ failed: true, text: expect.stringContaining('Completed 0 of 1 tasks.') });
  });

  it('lists open tasks of a period, refusing more than the API allows', async () => {
    const { h, dida } = await setup({ maxResults: 2 });
    dida.on('POST', '/task/undone', [
      task({ id: 'b', title: 'Later', startDate: '2026-11-13T07:00:00+0000', dueDate: '2026-11-13T08:00:00+0000', isAllDay: false, priority: 5, tags: ['work'], repeatFlag: 'RRULE:FREQ=DAILY' }),
      task({ id: 'a', title: 'Earlier', projectId: 'inbox42', startDate: '2026-11-12T16:00:00+0000', isAllDay: true, timeZone: TZ, content: 'Bring  the\nforms' }),
      task({ id: 'c', title: 'Third', startDate: '2026-11-14T01:00:00+0000' }),
    ]);
    const r = await h.callTool('dida_task_undone', { from: '2026-11-13', to: '2026-11-14', project_ids: ['p1', 'inbox'] });
    expect(dida.to('POST', '/task/undone')[0]?.body).toEqual({ startDate: '2026-11-12T16:00:00+0000', endDate: '2026-11-14T15:59:59+0000', projectIds: ['p1', 'inbox'] });
    expect(r.text).toBe(
      [
        'Open tasks from 2026-11-13 00:00 to 2026-11-14 23:59; times in Asia/Shanghai (2 of 3):',
        '- [ ] Earlier — 2026-11-13 (all day)',
        '  task_id a · project_id inbox42 (Inbox)',
        '  note: Bring the forms',
        '- [ ] Later — 2026-11-13 15:00 → 2026-11-13 16:00 · high priority · #work · repeats',
        '  task_id b · project_id p1 (Work)',
        '… 1 more not shown; narrow the query.',
      ].join('\n'),
    );

    expect(await h.callTool('dida_task_undone', { from: '2026-11-01', to: '2026-11-16' })).toEqual({ text: 'the period may span at most 14 days; ask for several periods', failed: true });
    expect(await h.callTool('dida_task_undone', { from: '2026-11-14', to: '2026-11-13T12:00' })).toEqual({ text: 'the range ends before it starts', failed: true });
    expect(dida.to('POST', '/task/undone')).toHaveLength(1);
  });

  it('maps the filters of the other listings onto the API', async () => {
    const { h, dida } = await setup();
    dida.on('POST', '/task/filter', []).on('POST', '/task/search', [task({ status: 2, completedTime: '2026-11-10T02:00:00+0000' })]).on('POST', '/task/completed', []);

    expect((await h.callTool('dida_task_filter', { project_ids: ['p1'], start_from: '2026-11-01', start_to: '2026-11-30', priority: ['high', 'none'], tags: ['work'], kind: ['TEXT'], status: ['open', 'abandoned'] })).text).toBe('No task matches.');
    expect(dida.to('POST', '/task/filter')[0]?.body).toEqual({ projectIds: ['p1'], startDate: '2026-10-31T16:00:00+0000', endDate: '2026-11-30T15:59:59+0000', priority: [5, 0], tag: ['work'], kind: ['TEXT'], status: [0, -1] });
    await h.callTool('dida_task_filter', {});
    expect(dida.to('POST', '/task/filter')[1]?.body).toEqual({});

    const found = await h.callTool('dida_task_search', { keywords: ' report ', status: ['completed'], due_to: '2026-11-30T18:00' });
    expect(dida.to('POST', '/task/search')[0]?.body).toEqual({ keywords: 'report', status: [2], dueTo: '2026-11-30T10:00:00+0000' });
    expect(found.text).toBe(['Found tasks; times in Asia/Shanghai (1):', '- [x] Write the report — completed 2026-11-10 10:00', '  task_id t1 · project_id p1 (Work)'].join('\n'));
    expect(await h.callTool('dida_task_search', {})).toEqual({ text: 'give keywords or at least one filter', failed: true });
    expect(await h.callTool('dida_task_search', { keywords: '  ' })).toEqual({ text: 'keywords must not be blank', failed: true });

    await h.callTool('dida_task_completed', { project_ids: ['p1'], from: '2026-11-01T00:00:00Z', to: '2026-11-07' });
    expect(dida.to('POST', '/task/completed')[0]?.body).toEqual({ projectIds: ['p1'], startDate: '2026-11-01T00:00:00+0000', endDate: '2026-11-07T15:59:59+0000' });
  });

  it('reads one task with its comments, and adds a comment', async () => {
    const { h, dida } = await setup();
    dida
      .on('GET', '/project/p1/task/t1', task({ desc: 'Checklist intro', kind: 'CHECKLIST', parentId: 't0', assigneeUsername: 'ann@example.com', items: [{ id: 'i1', title: 'Outline', status: 1 }], focusSummaries: [{ pomoCount: 2, pomoDuration: 3000, stopwatchDuration: 600 }] }))
      .on('GET', '/project/p1/task/t1/comments', [{ id: 'c1', title: 'Looks good', createdTime: '2026-04-07T09:00:00+0000' }])
      .on('POST', '/project/p1/task/t1/comment', (c) => ({ id: 'c2', createdTime: '2026-04-08T01:30:00+0000', ...(c.body as object) }));
    const r = await h.callTool('dida_task_get', { project_id: 'p1', task_id: 't1', comments: true });
    expect(r.text).toBe(
      [
        '[ ] Write the report',
        'task_id: t1',
        'project_id: p1 (Work)',
        'status: open',
        'priority: none',
        'kind: CHECKLIST',
        'parent task_id: t0',
        'assignee: ann@example.com',
        'focus: 2 pomodoros, 60 min focused',
        'description:',
        'Checklist intro',
        'items:',
        '  - [x] Outline (item id i1)',
        'comments:',
        '  - 2026-04-07 17:00 (comment_id c1): Looks good',
      ].join('\n'),
    );
    expect((await h.callTool('dida_task_get', { project_id: 'p1', task_id: 't1' })).text).not.toContain('comments');
    expect((await h.callTool('dida_comment_add', { project_id: 'p1', task_id: 't1', text: 'Sent to Bo' })).text).toBe('Comment added:\n  - 2026-04-08 09:30 (comment_id c2): Sent to Bo');
    expect(dida.to('POST', '/project/p1/task/t1/comment')[0]?.body).toEqual({ title: 'Sent to Bo' });
  });

  it('moves, assigns and batches', async () => {
    const { h, dida } = await setup();
    dida
      .on('POST', '/task/move', [{ id: 't1', etag: 'e1' }])
      .on('POST', '/task/assign', (c) => task({ assigneeUsername: (c.body as { assigneeUsername: string }).assigneeUsername }))
      .on('POST', '/task/unassign', task())
      .on('GET', '/project/p1/task/t1', task({ tags: ['work'], startDate: '2026-11-13T07:00:00+0000', isAllDay: false, timeZone: TZ }))
      .on('POST', '/task/batch', { id2etag: { t1: 'e2', fresh1: 'e3' }, id2error: { t9: 'NOT_EXISTED' } });

    const moved = await h.callTool('dida_task_move', {
      moves: [
        { task_id: 't1', from_project_id: 'p1', to_project_id: 'p2' },
        { task_id: 't5', from_project_id: 'p1', to_project_id: 'p2' },
      ],
    });
    expect(dida.to('POST', '/task/move')[0]?.body).toEqual([
      { taskId: 't1', fromProjectId: 'p1', toProjectId: 'p2' },
      { taskId: 't5', fromProjectId: 'p1', toProjectId: 'p2' },
    ]);
    expect(moved.text).toBe('Moved 1 of 2 tasks. Not moved: t5.');

    expect((await h.callTool('dida_task_assign', { project_id: 'p1', task_id: 't1', assignee: 'ann@example.com' })).text.split('\n')[0]).toBe('Assigned task t1 to ann@example.com.');
    expect(dida.to('POST', '/task/assign')[0]?.body).toEqual({ projectId: 'p1', taskId: 't1', assigneeUsername: 'ann@example.com' });
    await h.callTool('dida_task_assign', { project_id: 'p1', task_id: 't1', assignee: null });
    expect(dida.to('POST', '/task/unassign')[0]?.body).toEqual({ projectId: 'p1', taskId: 't1' });

    const batch = await h.callTool('dida_task_batch', { add: [{ title: 'New one', project_id: 'p2', start: '2026-11-20' }], update: [{ project_id: 'p1', task_id: 't1', priority: 'low' }] });
    expect(dida.to('POST', '/task/batch')[0]?.body).toEqual({
      add: [{ title: 'New one', projectId: 'p2', startDate: '2026-11-19T16:00:00+0000', timeZone: TZ, isAllDay: true }],
      // The changed task was read first, so its other fields travel along.
      update: [{ id: 't1', projectId: 'p1', title: 'Write the report', priority: 1, tags: ['work'], startDate: '2026-11-13T07:00:00+0000', isAllDay: false, timeZone: TZ }],
    });
    expect(batch.text).toBe(['Batch sent: 1 to add, 1 to change.', 'Created task_ids: fresh1', 'Changed task_ids: t1', 'Refused: t9 (NOT_EXISTED)'].join('\n'));
    expect(await h.callTool('dida_task_batch', {})).toEqual({ text: 'nothing to do: give add or update', failed: true });
    // A task that cannot be read stops the batch before anything is sent.
    expect(await h.callTool('dida_task_batch', { update: [{ project_id: 'p1', task_id: 'gone', title: 'x' }] })).toMatchObject({ failed: true });
    expect(dida.to('POST', '/task/batch')).toHaveLength(1);
  });
});

describe('projects, tags, focus, habits, countdowns', () => {
  it('lists projects with their groups and reads one project', async () => {
    const { h, dida } = await setup();
    dida
      .on('GET', '/project/group', [{ id: 'g1', name: 'Family' }])
      .on('GET', '/project/p2/data', { project: { id: 'p2', name: 'Home', viewMode: 'kanban', groupId: 'g1' }, tasks: [task({ id: 't7', projectId: 'p2', title: 'Fix tap' })], columns: [{ id: 'col1', projectId: 'p2', name: 'Doing' }] })
      .on('GET', '/project/p2', { id: 'p2', name: 'Home', closed: true, permission: 'read', kind: 'NOTE' })
      .on('GET', '/project/p2/column', [{ id: 'col1', name: 'Doing' }])
      .on('GET', '/project/p2/members', [
        { username: 'me@example.com', displayName: 'Me', self: true },
        { username: 'ann@example.com', displayName: 'Ann' },
      ]);
    expect((await h.callTool('dida_project_list', {})).text).toBe(
      ['Projects (2):', '- Work — project_id p1', '- Home — project_id p2 · kanban view · group Family (group_id g1)', 'Project groups (1):', '- Family — group_id g1', 'The inbox is project_id "inbox".'].join('\n'),
    );
    await h.callTool('dida_project_list', { offset: 200 });
    expect(dida.to('GET', '/project').at(-1)?.query).toEqual({ offset: '200' });

    expect((await h.callTool('dida_project_get', { project_id: 'p2' })).text).toBe(
      ['- Home — project_id p2 · kanban view · group_id g1', 'Columns (1):', '- Doing — column_id col1', 'Open tasks; times in Asia/Shanghai (1):', '- [ ] Fix tap', '  task_id t7 · project_id p2 (Home)'].join('\n'),
    );
    expect((await h.callTool('dida_project_get', { project_id: 'p2', tasks: false, members: true })).text).toBe(
      ['- Home — project_id p2 · notes · archived · read only', 'Columns (1):', '- Doing — column_id col1', 'Members (2):', '- Me — username me@example.com (the owner)', '- Ann — username ann@example.com'].join('\n'),
    );
  });

  it('creates and changes projects, groups, columns and tags', async () => {
    const { h, dida } = await setup();
    const echo = (id: string) => (c: { body: unknown }) => ({ id, ...(c.body as object) });
    dida.on('POST', '/project', echo('p9')).on('POST', '/project/p9', echo('p9')).on('POST', '/project/group', echo('g9')).on('POST', '/project/group/g9', echo('g9')).on('POST', '/project/p9/column', echo('c9')).on('POST', '/project/p9/column/c9', echo('c9')).on('POST', '/tag', (c) => c.body);

    expect((await h.callTool('dida_project_save', { name: 'Trip', color: '#F18181', view_mode: 'kanban', kind: 'TASK' })).text).toBe('Created the project:\n- Trip — project_id p9 · kanban view');
    expect(dida.to('POST', '/project')[0]?.body).toEqual({ name: 'Trip', color: '#F18181', viewMode: 'kanban', kind: 'TASK' });
    expect((await h.callTool('dida_project_save', { project_id: 'p9', name: 'Trip to Kyoto' })).text).toBe('Changed the project:\n- Trip to Kyoto — project_id p9');
    expect(await h.callTool('dida_project_save', { color: '#000000' })).toEqual({ text: 'a new project needs a name', failed: true });
    expect(await h.callTool('dida_project_save', { project_id: 'p9' })).toEqual({ text: 'nothing to change: name at least one field', failed: true });

    expect((await h.callTool('dida_group_save', { name: 'Travel' })).text).toBe('Created the project group:\n- Travel — group_id g9');
    expect((await h.callTool('dida_group_save', { group_id: 'g9', name: 'Trips' })).text).toBe('Renamed the project group:\n- Trips — group_id g9');
    expect((await h.callTool('dida_column_save', { project_id: 'p9', name: 'Booked' })).text).toBe('Added the column:\n- Booked — column_id c9');
    expect((await h.callTool('dida_column_save', { project_id: 'p9', column_id: 'c9', name: 'Paid' })).text).toBe('Renamed the column:\n- Paid — column_id c9');

    expect((await h.callTool('dida_tag_create', { name: ' Deep Work ' })).text).toBe('Created the tag Deep Work.');
    expect(dida.to('POST', '/tag')[0]?.body).toEqual({ name: 'deep work', label: 'Deep Work' });
    dida.on('GET', '/tag', [{ name: 'deep work', label: 'Deep Work' }, { name: 'q4', label: 'Q4', parent: 'work', type: 2 }]);
    expect((await h.callTool('dida_tag_list', {})).text).toBe(['Tags (2):', '- Deep Work', '- Q4 (under work) · team tag'].join('\n'));
  });

  it('deletes what it is told to, and nothing when an id is missing', async () => {
    const { h, dida } = await setup();
    for (const p of ['/project/p1/task/t1', '/project/p1/task/t1/comment/c1', '/project/p1', '/project/group/g1', '/focus/f1']) dida.on('DELETE', p);
    const run = async (input: Record<string, unknown>) => (await h.callTool('dida_delete', input)).text;
    expect(await run({ type: 'task', project_id: 'p1', task_id: 't1' })).toBe('Deleted task t1.');
    expect(await run({ type: 'comment', project_id: 'p1', task_id: 't1', comment_id: 'c1' })).toBe('Deleted comment c1.');
    expect(await run({ type: 'project', project_id: 'p1' })).toBe('Deleted project p1.');
    expect(await run({ type: 'project_group', group_id: 'g1' })).toBe('Deleted project group g1.');
    expect(await run({ type: 'focus', focus_id: 'f1', focus_type: 'timing' })).toBe('Deleted focus record f1.');
    const deletes = dida.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.path)).toEqual(['/project/p1/task/t1', '/project/p1/task/t1/comment/c1', '/project/p1', '/project/group/g1', '/focus/f1']);
    expect(deletes.at(-1)?.query).toEqual({ type: '1' });

    expect(await h.callTool('dida_delete', { type: 'task', task_id: 't1' })).toEqual({ text: 'deleting a task needs project_id', failed: true });
    expect(await h.callTool('dida_delete', { type: 'comment', project_id: 'p1', task_id: 't1' })).toEqual({ text: 'deleting a comment needs comment_id', failed: true });
    expect(await h.callTool('dida_delete', { type: 'focus', focus_id: 'f1' })).toEqual({ text: 'deleting a focus record needs focus_type', failed: true });
    expect(await h.callTool('dida_delete', { type: 'habit', habit_id: 'h1' })).toMatchObject({ failed: true });
    // Ids are escaped, so one cannot reach another path.
    await h.callTool('dida_delete', { type: 'project', project_id: 'p1/task/t2' });
    expect(dida.calls.filter((c) => c.method === 'DELETE')).toHaveLength(6);
    expect(dida.calls.at(-1)?.path).toBe('/project/p1%2Ftask%2Ft2');
  });

  it('reads and records focus sessions', async () => {
    const { h, dida } = await setup();
    dida
      .on('GET', '/focus', [{ id: 'f1', type: 0, startTime: '2026-04-07T09:00:00+0800', endTime: '2026-04-07T09:25:00+0800', duration: 1500, tasks: [{ title: 'Write the report' }], note: 'Deep work' }])
      .on('GET', '/focus/f1', { id: 'f1', type: 0, duration: 1500, taskId: 't1' })
      .on('POST', '/focus', (c) => ({ id: 'f2', ...(c.body as object) }));
    const list = await h.callTool('dida_focus_list', { type: 'pomodoro', from: '2026-04-01', to: '2026-04-07' });
    expect(dida.to('GET', '/focus')[0]?.query).toEqual({ from: '2026-03-31T16:00:00+0000', to: '2026-04-07T15:59:59+0000', type: '0' });
    expect(list.text).toBe(['Focus records (pomodoro), 25 min in total; times in Asia/Shanghai (1):', '- pomodoro 2026-04-07 09:00 → 09:25 · 25 min · on Write the report · note: Deep work — focus_id f1'].join('\n'));
    expect((await h.callTool('dida_focus_list', { type: 'pomodoro', focus_id: 'f1' })).text).toBe('- pomodoro no time · 25 min · task_id t1 — focus_id f1');
    expect(await h.callTool('dida_focus_list', { type: 'timing', from: '2026-04-01' })).toEqual({ text: 'give from and to, or a focus_id', failed: true });

    await h.callTool('dida_focus_create', { type: 'timing', start: '2026-04-07T09:00', end: '2026-04-07T10:30', pause_sec: 300, task_id: 't1' });
    expect(dida.to('POST', '/focus')[0]?.body).toEqual({ type: 1, startTime: '2026-04-07T01:00:00+0000', endTime: '2026-04-07T02:30:00+0000', duration: 5100, pauseDuration: 300, taskId: 't1' });
    expect(await h.callTool('dida_focus_create', { type: 'timing', start: '2026-04-07T10:00', end: '2026-04-07T09:00' })).toEqual({ text: 'end must be after start', failed: true });
  });

  it('lists habits with check-ins, saves a habit and checks in', async () => {
    const now = Date.parse('2026-04-07T18:30:00Z'); // 2026-04-08 02:30 in Shanghai
    const { h, dida } = await setup({}, { now: () => now });
    dida
      .on('GET', '/habit', [
        { id: 'h1', name: 'Read', type: 'Boolean', repeatRule: 'RRULE:FREQ=DAILY;INTERVAL=1', totalCheckIns: 12, sectionId: 's1' },
        { id: 'h2', name: 'Run', type: 'Real', goal: 5, unit: 'km' },
      ])
      .on('GET', '/habit/h1', { id: 'h1', name: 'Read' })
      .on('GET', '/habit/sections', [{ id: 's1', name: 'Morning' }])
      .on('GET', '/habit/checkins', [{ habitId: 'h1', year: 2026, checkins: [{ stamp: 20260406, value: 1, goal: 1 }, { stamp: 20260407, value: 1, goal: 1, status: 2 }] }])
      .on('POST', '/habit', (c) => ({ id: 'h3', ...(c.body as object) }))
      .on('POST', '/habit/h1', (c) => ({ id: 'h1', name: 'Read', ...(c.body as object) }))
      .on('POST', '/habit/h2/checkin', (c) => ({ habitId: 'h2', year: 2026, checkins: [{ stamp: 20260101, value: 9, goal: 5 }, { ...(c.body as object) }] }));

    const list = await h.callTool('dida_habit_list', { sections: true, checkins_from: '2026-04-01' });
    expect(dida.to('GET', '/habit/checkins')[0]?.query).toEqual({ habitIds: 'h1,h2', from: '20260401', to: '20260408' });
    expect(list.text).toBe(
      [
        'Habits (2):',
        '- Read — habit_id h1 · RRULE:FREQ=DAILY;INTERVAL=1 · 12 check-ins · section Morning',
        '- Run — habit_id h2 · goal 5 km',
        'Habit sections (1):',
        '- Morning — section_id s1',
        'Check-ins 2026-04-01 to today, as done/goal (1):',
        '- Read (habit_id h1): 2026-04-06: 1/1, 2026-04-07: 1/1 (status 2)',
      ].join('\n'),
    );
    expect((await h.callTool('dida_habit_list', { habit_id: 'h1' })).text).toBe('Habits (1):\n- Read — habit_id h1');

    await h.callTool('dida_habit_save', { name: 'Stretch', type: 'Boolean', repeat: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', icon: 'habit_yoga', record_enabled: false, target_days: 30, target_start: '2026-04-01', section_id: 's1' });
    expect(dida.to('POST', '/habit')[0]?.body).toEqual({ name: 'Stretch', type: 'Boolean', repeatRule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', iconRes: 'habit_yoga', recordEnable: false, targetDays: 30, targetStartDate: 20260401, sectionId: 's1' });
    await h.callTool('dida_habit_save', { habit_id: 'h1', goal: 2 });
    expect(dida.to('POST', '/habit/h1')[0]?.body).toEqual({ goal: 2 });
    expect(await h.callTool('dida_habit_save', { goal: 2 })).toEqual({ text: 'a new habit needs a name', failed: true });

    // Today is the day in the configured zone, not in UTC.
    const checked = await h.callTool('dida_habit_checkin', { habit_id: 'h2', value: 3.5, goal: 5 });
    expect(dida.to('POST', '/habit/h2/checkin')[0]?.body).toEqual({ stamp: 20260408, opTime: '2026-04-07T18:30:00+0000', value: 3.5, goal: 5 });
    expect(checked.text).toBe('Checked in:\n- habit_id h2: 2026-04-08: 3.5/5');
    await h.callTool('dida_habit_checkin', { habit_id: 'h2', date: '2026-04-05', time: '2026-04-05T07:30' });
    expect(dida.to('POST', '/habit/h2/checkin')[1]?.body).toEqual({ stamp: 20260405, opTime: '2026-04-07T18:30:00+0000', time: '2026-04-04T23:30:00+0000' });
  });

  it('lists countdowns', async () => {
    const { h, dida } = await setup();
    dida.on('GET', '/countdown', [{ id: 'cd1', name: 'Birthday', date: 20260407, ignoreYear: true, remark: 'Cake' }]);
    expect((await h.callTool('dida_countdown_list', {})).text).toBe('Countdowns (1):\n- Birthday — 2026-04-07 · every year · Cake — countdown_id cd1');
    dida.on('GET', '/countdown', []);
    expect((await h.callTool('dida_countdown_list', {})).text).toBe('No countdowns.');
  });
});
