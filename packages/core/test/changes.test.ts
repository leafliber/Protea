import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeRequestInfo, PluginStatus, SkillInfo } from '@protea/protocol';
import {
  AuditLog,
  Bus,
  ChangeRequestService,
  changeTools,
  mcpChangeAdapter,
  normalizeMcpServer,
  openDatabase,
  pluginChangeAdapter,
  silentLogger,
  skillChangeAdapter,
  type ChangeAdapter,
  type McpServerSettings,
} from '../src/index.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'protea-changes-'));

const SKILL = `---
name: demo-skill
description: A demo skill for tests.
---

# Demo

Do the demo.
`;

/** A service over real storage with the three real adapters, each on a small in-memory world. */
function setup(over: { adapters?: Partial<Record<'mcp' | 'skill' | 'plugin', ChangeAdapter>>; maxPending?: number } = {}) {
  const dir = tmp();
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const { db } = openDatabase(path.join(dir, 'protea.db'));
  const bus = new Bus();
  const clock = { t: Date.parse('2026-11-12T00:00:00Z'), now: () => clock.t };
  const audit = new AuditLog(db, clock);
  const events: Array<{ type: string; level: number; trigger: string; text: string; correlation?: string }> = [];
  const changed: ChangeRequestInfo[] = [];
  bus.on('change.changed', (c) => changed.push(c));
  const applied: string[] = [];

  const servers: Record<string, McpServerSettings> = { old: normalizeMcpServer('old', { command: 'uvx', args: ['old-server'] }) };
  const mcp = mcpChangeAdapter({
    servers: () => servers,
    put: async (id, entry) => {
      applied.push(`mcp.put ${id} ${entry === null ? 'null' : JSON.stringify(entry)}`);
      if (entry === null) delete servers[id];
      else servers[id] = normalizeMcpServer(id, entry);
    },
    setEnabled: async (id, enabled) => {
      applied.push(`mcp.enabled ${id} ${enabled}`);
      servers[id] = { ...(servers[id] as McpServerSettings), enabled };
    },
    describe: (id) => (servers[id]?.enabled ? 'running with 3 tools' : 'disabled'),
  });

  const skillsDir = path.join(dir, 'skills');
  const skillInfo = (name: string, origin: SkillInfo['origin'], enabled = true): SkillInfo =>
    ({ name, description: 'd', origin, enabled, listed: enabled, requiresTools: [], errors: [], warnings: [] }) as unknown as SkillInfo;
  const skills = new Map<string, SkillInfo>([['built', skillInfo('built', 'builtin')]]);
  const skill = skillChangeAdapter({
    get: (name) => skills.get(name),
    dirOf: (name) => (skills.get(name)?.origin === 'user' ? path.join(skillsDir, name) : undefined),
    install: (src) => {
      const name = /^name: (.+)$/m.exec(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'))?.[1] as string;
      fs.cpSync(src, path.join(skillsDir, name), { recursive: true });
      applied.push(`skill.install ${name}`);
      skills.set(name, skillInfo(name, 'user'));
      return skills.get(name) as SkillInfo;
    },
    uninstall: (name) => {
      applied.push(`skill.uninstall ${name}`);
      skills.delete(name);
    },
    setEnabled: (name, enabled) => {
      applied.push(`skill.enabled ${name} ${enabled}`);
      skills.set(name, skillInfo(name, skills.get(name)?.origin ?? 'user', enabled));
    },
    workspace,
  });

  const plugins = new Map<string, PluginStatus>();
  const configs: Record<string, Record<string, unknown>> = {};
  const status = (id: string, enabled: boolean): PluginStatus => ({ id, kind: 'tool', state: enabled ? 'running' : 'stopped', enabled, origin: 'data', tools: [] });
  const plugin = pluginChangeAdapter({
    get: (id) => plugins.get(id),
    dirOf: (id) => (plugins.has(id) ? path.join(dir, 'plugins', id) : undefined),
    install: async (src, o) => {
      const id = (JSON.parse(fs.readFileSync(path.join(src, 'protea.plugin.json'), 'utf8')) as { id: string }).id;
      fs.cpSync(src, path.join(dir, 'plugins', id), { recursive: true });
      applied.push(`plugin.install ${id} enable=${o.enable}`);
      plugins.set(id, status(id, o.enable));
      return plugins.get(id) as PluginStatus;
    },
    uninstall: async (id) => {
      applied.push(`plugin.uninstall ${id}`);
      plugins.delete(id);
    },
    enable: async (id) => {
      applied.push(`plugin.enable ${id}`);
      plugins.set(id, status(id, true));
      return plugins.get(id) as PluginStatus;
    },
    disable: async (id) => {
      applied.push(`plugin.disable ${id}`);
      plugins.set(id, status(id, false));
      return plugins.get(id) as PluginStatus;
    },
    config: (id) => configs[id] ?? {},
    setConfig: async (id, cfg) => {
      applied.push(`plugin.config ${id} ${JSON.stringify(cfg)}`);
      configs[id] = cfg;
    },
    workspace,
  });

  const secrets = new Set<string>(['HAVE_IT']);
  const changes = new ChangeRequestService({
    db,
    bus,
    audit,
    clock,
    log: silentLogger(),
    dir: path.join(dir, 'changes'),
    adapters: { mcp, skill, plugin, ...over.adapters },
    pushInternal: (e) => events.push(e as never),
    redact: (text) => text.replaceAll('hunter2', '[redacted]'),
    secretSet: (name) => secrets.has(name),
    ...(over.maxPending !== undefined ? { maxPending: over.maxPending } : {}),
  });
  return { dir, workspace, db, clock, audit, events, changed, applied, servers, skills, plugins, configs, changes };
}

const staged = (h: { dir: string }, id: string): string => path.join(h.dir, 'changes', id);

describe('change requests: the assistant proposes, a person decides', () => {
  it('files a request without changing anything, and applies it only when it is approved', async () => {
    const h = setup();
    const c = await h.changes.propose({ kind: 'mcp', action: 'add', target: 'fetch', input: { server: { command: 'uvx', args: ['mcp-server-fetch'] } }, reason: 'the owner asked for web pages', sessionId: 'main', batchId: 'b7' });
    expect(c).toMatchObject({ id: 'c1', kind: 'mcp', action: 'add', target: 'fetch', state: 'pending', summary: 'add MCP server fetch (stdio: uvx mcp-server-fetch)', reason: 'the owner asked for web pages', batchId: 'b7' });
    expect(h.applied).toEqual([]);
    expect(h.servers['fetch']).toBeUndefined();
    expect(h.events).toEqual([]);
    expect(h.changed.map((x) => x.state)).toEqual(['pending']);
    expect(h.audit.list({ kind: 'change_requested' })[0]).toMatchObject({ tool: 'mcp.add', approvalId: 'c1', batchId: 'b7' });

    const detail = h.changes.detail('c1');
    expect(detail?.before).toBeNull();
    expect(JSON.parse(detail?.after ?? '{}')).toMatchObject({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], enabled: true, trust: 'normal' });
    expect(detail?.warnings).toHaveLength(1);

    const r = await h.changes.decide('c1', 'approve', 'console:alice', 'go ahead');
    expect(r).toMatchObject({ ok: true, change: { state: 'applied', decidedBy: 'console:alice', note: 'go ahead', result: 'the MCP server fetch is running with 3 tools.' } });
    expect(h.applied).toEqual(['mcp.put fetch {"command":"uvx","args":["mcp-server-fetch"]}']);
    expect(h.events).toEqual([
      { type: 'change.decided', level: 1, trigger: 'flush', correlation: 'c1', text: 'Change request c1 (add MCP server fetch (stdio: uvx mcp-server-fetch)) was approved by the owner and applied: the MCP server fetch is running with 3 tools. The owner added: "go ahead"' },
    ]);
    expect(h.audit.list({ kind: 'change_decided' })[0]).toMatchObject({ approvalId: 'c1', outcome: 'applied' });
    // Decided once.
    expect(await h.changes.decide('c1', 'reject', 'console:alice')).toMatchObject({ ok: false, message: 'change request c1 is already applied' });
    expect(await h.changes.decide('c9', 'approve', 'console:alice')).toMatchObject({ ok: false, message: 'no change request c9' });
  });

  it('a rejection changes nothing and tells the assistant, with the reviewer’s note', async () => {
    const h = setup();
    await h.changes.propose({ kind: 'mcp', action: 'remove', target: 'old', input: {}, reason: 'unused' });
    expect(await h.changes.decide('c1', 'reject', 'api:admin', 'I still use it')).toMatchObject({ ok: true, change: { state: 'rejected', note: 'I still use it' } });
    expect(h.applied).toEqual([]);
    expect(h.servers['old']).toBeDefined();
    expect(h.events[0]?.text).toBe('Change request c1 (remove MCP server old) was rejected by the owner: "I still use it". Nothing changed. Do not propose it again unless the owner asks.');
  });

  it('applies nothing when the target changed after the proposal', async () => {
    const h = setup();
    await h.changes.propose({ kind: 'mcp', action: 'update', target: 'old', input: { server: { command: 'uvx', args: ['old-server', '--fast'] } }, reason: 'faster' });
    expect(h.changes.detail('c1')?.stale).toBeUndefined();
    // The owner edits the server in the console meanwhile.
    h.servers['old'] = normalizeMcpServer('old', { command: 'npx', args: ['other'] });
    expect(h.changes.detail('c1')?.stale).toBe(true);
    expect(await h.changes.decide('c1', 'approve', 'console:alice')).toMatchObject({ ok: true, change: { state: 'stale' } });
    expect(h.applied).toEqual([]);
    expect(h.events[0]?.text).toContain('had changed since it was proposed, so nothing was applied');
  });

  it('applies the bytes that were reviewed: staged files that changed on disk are refused', async () => {
    const h = setup();
    await h.changes.propose({ kind: 'skill', action: 'add', target: 'demo-skill', input: { content: SKILL, files: [{ path: 'notes/a.md', content: 'A' }] }, reason: 'demo' });
    expect(fs.readdirSync(staged(h, 'c1')).sort()).toEqual(['SKILL.md', 'notes']);
    expect(h.changes.detail('c1')).toMatchObject({ before: null, after: SKILL, files: [{ path: 'SKILL.md', size: SKILL.length }, { path: 'notes/a.md', size: 1 }] });
    expect(h.changes.readFile('c1', 'notes/a.md')).toEqual({ text: 'A' });
    expect(h.changes.readFile('c1', '../protea.db')).toEqual({ error: 'no staged file ../protea.db' });
    fs.writeFileSync(path.join(staged(h, 'c1'), 'SKILL.md'), `${SKILL}\nRun rm -rf.\n`);
    expect(await h.changes.decide('c1', 'approve', 'console:alice')).toMatchObject({ change: { state: 'failed', result: 'the staged files are not the ones that were proposed' } });
    expect(h.applied).toEqual([]);
    expect(fs.existsSync(staged(h, 'c1'))).toBe(false);
  });

  it('reports a change that was approved but could not be applied', async () => {
    const failing: ChangeAdapter = {
      prepare: ({ target }) => ({ target, summary: `add MCP server ${target}`, before: null, after: 'x', payload: {} }),
      snapshot: () => null,
      apply: () => {
        throw new Error('port 80 is taken, token hunter2');
      },
    };
    const h = setup({ adapters: { mcp: failing } });
    await h.changes.propose({ kind: 'mcp', action: 'add', target: 'x', input: {}, reason: 'r' });
    expect(await h.changes.decide('c1', 'approve', 'console:alice')).toMatchObject({ change: { state: 'failed', result: 'port 80 is taken, token [redacted]' } });
    expect(h.events[0]?.text).toBe('Change request c1 (add MCP server x) was approved by the owner but could not be applied: port 80 is taken, token [redacted]');
  });

  it('wants a reason, one request per target, and not too many at once; a request can be withdrawn and expires', async () => {
    const h = setup({ maxPending: 2 });
    const add = (target: string, reason = 'r') => h.changes.propose({ kind: 'mcp', action: 'add', target, input: { server: { command: 'x' } }, reason });
    await expect(add('a', '  ')).rejects.toThrow(/a reason is required/);
    await add('a');
    await expect(add('a')).rejects.toThrow(/change request c1 for this MCP server is still waiting for the owner; withdraw it first/);
    await add('b');
    await expect(add('c')).rejects.toThrow(/2 change requests are already waiting for the owner/);
    // Nothing of a refused proposal stays behind.
    expect(fs.readdirSync(path.join(h.dir, 'changes'))).toEqual([]);

    expect(await h.changes.withdraw('c1')).toMatchObject({ ok: true, change: { state: 'withdrawn', decidedBy: 'assistant' } });
    expect(await h.changes.withdraw('c1')).toMatchObject({ ok: false });
    await add('a');
    h.clock.t += 7 * 24 * 3600_000 + 1;
    expect(h.changes.list('pending')).toEqual([]);
    expect(h.changes.list().map((c) => [c.id, c.state])).toEqual([['c3', 'expired'], ['c2', 'expired'], ['c1', 'withdrawn']]);
    expect(h.events.map((e) => [e.type, e.level, e.trigger])).toEqual([['change.expired', 4, 'piggyback'], ['change.expired', 4, 'piggyback']]);
    expect(await h.changes.decide('c2', 'approve', 'console:alice')).toMatchObject({ ok: false, message: 'change request c2 is already expired' });
    expect(h.applied).toEqual([]);
  });

  it('gives the assistant tools that propose, look and withdraw, and none that decides', async () => {
    const h = setup();
    const tools = changeTools(h.changes);
    expect(tools.map((t) => t.name)).toEqual(['mcp_propose', 'skill_propose', 'plugin_propose', 'change_status', 'change_withdraw']);
    expect(tools.some((t) => t.flags?.sideEffect)).toBe(false);
    const ctx = { signal: new AbortController().signal, callId: 'u1', sessionId: 'main', batchId: 'b1', batchLevel: 1 as const };
    const run = async (name: string, input: unknown) => {
      const out = await (tools.find((t) => t.name === name) as unknown as { handler: (i: unknown, c: typeof ctx) => unknown }).handler(input, ctx);
      return typeof out === 'string' ? { text: out } : (out as { text: string; failed?: boolean });
    };
    const filed = await run('mcp_propose', { action: 'add', id: 'fetch', server: { command: 'uvx', args: ['mcp-server-fetch'] }, reason: 'web pages' });
    expect(filed.failed).toBeUndefined();
    expect(filed.text).toContain('Change request c1 is filed');
    expect(filed.text).toContain('Nothing has changed yet');
    expect(filed.text).toContain('can only be approved by hand');
    expect(h.changes.get('c1')).toMatchObject({ state: 'pending', sessionId: 'main', batchId: 'b1' });
    expect(await run('mcp_propose', { action: 'add', id: 'old', server: { command: 'x' }, reason: 'r' })).toMatchObject({ failed: true, text: 'not filed: the MCP server old already exists; propose an update instead' });
    expect((await run('change_status', {})).text).toMatch(/^c1 \[pending\] add MCP server fetch/);
    expect(await run('plugin_propose', { action: 'enable', reason: 'r' })).toMatchObject({ failed: true, text: 'not filed: id is required' });
    expect((await run('change_withdraw', { id: 'c1' })).text).toBe('change request c1 is withdrawn');
    expect(h.applied).toEqual([]);
  });
});

describe('what can be proposed', () => {
  it('MCP: a token is named, never written; the review says which secrets are missing', async () => {
    const h = setup();
    const propose = (id: string, server: Record<string, unknown>) => h.changes.propose({ kind: 'mcp', action: 'add', target: id, input: { server }, reason: 'r' });
    await expect(propose('gh', { url: 'https://example.com/mcp', auth: { type: 'bearer', token: 'ghp_abc123' } })).rejects.toThrow(/auth\.token must refer to a stored secret as \$\{secret:NAME\}/);
    await expect(propose('gh', { url: 'ftp://example.com' })).rejects.toThrow(/url must be http\(s\)/);
    await expect(propose('Bad_Id', { command: 'x' })).rejects.toThrow(/the id must match/);
    await expect(propose('gh', undefined as never)).rejects.toThrow(/server is required/);
    await propose('gh', { url: 'https://example.com/mcp', auth: { type: 'bearer', token: '${secret:GH_TOKEN}' }, headers: { 'x-key': '${secret:HAVE_IT}' }, trust: 'high' });
    const d = h.changes.detail('c1');
    expect(d?.secrets).toEqual([
      { name: 'GH_TOKEN', set: false },
      { name: 'HAVE_IT', set: true },
    ]);
    expect(d?.warnings).toEqual(['trust: high —— 它的工具不经询问就能运行。']);
    await expect(h.changes.propose({ kind: 'mcp', action: 'disable', target: 'nope', input: {}, reason: 'r' })).rejects.toThrow(/there is no MCP server nope; configured: old/);
    await expect(h.changes.propose({ kind: 'mcp', action: 'enable', target: 'old', input: {}, reason: 'r' })).rejects.toThrow(/already enabled/);
    await expect(h.changes.propose({ kind: 'mcp', action: 'configure', target: 'old', input: {}, reason: 'r' })).rejects.toThrow(/configure is not something that can be proposed for an MCP server/);
  });

  it('skills: from text or from the workspace, checked before they are filed, and installed as reviewed', async () => {
    const h = setup();
    const propose = (action: 'add' | 'update' | 'remove' | 'disable', name: string, input: Record<string, unknown> = {}) => h.changes.propose({ kind: 'skill', action, target: name, input, reason: 'r' });
    await expect(propose('add', 'other-name', { content: SKILL })).rejects.toThrow(/invalid skill/);
    await expect(propose('add', 'demo-skill', {})).rejects.toThrow(/give the whole SKILL\.md as content, or a workspace directory as from/);
    await expect(propose('add', 'demo-skill', { content: SKILL, files: [{ path: '../../etc/passwd', content: 'x' }] })).rejects.toThrow(/invalid file path/);
    await expect(propose('add', 'demo-skill', { from: '../skills' })).rejects.toThrow(/is not a directory in the workspace|outside the workspace/);
    await expect(propose('remove', 'built')).rejects.toThrow(/built is a builtin skill and cannot be removed; propose to disable it instead/);
    await expect(propose('add', 'built', { content: SKILL })).rejects.toThrow(/already exists \(builtin\)/);

    fs.mkdirSync(path.join(h.workspace, 'drafts', 'demo-skill', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'drafts', 'demo-skill', 'SKILL.md'), SKILL);
    fs.writeFileSync(path.join(h.workspace, 'drafts', 'demo-skill', 'scripts', 'run.sh'), 'echo hi\n');
    const c = await propose('add', 'demo-skill', { from: 'drafts/demo-skill' });
    expect(h.changes.detail(c.id)).toMatchObject({ source: 'workspace:drafts/demo-skill', files: [{ path: 'SKILL.md' }, { path: 'scripts/run.sh' }] });
    // What is installed is the staged copy: a later edit in the workspace does not get in.
    fs.writeFileSync(path.join(h.workspace, 'drafts', 'demo-skill', 'SKILL.md'), `${SKILL}\nextra`);
    expect(await h.changes.decide(c.id, 'approve', 'console:alice')).toMatchObject({ change: { state: 'applied', result: 'the skill demo-skill is installed and listed.' } });
    expect(fs.readFileSync(path.join(h.dir, 'skills', 'demo-skill', 'SKILL.md'), 'utf8')).toBe(SKILL);
    expect(h.applied).toEqual(['skill.install demo-skill']);

    // An update shows the old text against the new one.
    const next = SKILL.replace('Do the demo.', 'Do the demo twice.');
    const u = await propose('update', 'demo-skill', { content: next });
    expect(h.changes.detail(u.id)).toMatchObject({ before: SKILL, after: next });
    await propose('disable', 'built');
    expect(await h.changes.decide('c3', 'approve', 'console:alice')).toMatchObject({ change: { state: 'applied', result: 'the skill built is disabled.' } });
  });

  it('plugins: only from the workspace or an https source, with the manifest checked and the files staged', async () => {
    const h = setup();
    const propose = (action: 'add' | 'update' | 'remove' | 'configure', id: string, input: Record<string, unknown> = {}) => h.changes.propose({ kind: 'plugin', action, target: id, input, reason: 'r' });
    await expect(propose('add', '', { source: { git: 'ssh://git@example.com/x.git' } })).rejects.toThrow(/must be an https:\/\/ URL/);
    await expect(propose('add', '', { source: { git: 'file:///etc' } })).rejects.toThrow(/must be an https:\/\/ URL/);
    await expect(propose('add', '', { source: { path: '..' } })).rejects.toThrow(/outside the workspace|not a directory in the workspace/);
    await expect(propose('add', '', { source: { path: 'a', git: 'https://example.com/x' } })).rejects.toThrow(/exactly one of path, git or tarball/);
    await expect(propose('add', '', {})).rejects.toThrow(/source is required/);
    fs.mkdirSync(path.join(h.workspace, 'empty'));
    await expect(propose('add', '', { source: { path: 'empty' } })).rejects.toThrow(/invalid plugin/);
    await expect(propose('remove', 'nope')).rejects.toThrow(/there is no plugin nope/);

    const src = path.join(h.workspace, 'my-notes');
    fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
    const manifest = { id: 'my-notes', kind: 'tool', api: 1, version: '0.1.0', displayName: 'Notes', description: 'Keeps notes.', runtime: { exec: 'node', args: ['dist/main.js'] }, level: 4, tools: ['myn_add'] };
    fs.writeFileSync(path.join(src, 'protea.plugin.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(src, 'dist', 'main.js'), 'console.log("hi")\n');
    await expect(propose('add', 'other', { source: { path: 'my-notes' } })).rejects.toThrow(/the manifest says the plugin is my-notes, not other/);
    const c = await propose('add', '', { source: { path: 'my-notes' } });
    expect(c).toMatchObject({ target: 'my-notes', summary: 'install plugin my-notes 0.1.0 (tool, 1 tools)' });
    const d = h.changes.detail(c.id);
    expect(d).toMatchObject({ source: 'workspace:my-notes', before: null, files: [{ path: 'dist/main.js' }, { path: 'protea.plugin.json' }] });
    expect(d?.warnings[0]).toContain('安装插件等于让它的代码在守护进程旁边运行');
    expect(h.changes.readFile(c.id, 'dist/main.js')).toEqual({ text: 'console.log("hi")\n' });
    expect(await h.changes.decide(c.id, 'approve', 'console:alice')).toMatchObject({ change: { state: 'applied', result: 'the plugin my-notes is installed and running.' } });
    expect(h.applied).toEqual(['plugin.install my-notes enable=true']);

    // An update swaps the files and keeps the configuration and whether it was on.
    h.configs['my-notes'] = { dir: '/data/notes' };
    fs.writeFileSync(path.join(src, 'protea.plugin.json'), JSON.stringify({ ...manifest, version: '0.2.0' }, null, 2));
    const u = await propose('update', 'my-notes', { source: { path: 'my-notes' } });
    expect(await h.changes.decide(u.id, 'approve', 'console:alice')).toMatchObject({ change: { state: 'applied', result: 'the plugin my-notes is updated and running.' } });
    expect(h.applied.slice(1)).toEqual(['plugin.disable my-notes', 'plugin.uninstall my-notes', 'plugin.install my-notes enable=false', 'plugin.config my-notes {"dir":"/data/notes"}', 'plugin.enable my-notes']);

    const k = await propose('configure', 'my-notes', { config: { dir: '/data/other' } });
    expect(h.changes.detail(k.id)).toMatchObject({ before: '{\n  "dir": "/data/notes"\n}\n', after: '{\n  "dir": "/data/other"\n}\n' });
  });
});
