import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, silentLogger, textReply, toolCall } from '@protea/core';
import { startDaemon, type Daemon } from '../src/index.js';
import { stream } from '../../cli/src/client.js';

const dirs: string[] = [];
const running: Daemon[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-daemon-'));
  dirs.push(d);
  return d;
}
async function start(dataDir: string, provider: ScriptedProvider, env: NodeJS.ProcessEnv = {}): Promise<Daemon> {
  const d = await startDaemon({ dataDir, provider, listen: '127.0.0.1:0', logger: silentLogger(), env });
  running.push(d);
  return d;
}
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const auth = (d: Daemon) => ({ authorization: `Bearer ${d.adminToken}`, 'content-type': 'application/json' });

describe('daemon', () => {
  it('streams a web chat reply to clients that ask for drafts, and the sent reply closes it', async () => {
    const provider = new ScriptedProvider([
      async (_r, _i, { onToolInput }) => {
        onToolInput?.({ id: 'call_1', name: 'chat_send', json: '{"platform":"webchat","text":"你' });
        await new Promise((r) => setTimeout(r, 120));
        onToolInput?.({ id: 'call_1', name: 'chat_send', json: '好！"}' });
        return reply([toolCall('chat_send', { platform: 'webchat', text: '你好！' }, 'call_1')]);
      },
      () => textReply('done'),
    ]);
    const d = await start(tmp(), provider);
    const ac = new AbortController();
    const client = { url: d.url, token: d.adminToken };
    const withDrafts = stream(client, '/api/stream?drafts=1', ac.signal);
    const plain = stream(client, '/api/stream', ac.signal);
    expect((await withDrafts.next()).value?.event).toBe('hello');
    expect((await plain.next()).value?.event).toBe('hello');
    const res = await fetch(`${d.url}/api/chat/messages`, { method: 'POST', headers: auth(d), body: JSON.stringify({ text: '你好' }) });
    expect(res.status).toBe(201);

    const collect = async (it: typeof plain) => {
      const seen: Array<[string, Record<string, unknown>]> = [];
      for await (const m of it) {
        if (m.event === 'chat.draft' || m.event === 'output') seen.push([m.event, JSON.parse(m.data) as Record<string, unknown>]);
        if (m.event === 'batch.ended') break;
      }
      return seen;
    };
    const [live, whole] = await Promise.all([collect(withDrafts), collect(plain)]);
    ac.abort();
    expect(live.map(([e, x]) => (e === 'output' ? ['output', x['text'], x['callId']] : [x['state'], x['offset'], x['text']]))).toEqual([
      ['writing', 0, '你'],
      ['writing', 1, '好！'],
      ['output', '你好！', 'call_1'],
      ['discarded', undefined, undefined],
    ]);
    expect(whole.map(([e]) => e)).toEqual(['output']);
  });

  it('answers a console message end to end over HTTP and SSE', async () => {
    const provider = new ScriptedProvider([() => reply([toolCall('chat_send', { platform: 'webchat', text: '你好！' })]), () => textReply('done')]);
    const d = await start(tmp(), provider);

    expect((await fetch(`${d.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${d.url}/api/status`)).status).toBe(401);

    const ac = new AbortController();
    const it = stream({ url: d.url, token: d.adminToken }, '/api/stream', ac.signal);
    expect((await it.next()).value?.event).toBe('hello');
    const res = await fetch(`${d.url}/api/events`, { method: 'POST', headers: auth(d), body: JSON.stringify({ text: '你好' }) });
    expect(res.status).toBe(201);
    const pushed = (await res.json()) as { cursor: number; effectiveLevel: number };
    expect(pushed.effectiveLevel).toBe(1);

    const seen: string[] = [];
    const outputs: string[] = [];
    for await (const m of it) {
      seen.push(m.event);
      if (m.event === 'output') outputs.push((JSON.parse(m.data) as { text: string }).text);
      if (m.event === 'batch.ended') break;
    }
    ac.abort();
    expect(outputs).toEqual(['你好！']);
    expect(seen).toEqual(expect.arrayContaining(['event', 'batch.started', 'phase', 'settled', 'output', 'batch.ended']));

    const ev = (await (await fetch(`${d.url}/api/events/${pushed.cursor}`, { headers: auth(d) })).json()) as {
      event: { state: string; senderRole: string };
      delivery: { outcome: string };
    };
    expect(ev.event).toMatchObject({ state: 'delivered', senderRole: 'owner' });
    expect(ev.delivery.outcome).toBe('delivered');

    const status = (await (await fetch(`${d.url}/api/status`, { headers: auth(d) })).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ phase: 'idle', provider: { id: 'scripted', ready: true } });
    // In-process console, webchat and cron run; the out-of-process built-ins are discovered but off by default.
    expect((status['plugins'] as Array<{ id: string; state: string }>).map((p) => `${p.id}:${p.state}`)).toEqual([
      'console:running',
      'cron:running',
      'dida365:loaded',
      'filewatch:loaded',
      'imap:loaded',
      'qq:loaded',
      'rss:loaded',
      'shell:loaded',
      'telegram:loaded',
      'webchat:running',
      'webhook:loaded',
      'wechat:loaded',
    ]);

    // The system prefix: persona, runtime notes, plugin environment prompts, then the Skills catalog; kernel and plugin tools.
    const req = provider.calls[0];
    expect(req?.system.map((s) => s.id)).toEqual(['identity', 'runtime', 'operating', 'owner', 'env:console', 'env:cron', 'env:webchat', 'skills-catalog', 'memory-index']);
    expect(req?.system.find((s) => s.id === 'skills-catalog')?.text).toMatch(
      /- daily-brief: .*\(source: builtin\)\n- memory-dream: .*\(source: builtin\)\n- protea-self-ops: .*\(source: builtin\)$/,
    );
    expect(req?.system.at(-1)?.text).toMatch(/^<memory_index path="\/memories\/INDEX.md">\n# Memory index\n/);
    expect(req?.tools.map((t) => t.name)).toEqual([
      'approval_request', 'board', 'change_status', 'change_withdraw', 'events_promote', 'events_query', 'fork_cancel', 'fork_send', 'fork_spawn', 'fork_status', 'idle', 'mcp_propose', 'memory', 'memory_recent', 'memory_search', 'plugin_propose', 'self_status', 'skill_load', 'skill_propose', 'skill_read', 'view_image',
      'chat_send', 'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update', 'sleep_until',
    ]);
    expect(req?.toolSearch).toBeUndefined();
    expect(status['forks']).toEqual([]);
    expect(status).toMatchObject({ mcp: [], skills: { listed: 3, rejected: 0 }, tools: { total: 27, deferred: 0 }, memory: { files: 1 } });
    // The scripted provider reports no context window: 200k − 64k output − 10k margin.
    expect(status['context']).toMatchObject({ transcript: 'main.0001.jsonl', handoffs: 0, softTokens: 80_000, hardTokens: 126_000 });
    expect((status['budget'] as { enforced: boolean }).enforced).toBe(true);
  });

  it('ends the turn with the reply when chat_send says it is final, and not when the send fails', async () => {
    const provider = new ScriptedProvider([
      () => reply([toolCall('chat_send', { platform: 'webchat', text: 'here you go', final: true })]),
      // Second message: the first send names a platform that does not exist, so the turn goes on.
      () => reply([toolCall('chat_send', { platform: 'nowhere', text: 'lost', final: true })]),
      () => reply([toolCall('chat_send', { platform: 'webchat', text: 'second try' })]),
      () => textReply('done'),
    ]);
    const d = await start(tmp(), provider);
    const ended: Array<{ endReason: string; rounds: number }> = [];
    const outputs: string[] = [];
    d.bus.on('batch.ended', (b) => ended.push({ endReason: b.endReason, rounds: b.rounds }));
    d.bus.on('plugin.output', (o) => outputs.push(o.text));
    await fetch(`${d.url}/api/chat/messages`, { method: 'POST', headers: auth(d), body: JSON.stringify({ text: 'one' }) });
    await waitUntil(() => ended.length === 1);
    // One model call: no round after the reply.
    expect(ended[0]).toEqual({ endReason: 'ends_turn', rounds: 1 });
    expect(provider.calls).toHaveLength(1);
    expect(outputs).toEqual(['here you go']);

    await fetch(`${d.url}/api/chat/messages`, { method: 'POST', headers: auth(d), body: JSON.stringify({ text: 'two' }) });
    await waitUntil(() => ended.length === 2);
    expect(ended[1]).toEqual({ endReason: 'end_turn', rounds: 3 });
    expect(outputs).toEqual(['here you go', 'second try']);
  });

  it('runs a fork and serves it over the control API', async () => {
    const provider = new ScriptedProvider([
      (req) => {
        if (req.role === 'fork') return textReply('Found 2 open invoices.');
        const report = req.messages.some((m) => m.content.some((b) => b.type === 'text' && String(b['text']).includes('type="fork.completed"')));
        if (report) return reply([toolCall('chat_send', { platform: 'webchat', text: '2 open invoices' }), toolCall('idle', {})]);
        if (req.messages.length === 1) return reply([toolCall('fork_spawn', { goal: 'Count open invoices.' })]);
        return reply([toolCall('idle', {})]);
      },
    ]);
    const d = await start(tmp(), provider);
    const outputs: string[] = [];
    d.bus.on('plugin.output', (o) => outputs.push(o.text));
    await fetch(`${d.url}/api/events`, { method: 'POST', headers: auth(d), body: JSON.stringify({ text: 'how many invoices are open?' }) });
    await waitUntil(() => outputs.length > 0 && d.forks.list()[0]?.state === 'idle' && d.main.phase === 'idle');
    expect(outputs).toEqual(['2 open invoices']);

    const { forks } = (await (await fetch(`${d.url}/api/sessions/forks`, { headers: auth(d) })).json()) as { forks: Array<{ id: string; state: string; level: number }> };
    expect(forks).toHaveLength(1);
    const f = forks[0] as { id: string; state: string; level: number };
    // It reported and now waits for follow-up work.
    expect(f).toMatchObject({ state: 'idle', level: 1 });
    expect((f as { idleUntil?: string }).idleUntil).toBeDefined();
    const t = (await (await fetch(`${d.url}/api/sessions/${f.id}/transcript`, { headers: auth(d) })).json()) as {
      total: number;
      messages: Array<{ role: string }>;
    };
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((await fetch(`${d.url}/api/sessions/nope/transcript`, { headers: auth(d) })).status).toBe(404);
    expect(fs.existsSync(path.join(d.dataDir, 'sessions', 'forks', `${f.id}.checkpoint.json`))).toBe(true);
    const status = (await (await fetch(`${d.url}/api/status`, { headers: auth(d) })).json()) as { forks: unknown[] };
    expect(status.forks).toHaveLength(1);
    const { sessions } = (await (await fetch(`${d.url}/api/sessions`, { headers: auth(d) })).json()) as { sessions: Array<{ id: string; kind: string }> };
    expect(sessions.map((x) => x.kind)).toEqual(['main', 'fork']);
    const cancel = await fetch(`${d.url}/api/sessions/forks/${f.id}/cancel`, { method: 'POST', headers: auth(d) });
    expect(((await cancel.json()) as { state: string }).state).toBe('completed'); // an idle fork is released, not cancelled
    const again = await fetch(`${d.url}/api/sessions/forks/${f.id}/cancel`, { method: 'POST', headers: auth(d) });
    expect(((await again.json()) as { state: string }).state).toBe('completed'); // already ended: unchanged
  });

  it('rejects bad requests', async () => {
    const d = await start(tmp(), new ScriptedProvider([() => textReply('ok')]));
    const post = (body: unknown) => fetch(`${d.url}/api/events`, { method: 'POST', headers: auth(d), body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    expect((await post({ text: 'x', level: 9 })).status).toBe(400);
    expect((await post({ text: 'x', trigger: 'now' })).status).toBe(400);
    expect((await fetch(`${d.url}/api/events/999`, { headers: auth(d) })).status).toBe(404);
  });

  it('aborts the running batch on stop and resumes it on the next start', async () => {
    const dir = tmp();
    const slow = new ScriptedProvider([() => textReply('never')], 10_000);
    const d1 = await start(dir, slow, { PROTEA_DAEMON__SHUTDOWN__GRACE_MS: '50' });
    const r = await d1.console.receive('remember me', { senderKey: 'console:admin' });
    await waitUntil(() => slow.calls.length === 1);
    await d1.stop('test');
    running.splice(running.indexOf(d1), 1);
    expect(fs.existsSync(path.join(dir, 'protea.lock'))).toBe(false);

    const fast = new ScriptedProvider([() => reply([toolCall('chat_send', { platform: 'webchat', text: 'back' })]), () => textReply('done')]);
    const outputs: string[] = [];
    const d2 = await start(dir, fast);
    d2.bus.on('plugin.output', (o) => outputs.push(o.text));
    await waitUntil(() => outputs.length > 0);
    expect(outputs).toEqual(['back']);
    const text = JSON.stringify(fast.calls[0]?.messages);
    expect(text).toContain('remember me');
    expect(text).toContain('daemon.started');
    expect(d2.store.get(r.cursor as number)?.state).toBe('delivered');
  });

  it('refuses a second daemon on the same data directory', async () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'protea.lock'), `${process.ppid}\n`);
    await expect(start(dir, new ScriptedProvider([() => textReply('x')]))).rejects.toThrow(/another Protea daemon/);
  });
});
