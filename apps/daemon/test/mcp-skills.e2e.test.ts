import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, setConfigValue, silentLogger, textReply, toolCall, type ProviderRequest } from '@protea/core';
import type { McpServerStatus, SkillInfo } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';
import { FIXTURE, fakeAuthServer, httpMcpServer } from '../../../packages/core/test/mcp-fixtures.js';

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function lastUser(req: ProviderRequest): string {
  const m = req.messages.at(-1);
  if (m?.role !== 'user') return '';
  return m.content.map((b) => (b.type === 'text' ? String(b['text']) : b.type === 'tool_result' ? String(b['content']) : '')).join('\n');
}

/** The model: uses an MCP tool or a skill when asked to, otherwise ends the turn. */
const provider = new ScriptedProvider([
  (req) => {
    const last = lastUser(req);
    if (last.includes('use the echo tool')) return reply([toolCall('mcp__fx__echo', { text: 'from the model' })]);
    if (last.includes('load the release skill')) return reply([toolCall('skill_load', { name: 'release-notes' })]);
    if (last.includes('use the remote tool')) return reply([toolCall('mcp__remote__echo', { text: 'remote' })]);
    return reply([toolCall('idle', {})]);
  },
]);

describe('M3 acceptance: MCP servers and skills join a running daemon', () => {
  let d: Daemon;
  let dataDir: string;
  const api = async <T>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${d.url}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  const turn = async (text: string): Promise<ProviderRequest> => {
    const n = provider.calls.length;
    await api('POST', '/api/events', { text });
    await waitUntil(() => provider.calls.length > n && !d.main.busy, `turn "${text}"`);
    return provider.calls[n] as ProviderRequest;
  };
  const toolResults = (): string[] =>
    d.transcript.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => String(b['content'])));

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-m3-'));
    d = await startDaemon({ dataDir, provider, listen: '127.0.0.1:0', logger: silentLogger(), env: {} });
  });
  afterAll(async () => {
    await d?.stop('test end');
  });

  it('adds an MCP server through the control API, the model calls it, and its tools leave when it is removed', async () => {
    const t0 = Date.now();
    const added = await api<McpServerStatus>('POST', '/api/mcp/servers', { id: 'fx', command: process.execPath, args: [FIXTURE] });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ id: 'fx', state: 'running', server: { name: 'fixture' } });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8')).toMatch(/mcp:\n\s+servers:\n\s+fx:\n\s+command:/);

    const req = await turn('please use the echo tool');
    expect(req.tools.map((t) => t.name)).toContain('mcp__fx__echo');
    await waitUntil(() => toolResults().includes('echo: from the model'), 'MCP tool result');
    const status = (await api<{ mcp: McpServerStatus[]; tools: { total: number } }>('GET', '/api/status')).json;
    expect(status.mcp.map((m) => `${m.id}:${m.state}`)).toEqual(['fx:running']);
    const listed = await api<{ tools: Array<{ name: string; readOnly: boolean }> }>('GET', '/api/mcp/servers/fx/tools');
    expect(listed.json.tools.find((t) => t.name === 'mcp__fx__echo')).toMatchObject({ readOnly: true });
    // Prompts appear as read-only skills.
    expect(req.system.find((s) => s.id === 'skills-catalog')?.text).toContain('- mcp:fx/greet: Greet someone by name. (source: mcp)');

    expect((await api('DELETE', '/api/mcp/servers/fx')).status).toBe(200);
    const after = await turn('anything else?');
    expect(after.tools.some((t) => t.name.startsWith('mcp__fx__'))).toBe(false);
    expect(after.system.find((s) => s.id === 'skills-catalog')?.text).not.toContain('mcp:fx/greet');
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8')).not.toContain('fx:');
  });

  it('starts servers written into config.yaml without a restart', async () => {
    setConfigValue(dataDir, ['mcp', 'servers', 'cfg'], { command: process.execPath, args: [FIXTURE], trust: 'low' });
    await waitUntil(() => d.mcp.get('cfg')?.state === 'running', 'config server running');
    expect(d.tools.get('mcp__cfg__add')).toBeDefined();
    // trust low: tools without readOnlyHint need approval, and the prefix says so in advance.
    const req = await turn('status?');
    expect(req.system.find((s) => s.id === 'permissions')?.text).toMatch(/Needs the owner's approval: .*mcp__cfg__add/);
    setConfigValue(dataDir, ['mcp', 'servers', 'cfg'], undefined);
    await waitUntil(() => d.mcp.get('cfg') === undefined, 'config server removed');
  });

  it('lists a skill copied into the data volume at the next turn, loads it, and rejects a broken one with its reason', async () => {
    const dir = path.join(dataDir, 'skills', 'release-notes');
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'references', 'style.md'), '# Style\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes from merged pull requests.\n---\n\n# Release notes\nGroup by feature.\n');
    const broken = path.join(dataDir, 'skills', 'broken-skill');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'SKILL.md'), '---\nname: broken-skill\n---\nNo description.\n');
    await waitUntil(() => d.skills.listedNames().includes('release-notes'), 'skill picked up');

    const req = await turn('load the release skill');
    expect(req.system.find((s) => s.id === 'skills-catalog')?.text).toContain('- release-notes: Write release notes from merged pull requests. (source: user)');
    await waitUntil(() => toolResults().some((t) => t.startsWith('# Skill: release-notes (user)')), 'skill_load receipt');
    const receipt = toolResults().find((t) => t.startsWith('# Skill: release-notes')) as string;
    expect(receipt).toBe(
      '# Skill: release-notes (user)\n# Release notes\nGroup by feature.\n\n## Files\nreferences/style.md (8 B)\n\nRead these with skill_read {"name": "release-notes", "path": "<file>"}.',
    );
    const { json } = await api<{ skills: SkillInfo[] }>('GET', '/api/skills');
    expect(json.skills.find((k) => k.name === 'broken-skill')).toMatchObject({ listed: false, errors: ['description is missing or empty'] });
    expect(json.skills.find((k) => k.name === 'release-notes')).toMatchObject({ origin: 'user', listed: true, loads: 1 });

    // Disabling hides it from the next turn's catalog and is saved.
    expect((await api<SkillInfo>('POST', '/api/skills/release-notes/disable')).json).toMatchObject({ enabled: false, listed: false });
    const next = await turn('ok');
    expect(next.system.find((s) => s.id === 'skills-catalog')?.text).not.toContain('release-notes');
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8')).toMatch(/skills:\n\s+disabled:\n\s+- release-notes/);
    expect((await api<SkillInfo>('POST', '/api/skills/release-notes/enable')).json).toMatchObject({ listed: true });
  });

  it('completes an MCP OAuth authorization through the control plane callback', async () => {
    const as = await fakeAuthServer();
    let resource = '';
    const srv = await httpMcpServer((r, res) => {
      const u = new URL(r.url ?? '/', 'http://x');
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource, authorization_servers: [as.issuer] }));
        return false;
      }
      const token = r.headers.authorization?.replace(/^Bearer /, '');
      if (token && as.tokens.has(token)) return true;
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${resource.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource/mcp"` }).end();
      return false;
    });
    resource = srv.url;
    try {
      const added = await api<McpServerStatus>('POST', '/api/mcp/servers', { id: 'remote', url: srv.url, auth: { type: 'oauth' } });
      expect(added.json).toMatchObject({ state: 'auth_required' });
      const authorizeUrl = added.json.authorizeUrl as string;
      expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(`${d.url}/api/mcp/oauth/callback`);
      expect(d.store.query({ type: 'mcp.auth_required' })).toHaveLength(1);
      // The browser: authorization server → Protea's callback (no admin token).
      const redirect = await fetch(authorizeUrl, { redirect: 'manual' });
      const callback = await fetch(redirect.headers.get('location') as string);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain('Protea can now use the MCP server remote (running)');
      expect((await fetch(`${d.url}/api/mcp/oauth/callback?code=x&state=forged`)).status).toBe(400);
      await turn('please use the remote tool');
      await waitUntil(() => toolResults().includes('echo: remote'), 'remote tool result');
    } finally {
      await api('DELETE', '/api/mcp/servers/remote');
      await srv.close();
      await as.close();
    }
  });
});

/**
 * The roadmap's real servers. Needs network access and uv/npx, so it runs only with
 * PROTEA_REAL_MCP=1 (first runs download the packages).
 */
describe.runIf(process.env['PROTEA_REAL_MCP'] === '1')('M3 acceptance with real MCP servers', () => {
  it('adds uvx mcp-server-fetch and npx @modelcontextprotocol/server-filesystem; the model can call them', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-m3-real-'));
    const files = path.join(dataDir, 'workspace');
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, 'hello.txt'), 'hello from the filesystem server\n');
    const model = new ScriptedProvider([
      (req) => {
        const last = lastUser(req);
        if (last.includes('read the file')) return reply([toolCall('mcp__files__read_text_file', { path: path.join(files, 'hello.txt') })]);
        if (last.includes('fetch the page')) return reply([toolCall('mcp__fetch__fetch', { url: 'https://example.com', max_length: 500 })]);
        return textReply('ok');
      },
    ]);
    const d = await startDaemon({ dataDir, provider: model, listen: '127.0.0.1:0', logger: silentLogger(), env: process.env });
    const post = (p: string, body: unknown) =>
      fetch(`${d.url}${p}`, { method: 'POST', headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const results = (): string[] => d.transcript.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => String(b['content'])));
    try {
      for (const [id, entry] of [
        ['fetch', { command: 'uvx', args: ['mcp-server-fetch'] }],
        ['files', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', files] }],
      ] as const) {
        const t0 = Date.now();
        const s = (await (await post('/api/mcp/servers', { id, ...entry })).json()) as McpServerStatus;
        expect(s).toMatchObject({ id, state: 'running' });
        process.stderr.write(`[real mcp] ${id}: ${s.tools.length} tools in ${Date.now() - t0} ms\n`);
      }
      await post('/api/events', { text: 'read the file please' });
      await waitUntil(() => results().some((r) => r.includes('hello from the filesystem server')), 'filesystem read', 30_000);
      await post('/api/events', { text: 'fetch the page please' });
      // mcp-server-fetch answers "Contents of <url>:" followed by the page as Markdown.
      await waitUntil(() => results().some((r) => r.includes('Contents of https://example.com')), 'fetch', 60_000).catch((err: Error) => {
        throw new Error(`${err.message}; last results: ${results().slice(-2).join(' | ').slice(0, 600)}`);
      });
      await fetch(`${d.url}/api/mcp/servers/files`, { method: 'DELETE', headers: { authorization: `Bearer ${d.adminToken}` } });
      const n = model.calls.length;
      await post('/api/events', { text: 'anything?' });
      await waitUntil(() => model.calls.length > n && !d.main.busy, 'next turn');
      expect(model.calls.at(-1)?.tools.some((t) => t.name.startsWith('mcp__files__'))).toBe(false);
    } finally {
      await d.stop('test end');
    }
  }, 300_000);
});
