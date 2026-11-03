import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  Bus,
  DEFAULT_MCP_SETTINGS,
  McpManager,
  ToolDispatcher,
  ToolRegistry,
  normalizeMcpServer,
  silentLogger,
  systemClock,
  type McpServerSettings,
} from '../src/index.js';
import type { EventInput, ToolUseBlock } from '@protea/protocol';
import { createFixtureServer } from './fixtures/mcp-server.mjs';
import { tmpDir } from './helpers.js';

export const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));

export function stdioServer(extra: Record<string, unknown> = {}): McpServerSettings {
  return normalizeMcpServer('fx', { command: process.execPath, args: [FIXTURE], ...extra });
}

export function mcpHarness(opts: { maxCrashes?: number; pingIntervalMs?: number } = {}) {
  const dataDir = tmpDir('protea-mcp-');
  const tools = new ToolRegistry();
  const bus = new Bus();
  const internal: Array<Omit<EventInput, 'ts' | 'origin'>> = [];
  const events: Array<{ server: string; input: Omit<EventInput, 'ts' | 'origin'> }> = [];
  const mcp = new McpManager({
    tools,
    bus,
    log: silentLogger(),
    clock: systemClock,
    dataDir,
    version: 'test',
    settings: () => ({ ...DEFAULT_MCP_SETTINGS, pingIntervalMs: opts.pingIntervalMs ?? 0, listChangedDebounceMs: 20 }),
    supervision: () => ({ restartBackoffMs: [50], maxCrashes: opts.maxCrashes ?? 3, stableAfterMs: 60_000, initializeTimeoutMs: 10_000, drainTimeoutMs: 2_000 }),
    pushInternal: (e) => internal.push(e),
    pushEvent: (server, input) => events.push({ server, input }),
    redirectUrl: () => 'http://127.0.0.1:1/api/mcp/oauth/callback',
  });
  const dispatcher = new ToolDispatcher(tools, silentLogger());
  let seq = 0;
  const call = async (name: string, input: unknown = {}) => {
    const use: ToolUseBlock = { type: 'tool_use', id: `tu_${++seq}`, name, input };
    const r = await dispatcher.runAll([use], { signal: new AbortController().signal, sessionId: 'main', batchId: 'b1', batchLevel: 1 });
    return r.results[0] as { content: string; is_error?: boolean };
  };
  return { dataDir, tools, bus, mcp, internal, events, call };
}

export interface HttpMcp {
  url: string;
  requests: Array<{ authorization?: string }>;
  close(): Promise<void>;
}

/** The fixture behind Streamable HTTP (stateless: a fresh server per request). */
export async function httpMcpServer(check?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean): Promise<HttpMcp> {
  const requests: HttpMcp['requests'] = [];
  const srv = http.createServer((req, res) => {
    void (async () => {
      requests.push({ ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
      if (check && !check(req, res)) return;
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      const server = createFixtureServer({ MCP_FIXTURE_NAME: 'http-fixture' });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

/** A minimal OAuth 2.1 authorization server (metadata, dynamic registration, PKCE code flow). */
export async function fakeAuthServer(): Promise<{ issuer: string; tokens: Set<string>; close(): Promise<void> }> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const tokens = new Set<string>();
  const srv = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const issuer = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/register') {
        const meta = JSON.parse(raw) as Record<string, unknown>;
        return json(201, { ...meta, client_id: 'client-1', client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (url.pathname === '/authorize') {
        const code = crypto.randomBytes(8).toString('hex');
        const redirect = url.searchParams.get('redirect_uri') as string;
        codes.set(code, { challenge: url.searchParams.get('code_challenge') as string, redirect });
        const back = new URL(redirect);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        return res.writeHead(302, { location: back.href }).end();
      }
      if (url.pathname === '/token') {
        const p = new URLSearchParams(raw);
        const c = codes.get(p.get('code') ?? '');
        const verifier = p.get('code_verifier') ?? '';
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (!c || c.challenge !== challenge) return json(400, { error: 'invalid_grant' });
        codes.delete(p.get('code') as string);
        const token = `at-${crypto.randomBytes(8).toString('hex')}`;
        tokens.add(token);
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1' });
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { issuer: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, tokens, close: () => new Promise((r) => srv.close(() => r())) };
}
