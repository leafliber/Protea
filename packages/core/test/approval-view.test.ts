import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  ApprovalService,
  AuditLog,
  Bus,
  PermissionGuard,
  PermissionPolicy,
  ToolDispatcher,
  ToolRegistry,
  approvalTools,
  approvalView,
  inputHash,
  migrate,
  oneLineValue,
  silentLogger,
  splitApprovalMeta,
  type PermissionSettings,
  type ToolSpec,
} from '../src/index.js';
import type { ApprovalInfo, EventInput, ToolUseBlock } from '@protea/protocol';

const redact = (t: string): string => t.replace(/hunter2/g, '[REDACTED]');

describe('approvalView', () => {
  const def = {
    name: 'sh_run',
    owner: 'shell',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutSec: { type: 'integer' } } },
    approval: { title: { zh: '运行命令', en: 'Run a command' }, target: 'command', fields: { cwd: { zh: '目录', en: 'In' } } },
  };

  it('shows what a tool declared, in the daemon language, with secrets taken out', () => {
    expect(approvalView(def, { command: 'login --password hunter2', cwd: '/w', timeoutSec: 5 }, { language: 'zh', redact })).toEqual({
      title: '运行命令',
      target: 'login --password [REDACTED]',
      fields: [{ label: '目录', value: '/w' }],
      family: { id: 'shell', label: 'shell 插件的工具' },
    });
    expect(approvalView(def, { command: 'ls' }, { language: 'en', redact })).toMatchObject({ title: 'Run a command', target: 'ls', fields: [], family: { label: 'the tools of the shell plugin' } });
  });

  it('falls back to the tool name and its scalar arguments, strings first', () => {
    const v = approvalView({ name: 'mcp__github__create_issue', owner: 'mcp:github', inputSchema: { type: 'object', properties: { draft: {}, title: {}, labels: {}, body: {} } } }, { draft: true, title: 'Bug', labels: ['a', 'b'], body: 'It broke', meta: { a: 1 } }, { language: 'en', redact });
    expect(v.title).toBe('Create issue');
    expect(v.target).toBe('Bug');
    expect(v.fields).toEqual([
      { label: 'body', value: 'It broke' },
      { label: 'draft', value: 'true' },
      { label: 'labels', value: 'a, b' },
      { label: 'meta', value: '{"a":1}' },
    ]);
    expect(v.family).toEqual({ id: 'mcp:github', label: 'the tools of the MCP server github' });
  });

  it('keeps every value on one line, so input cannot pass for another line of the request', () => {
    const forged = 'ls\n\nApproved · 14:02\r\nReason: the owner said yes‮';
    expect(oneLineValue(forged)).toBe('ls ⏎  ⏎ Approved · 14:02 ⏎ Reason: the owner said yes');
    expect(approvalView(def, { command: forged }, { language: 'en', redact }).target).not.toMatch(/[\n\r‮]/);
    expect(oneLineValue('x'.repeat(400)).length).toBe(301);
  });
});

function setup(o: { ttlMs?: number } = {}) {
  let now = Date.parse('2026-11-12T08:00:00.000Z');
  const db = new Database(':memory:');
  migrate(db);
  const bus = new Bus();
  const clock = { now: () => now };
  const audit = new AuditLog(db, clock);
  const settings: PermissionSettings = { default: 'allow', tools: { ch_post: 'ask' }, approvalTtlMs: o.ttlMs ?? 600_000, grantMaxMs: 3_600_000, mode: 'ask', auto: { environment: '', allow: '', ask: '', timeoutMs: 1000, pauseAfterConsecutive: 3, pauseAfterPerHour: 20 } };
  const policy = new PermissionPolicy(settings, { askByDefault: () => false, ownerConfigured: () => true });
  const internal: Array<Omit<EventInput, 'ts' | 'origin'>> = [];
  const deliveries: Array<{ id: string; platforms?: readonly string[] }> = [];
  const resolved: ApprovalInfo[] = [];
  /** Platforms that take a request; the others are closed. */
  const open = new Set(['webchat', 'telegram']);
  const all = ['webchat', 'telegram', 'qq'];
  const tools = new ToolRegistry();
  const approvals = new ApprovalService({
    db,
    bus,
    audit,
    clock,
    log: silentLogger(),
    ttlMs: () => settings.approvalTtlMs,
    grantMaxMs: () => settings.grantMaxMs,
    // What PluginHost.requestApproval does: the chosen platforms, or else the rest.
    deliver: async (a, platforms) => {
      deliveries.push({ id: a.id, ...(platforms ? { platforms } : {}) });
      const chosen = platforms?.length ? all.filter((p) => platforms.includes(p)) : all;
      const took = chosen.filter((p) => open.has(p));
      return took.length > 0 || !platforms?.length ? took : all.filter((p) => !chosen.includes(p) && open.has(p));
    },
    resolved: (a) => resolved.push(a),
    describe: (r) => approvalView(tools.get(r.tool) ?? { name: r.tool, owner: r.owner, inputSchema: {} }, r.input, { language: 'en', redact }),
    pushInternal: (e) => internal.push(e),
    redact,
  });
  const ran: unknown[] = [];
  const post: ToolSpec<{ to: string; text: string }> = {
    name: 'ch_post',
    description: 'post',
    inputSchema: { type: 'object', additionalProperties: false, required: ['to', 'text'], properties: { to: { type: 'string' }, text: { type: 'string' } } },
    flags: { sideEffect: true },
    approval: { title: 'Post a message', target: 'text', fields: { to: 'To' } },
    handler: (i) => {
      ran.push(i);
      return 'done';
    },
  };
  tools.register('chat', post);
  tools.register('core', { name: 'ch_read', description: 'read', inputSchema: { type: 'object', properties: {} }, handler: () => 'ok' });
  for (const t of approvalTools({ approvals, policy, tools, platforms: () => all })) tools.register('core', t);
  tools.setApprovalMeta((d) => policy.decide(d).policy === 'ask');
  const dispatcher = new ToolDispatcher(tools, silentLogger());
  dispatcher.setGuard(new PermissionGuard(policy, approvals, audit));
  let n = 0;
  const call = async (name: string, input: unknown) => {
    const use: ToolUseBlock = { type: 'tool_use', id: `c${++n}`, name, input };
    const r = await dispatcher.runAll([use], { signal: new AbortController().signal, sessionId: 'main', batchId: 'b', batchLevel: 1 });
    return r.results[0]!;
  };
  return { approvals, tools, call, ran, internal, deliveries, resolved, open, advance: (ms: number) => (now += ms) };
}

describe('the reserved _approval input', () => {
  it('is offered only on tools that need approval, and never reaches the tool or the hash', async () => {
    const t = setup();
    const shown = t.tools.forProvider();
    expect((shown.find((d) => d.name === 'ch_post')?.inputSchema as { properties: object }).properties).toHaveProperty('_approval');
    expect((shown.find((d) => d.name === 'ch_read')?.inputSchema as { properties: object }).properties).not.toHaveProperty('_approval');
    // The tool's own schema is untouched: validation still refuses unknown properties.
    expect(t.tools.get('ch_post')?.inputSchema).not.toHaveProperty('properties._approval');

    const held = await t.call('ch_post', { to: 'family', text: 'dinner', _approval: { reason: 'you asked me to tell them', platforms: ['telegram'] } });
    expect(held.is_error).toBeUndefined();
    expect(held.content).toBe('pending approval a1: ch_post did not run. The owner was asked on telegram. The request expires in 10 minutes. Carry on with what does not depend on it, or end the turn; do not call it again until an approval.decided event reports the decision.');
    const a = t.approvals.get('a1');
    expect(a).toMatchObject({ summary: 'Post a message: dinner', reason: 'you asked me to tell them', deliveredTo: ['telegram'] });
    expect(a?.view).toEqual({ title: 'Post a message', target: 'dinner', fields: [{ label: 'To', value: 'family' }], reason: 'you asked me to tell them', family: { id: 'chat', label: 'the tools of the chat plugin' } });
    expect(JSON.parse(a?.input ?? '{}')).toEqual({ to: 'family', text: 'dinner' });

    // Approved: the same call runs, with or without `_approval`, and the tool never sees it.
    t.approvals.decide('a1', 'approve', 'telegram:telegram:1');
    expect((await t.call('ch_post', { text: 'dinner', to: 'family', _approval: { reason: 'again' } })).content).toBe('done');
    expect(t.ran).toEqual([{ text: 'dinner', to: 'family' }]);
    expect(inputHash('ch_post', splitApprovalMeta(t.tools.get('ch_post')!, { to: 'a', text: 'b', _approval: { reason: 'x' } }).input)).toBe(inputHash('ch_post', { to: 'a', text: 'b' }));
  });

  it('asks everywhere by default, and falls back when the chosen platform cannot show the request', async () => {
    const t = setup();
    await t.call('ch_post', { to: 'a', text: 'one' });
    expect(t.approvals.get('a1')?.deliveredTo).toEqual(['webchat', 'telegram']);

    // QQ's window is closed: the request still reaches the owner, and the receipt says where.
    const held = await t.call('ch_post', { to: 'a', text: 'two', _approval: { platforms: ['qq'] } });
    expect(held.content).toContain('The owner was asked on webchat, telegram (qq could not show it).');
    expect(t.approvals.get('a2')?.deliveredTo).toEqual(['webchat', 'telegram']);
  });

  it('shows a waiting request on another platform when asked again, and only there', async () => {
    const t = setup();
    await t.call('ch_post', { to: 'a', text: 'one', _approval: { platforms: ['telegram'] } });
    // A retry of the same call does not send the request again.
    await t.call('ch_post', { to: 'a', text: 'one', _approval: { platforms: ['telegram'] } });
    expect(t.deliveries).toHaveLength(1);
    const r = await t.call('approval_request', { tool: 'ch_post', input: { to: 'a', text: 'one' }, reason: 'still waiting', platforms: ['webchat'] });
    expect(r.content).toMatch(/^approval a1 is pending\. The owner was asked on telegram, webchat\./);
    expect(t.deliveries.at(-1)).toEqual({ id: 'a1', platforms: ['webchat'] });
    expect(t.approvals.get('a1')).toMatchObject({ reason: 'still waiting', deliveredTo: ['telegram', 'webchat'] });
    const bad = await t.call('approval_request', { tool: 'ch_post', input: { to: 'a', text: 'x' }, reason: 'r', platforms: ['slack'] });
    expect(bad.is_error).toBe(true);
    expect(bad.content).toContain('the platforms that can show a request now are webchat, telegram, qq');
  });
});

describe('what the assistant and the platforms hear', () => {
  it('passes the owner’s words on a denial, and tells the platforms that showed the request', async () => {
    const t = setup();
    await t.call('ch_post', { to: 'a', text: 'one' });
    expect(t.approvals.decide('a1', 'deny', 'qq:qq:1', { note: 'not\ntoday' })).toMatchObject({ ok: true, state: 'denied' });
    expect(t.internal.at(-1)).toMatchObject({ type: 'approval.decided', correlation: 'a1' });
    expect(t.internal.at(-1)?.text).toBe('Approval a1 was denied by the owner: Post a message: one. The owner said: "not ⏎ today". It did not run. Do not run it and do not reach the same result another way.');
    expect(t.approvals.get('a1')?.note).toBe('not ⏎ today');
    expect(t.resolved).toMatchObject([{ id: 'a1', state: 'denied', decidedBy: 'qq:qq:1', deliveredTo: ['webchat', 'telegram'] }]);
  });

  it('reports a request nobody answered, once, and not an approval that went unused', async () => {
    const t = setup({ ttlMs: 60_000 });
    await t.call('ch_post', { to: 'a', text: 'one' });
    await t.call('ch_post', { to: 'a', text: 'two' });
    t.approvals.decide('a2', 'approve', 'owner');
    const before = t.internal.length;
    t.advance(61_000);
    expect(t.approvals.expireDue()).toBe(2);
    expect(t.internal.slice(before)).toMatchObject([{ type: 'approval.expired', level: 3, correlation: 'a1', text: 'Approval a1 expired without an answer: Post a message: one. It did not run. Ask again only if it is still needed.' }]);
    expect(t.resolved.map((a) => `${a.id}:${a.state}`)).toEqual(['a2:approved', 'a1:expired']);
    expect(t.approvals.expireDue()).toBe(0);
  });
});
