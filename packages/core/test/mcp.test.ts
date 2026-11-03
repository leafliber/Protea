import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpToolName, normalizeMcpServer, renderCallResult, type ToolDef } from '../src/index.js';
import { waitFor } from './helpers.js';
import { fakeAuthServer, httpMcpServer, mcpHarness, stdioServer } from './mcp-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
function harness(opts?: Parameters<typeof mcpHarness>[0]) {
  const h = mcpHarness(opts);
  cleanups.push(() => h.mcp.stopAll());
  return h;
}

describe('MCP settings and names', () => {
  it('fills defaults and rejects bad entries', () => {
    expect(normalizeMcpServer('fetch', { command: 'uvx', args: ['mcp-server-fetch'] })).toMatchObject({
      enabled: true,
      transport: 'stdio',
      trust: 'normal',
      toolTimeoutMs: 60_000,
      auth: { type: 'none' },
    });
    expect(normalizeMcpServer('gh', { url: 'https://example.com/mcp', auth: { type: 'bearer', token: '${secret:GH}' } })).toMatchObject({
      transport: 'streamable-http',
      auth: { type: 'bearer', token: '${secret:GH}' },
    });
    expect(() => normalizeMcpServer('Bad_Id', { command: 'x' })).toThrow(/id must match/);
    expect(() => normalizeMcpServer('x', {})).toThrow(/command is required/);
    expect(() => normalizeMcpServer('x', { url: 'ftp://h' })).toThrow(/http/);
    expect(() => normalizeMcpServer('x', { command: 'x', trust: 'total' })).toThrow(/trust/);
  });

  it('namespaces tool names and keeps them within the API limits', () => {
    expect(mcpToolName('fetch', 'fetch')).toBe('mcp__fetch__fetch');
    const dotted = mcpToolName('fx', 'dotted.name');
    expect(dotted).toMatch(/^mcp__fx__dotted_name_[0-9a-f]{6}$/);
    const long = mcpToolName('server', 'x'.repeat(100));
    expect(long.length).toBe(64);
    expect(long).toBe(mcpToolName('server', 'x'.repeat(100)));
  });

  it('renders tool results as text', () => {
    expect(renderCallResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] })).toEqual({
      text: 'a\n[image image/png, 5 bytes]',
    });
    expect(renderCallResult({ content: [], structuredContent: { n: 1 } })).toEqual({ text: '{"n":1}' });
    expect(renderCallResult({ content: [{ type: 'text', text: 'no' }], isError: true })).toEqual({ text: 'no', failed: true });
  });
});

describe('MCP manager over stdio', () => {
  it('connects, registers namespaced tools with flags from annotations, and calls them', async () => {
    const h = harness();
    await h.mcp.apply({ fx: stdioServer() });
    const st = h.mcp.get('fx');
    expect(st).toMatchObject({ state: 'running', transport: 'stdio', server: { name: 'fixture', version: '1.2.3' }, prompts: 1, resources: true });
    expect(st?.pid).toBeGreaterThan(0);
    const names = h.tools.namesOf('mcp:fx');
    expect(names).toContain('mcp__fx__echo');
    expect(names.some((n) => n.startsWith('mcp__fx__dotted_name_'))).toBe(true);
    const echo = h.tools.get('mcp__fx__echo') as ToolDef;
    expect(echo).toMatchObject({ owner: 'mcp:fx', deferrable: true, flags: { readOnly: true } });
    expect(echo.inputSchema).not.toHaveProperty('$schema');
    expect(h.tools.get('mcp__fx__add')?.flags).toMatchObject({ sideEffect: true });

    expect(await h.call('mcp__fx__echo', { text: 'hi' })).toMatchObject({ content: 'echo: hi' });
    expect((await h.call('mcp__fx__add', { a: 1, b: 2 })).content).toBe('3');
    expect(await h.call('mcp__fx__fail')).toMatchObject({ content: 'it went wrong', is_error: true });
    expect((await h.call('mcp__fx__echo', {})).content).toMatch(/invalid input/);
    const dotted = names.find((n) => n.startsWith('mcp__fx__dotted_name_')) as string;
    expect((await h.call(dotted)).content).toBe('[image image/png, 5 bytes]\n[resource link: memo://one (one)]');
    // The resource tools exist while a server offers resources.
    expect(h.tools.namesOf('mcp')).toEqual(['mcp_resource_list', 'mcp_resource_read']);
    expect((await h.call('mcp_resource_list', { server: 'fx' })).content).toContain('memo://one — one (text/plain)');
    expect((await h.call('mcp_resource_read', { server: 'fx', uri: 'memo://one' })).content).toBe('contents of memo://one');
    expect((await h.call('mcp_resource_read', { server: 'nope', uri: 'x' })).content).toMatch(/not running.*Servers with resources: fx/);
    // Roots: the workspace directory.
    expect((await h.call('mcp__fx__roots')).content).toBe(pathToFileURL(path.join(h.dataDir, 'workspace')).href);
    // The working directory of a stdio server.
    expect(fs.existsSync(path.join(h.dataDir, 'plugin-data', 'mcp', 'fx'))).toBe(true);
  });

  it('derives default policies from annotations and trust', async () => {
    const h = harness();
    await h.mcp.apply({ fx: stdioServer() });
    const p = (n: string) => h.mcp.policyFor(h.tools.get(`mcp__fx__${n}`) as ToolDef);
    expect(p('echo')).toEqual({ policy: 'allow', rule: 'readOnlyHint of MCP server fx' });
    expect(p('rm')).toEqual({ policy: 'ask', rule: 'destructiveHint of MCP server fx' });
    expect(p('add')).toBeNull();
    await h.mcp.apply({ fx: stdioServer({ trust: 'low' }) });
    expect(p('add')).toEqual({ policy: 'ask', rule: 'MCP server fx has trust low' });
    expect(p('echo')?.policy).toBe('allow');
    await h.mcp.apply({ fx: stdioServer({ trust: 'high' }) });
    expect(p('rm')).toBeNull();
  });

  it('filters tools with allow and deny globs', async () => {
    const h = harness();
    await h.mcp.apply({ fx: stdioServer({ tools: { allow: ['e*', 'a*', 'r*'], deny: ['roots'] } }) });
    expect(h.tools.namesOf('mcp:fx')).toEqual(['mcp__fx__add', 'mcp__fx__echo', 'mcp__fx__rm']);
    expect(h.mcp.toolsOf('fx')?.find((t) => t.mcpName === 'roots')).toMatchObject({ filtered: true });
  });

  it('applies tools/list_changed', async () => {
    const h = harness();
    await h.mcp.apply({ fx: stdioServer() });
    const rev = h.tools.revision;
    expect((await h.call('mcp__fx__grow', { name: 'fresh' })).content).toBe('grew fresh');
    await waitFor(() => h.tools.get('mcp__fx__fresh') !== undefined, 5000, 'new tool');
    expect(h.tools.revision).toBeGreaterThan(rev);
    expect((await h.call('mcp__fx__fresh', {})).content).toBe('fresh: ');
  });

  it('restarts a crashed server, answers calls during the outage, and fails after maxCrashes', async () => {
    const h = harness({ maxCrashes: 3 });
    await h.mcp.apply({ fx: stdioServer() });
    const pid = h.mcp.get('fx')?.pid;
    await h.call('mcp__fx__crash');
    await waitFor(() => h.mcp.get('fx')?.state === 'crashed' || (h.mcp.get('fx')?.restarts ?? 0) > 0, 5000, 'crash noticed');
    await waitFor(() => h.mcp.get('fx')?.state === 'running', 10_000, 'restart');
    expect(h.mcp.get('fx')).toMatchObject({ restarts: 1 });
    expect(h.mcp.get('fx')?.pid).not.toBe(pid);
    expect(h.internal.map((e) => e.type)).toContain('mcp.crashed');
    expect((await h.call('mcp__fx__echo', { text: 'back' })).content).toBe('echo: back');

    // A call in flight when the process dies gets a clear receipt.
    const slow = h.call('mcp__fx__slow', { ms: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    process.kill(h.mcp.get('fx')?.pid as number, 'SIGKILL');
    expect((await slow).content).toMatch(/exited during the call/);
    await waitFor(() => h.mcp.get('fx')?.state === 'running', 10_000, 'second restart');

    // A server that cannot start at all ends up failed, visibly.
    await h.mcp.apply({ fx: normalizeMcpServer('fx', { command: '/nonexistent/mcp-server' }) });
    await waitFor(() => h.mcp.get('fx')?.state === 'failed', 10_000, 'failed');
    expect(h.mcp.get('fx')?.error).toMatch(/could not start/);
    expect(h.internal.at(-1)).toMatchObject({ type: 'mcp.failed', level: 2, trigger: 'flush' });
    expect((await h.call('mcp__fx__echo', { text: 'x' })).content).toMatch(/tool mcp__fx__echo is not available \(the MCP server fx/);
  });

  it('times out slow calls without restarting the server', async () => {
    const h = harness();
    await h.mcp.apply({ fx: stdioServer({ toolTimeoutMs: 300 }) });
    const pid = h.mcp.get('fx')?.pid;
    expect((await h.call('mcp__fx__slow', { ms: 5000 })).content).toMatch(/timed out after/);
    expect(h.mcp.get('fx')).toMatchObject({ state: 'running', pid });
    expect((await h.call('mcp__fx__echo', { text: 'still here' })).content).toBe('echo: still here');
  });

  it('exposes prompts for the Skills catalog', async () => {
    const h = harness();
    await h.mcp.apply({ fx: stdioServer() });
    expect(h.mcp.prompts()).toEqual([
      { server: 'fx', prompt: 'greet', description: 'Greet someone by name.', arguments: [{ name: 'who', description: 'Whom to greet', required: true }] },
    ]);
    expect(await h.mcp.render('fx', 'greet', { who: 'Ann' }, new AbortController().signal)).toBe('A greeting\n\n[user]\nSay hello to Ann.');
  });

  it('stops, disables and removes servers; their tools leave with a reason', async () => {
    const h = harness();
    await h.mcp.apply({ fx: stdioServer() });
    await h.mcp.apply({ fx: stdioServer({ enabled: false }) });
    expect(h.mcp.get('fx')?.state).toBe('stopped');
    expect(h.tools.namesOf('mcp:fx')).toEqual([]);
    expect(h.tools.namesOf('mcp')).toEqual([]);
    expect((await h.call('mcp__fx__echo', { text: 'x' })).content).toMatch(/stopped \(disabled\)/);
    await h.mcp.apply({ fx: stdioServer() });
    expect(h.mcp.get('fx')?.state).toBe('running');
    await h.mcp.apply({});
    expect(h.mcp.get('fx')).toBeUndefined();
    expect((await h.call('mcp__fx__echo', { text: 'x' })).content).toMatch(/was removed/);

    // Removed and added back at once (an API call and the config watcher racing): the new one survives.
    await h.mcp.apply({ fx: stdioServer() });
    const removing = h.mcp.apply({});
    const adding = h.mcp.apply({ fx: stdioServer() });
    await Promise.all([removing, adding]);
    expect(h.mcp.get('fx')?.state).toBe('running');
    expect((await h.call('mcp__fx__echo', { text: 'again' })).content).toBe('echo: again');
  });

  it('pings running servers', async () => {
    const h = harness({ pingIntervalMs: 50 });
    await h.mcp.apply({ fx: stdioServer() });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.mcp.get('fx')?.state).toBe('running');
  });
});

describe('MCP manager over Streamable HTTP', () => {
  it('connects with a bearer token from the secret store', async () => {
    const srv = await httpMcpServer((req, res) => {
      if (req.headers.authorization === 'Bearer tok-123') return true;
      res.writeHead(401).end();
      return false;
    });
    cleanups.push(() => srv.close());
    const h = harness();
    // Without the secret the server does not start, and says why.
    await h.mcp.apply({ web: normalizeMcpServer('web', { url: srv.url, auth: { type: 'bearer', token: '${secret:WEB_TOKEN}' } }) });
    expect(h.mcp.get('web')).toMatchObject({ state: 'failed', error: 'secret WEB_TOKEN is not set' });
    fs.mkdirSync(path.join(h.dataDir, 'secrets'), { recursive: true });
    await h.mcp.apply({ web: normalizeMcpServer('web', { url: srv.url, headers: { Authorization: 'Bearer tok-123' } }) });
    expect(h.mcp.get('web')).toMatchObject({ state: 'running', transport: 'streamable-http', server: { name: 'http-fixture' } });
    expect((await h.call('mcp__web__echo', { text: 'over http' })).content).toBe('echo: over http');
  });

  it('runs the OAuth authorization code flow', async () => {
    const as = await fakeAuthServer();
    cleanups.push(() => as.close());
    let resourceUrl = '';
    const srv = await httpMcpServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/.well-known/oauth-protected-resource/mcp' || u.pathname === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: resourceUrl, authorization_servers: [as.issuer] }));
        return false;
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (token && as.tokens.has(token)) return true;
      const base = resourceUrl.replace(/\/mcp$/, '');
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
      return false;
    });
    resourceUrl = srv.url;
    cleanups.push(() => srv.close());
    const h = harness();
    await h.mcp.apply({ gh: normalizeMcpServer('gh', { url: srv.url, auth: { type: 'oauth' } }) });
    const pending = h.mcp.get('gh');
    expect(pending).toMatchObject({ state: 'auth_required' });
    expect(pending?.authorizeUrl).toContain(`${as.issuer}/authorize`);
    expect(h.internal.at(-1)).toMatchObject({ type: 'mcp.auth_required', level: 2 });
    expect(await h.mcp.authorize('gh')).toMatchObject({ state: 'auth_required', authorizeUrl: pending?.authorizeUrl });

    // The owner's browser: the authorization server redirects back with a code.
    const res = await fetch(pending?.authorizeUrl as string, { redirect: 'manual' });
    const back = new URL(res.headers.get('location') as string);
    expect(back.pathname).toBe('/api/mcp/oauth/callback');
    await expect(h.mcp.finishAuth('wrong-state', 'x')).rejects.toThrow(/no MCP authorization/);
    const done = await h.mcp.finishAuth(back.searchParams.get('state') as string, back.searchParams.get('code') as string);
    expect(done).toMatchObject({ state: 'running' });
    expect((await h.call('mcp__gh__echo', { text: 'authorized' })).content).toBe('echo: authorized');
    const stored = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'secrets', 'mcp-oauth', 'gh.json'), 'utf8')) as { tokens: { access_token: string } };
    expect(as.tokens.has(stored.tokens.access_token)).toBe(true);
    expect(fs.statSync(path.join(h.dataDir, 'secrets', 'mcp-oauth', 'gh.json')).mode & 0o777).toBe(0o600);

    // Restarting reuses the stored token: no new authorization.
    expect(await h.mcp.restart('gh')).toMatchObject({ state: 'running' });
  });
});
