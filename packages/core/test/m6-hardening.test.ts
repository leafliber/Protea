import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LogRing,
  OutboundLimiter,
  SecretStore,
  ToolDispatcher,
  ToolRegistry,
  cidrsContain,
  createLogger,
  isLoopback,
  parseCidr,
  silentLogger,
  treeRss,
  withLimits,
} from '../src/index.js';
import { makeHostHarness, writeFixture } from './plugin-fixtures.js';
import { tmpDir, waitFor } from './helpers.js';

const open: Array<ReturnType<typeof makeHostHarness>> = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

describe('control.allowCidrs matching', () => {
  it('parses IPv4/IPv6 ranges and matches socket addresses', () => {
    const list = ['10.0.0.0/8', '192.168.1.7', 'fd00::/8'].map(parseCidr);
    expect(cidrsContain(list, '10.200.3.4')).toBe(true);
    expect(cidrsContain(list, '::ffff:10.1.2.3')).toBe(true); // IPv4-mapped, as Node reports it
    expect(cidrsContain(list, '192.168.1.7')).toBe(true);
    expect(cidrsContain(list, '192.168.1.8')).toBe(false);
    expect(cidrsContain(list, 'fd12:3456::1')).toBe(true);
    expect(cidrsContain(list, '2001:db8::1')).toBe(false);
    expect(cidrsContain(list, 'garbage')).toBe(false);
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(() => parseCidr('10.0.0.0/33')).toThrow(/prefix length/);
    expect(() => parseCidr('example.com')).toThrow(/not an IP/);
    expect(cidrsContain([parseCidr('0.0.0.0/0')], '8.8.8.8')).toBe(true);
  });
});

describe('process limits', () => {
  it('applies the file-descriptor limit before exec', () => {
    const w = withLimits('/bin/sh', ['-c', 'ulimit -n'], { openFiles: 256 });
    const r = spawnSync(w.command, w.args, { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('256');
    // Node.js raises its soft limit to the hard limit at startup: the hard limit must be lowered too.
    const viaNode = withLimits(process.execPath, ['-e', "process.stdout.write(require('node:child_process').execSync('ulimit -n', { shell: '/bin/sh' }).toString())"], { openFiles: 256 });
    expect(spawnSync(viaNode.command, viaNode.args, { encoding: 'utf8' }).stdout.trim()).toBe('256');
    expect(withLimits('node', ['x'], { openFiles: null })).toEqual({ command: 'node', args: ['x'] });
  });

  it('measures the memory of a process tree', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 5 & sleep 5'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const rss = await treeRss([child.pid as number, 999_999_999]);
      expect(rss?.get(child.pid as number)).toBeGreaterThan(0);
      expect(rss?.has(999_999_999)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('restarts a plugin whose process tree goes over its memory limit', async () => {
    // A Node.js plugin uses far more than 32 MB, so the first sample is over the limit.
    const h = makeHostHarness({ settings: { fx: { enabled: true, config: {} } }, host: { limits: { memoryMb: 32, openFiles: 512, checkMs: 1000 } } });
    open.push(h);
    writeFixture(h.pluginsDir);
    await h.rescan();
    await h.host.startAll();
    await waitFor(() => /memory limit exceeded/.test(h.host.get('fx')?.error ?? ''), 15_000, 'memory restart');
    expect(h.states).toContain('fx:crashed');
  }, 30_000);
});

describe('outbound rate limit', () => {
  it('allows N connector calls per sliding minute and records each burst once', async () => {
    let now = 1_000_000;
    const notices: string[] = [];
    const limiter = new OutboundLimiter({
      perMinute: () => 3,
      isConnector: (owner) => owner === 'telegram',
      clock: { now: () => now },
      log: silentLogger(),
      pushInternal: (e) => notices.push(e.type),
    });
    const send = { owner: 'telegram', name: 'tg_send' };
    expect([limiter.check(send), limiter.check(send), limiter.check(send)]).toEqual([null, null, null]);
    expect(limiter.check(send)).toMatch(/already made 3 outbound calls/);
    expect(limiter.check(send)).toMatch(/Wait about 60s/);
    expect(notices).toEqual(['outbound.rate_limited']);
    // Read-only tools and non-connectors are not counted.
    expect(limiter.check({ ...send, flags: { readOnly: true } })).toBeNull();
    expect(limiter.check({ owner: 'rss', name: 'rss_items' })).toBeNull();
    now += 60_001;
    expect(limiter.check(send)).toBeNull();

    // In the dispatcher the refusal is a tool error and the tool never runs.
    const tools = new ToolRegistry();
    let ran = 0;
    tools.register('telegram', { name: 'tg_send', description: 'send', inputSchema: { type: 'object' }, handler: () => (ran++, 'sent') });
    const d = new ToolDispatcher(tools, silentLogger());
    d.setLimiter(() => 'nope, too many');
    const r = await d.runAll([{ type: 'tool_use', id: 'u1', name: 'tg_send', input: {} }], { signal: new AbortController().signal, sessionId: 'main', batchId: 'b', batchLevel: 1 });
    expect(r.results[0]).toMatchObject({ is_error: true, content: 'not run: nope, too many' });
    expect(ran).toBe(0);
  });
});

describe('secrets in logs', () => {
  it('every log destination sees redacted lines, also for JSON-escaped values', () => {
    const dir = tmpDir();
    const secrets = new SecretStore(path.join(dir, 'secrets'), {});
    secrets.set('TELEGRAM_BOT_TOKEN', '123456:abcdefSECRET');
    secrets.set('ODD_SECRET', 'pa"ss\\word42');
    const ring = new LogRing();
    const log = createLogger({ level: 'silent', file: path.join(dir, 'log.jsonl'), sinks: [ring], redact: (l) => secrets.redactJsonText(l) });
    log.info({ url: 'https://api.telegram.org/bot123456:abcdefSECRET/getUpdates' }, 'polling');
    log.warn({ err: 'auth failed for pa"ss\\word42' }, 'odd value pa"ss\\word42 in the message');
    const lines = ring.query({}, 10).map((e) => JSON.stringify(e));
    expect(lines.join('\n')).not.toContain('abcdefSECRET');
    expect(lines.join('\n')).not.toContain('word42');
    expect(lines.join('\n')).toContain('[REDACTED:TELEGRAM_BOT_TOKEN]');
    expect(lines.join('\n')).toContain('[REDACTED:ODD_SECRET]');
    // A secret written after the logger started is redacted as well (the cache is invalidated).
    secrets.set('LATE_TOKEN', 'late-value-999');
    log.info('late-value-999 appeared');
    expect(JSON.stringify(ring.query({}, 1))).toContain('[REDACTED:LATE_TOKEN]');
  });
});

describe('entrypoint migration', () => {
  it('snapshots an older database before migrating and refuses a newer one', async () => {
    const { MIGRATIONS, LATEST_SCHEMA, migrate, prepareDatabase, schemaVersion } = await import('../src/index.js');
    const Database = (await import('better-sqlite3')).default;
    const dir = tmpDir();
    const file = path.join(dir, 'protea.db');
    const old = new Database(file);
    migrate(old, MIGRATIONS.slice(0, 2));
    old.close();
    const r = await prepareDatabase(file, path.join(dir, 'backups'));
    expect(r).toMatchObject({ from: 2, to: LATEST_SCHEMA });
    expect(r.snapshot && fs.existsSync(r.snapshot)).toBe(true);
    const snap = new Database(r.snapshot as string, { readonly: true });
    expect(schemaVersion(snap)).toBe(2);
    snap.close();
    // Current: nothing to do, no snapshot.
    expect(await prepareDatabase(file, path.join(dir, 'backups'))).toEqual({ from: LATEST_SCHEMA, to: LATEST_SCHEMA, applied: [] });
    // Newer than this build: refused, file untouched.
    const db = new Database(file);
    db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(LATEST_SCHEMA + 1, 'future', new Date().toISOString());
    db.close();
    await expect(prepareDatabase(file, path.join(dir, 'backups'))).rejects.toThrow(/newer than this build/);
  });
});

describe('git backup', () => {
  it('pushes config, persona, memory and skills, one commit per change, never the database or secrets', async () => {
    const { gitBackup } = await import('../src/index.js');
    const root = tmpDir();
    const remote = path.join(root, 'remote.git');
    spawnSync('git', ['init', '--quiet', '--bare', remote]);
    const data = path.join(root, 'data');
    for (const d of ['persona', 'memory/notes', 'skills/demo', 'secrets']) fs.mkdirSync(path.join(data, d), { recursive: true });
    fs.writeFileSync(path.join(data, 'config.yaml'), 'daemon: {}\n');
    fs.writeFileSync(path.join(data, 'persona', 'SOUL.md'), '# Soul\n');
    fs.writeFileSync(path.join(data, 'memory', 'notes', 'a.md'), 'first\n');
    fs.writeFileSync(path.join(data, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
    fs.writeFileSync(path.join(data, 'secrets', 'TOKEN'), 'never-pushed-123\n');
    fs.writeFileSync(path.join(data, 'protea.db'), 'not a real database');
    const url = `file://${remote}`;

    const first = await gitBackup({ dataDir: data, url });
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitBackup({ dataDir: data, url })).toEqual({ commit: null, changed: 0 });
    fs.writeFileSync(path.join(data, 'memory', 'notes', 'a.md'), 'second\n');
    const second = await gitBackup({ dataDir: data, url });
    expect(second).toMatchObject({ changed: 1 });

    const files = spawnSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
    expect(files).toEqual(['config.yaml', 'memory/notes/a.md', 'persona/SOUL.md', 'skills/demo/SKILL.md']);
    expect(spawnSync('git', ['--git-dir', remote, 'show', 'HEAD:memory/notes/a.md'], { encoding: 'utf8' }).stdout).toBe('second\n');
    expect(spawnSync('git', ['--git-dir', remote, 'log', '--format=%an <%ae>'], { encoding: 'utf8' }).stdout.trim().split('\n')).toEqual(['Protea <protea@localhost>', 'Protea <protea@localhost>']);
  });
});

describe('echo provider usage', () => {
  it('reports estimated tokens, so handoff happens offline as with a real model', async () => {
    const { EchoProvider } = await import('../src/index.js');
    const p = new EchoProvider();
    const big = 'x'.repeat(40_000);
    const r = await p.generate(
      { role: 'main', system: [{ id: 's', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text: big }] }], tools: [], effort: 'low' },
      { signal: new AbortController().signal },
    );
    expect(r.usage.inputTokens).toBeGreaterThan(5000);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
  });
});
