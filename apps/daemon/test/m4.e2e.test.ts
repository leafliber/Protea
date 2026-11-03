import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderError,
  ScriptedProvider,
  estimateRequestTokens,
  reply,
  silentLogger,
  toolCall,
  transcriptSeq,
  type ProviderRequest,
  type ProviderResponse,
} from '@protea/core';
import type { ContentBlock } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A data directory whose config makes batches quick and handoffs frequent. */
function dataDir(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-m4-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    `scheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n    2: { debounceMs: 20, maxWaitMs: 0 }\n${yaml}`,
  );
  return dir;
}

async function start(dir: string, provider: ScriptedProvider, env: NodeJS.ProcessEnv = {}): Promise<Daemon> {
  const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', logger: silentLogger(), env });
  running.push(d);
  return d;
}

/** Report realistic input usage, as a real provider would (the handoff estimate starts from it). */
function sized(res: ProviderResponse, req: ProviderRequest): ProviderResponse {
  return { ...res, usage: { ...res.usage, inputTokens: estimateRequestTokens(req) } };
}

function texts(req: ProviderRequest): string[] {
  return req.messages.flatMap((m) =>
    m.content.map((b) => (b.type === 'text' ? String(b['text']) : b.type === 'tool_result' ? String(b['content']) : '')),
  );
}

function lastUserText(req: ProviderRequest): string {
  const m = req.messages.at(-1);
  return m?.role === 'user' ? m.content.map((b) => (b.type === 'text' ? String(b['text']) : b.type === 'tool_result' ? String(b['content']) : '')).join('\n') : '';
}

const COMMITMENT = '我们说好的三件事：买咖啡豆、预约牙医、周五交报告。';

/**
 * Deterministic notes model: keeps the "Commitments" of the previous notes and adds every
 * line of the dropped conversation that records an agreement (说好). Stands in for the
 * cheap model so the test checks the mechanism, not a model's summarising skill.
 */
function notesModel(req: ProviderRequest): ProviderResponse {
  const input = texts(req).join('\n');
  const lines = new Set<string>();
  for (const l of input.split('\n')) {
    const m = /(我们说好的[^<]*)/.exec(l);
    if (m) lines.add(`- ${(m[1] as string).trim()}`);
  }
  return sized(reply([{ type: 'text', text: `## Commitments\n${[...lines].join('\n') || '- (none)'}` }]), req);
}

describe('M4 acceptance', () => {
  it('replays 2000 events through at least three handoffs and still recalls what was agreed', async () => {
    const outputs: string[] = [];
    const provider = new ScriptedProvider([
      (req) => {
        if (req.role === 'cheap') return notesModel(req);
        const last = lastUserText(req);
        if (last.includes('三件事是什么')) {
          // Find the newest handoff notice and read the notes it points to.
          const notice = texts(req).filter((t) => t.includes('type="session.handoff"')).at(-1) ?? '';
          const notes = /\/memories\/handoff\/[^ ;]+\.md/.exec(notice)?.[0];
          return sized(reply([toolCall('memory', { command: 'view', path: notes ?? '/memories/INDEX.md' })]), req);
        }
        if (last.includes("Here's the content of /memories/handoff/")) {
          const agreed = /我们说好的三件事：[^\n]*/.exec(last)?.[0] ?? '不记得了';
          return sized(reply([toolCall('con_send', { text: agreed }), toolCall('idle', {})]), req);
        }
        return sized(reply([toolCall('idle', {})]), req);
      },
    ]);
    const d = await start(dataDir('context:\n  handoff: { softTokens: 12000, hardTokens: 40000 }\n'), provider);
    d.bus.on('plugin.output', (o) => outputs.push(o.text));

    const filler = (i: number): string => `event ${i}: the build pipeline reported status green for commit ${i.toString(16)}; nothing needs attention right now, just keeping a log line.`;
    let sent = 0;
    const burst = async (items: string[]): Promise<void> => {
      const before = provider.calls.length;
      for (const t of items) d.console.receive(t, { senderKey: 'console:admin' });
      sent += items.length;
      await waitUntil(() => provider.calls.length > before && !d.main.busy && d.store.pendingCounts()[1] === 0, `burst ending at ${sent}`);
    };
    await burst([COMMITMENT]);
    for (let i = 1; sent < 2000; i += 20) await burst(Array.from({ length: Math.min(20, 2000 - sent) }, (_, k) => filler(i + k)));
    expect(sent).toBe(2000);

    const handoffs = transcriptSeq(d.transcript.file) - 1;
    expect(handoffs).toBeGreaterThanOrEqual(3);
    // The agreement left the conversation long ago; only the notes chain still carries it.
    const lastMain = provider.calls.filter((c) => c.role === 'main').at(-1) as ProviderRequest;
    expect(texts(lastMain).some((t) => t.includes(COMMITMENT) && !t.includes('/memories/handoff/'))).toBe(false);

    await burst(['我们昨天说好的三件事是什么？']);
    await waitUntil(() => outputs.length > 0, 'the answer');
    expect(outputs.at(-1)).toContain('买咖啡豆');
    expect(outputs.at(-1)).toContain('预约牙医');
    expect(outputs.at(-1)).toContain('周五交报告');

    // Bookkeeping: a short list of recent handoffs in INDEX.md, the old transcripts sealed, the pointer moved.
    const index = d.memory.readText('INDEX.md') ?? '';
    expect(index).toMatch(/## Recent handoffs\n\n(- \/memories\/handoff\/\S+\.md\n){5}$/);
    const sessions = path.join(d.dataDir, 'sessions');
    expect(fs.readFileSync(path.join(sessions, 'main.current'), 'utf8').trim()).toBe(path.basename(d.transcript.file));
    expect(fs.readFileSync(path.join(sessions, 'main.0001.jsonl'), 'utf8')).toMatch(/"kind":"handoff","to":"main.0002.jsonl"/);
    // Every request after a handoff opens with the session.handoff notice and stays under the hard limit.
    expect(d.status().context.handoffs).toBe(transcriptSeq(d.transcript.file) - 1);
    for (const c of provider.calls.filter((r) => r.role === 'main')) expect(estimateRequestTokens(c)).toBeLessThan(40_000);
    const firstAfter = d.transcript.messages[0]?.content[0] as ContentBlock;
    expect(String(firstAfter['text'])).toContain('type="session.handoff"');
  }, 120_000);

  it('applies an edited SOUL.md at the next model request, invalidating the cache once', async () => {
    let n = 0;
    const provider = new ScriptedProvider([
      () => reply([{ type: 'thinking', thinking: `thought ${++n}`, signature: `sig${n}` }, toolCall('idle', {}, `toolu_soul_${n}`)]),
    ]);
    const d = await start(dataDir(''), provider);
    const turn = async (text: string): Promise<void> => {
      const before = provider.calls.length;
      d.console.receive(text, { senderKey: 'console:admin' });
      await waitUntil(() => provider.calls.length > before && !d.main.busy, text);
    };
    for (const t of ['one', 'two', 'three']) await turn(t);
    fs.appendFileSync(path.join(d.dataDir, 'persona', 'SOUL.md'), '\n\nYou sign every message with a sprig of protea.');
    await waitUntil(() => d.persona.current.soul?.includes('sprig of protea') === true, 'persona reload');
    for (const t of ['four', 'five', 'six']) await turn(t);

    const calls = provider.calls;
    expect(calls).toHaveLength(6);
    const identity = (r: ProviderRequest): string => r.system.find((s) => s.id === 'identity')?.text ?? '';
    expect(calls.slice(0, 3).every((r) => !identity(r).includes('sprig'))).toBe(true);
    expect(calls.slice(3).every((r) => identity(r).includes('sprig'))).toBe(true);

    // Simulated prompt cache: a request hits when the previous request (tools, system, messages) is its prefix.
    const flat = (r: ProviderRequest): string[] => [JSON.stringify(r.tools), JSON.stringify(r.system), ...r.messages.flatMap((m) => m.content.map((b) => JSON.stringify([m.role, b])))];
    const misses = calls.slice(1).filter((r, i) => {
      const prev = flat(calls[i] as ProviderRequest);
      const cur = flat(r);
      return prev.some((x, k) => cur[k] !== x);
    });
    expect(misses).toEqual([calls[3]]);
    // Thinking from before the change is no longer sent; thinking produced after it is.
    const thoughts = (r: ProviderRequest): string[] => r.messages.flatMap((m) => m.content.filter((b) => b.type === 'thinking').map((b) => String(b['thinking'])));
    expect(thoughts(calls[2] as ProviderRequest)).toEqual(['thought 1', 'thought 2']);
    expect(thoughts(calls[3] as ProviderRequest)).toEqual([]);
    expect(thoughts(calls[5] as ProviderRequest)).toEqual(['thought 4', 'thought 5']);
  }, 60_000);

  it('keeps every secret value out of model requests (invariant I-7)', async () => {
    const secret = 'tok-4f9a1c7e22b8d01';
    const dir = dataDir('context:\n  handoff: { softTokens: 2500, hardTokens: 40000 }\n');
    // A persona that mentions the secret (system prompt), set up before the first start.
    fs.mkdirSync(path.join(dir, 'persona'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'persona', 'SOUL.md'), 'You are Protea.');
    fs.writeFileSync(path.join(dir, 'persona', 'USER.md'), `The owner's shop token is ${secret}.`);
    const provider = new ScriptedProvider([
      (req) => {
        if (req.role === 'cheap') return sized(reply([{ type: 'text', text: `notes: ${texts(req).join(' ').slice(0, 200)}` }]), req);
        const last = lastUserText(req);
        if (last.includes('read the note')) return sized(reply([toolCall('memory', { command: 'view', path: '/memories/notes/shop.md' })]), req);
        return sized(reply([toolCall('idle', {})]), req);
      },
    ]);
    const d = await start(dir, provider, { PROTEA_SECRET_SHOP_TOKEN: secret });
    d.memory.writeText('notes/shop.md', `Shop API token: ${secret}`);
    const turn = async (text: string): Promise<void> => {
      const before = provider.calls.length;
      d.console.receive(text, { senderKey: 'console:admin' });
      await waitUntil(() => provider.calls.length > before && !d.main.busy, text);
    };
    await turn(`here is the token ${secret}, keep it safe`);
    await turn('please read the note');
    for (let i = 0; i < 30; i++) await turn(`filler ${i} `.repeat(40));
    expect(transcriptSeq(d.transcript.file)).toBeGreaterThan(1); // a handoff ran, so the notes request was scanned too

    const bodies = provider.calls.map((c) => JSON.stringify(c));
    expect(bodies.some((b) => b.includes(secret))).toBe(false);
    expect(provider.calls.some((c) => c.role === 'cheap')).toBe(true);
    // USER.md carries the token into every main-session system prompt, redacted each time.
    const main = provider.calls.filter((c) => c.role === 'main');
    expect(main.every((c) => c.system.some((s) => s.text.includes('[REDACTED:SHOP_TOKEN]')))).toBe(true);
    expect(main.some((c) => texts(c).some((t) => t.includes('Shop API token: [REDACTED:SHOP_TOKEN]')))).toBe(true);
    const redacted = d.store.query({ type: 'secret.redacted', order: 'asc', limit: 10 });
    expect(redacted).toHaveLength(1);
    expect(redacted[0]?.text).toContain('SHOP_TOKEN');
    expect(redacted[0]?.text).not.toContain(secret);
  }, 60_000);

  it('hands off on request, serves memory over the control API and audits writes', async () => {
    const provider = new ScriptedProvider([(req) => (req.role === 'cheap' ? sized(reply([{ type: 'text', text: '## In progress\n- nothing' }]), req) : reply([toolCall('idle', {})]))]);
    const d = await start(dataDir(''), provider);
    const api = async <T>(method: string, p: string, body?: string): Promise<{ status: number; json: T }> => {
      const res = await fetch(`${d.url}${p}`, { method, headers: { authorization: `Bearer ${d.adminToken}` }, ...(body !== undefined ? { body } : {}) });
      return { status: res.status, json: (await res.json()) as T };
    };
    for (const t of ['alpha', 'beta']) {
      const before = provider.calls.length;
      d.console.receive(t, { senderKey: 'console:admin' });
      await waitUntil(() => provider.calls.length > before && !d.main.busy, t);
    }
    const h = await api<{ handedOff: boolean; transcript: string; notes: string; kept: number }>('POST', '/api/sessions/main/handoff', '{}');
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ handedOff: true, transcript: 'main.0002.jsonl' });
    expect(d.transcript.needsResume()).toBe(false);
    const notes = await api<{ text: string }>('GET', `/api/memory/file?path=${encodeURIComponent(h.json.notes)}`);
    expect(notes.json.text).toMatch(/^# Handoff .*\n\nConversation main\.0001\.jsonl: \d+ message\(s\) handed off, \d+ kept \(requested through the control API\)\.\n\n## In progress\n- nothing\n$/);

    expect((await api('PUT', '/api/memory/file?path=notes/plan.md', 'Ship M4 on Friday.')).status).toBe(200);
    expect((await api('PUT', '/api/memory/file?path=../escape.md', 'x')).status).toBe(400);
    const search = await api<{ hits: Array<{ path: string }> }>('GET', '/api/memory/search?q=Friday');
    expect(search.json.hits.map((x) => x.path)).toEqual(['/memories/notes/plan.md']);
    const tree = await api<{ files: Array<{ path: string }> }>('GET', '/api/memory/tree');
    expect(tree.json.files.map((f) => f.path)).toEqual(expect.arrayContaining(['INDEX.md', 'notes/plan.md', h.json.notes]));
    expect(d.audit.list({ kind: 'memory_write' }).map((r) => r.summary)).toEqual(['/memories/notes/plan.md']);
    // The next batch starts in the new transcript, behind the handoff notice.
    const before = provider.calls.length;
    d.console.receive('gamma', { senderKey: 'console:admin' });
    await waitUntil(() => provider.calls.length > before && !d.main.busy, 'gamma');
    expect(texts(provider.calls.at(-1) as ProviderRequest)[0]).toContain('type="session.handoff"');
  }, 60_000);

  it('loads persona hooks: custom rounds, segments and handoff, reloaded on change', async () => {
    const dir = dataDir('context:\n  handoff: { softTokens: 1500, hardTokens: 40000 }\n');
    fs.mkdirSync(path.join(dir, 'persona'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'persona', 'SOUL.md'), 'You are Protea.');
    fs.writeFileSync(
      path.join(dir, 'persona', 'hooks.mjs'),
      `export default {
  rounds: () => ({ soft: 1, hard: 2 }),
  systemSegments: ({ defaults }) => [...defaults, { id: 'hook', text: 'hook segment v1' }],
  onHandoff: (snap) => ({ tail: snap.messages.slice(-1), notes: 'custom notes from the hook' }),
};\n`,
    );
    const provider = new ScriptedProvider([(req) => sized(reply([toolCall('events_query', { limit: 1 })]), req)]);
    const d = await start(dir, provider);
    expect(d.status().persona).toEqual({ hooks: true });
    const before = provider.calls.length;
    d.console.receive('x '.repeat(800), { senderKey: 'console:admin' });
    await waitUntil(() => !d.main.busy && provider.calls.length >= before + 2, 'a batch cut at two rounds');
    await waitUntil(() => !d.main.busy, 'idle');
    expect(provider.calls.length - before).toBe(2); // hard limit of 2 rounds from the hook
    expect(provider.calls.at(-1)?.system.at(-1)).toEqual({ id: 'hook', text: 'hook segment v1' });
    expect(transcriptSeq(d.transcript.file)).toBe(2);
    const notesPath = /notes":"([^"]+)"/.exec(fs.readFileSync(d.transcript.file, 'utf8'))?.[1] as string;
    expect(d.memory.readText(notesPath)).toContain('custom notes from the hook');

    fs.writeFileSync(path.join(dir, 'persona', 'hooks.mjs'), `export default { systemSegments: ({ defaults }) => [...defaults, { id: 'hook', text: 'hook segment v2' }] };\n`);
    // mtime resolution: make sure the reload sees a new file version.
    fs.utimesSync(path.join(dir, 'persona', 'hooks.mjs'), new Date(), new Date(Date.now() + 2_000));
    await waitUntil(() => d.persona.hooks?.rounds === undefined, 'hooks reload');
    const b2 = provider.calls.length;
    d.console.receive('again', { senderKey: 'console:admin' });
    await waitUntil(() => provider.calls.length > b2 && !d.main.busy, 'again');
    expect(provider.calls.slice(b2).find((c) => c.role === 'main')?.system.at(-1)).toEqual({ id: 'hook', text: 'hook segment v2' });
  }, 60_000);

  it('hands off and retries when the provider refuses the input as too long', async () => {
    let refused = false;
    const provider = new ScriptedProvider([
      (req) => {
        if (req.role === 'cheap') return sized(reply([{ type: 'text', text: '## In progress\n- three messages' }]), req);
        if (!refused && texts(req).some((t) => t.includes('third'))) {
          refused = true;
          return new ProviderError('overflow', 'input too long: prompt is too long');
        }
        return reply([toolCall('idle', {})]);
      },
    ]);
    const d = await start(dataDir(''), provider);
    for (const t of ['first', 'second', 'third']) {
      const before = provider.calls.length;
      d.console.receive(t, { senderKey: 'console:admin' });
      await waitUntil(() => provider.calls.length > before && !d.main.busy, t);
    }
    expect(refused).toBe(true);
    expect(transcriptSeq(d.transcript.file)).toBe(2);
    const retried = provider.calls.filter((c) => c.role === 'main').at(-1) as ProviderRequest;
    expect(texts(retried)[0]).toContain('type="session.handoff"');
    expect(texts(retried).some((t) => t.includes('third'))).toBe(true);
    expect(texts(retried).some((t) => t.includes('first'))).toBe(false);
    expect(d.db.prepare("SELECT end_reason AS r FROM batches ORDER BY started_at DESC LIMIT 1").get()).toEqual({ r: 'ends_turn' });
  }, 60_000);

  it('stops handing off in a loop when the prefix alone is over the limit', async () => {
    const provider = new ScriptedProvider([(req) => sized(reply([toolCall('idle', {})]), req)]);
    const d = await start(dataDir('context:\n  handoff: { softTokens: 200, hardTokens: 300 }\n'), provider);
    for (const t of ['one', 'two', 'three']) {
      d.console.receive(t, { senderKey: 'console:admin' });
      await new Promise((r) => setTimeout(r, 150));
      await waitUntil(() => !d.main.busy, t);
    }
    expect(provider.calls.filter((c) => c.role === 'main')).toHaveLength(0);
    const overflow = d.store.query({ type: 'context.overflow', order: 'asc', limit: 10 });
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.effLevel).toBe(0);
    expect(d.db.prepare("SELECT COUNT(*) AS n FROM batches WHERE end_reason = 'context_overflow'").get()).toMatchObject({ n: expect.any(Number) });
  }, 60_000);
});
