import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  EVENT_STATES,
  isLevel,
  isTrigger,
  type EventState,
  type PushEventRequest,
  type PushEventResponse,
  type StatusResponse,
  type StreamMessage,
} from '@protea/protocol';
import {
  MemoryError,
  type ApprovalService,
  type Bus,
  type EventStore,
  type ForkManager,
  type HandoffResult,
  type Logger,
  type McpManager,
  type MemoryIndex,
  type MemoryStore,
  type PluginHost,
  type PushResult,
  type SkillRegistry,
  type Transcript,
} from '@protea/core';

export interface ControlDeps {
  adminToken: string;
  bus: Bus;
  store: EventStore;
  log: Logger;
  transcript: () => Transcript;
  forks?: ForkManager;
  plugins?: PluginHost;
  approvals?: ApprovalService;
  /** Re-scan plugin directories (after uninstall, so a built-in with the same id reappears). */
  rescanPlugins?: () => Promise<void>;
  /** Validate, apply and persist a plugin's configuration. */
  setPluginConfig?: (id: string, config: Record<string, unknown>) => Promise<void>;
  mcp?: McpManager;
  /** Add or replace (a config entry) or remove (null) an MCP server: validated, persisted and applied. */
  putMcpServer?: (id: string, entry: Record<string, unknown> | null) => Promise<void>;
  setMcpEnabled?: (id: string, enabled: boolean) => Promise<void>;
  skills?: SkillRegistry;
  /** Persist `skills.disabled` and update the catalog. */
  setSkillEnabled?: (name: string, enabled: boolean) => void;
  /** Hand the main session off now (idle) or at the start of the next batch. */
  handoff?: (reason?: string) => Promise<{ scheduled: true } | { result: HandoffResult | null }>;
  memory?: { store: MemoryStore; index: MemoryIndex; onWrite?: (path: string) => void };
  status: () => StatusResponse;
  ready: () => { ready: boolean; reasons: string[] };
  /** Deliver an operator message through the console plugin. */
  pushConsole: (req: PushEventRequest, senderKey: string) => PushResult;
  keepAliveMs?: number;
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const MAX_HOOK_BODY = 1024 * 1024;

function errorJson(c: Context, status: 400 | 404 | 409, code: string, err: unknown) {
  return c.json({ error: { code, message: err instanceof Error ? err.message : String(err) } }, status);
}

function intParam(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * HTTP control plane (M0/M1 subset of docs/30-specs/05-control-api.md): health,
 * status, events, session transcripts, forks and a Server-Sent Events stream.
 */
export function createControlApp(d: ControlDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) => {
    const r = d.ready();
    return c.json(r, r.ready ? 200 : 503);
  });

  // Webhooks: no admin token; the serving plugin verifies signatures (docs/10-architecture/14-security-and-permissions.md §8).
  const hook = async (c: Context) => {
    const name = c.req.param('name') ?? '';
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.length > MAX_HOOK_BODY) return c.json({ error: { code: 'too_large', message: 'body too large' } }, 413);
    const url = new URL(c.req.url);
    const prefix = `/hooks/${name}`;
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let res;
    try {
      res = await d.plugins?.hook(name, {
        method: c.req.method,
        path: url.pathname.slice(prefix.length),
        query: Object.fromEntries(url.searchParams),
        headers,
        bodyBase64: body.toString('base64'),
      });
    } catch (err) {
      d.log.warn({ hook: name, err: err instanceof Error ? err.message : String(err) }, 'webhook handler failed');
      return c.json({ error: { code: 'hook_failed', message: 'the plugin did not handle the request' } }, 502);
    }
    if (!res) return c.json({ error: { code: 'not_found', message: `no plugin serves /hooks/${name}` } }, 404);
    const status = Number.isInteger(res.status) && res.status >= 200 && res.status <= 599 ? res.status : 500;
    return new Response(res.body ?? '', { status, headers: res.headers ?? { 'content-type': 'text/plain; charset=utf-8' } });
  };
  app.all('/hooks/:name', hook);
  app.all('/hooks/:name/*', hook);

  // OAuth: the owner's browser returns here from an MCP server's authorization server (state-checked, no token).
  app.get('/api/mcp/oauth/callback', async (c) => {
    const page = (status: 200 | 400, title: string, text: string) =>
      c.html(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3em"><h1>${title}</h1><p>${text}</p></body>`, status);
    const code = c.req.query('code');
    const state = c.req.query('state');
    const err = c.req.query('error');
    if (err) return page(400, 'Authorization failed', `The server answered: ${err.replace(/[<>&]/g, '')}`);
    if (!code || !state || !d.mcp) return page(400, 'Authorization failed', 'The request has no code or state.');
    try {
      const s = await d.mcp.finishAuth(state, code);
      return page(200, 'Authorized', `Protea can now use the MCP server ${s.id} (${s.state}). You can close this tab.`);
    } catch (e) {
      d.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'MCP OAuth callback failed');
      return page(400, 'Authorization failed', 'This authorization is unknown or has expired. Start it again with: protea mcp auth &lt;server&gt;');
    }
  });

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!tokenMatches(token, d.adminToken)) return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    await next();
  });

  app.get('/api/status', (c) => c.json(d.status()));

  app.post('/api/events', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'body must be JSON' } }, 400);
    }
    const b = body as Partial<PushEventRequest>;
    if (typeof b.text !== 'string' || b.text.length === 0) {
      return c.json({ error: { code: 'bad_request', message: 'text is required' } }, 400);
    }
    if (b.level !== undefined && !isLevel(b.level)) return c.json({ error: { code: 'bad_request', message: 'invalid level' } }, 400);
    if (b.trigger !== undefined && !isTrigger(b.trigger)) {
      return c.json({ error: { code: 'bad_request', message: 'invalid trigger' } }, 400);
    }
    const req: PushEventRequest = {
      text: b.text,
      ...(b.level !== undefined ? { level: b.level } : {}),
      ...(b.trigger !== undefined ? { trigger: b.trigger } : {}),
      ...(Array.isArray(b.tags) ? { tags: b.tags } : {}),
    };
    const r = d.pushConsole(req, 'console:admin');
    if (!r.ok || r.cursor === undefined) {
      return c.json({ error: { code: 'rejected', message: 'event rejected', details: r.errors ?? [] } }, 422);
    }
    const res: PushEventResponse = {
      cursor: r.cursor,
      effectiveLevel: r.effectiveLevel ?? 1,
      effectiveTrigger: r.effectiveTrigger ?? 'flush',
      deduped: r.deduped ?? false,
      warnings: r.warnings,
    };
    return c.json(res, 201);
  });

  app.get('/api/events', (c) => {
    const state = c.req.query('state');
    const states = state ? (state.split(',').filter((s) => (EVENT_STATES as readonly string[]).includes(s)) as EventState[]) : undefined;
    const since = intParam(c, 'since');
    const level = intParam(c, 'level');
    const limit = intParam(c, 'limit');
    const source = c.req.query('source');
    const events = d.store.query({
      order: c.req.query('order') === 'asc' ? 'asc' : 'desc',
      ...(since !== undefined ? { sinceCursor: since } : {}),
      ...(level !== undefined && isLevel(level) ? { maxLevel: level } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(source ? { source } : {}),
      ...(states ? { states } : {}),
    });
    return c.json({ events });
  });

  app.get('/api/events/:cursor', (c) => {
    const cursor = Number(c.req.param('cursor'));
    const event = Number.isInteger(cursor) ? d.store.get(cursor) : undefined;
    if (!event) return c.json({ error: { code: 'not_found', message: 'no such event' } }, 404);
    return c.json({ event, delivery: d.store.deliveryOf(cursor) ?? null });
  });

  app.get('/api/sessions/:id/transcript', (c) => {
    const id = c.req.param('id');
    const all = id === 'main' ? d.transcript().messages : d.forks?.transcript(id);
    if (!all) return c.json({ error: { code: 'not_found', message: 'no such session' } }, 404);
    const limit = Math.min(Math.max(intParam(c, 'limit') ?? 50, 1), 500);
    const from = intParam(c, 'from') ?? Math.max(0, all.length - limit);
    return c.json({ total: all.length, from, messages: all.slice(from, from + limit) });
  });

  app.get('/api/sessions', (c) => {
    const s = d.status();
    return c.json({
      sessions: [
        { id: 'main', kind: 'main', phase: s.phase, batchId: s.batchId },
        ...(d.forks?.list() ?? []).map((f) => ({ kind: 'fork', ...f })),
      ],
    });
  });

  app.post('/api/sessions/main/handoff', async (c) => {
    if (!d.handoff) return c.json({ error: { code: 'not_found', message: 'handoff is not available' } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const out = await d.handoff(typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined);
    if ('scheduled' in out) return c.json({ scheduled: true }, 202);
    const r = out.result;
    return c.json(r ? { handedOff: true, transcript: r.transcript.file.split('/').pop(), notes: r.notesPath, dropped: r.dropped, kept: r.kept } : { handedOff: false });
  });

  // Memory (docs/10-architecture/11-memory-and-persona.md); writes are audited.
  const memoryPath = (raw: string | undefined): string => {
    const p = (raw ?? '').trim();
    return p.startsWith('/memories') ? p : `/memories/${p.replace(/^\/+/, '')}`;
  };
  app.get('/api/memory/tree', (c) => {
    if (!d.memory) return c.json({ files: [] });
    return c.json({ files: d.memory.store.listFiles().map((f) => ({ path: f.path, size: f.size, mtime: new Date(f.mtimeMs).toISOString() })) });
  });
  app.get('/api/memory/file', (c) => {
    if (!d.memory) return c.json({ error: { code: 'not_found', message: 'no memory directory' } }, 404);
    try {
      const rel = d.memory.store.relative(memoryPath(c.req.query('path')));
      const text = d.memory.store.readText(rel);
      if (text === undefined) return c.json({ error: { code: 'not_found', message: 'no such memory file' } }, 404);
      return c.json({ path: rel, text });
    } catch (err) {
      return errorJson(c, 400, 'invalid_path', err);
    }
  });
  app.put('/api/memory/file', async (c) => {
    if (!d.memory) return c.json({ error: { code: 'not_found', message: 'no memory directory' } }, 404);
    try {
      const rel = d.memory.store.relative(memoryPath(c.req.query('path')));
      if (rel === '') throw new MemoryError('a file path is required');
      const text = await c.req.text();
      d.memory.store.writeText(rel, text);
      d.memory.onWrite?.(rel);
      return c.json({ ok: true, path: rel });
    } catch (err) {
      return errorJson(c, 400, 'invalid_path', err);
    }
  });
  app.get('/api/memory/search', (c) => {
    if (!d.memory) return c.json({ hits: [] });
    const q = c.req.query('q') ?? '';
    const paths = c.req.queries('paths');
    const limit = Math.min(Math.max(intParam(c, 'limit') ?? 10, 1), 50);
    return c.json({ hits: d.memory.index.search(q, { ...(paths ? { paths } : {}), limit }) });
  });

  app.get('/api/sessions/forks', (c) => c.json({ forks: d.forks?.list() ?? [] }));

  app.get('/api/sessions/forks/:id', (c) => {
    const f = d.forks?.get(c.req.param('id'));
    if (!f) return c.json({ error: { code: 'not_found', message: 'no such fork' } }, 404);
    return c.json(f);
  });

  app.post('/api/sessions/forks/:id/cancel', (c) => {
    if (!d.forks?.get(c.req.param('id'))) return c.json({ error: { code: 'not_found', message: 'no such fork' } }, 404);
    return c.json(d.forks.cancel(c.req.param('id')));
  });

  // Plugins (docs/30-specs/05-control-api.md).
  app.get('/api/plugins', (c) => c.json({ plugins: d.plugins?.status() ?? [] }));
  app.get('/api/plugins/:id', (c) => {
    const p = d.plugins?.get(c.req.param('id'));
    return p ? c.json(p) : c.json({ error: { code: 'not_found', message: 'no such plugin' } }, 404);
  });
  app.post('/api/plugins', async (c) => {
    if (!d.plugins) return c.json({ error: { code: 'unavailable', message: 'no plugin host' } }, 404);
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; enable?: unknown } | null;
    if (!body || typeof body.path !== 'string') return c.json({ error: { code: 'bad_request', message: 'path is required (git and tarball sources arrive later)' } }, 400);
    try {
      return c.json(await d.plugins.install(body.path, { enable: body.enable !== false }), 201);
    } catch (err) {
      return errorJson(c, 400, 'install_failed', err);
    }
  });
  for (const action of ['enable', 'disable', 'reload', 'restart'] as const) {
    app.post(`/api/plugins/:id/${action}`, async (c) => {
      const id = c.req.param('id');
      if (!d.plugins?.get(id)) return c.json({ error: { code: 'not_found', message: 'no such plugin' } }, 404);
      try {
        return c.json(await d.plugins[action](id));
      } catch (err) {
        return errorJson(c, 409, `${action}_failed`, err);
      }
    });
  }
  app.patch('/api/plugins/:id/config', async (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.get(id) || !d.setPluginConfig) return c.json({ error: { code: 'not_found', message: 'no such plugin' } }, 404);
    const body = (await c.req.json().catch(() => null)) as { config?: unknown } | null;
    if (!body || typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
      return c.json({ error: { code: 'bad_request', message: 'config must be an object' } }, 400);
    }
    try {
      await d.setPluginConfig(id, body.config as Record<string, unknown>);
      return c.json(d.plugins.get(id));
    } catch (err) {
      return errorJson(c, 400, 'invalid_config', err);
    }
  });
  app.delete('/api/plugins/:id', async (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.get(id)) return c.json({ error: { code: 'not_found', message: 'no such plugin' } }, 404);
    try {
      await d.plugins.uninstall(id, { keepData: c.req.query('keepData') === 'true' });
      await d.rescanPlugins?.();
      return c.json({ ok: true, replacedBy: d.plugins.get(id) ?? null });
    } catch (err) {
      return errorJson(c, 409, 'uninstall_failed', err);
    }
  });

  // MCP servers.
  const noMcp = (c: Context) => c.json({ error: { code: 'not_found', message: 'no such MCP server' } }, 404);
  app.get('/api/mcp/servers', (c) => c.json({ servers: d.mcp?.status() ?? [] }));
  app.get('/api/mcp/servers/:id', (c) => {
    const s = d.mcp?.get(c.req.param('id'));
    return s ? c.json(s) : noMcp(c);
  });
  app.get('/api/mcp/servers/:id/tools', (c) => {
    const tools = d.mcp?.toolsOf(c.req.param('id'));
    return tools ? c.json({ tools }) : noMcp(c);
  });
  app.post('/api/mcp/servers', async (c) => {
    if (!d.putMcpServer || !d.mcp) return noMcp(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const id = body?.['id'];
    if (!body || typeof id !== 'string') return c.json({ error: { code: 'bad_request', message: 'id is required' } }, 400);
    const { id: _id, ...entry } = body;
    const existed = d.mcp.get(id) !== undefined;
    try {
      await d.putMcpServer(id, entry);
    } catch (err) {
      return errorJson(c, 400, 'invalid_server', err);
    }
    return c.json(d.mcp.get(id), existed ? 200 : 201);
  });
  app.delete('/api/mcp/servers/:id', async (c) => {
    const id = c.req.param('id');
    if (!d.mcp?.get(id) || !d.putMcpServer) return noMcp(c);
    await d.putMcpServer(id, null);
    return c.json({ ok: true });
  });
  for (const action of ['enable', 'disable', 'restart'] as const) {
    app.post(`/api/mcp/servers/:id/${action}`, async (c) => {
      const id = c.req.param('id');
      if (!d.mcp?.get(id)) return noMcp(c);
      try {
        if (action === 'restart') return c.json(await d.mcp.restart(id));
        await d.setMcpEnabled?.(id, action === 'enable');
        return c.json(d.mcp.get(id));
      } catch (err) {
        return errorJson(c, 409, `${action}_failed`, err);
      }
    });
  }
  app.post('/api/mcp/servers/:id/oauth/start', async (c) => {
    const id = c.req.param('id');
    if (!d.mcp?.get(id)) return noMcp(c);
    try {
      return c.json(await d.mcp.authorize(id));
    } catch (err) {
      return errorJson(c, 409, 'oauth_failed', err);
    }
  });

  // Skills. Names of MCP prompt skills contain ":" and "/", so the name is the rest of the path.
  const skillName = (c: Context, suffix = ''): string => decodeURIComponent(c.req.path.slice('/api/skills/'.length, suffix ? -suffix.length : undefined));
  const noSkill = (c: Context) => c.json({ error: { code: 'not_found', message: 'no such skill' } }, 404);
  app.get('/api/skills', (c) => c.json({ skills: d.skills?.list() ?? [] }));
  app.post('/api/skills', async (c) => {
    if (!d.skills) return noSkill(c);
    const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
    if (!body || typeof body.path !== 'string') return c.json({ error: { code: 'bad_request', message: 'path is required (git sources arrive later)' } }, 400);
    try {
      return c.json(d.skills.install(body.path), 201);
    } catch (err) {
      return errorJson(c, 400, 'install_failed', err);
    }
  });
  app.get('/api/skills/*', (c) => {
    const s = d.skills?.get(skillName(c));
    return s ? c.json(s) : noSkill(c);
  });
  app.post('/api/skills/*', (c) => {
    const action = c.req.path.endsWith('/enable') ? 'enable' : c.req.path.endsWith('/disable') ? 'disable' : null;
    if (!action) return c.json({ error: { code: 'bad_request', message: 'POST /api/skills/<name>/enable or /disable' } }, 400);
    const name = skillName(c, `/${action}`);
    if (!d.skills?.get(name) || !d.setSkillEnabled) return noSkill(c);
    d.setSkillEnabled(name, action === 'enable');
    return c.json(d.skills.get(name));
  });
  app.delete('/api/skills/*', (c) => {
    const name = skillName(c);
    if (!d.skills?.get(name)) return noSkill(c);
    try {
      d.skills.uninstall(name);
      return c.json({ ok: true, replacedBy: d.skills.get(name) ?? null });
    } catch (err) {
      return errorJson(c, 409, 'uninstall_failed', err);
    }
  });

  // Approvals.
  app.get('/api/approvals', (c) => {
    const state = c.req.query('state');
    const states = ['pending', 'approved', 'denied', 'expired', 'used'];
    if (state !== undefined && !states.includes(state)) return c.json({ error: { code: 'bad_request', message: `state must be one of ${states.join(', ')}` } }, 400);
    return c.json({ approvals: d.approvals?.list(state as never) ?? [] });
  });
  app.post('/api/approvals/:id/decide', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { decision?: unknown } | null;
    if (body?.decision !== 'approve' && body?.decision !== 'deny') {
      return c.json({ error: { code: 'bad_request', message: 'decision must be approve or deny' } }, 400);
    }
    if (!d.approvals) return c.json({ error: { code: 'not_found', message: 'no approvals' } }, 404);
    const r = d.approvals.decide(c.req.param('id'), body.decision, 'console:admin');
    if (!r.ok) return c.json({ error: { code: r.state ? 'conflict' : 'not_found', message: r.message ?? 'not decided' } }, r.state ? 409 : 404);
    return c.json(d.approvals.get(c.req.param('id')));
  });

  app.get('/api/stream', (c) => {
    const since = intParam(c, 'since');
    return streamSSE(c, async (stream) => {
      const queue: StreamMessage[] = [];
      let wake: (() => void) | null = null;
      const push = (m: StreamMessage): void => {
        queue.push(m);
        wake?.();
      };
      const unsubs = [
        d.bus.on('event.stored', (e) => push({ topic: 'event', data: e })),
        d.bus.on('event.settled', (s) =>
          push({
            topic: 'settled',
            data: { cursors: s.cursors, outcome: s.outcome, ...(s.batchId !== undefined ? { batchId: s.batchId } : {}) },
          }),
        ),
        d.bus.on('session.phase', (p) =>
          push({
            topic: 'phase',
            data: {
              phase: p.phase,
              ...(p.batchId !== undefined ? { batchId: p.batchId } : {}),
              ...(p.round !== undefined ? { round: p.round } : {}),
            },
          }),
        ),
        d.bus.on('batch.started', (b) => push({ topic: 'batch.started', data: b })),
        d.bus.on('batch.extended', (b) => push({ topic: 'batch.extended', data: b })),
        d.bus.on('batch.ended', (b) => push({ topic: 'batch.ended', data: b })),
        d.bus.on('plugin.output', (o) => push({ topic: 'output', data: o })),
        d.bus.on('scheduler.action', (a) => push({ topic: 'scheduler', data: a })),
        d.bus.on('fork.changed', (f) => push({ topic: 'fork', data: f })),
        d.bus.on('plugin.changed', (p) => push({ topic: 'plugin', data: p })),
        d.bus.on('approval.changed', (a) => push({ topic: 'approval', data: a })),
        d.bus.on('mcp.changed', (m) => push({ topic: 'mcp', data: m })),
        d.bus.on('skills.changed', (k) => push({ topic: 'skills', data: k })),
        d.bus.on('session.handoff', (h) => push({ topic: 'handoff', data: { from: h.from.split('/').pop() ?? h.from, to: h.to.split('/').pop() ?? h.to, notes: h.notes, dropped: h.dropped, kept: h.kept } })),
      ];
      stream.onAbort(() => {
        for (const u of unsubs) u();
        wake?.();
      });

      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ runId: d.status().runId }) });
      let lastCursor = -1;
      if (since !== undefined) {
        for (const e of d.store.query({ sinceCursor: since, limit: 1000, order: 'asc' })) {
          await stream.writeSSE({ event: 'event', id: String(e.cursor), data: JSON.stringify(e) });
          lastCursor = e.cursor;
        }
      }
      const keepAlive = d.keepAliveMs ?? 15_000;
      while (!stream.aborted) {
        while (queue.length > 0) {
          const m = queue.shift() as StreamMessage;
          if (m.topic === 'event') {
            if (m.data.cursor <= lastCursor) continue;
            await stream.writeSSE({ event: m.topic, id: String(m.data.cursor), data: JSON.stringify(m.data) });
          } else {
            await stream.writeSSE({ event: m.topic, data: JSON.stringify(m.data) });
          }
        }
        const timedOut = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), keepAlive);
          wake = () => {
            clearTimeout(t);
            resolve(false);
          };
        });
        wake = null;
        if (timedOut && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' });
      }
      for (const u of unsubs) u();
    });
  });

  app.onError((err, c) => {
    d.log.error({ err: err.message, path: c.req.path }, 'control API error');
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  return app;
}
