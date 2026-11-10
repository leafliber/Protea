import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EventInput, ToolUseBlock } from '@protea/protocol';
import {
  ApprovalService,
  AuditLog,
  Bus,
  PermissionGuard,
  PermissionPolicy,
  ToolDispatcher,
  ToolRegistry,
  approvalTools,
  openDatabase,
  silentLogger,
  type PermissionSettings,
  type ToolDef,
  type ToolSpec,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup(settings: Partial<PermissionSettings> = {}, opts: { owner?: boolean; ask?: string[] } = {}) {
  const { db } = openDatabase(path.join(tmpDir(), 'protea.db'));
  let now = Date.parse('2026-11-03T08:00:00Z');
  const clock = { now: () => now };
  const bus = new Bus();
  const audit = new AuditLog(db, clock);
  const internal: Array<Omit<EventInput, 'ts' | 'origin'>> = [];
  const delivered: string[] = [];
  const policy = new PermissionPolicy(
    { default: 'allow', tools: {}, grantMaxMs: 8 * 3_600_000, approvalTtlMs: 86_400_000, mode: 'ask', auto: { environment: '', allow: '', ask: '', timeoutMs: 30_000, pauseAfterConsecutive: 3, pauseAfterPerHour: 20 }, ...settings },
    { askByDefault: (d: ToolDef) => (opts.ask ?? []).includes(d.name), ownerConfigured: () => opts.owner !== false },
  );
  const approvals = new ApprovalService({
    db,
    bus,
    audit,
    clock,
    log: silentLogger(),
    ttlMs: () => policy.ttlMs,
    grantMaxMs: () => settings.grantMaxMs ?? 8 * 3_600_000,
    deliver: async (a) => {
      delivered.push(a.id);
      return ['console'];
    },
    pushInternal: (e) => {
      internal.push(e);
    },
    redact: (t) => t.replaceAll('hunter2', '[REDACTED:PASSWORD]'),
  });
  const tools = new ToolRegistry();
  const ran: string[] = [];
  const mk = (name: string, sideEffect: boolean): ToolSpec<never> =>
    ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      ...(sideEffect ? { flags: { sideEffect: true } } : {}),
      handler: (i: unknown) => {
        ran.push(`${name} ${JSON.stringify(i)}`);
        return 'done';
      },
    }) as unknown as ToolSpec<never>;
  tools.register('chat', mk('ch_send', true));
  tools.register('chat', mk('ch_post', true));
  tools.register('chat', mk('ch_read', false));
  tools.register('shell', mk('sh_run', true));
  for (const t of approvalTools({ approvals, policy, tools })) tools.register('core', t);
  const dispatcher = new ToolDispatcher(tools, silentLogger());
  dispatcher.setGuard(new PermissionGuard(policy, approvals, audit));
  let seq = 0;
  const call = async (name: string, input: unknown = {}) => {
    const use: ToolUseBlock = { type: 'tool_use', id: `tu_${++seq}`, name, input };
    const r = await dispatcher.runAll([use], { signal: new AbortController().signal, sessionId: 'main', batchId: 'b1', batchLevel: 1 });
    return { ...(r.results[0] as { content: string; is_error?: boolean }), callId: use.id };
  };
  return { db, audit, policy, approvals, tools, dispatcher, call, ran, internal, delivered, advance: (ms: number) => (now += ms) };
}

describe('permission policy', () => {
  it('resolves exact names, then globs (most specific first), then manifest defaults, then the default', () => {
    const t = setup({ tools: { ch_send: 'allow', 'ch_*': 'deny', 'sh_*': 'ask', '*': 'allow' } }, { ask: ['ch_send', 'ch_read'] });
    const d = (n: string) => t.policy.decide(t.tools.get(n) as ToolDef);
    expect(d('ch_send')).toEqual({ policy: 'allow', rule: 'permissions.tools.ch_send' });
    expect(d('ch_post')).toEqual({ policy: 'deny', rule: 'permissions.tools."ch_*"' });
    expect(d('sh_run')).toEqual({ policy: 'ask', rule: 'permissions.tools."sh_*"', pinned: true });
    const plain = setup({}, { ask: ['ch_post'] });
    expect(plain.policy.decide(plain.tools.get('ch_post') as ToolDef)).toEqual({ policy: 'ask', rule: 'sideEffectTools of plugin chat' });
    expect(plain.policy.decide(plain.tools.get('ch_send') as ToolDef).policy).toBe('allow');
  });

  it('denies every side effect when no owner identity is configured (read-only mode)', async () => {
    const t = setup({ tools: { ch_send: 'allow' } }, { owner: false });
    expect((await t.call('ch_send')).content).toContain('denied by policy (no owner identity is configured');
    expect((await t.call('ch_read')).content).toBe('done');
  });

  it('states restrictions in advance for the system prompt', () => {
    const t = setup({ tools: { sh_run: 'deny' } }, { ask: ['ch_post'] });
    const text = t.policy.summary(t.tools.list()) ?? '';
    expect(text).toContain("Needs the owner's approval: ch_post");
    expect(text).toContain('Not allowed: sh_run');
    expect(setup().policy.summary(setup().tools.list())).toBeNull();
  });
});

describe('approvals', () => {
  it('blocks an ask call, asks the owner once, and runs exactly the approved input exactly once', async () => {
    const t = setup({}, { ask: ['ch_post'] });
    const first = await t.call('ch_post', { to: 'family', text: 'dinner' });
    expect(first.is_error).toBeUndefined();
    expect(first.content).toMatch(/^pending approval a1: ch_post needs the owner's approval and did not run/);
    const again = await t.call('ch_post', { text: 'dinner', to: 'family' }); // same input, other key order
    expect(again.content).toMatch(/^pending approval a1:/);
    expect(t.delivered).toEqual(['a1']);
    expect(t.ran).toEqual([]);

    expect(t.approvals.decide('a1', 'approve', 'telegram:telegram:42')).toEqual({ ok: true, state: 'approved' });
    expect(t.internal.at(-1)).toMatchObject({ type: 'approval.decided', level: 1, trigger: 'flush', correlation: 'a1' });
    expect(t.approvals.decide('a1', 'deny', 'x')).toMatchObject({ ok: false, state: 'approved' });

    expect((await t.call('ch_post', { to: 'family', text: 'other text' })).content).toMatch(/^pending approval a2:/);
    expect((await t.call('ch_post', { to: 'family', text: 'dinner' })).content).toBe('done');
    expect(t.approvals.get('a1')?.state).toBe('used');
    expect((await t.call('ch_post', { to: 'family', text: 'dinner' })).content).toMatch(/^pending approval a3:/);
    expect(t.ran).toEqual(['ch_post {"to":"family","text":"dinner"}']);
  });

  it('a grant allows the tool family for its time, audited, and can be revoked', async () => {
    const t = setup({ grantMaxMs: 3_600_000 }, { ask: ['ch_post', 'ch_send', 'sh_run'] });
    await t.call('ch_post', { n: 1 });
    expect(t.approvals.decide('a1', 'approve', 'owner', { grantMs: 10 * 3_600_000 })).toMatchObject({ ok: true, grant: { id: 'g1', family: 'chat', active: true } });
    expect(t.approvals.get('a1')?.grantId).toBe('g1');
    expect(t.internal.at(-1)?.text).toContain('allowed the tools of chat without asking');

    // The approved call uses its approval; others of the family use the grant; other plugins still ask.
    expect((await t.call('ch_post', { n: 1 })).content).toBe('done');
    expect(t.approvals.get('a1')?.state).toBe('used');
    expect((await t.call('ch_post', { n: 2 })).content).toBe('done');
    expect((await t.call('ch_send', { n: 3 })).content).toBe('done');
    expect((await t.call('sh_run', { c: 'ls' })).content).toMatch(/^pending approval/);
    const row = t.audit.list({ tool: 'ch_send' })[0];
    expect(row).toMatchObject({ kind: 'tool_call', outcome: 'ok', approvalId: 'a1' });
    expect(row?.policy).toContain('grant g1');

    // Capped by grantMaxMs, whatever was asked for.
    t.advance(3_600_001);
    expect((await t.call('ch_send', { n: 4 })).content).toMatch(/^pending approval a3/);
    expect(t.approvals.listGrants()[0]).toMatchObject({ id: 'g1', active: false });

    t.approvals.decide('a3', 'approve', 'owner', { grantMs: 60_000 });
    expect((await t.call('ch_send', { n: 5 })).content).toBe('done');
    expect(t.approvals.revokeGrant('g2', 'owner')).toMatchObject({ ok: true, grant: { active: false } });
    expect(t.approvals.revokeGrant('g2', 'owner')).toMatchObject({ ok: false });
    expect((await t.call('ch_send', { n: 6 })).content).toMatch(/^pending approval/);
    expect(t.audit.list({ kind: 'approval_grant' }).map((r) => r.outcome)).toEqual(['revoked', 'granted', 'granted']);
  });

  it('gives no grant when grants are off, or for a denial, and never overrides deny', async () => {
    const off = setup({ grantMaxMs: 0 }, { ask: ['ch_post'] });
    await off.call('ch_post', {});
    expect(off.approvals.decide('a1', 'approve', 'owner', { grantMs: 60_000 })).toEqual({ ok: true, state: 'approved' });
    expect(off.approvals.listGrants()).toEqual([]);

    const t = setup({ tools: { ch_send: 'deny' } }, { ask: ['ch_post'] });
    await t.call('ch_post', {});
    t.approvals.decide('a1', 'approve', 'owner', { grantMs: 60_000 });
    const denied = await t.call('ch_send', {});
    expect(denied.is_error).toBe(true);
    expect(denied.content).toContain('denied by policy');
  });

  it('expires requests and approvals after the TTL', async () => {
    const t = setup({ approvalTtlMs: 60_000 }, { ask: ['ch_post'] });
    await t.call('ch_post', { n: 1 });
    t.advance(61_000);
    expect(t.approvals.decide('a1', 'approve', 'owner')).toMatchObject({ ok: false, state: 'expired' });
    await t.call('ch_post', { n: 2 });
    t.approvals.decide('a2', 'approve', 'owner');
    t.advance(61_000);
    expect((await t.call('ch_post', { n: 2 })).content).toMatch(/^pending approval a3/);
    expect(t.approvals.list('expired').map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(t.audit.list({ kind: 'approval_expired' })).toHaveLength(2);
  });

  it('lets the model ask ahead of time with approval_request, with redacted summaries', async () => {
    const t = setup({ tools: { sh_run: 'ask', ch_read: 'deny' } });
    const r = await t.call('approval_request', { tool: 'sh_run', input: { cmd: 'login --password hunter2' }, reason: 'rotate the key' });
    expect(r.content).toMatch(/^approval a1 is pending/);
    const a = t.approvals.get('a1');
    expect(a?.summary).toBe('sh_run {"cmd":"login --password [REDACTED:PASSWORD]"}');
    expect(a?.reason).toBe('rotate the key');
    expect((await t.call('approval_request', { tool: 'ch_send', input: {}, reason: 'x' })).content).toBe('ch_send does not need approval; call it directly');
    expect((await t.call('approval_request', { tool: 'ch_read', input: {}, reason: 'x' })).is_error).toBe(true);
    t.approvals.decide('a1', 'approve', 'owner');
    expect((await t.call('sh_run', { cmd: 'login --password hunter2' })).content).toBe('done');
  });
});

describe('invariant I-8: side effects are auditable', () => {
  it('records every side-effecting or restricted call exactly once, and nothing runs without allow or a matching approval', async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('call' as const), tool: fc.constantFrom('ch_send', 'ch_post', 'ch_read', 'sh_run'), n: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ kind: fc.constant('decide' as const), id: fc.integer({ min: 1, max: 6 }), approve: fc.boolean() }),
      fc.record({ kind: fc.constant('wait' as const), ms: fc.constantFrom(1000, 40_000) }),
    );
    // Every run starts with request → approve → the same call again, so the approved path is always exercised.
    const seed = [
      { kind: 'call' as const, tool: 'ch_post', n: 0 },
      { kind: 'decide' as const, id: 1, approve: true },
      { kind: 'call' as const, tool: 'ch_post', n: 0 },
    ];
    let approvedRuns = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (random) => {
        const ops = [...seed, ...random];
        const t = setup({ tools: { sh_run: 'deny' }, approvalTtlMs: 60_000 }, { ask: ['ch_post'] });
        const calls: Array<{ callId: string; tool: string; ran: boolean }> = [];
        for (const o of ops) {
          if (o.kind === 'call') {
            const before = t.ran.length;
            const r = await t.call(o.tool, { n: o.n });
            calls.push({ callId: r.callId, tool: o.tool, ran: t.ran.length > before });
          } else if (o.kind === 'decide') {
            t.approvals.decide(`a${o.id}`, o.approve ? 'approve' : 'deny', 'owner');
          } else t.advance(o.ms);
        }
        const rows = t.audit.list({ limit: 1000 });
        for (const c of calls) {
          const mine = rows.filter((r) => r.callId === c.callId);
          if (c.tool === 'ch_read') {
            expect(mine).toEqual([]); // no side effect, allowed: nothing to audit
            continue;
          }
          expect(mine).toHaveLength(1);
          const row = mine[0];
          if (c.tool === 'sh_run') expect([row?.kind, row?.outcome, c.ran]).toEqual(['tool_blocked', 'denied', false]);
          if (c.tool === 'ch_send') expect([row?.kind, row?.outcome, c.ran]).toEqual(['tool_call', 'ok', true]);
          if (c.tool === 'ch_post') {
            // Runs only with an approval, which is then recorded on the call and used up.
            if (c.ran) {
              approvedRuns++;
              expect(row).toMatchObject({ kind: 'tool_call', outcome: 'ok' });
              expect(t.approvals.get(row?.approvalId as string)?.state).toBe('used');
            } else expect(row).toMatchObject({ kind: 'tool_blocked', outcome: 'pending_approval' });
          }
        }
        // Each approval ran at most one call.
        const used = rows.filter((r) => r.kind === 'tool_call' && r.approvalId);
        expect(new Set(used.map((r) => r.approvalId)).size).toBe(used.length);
        t.db.close();
      }),
      { numRuns: 60 },
    );
    expect(approvedRuns).toBeGreaterThanOrEqual(60);
  });
});
