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
  it('answers a console message end to end over HTTP and SSE', async () => {
    const provider = new ScriptedProvider([() => reply([toolCall('con_send', { text: '你好！' })]), () => textReply('done')]);
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
    expect((status['plugins'] as Array<{ id: string }>).map((p) => p.id)).toEqual(['console', 'cron']);

    // The system prefix: persona, runtime notes, then plugin environment prompts; kernel and plugin tools.
    const req = provider.calls[0];
    expect(req?.system.map((s) => s.id)).toEqual(['identity', 'runtime', 'operating', 'owner', 'env:console', 'env:cron']);
    expect(req?.tools.map((t) => t.name)).toEqual([
      'events_query', 'idle', 'self_status', 'con_send', 'schedule_create', 'schedule_delete', 'schedule_list', 'sleep_until',
    ]);
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

    const fast = new ScriptedProvider([() => reply([toolCall('con_send', { text: 'back' })]), () => textReply('done')]);
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
