import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  EVENT_STATES,
  isLevel,
  isTrigger,
  type BoardCommand,
  type BoardResponse,
  type ChatMessageRequest,
  type EventState,
  type PushEventRequest,
  type PushEventResponse,
  type ScheduleInfo,
  type ScheduleInput,
  type SchedulePreview,
  type ScheduleRun,
  type SetPermissionModeRequest,
  type SessionContextResponse,
  type StatusResponse,
  type StreamMessage,
  type MemoryHistoryResponse,
  type MemoryOverview,
  type MemorySearchHit,
} from '@protea/protocol';
import { BROWSER_SERVER_ID, PermissionModeError, type BlobStore, type ChangeRequestService, type PermissionModes, type WidgetStore } from '@protea/core';
import {
  BoardError,
  MemoryError,
  type ApprovalService,
  type AuditLog,
  type Board,
  type Bus,
  type Cidr,
  type DreamRunner,
  type EventStore,
  type ForkManager,
  type HandoffResult,
  type Logger,
  type McpManager,
  type MemoryAccess,
  type MemoryIndex,
  type MemoryStore,
  type ResidentMemory,
  type OutputLog,
  type PluginHost,
  type PushResult,
  type SkillRegistry,
  type Transcript,
} from '@protea/core';
import { addressGate } from './allow.js';
import { actorOf, principal, registerAccountRoutes, registerAuthRoutes, requireAuth, type AuthDeps } from './auth.js';
import { loginView } from './login.js';
import { installFrom, registerOpsRoutes, type OpsDeps } from './ops.js';
import { registerProviderRoutes, type ProviderOps } from './providers.js';
import { registerSpeechRoutes, type SpeechOps } from './speech.js';
import { registerConsole } from './static.js';
import { subscribeStream } from './stream.js';

export interface ControlDeps extends Omit<OpsDeps, 'store' | 'audit'> {
  /** API tokens, console accounts and sessions, and the first-run setup code. */
  auth: AuthDeps;
  /** Model provider profiles (/api/providers). */
  providers?: ProviderOps;
  /** Speech-to-text (/api/speech): settings, test, the web chat's microphone. */
  speech?: SpeechOps;
  bus: Bus;
  store: EventStore;
  /** Stored images (GET and POST /api/blobs). */
  blobs?: BlobStore;
  /** Inline widgets of chat replies (GET /api/widgets/:id). */
  widgets?: WidgetStore;
  /** The MCP server entry of the bundled browser. */
  browserPreset?: (o: { noSandbox?: boolean }) => Record<string, unknown>;
  /** False in an image without the browser. */
  browserAvailable?: () => boolean;
  /** The console conversation (GET /api/chat). */
  chat?: OutputLog;
  log: Logger;
  transcript: () => Transcript;
  forks?: ForkManager;
  plugins?: PluginHost;
  approvals?: ApprovalService;
  /** Changes to MCP servers, skills and plugins the assistant proposed; decided here and nowhere else. */
  changes?: ChangeRequestService;
  permissionModes?: PermissionModes;
  /** The cron plugin's schedules, for the console (docs/30-specs/05-control-api.md). */
  schedules?: {
    list(): ScheduleInfo[];
    get(id: string): ScheduleInfo | undefined;
    create(input: ScheduleInput): ScheduleInfo;
    update(id: string, patch: ScheduleInput): ScheduleInfo;
    remove(id: string): boolean;
    run(id: string): boolean;
    preview(input: { cron?: string; at?: string }): SchedulePreview;
    runs(id: string): ScheduleRun[];
  };
  /** Re-scan plugin directories (after uninstall, so a built-in with the same id reappears). */
  rescanPlugins?: () => Promise<void>;
  /** Validate, apply and persist a plugin's configuration. */
  setPluginConfig?: (id: string, config: Record<string, unknown>) => Promise<void>;
  mcp?: McpManager;
  /** Add or replace (a config entry) or remove (null) an MCP server: validated, persisted and applied. */
  putMcpServer?: (id: string, entry: Record<string, unknown> | null) => Promise<void>;
  setMcpEnabled?: (id: string, enabled: boolean) => Promise<void>;
  /** `alwaysLoad`: the server's tools are never deferred behind tool search. */
  setMcpAlwaysLoad?: (id: string, on: boolean) => Promise<void>;
  /** `plugins.<id>.alwaysLoad`: the plugin's tools are never deferred behind tool search (saved; the plugin keeps running). */
  setPluginAlwaysLoad?: (id: string, on: boolean) => void;
  skills?: SkillRegistry;
  /** Persist `skills.disabled` and update the catalog. */
  setSkillEnabled?: (name: string, enabled: boolean) => void;
  /** Hand the main session off now (idle) or at the start of the next batch. */
  handoff?: (reason?: string) => Promise<{ scheduled: true } | { result: HandoffResult | null }>;
  memory?: {
    store: MemoryStore;
    index: MemoryIndex;
    resident?: ResidentMemory;
    access?: MemoryAccess;
    board?: Board;
    dream?: DreamRunner;
    onWrite?: (path: string) => void;
    onBoardWrite?: (receipt: string) => void;
  };
  status: () => StatusResponse;
  ready: () => { ready: boolean; reasons: string[] };
  /** Deliver an operator injection through the console plugin. */
  pushConsole: (req: PushEventRequest, senderKey: string) => PushResult;
  /** Deliver the owner's message through the web chat. */
  pushChat?: (req: ChatMessageRequest, senderKey: string) => PushResult;
  /** What the next model request of a session would carry; undefined for an unknown session. */
  sessionContext?: (id: string, page: { from?: number; limit?: number }) => SessionContextResponse | undefined;
  keepAliveMs?: number;
  /** control.allowCidrs, parsed (empty: any address). */
  allowCidrs?: () => readonly Cidr[];
  /** Prometheus text exposition at /metrics. */
  metrics?: { render(): Promise<string>; contentType: string };
  /** Serve /metrics without a token (a scraper on a private network). */
  publicMetrics?: () => boolean;
  /** The built web console (apps/web/dist); null serves a "not built" page. */
  webDir?: () => string | null;
  /** State-changing requests are recorded as `control_write`. */
  audit?: AuditLog;
}

const MAX_HOOK_BODY = 1024 * 1024;

function errorJson(c: Context, status: 400 | 404 | 409 | 422, code: string, err: unknown) {
  return c.json({ error: { code, message: err instanceof Error ? err.message : String(err) } }, status);
}

function intParam(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

/**
 * HTTP control plane (docs/30-specs/05-control-api.md): health and metrics, status, events,
 * batches, sessions, plugins, MCP, Skills, approvals, memory, persona, configuration,
 * secrets, scheduler, logs, the SSE stream and the web console. The WebSocket lives in ws.ts.
 */
export function createControlApp(d: ControlDeps): Hono {
  const app = new Hono();
  const clientAddress = (c: Context): string => {
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const allowed = addressGate(d.allowCidrs ?? (() => []), d.log);
  app.use('*', async (c, next) => {
    if (allowed(clientAddress(c), c.req.path)) return next();
    return c.json({ error: { code: 'forbidden', message: 'this address may not use the control plane (control.allowCidrs)' } }, 403);
  });

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

  registerAuthRoutes(app, d.auth, clientAddress);
  const guard = requireAuth(d.auth);
  app.use('/api/*', guard);
  // Every state-changing request is audited (memory writes also get their own record).
  app.use('/api/*', async (c, next) => {
    await next();
    if (!d.audit || c.req.method === 'GET' || c.req.method === 'HEAD') return;
    d.audit.record({ kind: 'control_write', summary: `${c.req.method} ${c.req.path}`, owner: actorOf(principal(c)), outcome: String(c.res.status) });
  });
  registerAccountRoutes(app, d.auth);
  registerProviderRoutes(app, d.providers);
  registerSpeechRoutes(app, d.speech, (c) => actorOf(principal(c)));

  app.get('/metrics', async (c, next) => {
    if (!d.publicMetrics?.()) return guard(c, next);
    return next();
  });
  app.get('/metrics', async (c) => {
    if (!d.metrics) return c.text('# no metrics\n', 200);
    return c.body(await d.metrics.render(), 200, { 'content-type': d.metrics.contentType });
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
    const r = d.pushConsole(req, actorOf(principal(c)));
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

  // Newest first by default; `cursor` pages backwards (events older than it), `nextCursor` continues.
  app.get('/api/events', (c) => {
    const state = c.req.query('state');
    const states = state ? (state.split(',').filter((s) => (EVENT_STATES as readonly string[]).includes(s)) as EventState[]) : undefined;
    const since = intParam(c, 'since');
    const until = intParam(c, 'until');
    const before = intParam(c, 'cursor');
    const level = intParam(c, 'level');
    const limit = Math.min(Math.max(intParam(c, 'limit') ?? 100, 1), 1000);
    const source = c.req.query('source');
    const type = c.req.query('type');
    const order = c.req.query('order') === 'asc' ? 'asc' : 'desc';
    const upper = before !== undefined ? Math.min(before - 1, until ?? Number.MAX_SAFE_INTEGER) : until;
    const events = d.store.query({
      order,
      limit,
      ...(since !== undefined ? { sinceCursor: since } : {}),
      ...(upper !== undefined ? { untilCursor: upper } : {}),
      ...(level !== undefined && isLevel(level) ? { maxLevel: level } : {}),
      ...(source ? { source } : {}),
      ...(type ? { type } : {}),
      ...(states ? { states } : {}),
    });
    const last = events[events.length - 1];
    return c.json({ events, nextCursor: order === 'desc' && events.length === limit && last ? last.cursor : null });
  });

  // Images: admins only (auth.ts), like the memory they may hold.
  // A widget's code, for the chat window to hand to its sandbox frame. Always JSON: nothing serves it as a page.
  app.get('/api/widgets/:id', (c) => {
    const found = d.widgets?.get(c.req.param('id'));
    if (!found) return c.json({ error: { code: 'not_found', message: 'no such widget' } }, 404);
    return c.json(found, 200, { 'cache-control': 'private, max-age=86400, immutable', 'x-content-type-options': 'nosniff' });
  });

  app.get('/api/blobs/:handle', (c) => {
    // A read-only caller sees the images of the conversation it may read, and no others.
    if (principal(c).role === 'readonly' && !d.chat?.showsImage(c.req.param('handle'))) {
      return c.json({ error: { code: 'forbidden', message: 'a read-only account can only read images that appear in a conversation' } }, 403);
    }
    const found = d.blobs?.get(c.req.param('handle'));
    if (!found) return c.json({ error: { code: 'not_found', message: 'no such image' } }, 404);
    return new Response(new Uint8Array(found.bytes), {
      headers: { 'content-type': found.mime, 'cache-control': 'private, max-age=86400, immutable', 'x-content-type-options': 'nosniff' },
    });
  });
  app.post('/api/blobs', async (c) => {
    if (!d.blobs) return c.json({ error: { code: 'not_found', message: 'blobs are not available' } }, 404);
    const body = (await c.req.json().catch(() => null)) as { dataBase64?: unknown } | null;
    if (typeof body?.dataBase64 !== 'string' || body.dataBase64 === '') return c.json({ error: { code: 'bad_request', message: 'dataBase64 is required' } }, 400);
    const r = d.blobs.putImage(Buffer.from(body.dataBase64, 'base64'), 'console');
    if (!r.ok) return c.json({ error: { code: 'invalid_image', message: r.reason } }, 422);
    return c.json({ handle: r.blob.handle, mime: r.blob.mime, size: r.blob.size }, 201);
  });

  // The owner writes in the web chat.
  app.post('/api/chat/messages', async (c) => {
    if (!d.pushChat) return c.json({ error: { code: 'not_found', message: 'the web chat is not available' } }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'body must be JSON' } }, 400);
    }
    const b = body as Partial<ChatMessageRequest>;
    const images = Array.isArray(b.images) ? b.images : [];
    if (typeof b.text !== 'string' || (b.text.length === 0 && images.length === 0)) return c.json({ error: { code: 'bad_request', message: 'text is required' } }, 400);
    const stored = images.map((i) => d.blobs?.info(String(i?.handle)) ?? null);
    if (stored.includes(null)) return c.json({ error: { code: 'bad_request', message: 'an image is not stored; upload it with POST /api/blobs first' } }, 400);
    if (b.trigger !== undefined && b.trigger !== 'flush' && b.trigger !== 'interrupt') return c.json({ error: { code: 'bad_request', message: 'trigger must be flush or interrupt' } }, 400);
    const refs = stored.map((i) => ({ handle: (i as NonNullable<typeof i>).handle, mime: (i as NonNullable<typeof i>).mime }));
    const a = b.answer as { to?: unknown; labels?: unknown } | undefined;
    const okAnswer = a === undefined || (typeof a === 'object' && a !== null && typeof a.to === 'string' && a.to.length <= 256 && Array.isArray(a.labels) && a.labels.length <= 6 && a.labels.every((l) => typeof l === 'string' && l.length <= 40));
    if (!okAnswer) return c.json({ error: { code: 'bad_request', message: 'answer must be { to, labels }' } }, 400);
    const answer = a === undefined ? undefined : { to: a.to as string, labels: a.labels as string[] };
    const r = d.pushChat({ text: b.text, ...(b.trigger ? { trigger: b.trigger } : {}), ...(refs.length > 0 ? { images: refs } : {}), ...(answer ? { answer } : {}) }, actorOf(principal(c)));
    if (!r.ok || r.cursor === undefined) return c.json({ error: { code: 'rejected', message: 'message rejected', details: r.errors ?? [] } }, 422);
    const res: PushEventResponse = { cursor: r.cursor, effectiveLevel: r.effectiveLevel ?? 1, effectiveTrigger: r.effectiveTrigger ?? 'flush', deduped: r.deduped ?? false, warnings: r.warnings };
    return c.json(res, 201);
  });

  // A conversation (default: the web chat; `platform=all` for every platform), newest page first, items oldest first.
  app.get('/api/chat', (c) => {
    if (!d.chat) return c.json({ items: [], batches: [], before: null });
    const before = c.req.query('before');
    const limit = intParam(c, 'limit');
    const platform = c.req.query('platform');
    return c.json(d.chat.chat({ ...(before ? { before } : {}), ...(limit !== undefined ? { limit } : {}), ...(platform ? { platform } : {}) }));
  });

  app.get('/api/chat/batches', (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    return c.json({ batches: d.chat?.batches(ids) ?? [] });
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
    // thinking=summary (default) keeps the summarized thinking text but never the signature; none drops it.
    const mode = c.req.query('thinking') === 'none' ? 'none' : 'summary';
    const messages = all.slice(from, from + limit).map((m) => ({
      ...m,
      content: m.content
        .filter((b) => mode === 'summary' || !THINKING_TYPES.has(b.type))
        .map((b) =>
          b.type === 'thinking' ? { type: 'thinking', thinking: (b as { thinking?: string }).thinking ?? '' } : b.type === 'redacted_thinking' ? { type: 'redacted_thinking' } : b,
        ),
    }));
    return c.json({ total: all.length, from, messages });
  });

  app.get('/api/sessions/:id/context', (c) => {
    const from = intParam(c, 'from');
    const limit = intParam(c, 'limit');
    const r = d.sessionContext?.(c.req.param('id'), { ...(from !== undefined ? { from } : {}), ...(limit !== undefined ? { limit } : {}) });
    return r ? c.json(r) : c.json({ error: { code: 'not_found', message: 'no such session' } }, 404);
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
  app.get('/api/memory/tree', (c) => {
    if (!d.memory) return c.json({ files: [] });
    return c.json({ files: d.memory.store.listFiles().map((f) => ({ path: f.path, size: f.size, mtime: new Date(f.mtimeMs).toISOString() })) });
  });
  app.get('/api/memory/file', (c) => {
    if (!d.memory) return c.json({ error: { code: 'not_found', message: 'no memory directory' } }, 404);
    try {
      const rel = d.memory.store.relative(c.req.query('path') ?? '');
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
      const rel = d.memory.store.relative(c.req.query('path') ?? '');
      if (rel === '') throw new MemoryError('a file path is required');
      const text = await c.req.text();
      d.memory.store.writeText(rel, text);
      d.memory.onWrite?.(rel);
      return c.json({ ok: true, path: rel });
    } catch (err) {
      return errorJson(c, 400, 'invalid', err);
    }
  });
  app.get('/api/memory/search', (c) => {
    if (!d.memory) return c.json({ hits: [] });
    const q = c.req.query('q') ?? '';
    const paths = c.req.queries('paths');
    const limit = Math.min(Math.max(intParam(c, 'limit') ?? 10, 1), 50);
    const scope = c.req.query('scope');
    const hits: MemorySearchHit[] = d.memory.index.search(q, { ...(paths ? { paths } : {}), limit, ...(scope === 'notes' || scope === 'raw' || scope === 'all' ? { scope } : {}) });
    return c.json({ hits });
  });
  app.get('/api/memory/overview', (c) => {
    const m = d.memory;
    if (!m?.resident) return c.json({ error: { code: 'not_found', message: 'no resident memory' } }, 404);
    const body: MemoryOverview = {
      core: m.resident.usage(),
      index: m.resident.current().index,
      stale: m.resident.stale,
      checks: m.resident.checks(),
      recall: m.access ? m.access.recall(intParam(c, 'days') ?? 30, m.index.notes().map((n) => n.path)) : { days: 0, searches: 0, used: [], unused: [], misses: [] },
    };
    return c.json(body);
  });
  app.get('/api/memory/history', (c) => {
    if (!d.memory) return c.json({ error: { code: 'not_found', message: 'no memory directory' } }, 404);
    try {
      const rel = d.memory.store.relative(c.req.query('path') ?? '');
      const body: MemoryHistoryResponse = { path: rel, versions: d.memory.store.history(rel) };
      return c.json(body);
    } catch (err) {
      return errorJson(c, 400, 'invalid_path', err);
    }
  });
  app.get('/api/memory/board', (c) => {
    const board = d.memory?.board;
    if (!board) return c.json({ error: { code: 'not_found', message: 'no whiteboard' } }, 404);
    const body: BoardResponse = { rev: board.rev, items: board.open(), ...(c.req.query('closed') ? { closed: board.closed() } : {}) };
    return c.json(body);
  });
  app.post('/api/memory/board', async (c) => {
    const board = d.memory?.board;
    if (!board) return c.json({ error: { code: 'not_found', message: 'no whiteboard' } }, 404);
    const cmd = (await c.req.json().catch(() => null)) as BoardCommand | null;
    if (!cmd || typeof cmd !== 'object') return c.json({ error: { code: 'invalid', message: 'send a JSON board command' } }, 400);
    try {
      const receipt = board.apply(cmd, 'external');
      d.memory?.onBoardWrite?.(receipt);
      return c.json({ ok: true, receipt, rev: board.rev });
    } catch (err) {
      if (err instanceof BoardError) return errorJson(c, 400, 'invalid', err);
      throw err;
    }
  });
  app.get('/api/memory/dream', (c) => {
    const dream = d.memory?.dream;
    if (!dream) return c.json({ error: { code: 'not_found', message: 'no memory consolidation' } }, 404);
    return c.json(dream.status());
  });
  app.post('/api/memory/dream', (c) => {
    const dream = d.memory?.dream;
    if (!dream) return c.json({ error: { code: 'not_found', message: 'no memory consolidation' } }, 404);
    const r = dream.run({ manual: true });
    return r.started ? c.json(r, 202) : c.json({ error: { code: 'not_started', message: r.reason } }, 409);
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
    return p ? c.json({ ...p, manifest: d.plugins?.manifestOf(p.id) ?? null }) : c.json({ error: { code: 'not_found', message: 'no such plugin' } }, 404);
  });
  // { path } | { source: git, url, ref?, subdir? } | { source: tarball, url, subdir? }
  app.post('/api/plugins', async (c) => {
    if (!d.plugins) return c.json({ error: { code: 'unavailable', message: 'no plugin host' } }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: { code: 'bad_request', message: 'body must be { path } or { source, url }' } }, 400);
    const plugins = d.plugins;
    try {
      return c.json(await installFrom(body, (dir) => plugins.install(dir, { enable: body['enable'] !== false })), 201);
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
  for (const action of ['always-load', 'on-demand'] as const) {
    app.post(`/api/plugins/:id/${action}`, (c) => {
      const id = c.req.param('id');
      if (!d.plugins?.get(id) || !d.setPluginAlwaysLoad) return c.json({ error: { code: 'not_found', message: 'no such plugin' } }, 404);
      try {
        d.setPluginAlwaysLoad(id, action === 'always-load');
        return c.json(d.plugins.get(id));
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

  // Sign-in of plugins that have one.
  const noLogin = (c: Context) => c.json({ error: { code: 'not_found', message: 'this plugin has no sign-in' } }, 404);
  app.get('/api/plugins/:id/login', async (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.supportsLogin(id)) return noLogin(c);
    if (d.plugins.get(id)?.state !== 'running') return c.json({ state: 'unavailable', message: `plugin ${id} is not running` });
    try {
      return c.json(loginView(await d.plugins.loginStatus(id)));
    } catch (err) {
      return c.json({ state: 'unavailable', message: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/plugins/:id/login', async (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.supportsLogin(id)) return noLogin(c);
    try {
      return c.json(loginView(await d.plugins.loginStart(id)));
    } catch (err) {
      return errorJson(c, 409, 'login_failed', err);
    }
  });
  app.post('/api/plugins/:id/login/code', async (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.supportsLogin(id)) return noLogin(c);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    if (typeof body?.code !== 'string' || body.code.trim() === '') return c.json({ error: { code: 'bad_request', message: 'code must be a non-empty string' } }, 400);
    try {
      return c.json(loginView(await d.plugins.loginSubmit(id, body.code)));
    } catch (err) {
      return errorJson(c, 409, 'login_failed', err);
    }
  });
  app.post('/api/plugins/:id/login/cancel', async (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.supportsLogin(id)) return noLogin(c);
    try {
      return c.json(loginView(await d.plugins.loginCancel(id)));
    } catch (err) {
      return errorJson(c, 409, 'login_failed', err);
    }
  });
  app.delete('/api/plugins/:id/login', async (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.supportsLogin(id)) return noLogin(c);
    try {
      return c.json(await d.plugins.logout(id));
    } catch (err) {
      return errorJson(c, 409, 'logout_failed', err);
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
  // The bundled browser, with its fixed restrictions (docs/40-plan/08-sandbox-browser-vision.md §3).
  app.post('/api/mcp/presets/browser', async (c) => {
    if (!d.putMcpServer || !d.mcp || !d.browserPreset) return noMcp(c);
    if (d.browserAvailable && !d.browserAvailable()) {
      return c.json({ error: { code: 'unavailable', message: 'this image has no browser: build or pull the "browser" target' } }, 409);
    }
    const body = (await c.req.json().catch(() => null)) as { noSandbox?: unknown } | null;
    try {
      await d.putMcpServer(BROWSER_SERVER_ID, d.browserPreset({ ...(body?.noSandbox === true ? { noSandbox: true } : {}) }));
    } catch (err) {
      return errorJson(c, 400, 'invalid_server', err);
    }
    return c.json(d.mcp.get(BROWSER_SERVER_ID), 201);
  });
  app.delete('/api/mcp/servers/:id', async (c) => {
    const id = c.req.param('id');
    if (!d.mcp?.get(id) || !d.putMcpServer) return noMcp(c);
    await d.putMcpServer(id, null);
    return c.json({ ok: true });
  });
  for (const action of ['enable', 'disable', 'restart', 'always-load', 'on-demand'] as const) {
    app.post(`/api/mcp/servers/:id/${action}`, async (c) => {
      const id = c.req.param('id');
      if (!d.mcp?.get(id)) return noMcp(c);
      try {
        if (action === 'restart') return c.json(await d.mcp.restart(id));
        if (action === 'always-load' || action === 'on-demand') await d.setMcpAlwaysLoad?.(id, action === 'always-load');
        else await d.setMcpEnabled?.(id, action === 'enable');
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
  // { path } | { gitUrl, ref?, subdir? } | { source, url, … } as for plugins.
  app.post('/api/skills', async (c) => {
    if (!d.skills) return noSkill(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: { code: 'bad_request', message: 'body must be { path } or { gitUrl }' } }, 400);
    const skills = d.skills;
    try {
      return c.json(await installFrom(body, (dir) => skills.install(dir)), 201);
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

  // Change requests (docs/20-decisions/ADR-0019): what the assistant proposed for its own capabilities.
  // Deciding one is a write, so the read-only role is refused before it gets here; no other path decides.
  const CHANGE_STATES = ['pending', 'applied', 'rejected', 'failed', 'stale', 'expired', 'withdrawn'];
  const noChange = (c: Context) => c.json({ error: { code: 'not_found', message: 'no such change request' } }, 404);
  app.get('/api/changes', (c) => {
    const state = c.req.query('state');
    if (state !== undefined && !CHANGE_STATES.includes(state)) return c.json({ error: { code: 'bad_request', message: `state must be one of ${CHANGE_STATES.join(', ')}` } }, 400);
    return c.json({ changes: d.changes?.list(state as never, intParam(c, 'limit') ?? 50) ?? [] });
  });
  app.get('/api/changes/:id', (c) => {
    const detail = d.changes?.detail(c.req.param('id'));
    return detail ? c.json(detail) : noChange(c);
  });
  app.get('/api/changes/:id/file', (c) => {
    if (!d.changes?.get(c.req.param('id'))) return noChange(c);
    const r = d.changes.readFile(c.req.param('id'), c.req.query('path') ?? '');
    return 'error' in r ? c.json({ error: { code: 'unavailable', message: r.error } }, 409) : c.json(r);
  });
  app.post('/api/changes/:id/decide', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { decision?: unknown; note?: unknown } | null;
    if (body?.decision !== 'approve' && body?.decision !== 'reject') return c.json({ error: { code: 'bad_request', message: 'decision must be approve or reject' } }, 400);
    if (body.note !== undefined && typeof body.note !== 'string') return c.json({ error: { code: 'bad_request', message: 'note must be a string' } }, 400);
    if (!d.changes) return noChange(c);
    const who = principal(c);
    if (who.role !== 'admin') return c.json({ error: { code: 'forbidden', message: 'only an administrator decides a change request' } }, 403);
    const r = await d.changes.decide(c.req.param('id'), body.decision, actorOf(who), body.note);
    if (!r.ok) return c.json({ error: { code: r.change ? 'conflict' : 'not_found', message: r.message ?? 'not decided' } }, r.change ? 409 : 404);
    return c.json(d.changes.detail(c.req.param('id')));
  });

  // Schedules (the cron plugin).
  const noSchedules = (c: Context) => c.json({ error: { code: 'not_found', message: 'the cron plugin is not running' } }, 404);
  const scheduleInput = async (c: Context): Promise<ScheduleInput | null> => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return null;
    const text = (k: string): string | undefined => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
    return {
      ...(text('name') !== undefined ? { name: text('name') as string } : {}),
      ...(text('cron') ? { cron: text('cron') as string } : {}),
      ...(text('at') ? { at: text('at') as string } : {}),
      ...(text('note') !== undefined ? { note: text('note') as string } : {}),
      ...(b['level'] === 3 || b['level'] === 4 ? { level: b['level'] } : {}),
      ...(typeof b['enabled'] === 'boolean' ? { enabled: b['enabled'] } : {}),
    };
  };
  app.get('/api/schedules', (c) => c.json({ schedules: d.schedules?.list() ?? [] }));
  app.post('/api/schedules/preview', async (c) => {
    if (!d.schedules) return noSchedules(c);
    const input = await scheduleInput(c);
    if (!input) return c.json({ error: { code: 'bad_request', message: 'a JSON body is required' } }, 400);
    try {
      return c.json(d.schedules.preview(input));
    } catch (err) {
      return errorJson(c, 422, 'invalid', err);
    }
  });
  app.post('/api/schedules', async (c) => {
    if (!d.schedules) return noSchedules(c);
    const input = await scheduleInput(c);
    if (!input) return c.json({ error: { code: 'bad_request', message: 'a JSON body is required' } }, 400);
    try {
      return c.json(d.schedules.create(input), 201);
    } catch (err) {
      return errorJson(c, 422, 'invalid', err);
    }
  });
  app.patch('/api/schedules/:id', async (c) => {
    if (!d.schedules) return noSchedules(c);
    const id = c.req.param('id');
    if (!d.schedules.get(id)) return c.json({ error: { code: 'not_found', message: `no schedule ${id}` } }, 404);
    const input = await scheduleInput(c);
    if (!input) return c.json({ error: { code: 'bad_request', message: 'a JSON body is required' } }, 400);
    if (input.cron !== undefined && input.at !== undefined) return c.json({ error: { code: 'invalid', message: 'give at most one of cron or at' } }, 422);
    try {
      return c.json(d.schedules.update(id, input));
    } catch (err) {
      return errorJson(c, 422, 'invalid', err);
    }
  });
  app.delete('/api/schedules/:id', (c) => {
    if (!d.schedules) return noSchedules(c);
    try {
      return d.schedules.remove(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: `no schedule ${c.req.param('id')}` } }, 404);
    } catch (err) {
      return errorJson(c, 409, 'conflict', err);
    }
  });
  app.post('/api/schedules/:id/run', (c) => {
    if (!d.schedules) return noSchedules(c);
    return d.schedules.run(c.req.param('id')) ? c.json({ ok: true }, 202) : c.json({ error: { code: 'not_found', message: `no schedule ${c.req.param('id')}` } }, 404);
  });
  app.get('/api/schedules/:id/runs', (c) => {
    if (!d.schedules) return noSchedules(c);
    const info = d.schedules.get(c.req.param('id'));
    return c.json({ ...(info ? { schedule: info } : {}), runs: d.schedules.runs(c.req.param('id')) });
  });

  // Approvals.
  app.get('/api/approvals', (c) => {
    const state = c.req.query('state');
    const states = ['pending', 'approved', 'denied', 'expired', 'used'];
    if (state !== undefined && !states.includes(state)) return c.json({ error: { code: 'bad_request', message: `state must be one of ${states.join(', ')}` } }, 400);
    return c.json({ approvals: d.approvals?.list(state as never) ?? [] });
  });
  app.post('/api/approvals/:id/decide', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { decision?: unknown; grantMs?: unknown; note?: unknown } | null;
    if (body?.grantMs !== undefined && !(typeof body.grantMs === 'number' && body.grantMs > 0)) return c.json({ error: { code: 'bad_request', message: 'grantMs must be a positive number' } }, 400);
    if (body?.decision !== 'approve' && body?.decision !== 'deny') {
      return c.json({ error: { code: 'bad_request', message: 'decision must be approve or deny' } }, 400);
    }
    if (!d.approvals) return c.json({ error: { code: 'not_found', message: 'no approvals' } }, 404);
    const r = d.approvals.decide(c.req.param('id'), body.decision, 'console:admin', {
      ...(typeof body.grantMs === 'number' ? { grantMs: body.grantMs } : {}),
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note } : {}),
    });
    if (!r.ok) return c.json({ error: { code: r.state ? 'conflict' : 'not_found', message: r.message ?? 'not decided' } }, r.state ? 409 : 404);
    return c.json(d.approvals.get(c.req.param('id')));
  });
  app.get('/api/permissions/mode', (c) => (d.permissionModes ? c.json(d.permissionModes.info()) : c.json({ error: { code: 'not_found', message: 'permission modes are not available' } }, 404)));
  app.post('/api/permissions/mode', async (c) => {
    if (!d.permissionModes) return c.json({ error: { code: 'not_found', message: 'permission modes are not available' } }, 404);
    const b = (await c.req.json().catch(() => null)) as Partial<SetPermissionModeRequest> | null;
    if (typeof b?.mode !== 'string') return c.json({ error: { code: 'invalid', message: 'mode is required' } }, 400);
    try {
      return c.json(await d.permissionModes.set(b.mode, { by: actorOf(principal(c)), ...(typeof b.forMs === 'number' ? { forMs: b.forMs } : {}) }));
    } catch (err) {
      if (err instanceof PermissionModeError) return c.json({ error: { code: 'invalid', message: err.message } }, 400);
      throw err;
    }
  });
  app.get('/api/approvals/grants', (c) => c.json({ grants: d.approvals?.listGrants() ?? [] }));
  app.post('/api/approvals/grants/:id/revoke', (c) => {
    if (!d.approvals) return c.json({ error: { code: 'not_found', message: 'no approvals' } }, 404);
    const r = d.approvals.revokeGrant(c.req.param('id'), 'console:admin');
    if (!r.ok) return c.json({ error: { code: 'not_found', message: r.message ?? 'not revoked' } }, 404);
    return c.json(r.grant);
  });

  app.get('/api/stream', (c) => {
    const since = intParam(c, 'since');
    const trace = c.req.query('trace') === '1';
    const drafts = c.req.query('drafts') === '1';
    return streamSSE(c, async (stream) => {
      const queue: StreamMessage[] = [];
      let wake: (() => void) | null = null;
      const push = (m: StreamMessage): void => {
        queue.push(m);
        wake?.();
      };
      const unsub = subscribeStream(d.bus, (m) => push(m as StreamMessage), { trace, drafts });
      stream.onAbort(() => {
        unsub();
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
      unsub();
    });
  });

  registerOpsRoutes(app, { ...d, ...(d.audit ? { audit: d.audit } : {}) });
  registerConsole(app, d.webDir ?? (() => null));

  app.onError((err, c) => {
    d.log.error({ err: err.message, path: c.req.path }, 'control API error');
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  return app;
}
