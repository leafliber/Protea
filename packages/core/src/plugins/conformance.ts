import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import {
  LEVEL_TRIGGERS,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_TO_HOST,
  RPC_ERRORS,
  RpcError,
  type EventInput,
  type Level,
  type RpcHandler,
  type ToolCallResult,
  type ToolDecl,
} from '@protea/protocol';
import { createAjv, validateEventInput } from '../events/validate.js';
import { allowedTriggers, loadManifest } from './manifest.js';
import { ProcessPlugin, type StartedPlugin } from './process.js';

/** Optional calls to exercise, usually from `protea.conformance.json` in the plugin directory. */
export interface ConformanceProbe {
  config?: Record<string, unknown>;
  calls?: Array<{ tool: string; input: unknown; expect?: string }>;
  /** A call that should end early with a partial result when cancelled. */
  cancel?: { tool: string; input: unknown };
  /** Minimum number of events the calls should have pushed. */
  events?: number;
  /** Chat platforms: send this through `chat/send` and expect it to succeed (a real send, so it is opt-in). */
  chat?: { text: string };
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceResult {
  plugin: string;
  ok: boolean;
  checks: ConformanceCheck[];
  events: EventInput[];
}

export interface ConformanceOptions {
  dev?: { loader: string };
  pythonPath?: string;
  env?: Record<string, string>;
  probe?: ConformanceProbe;
  dataDir?: string;
}

const TOOL_RE = /^[a-z0-9]{2,4}_[a-z0-9_]+$/;

/**
 * Run a plugin against the protocol (docs/30-specs/03-plugin-protocol.md): handshake,
 * tool declarations, health, error codes, events, cancellation, clean stdout and a
 * clean stop. Used by the test suite and by `protea dev-plugin --check`.
 */
export async function checkConformance(dir: string, opts: ConformanceOptions = {}): Promise<ConformanceResult> {
  const checks: ConformanceCheck[] = [];
  const events: EventInput[] = [];
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  };
  const loaded = loadManifest(path.resolve(dir), 'data');
  const m = loaded.manifest;
  add('manifest is valid', loaded.errors.length === 0, loaded.errors.join('; ') || undefined);
  if (!m || loaded.errors.length > 0) return { plugin: m?.id ?? path.basename(dir), ok: false, checks, events };

  const probeFile = path.join(dir, 'protea.conformance.json');
  const probe: ConformanceProbe = opts.probe ?? (fs.existsSync(probeFile) ? (JSON.parse(fs.readFileSync(probeFile, 'utf8')) as ConformanceProbe) : {});
  const protocolErrors: string[] = [];
  const sink = { write: (line: string) => (line.includes('protocol error') ? protocolErrors.push(line) : 0) };
  const log = pino({ level: 'debug' }, sink);
  const levelCap = (m.level ?? 4) as Level;
  const triggers = allowedTriggers(m);
  const kv = new Map<string, unknown>();
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(fs.realpathSync(process.env['TMPDIR'] ?? '/tmp'), `protea-check-${m.id}-`));

  const blobs = new Map<string, Buffer>();
  const handlers: Record<string, RpcHandler> = {
    [PLUGIN_TO_HOST.eventsPush]: (params) => {
      const e = params as EventInput;
      const v = validateEventInput(e);
      if (!v.ok) throw new RpcError(RPC_ERRORS.InvalidParams, v.errors.join('; '));
      events.push(e);
      return { cursor: events.length, effectiveLevel: Math.max(e.level, levelCap), effectiveTrigger: e.trigger, deduped: false, warnings: [] };
    },
    [PLUGIN_TO_HOST.log]: () => undefined,
    [PLUGIN_TO_HOST.kvGet]: (p) => ({ value: kv.get((p as { key: string }).key) ?? null }),
    [PLUGIN_TO_HOST.kvSet]: (p) => (kv.set((p as { key: string }).key, (p as { value: unknown }).value), {}),
    [PLUGIN_TO_HOST.kvDelete]: (p) => (kv.delete((p as { key: string }).key), {}),
    [PLUGIN_TO_HOST.ownerResolve]: () => ({ role: 'unknown' }),
    [PLUGIN_TO_HOST.secretsExists]: () => ({ exists: false }),
    [PLUGIN_TO_HOST.approvalsDecide]: () => {
      throw new RpcError(RPC_ERRORS.Unauthorized, 'not the owner');
    },
    [PLUGIN_TO_HOST.blobPut]: (p) => {
      const data = Buffer.from((p as { dataBase64: string }).dataBase64, 'base64');
      const handle = `blob:${crypto.createHash('sha256').update(data).digest('hex')}`;
      blobs.set(handle, data);
      return { handle, mime: (p as { mime?: string }).mime ?? 'image/png', size: data.length };
    },
    [PLUGIN_TO_HOST.blobGet]: (p) => {
      const data = blobs.get((p as { handle: string }).handle);
      if (!data) throw new RpcError(RPC_ERRORS.InvalidParams, 'not stored');
      return { dataBase64: data.toString('base64'), mime: 'image/png', size: data.length };
    },
  };

  const runtime = m.runtime as NonNullable<typeof m.runtime>;
  let exec = runtime.exec;
  let args = runtime.args ?? [];
  if (opts.dev && runtime.dev) {
    exec = runtime.dev.exec ?? exec;
    args = runtime.dev.args ?? args;
  }
  if (exec === 'node') {
    exec = process.execPath;
    if (opts.dev) args = ['--conditions=source', '--import', opts.dev.loader, ...args];
  }
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', ...opts.env };
  if (opts.pythonPath) env['PYTHONPATH'] = opts.pythonPath;
  let crashed: string | null = null;
  const proc = new ProcessPlugin({
    id: m.id,
    exec,
    args,
    cwd: runtime.cwd ? path.resolve(dir, runtime.cwd) : path.resolve(dir),
    env,
    log,
    handlers,
    initializeTimeoutMs: 20_000,
    health: { intervalMs: 0, timeoutMs: 5000 },
    onUnexpectedExit: (reason) => {
      crashed = reason;
    },
  });

  let started: StartedPlugin;
  try {
    started = await proc.start({
      pluginId: m.id,
      config: probe.config ?? {},
      dataDir,
      hostDataDir: dataDir,
      timezone: 'UTC',
      language: 'en',
      hostCapabilities: ['events', 'kv', 'owner'],
      modelFacts: { mainModel: 'conformance' },
      levelCap,
      allowedTriggers: triggers,
    });
    add('initialize, tools/list and start succeed', true);
  } catch (err) {
    add('initialize, tools/list and start succeed', false, (err as Error).message);
    return { plugin: m.id, ok: false, checks, events };
  }

  try {
    add(
      `answers protocolVersion ${PLUGIN_PROTOCOL_VERSION} with a capabilities object`,
      started.init.protocolVersion === PLUGIN_PROTOCOL_VERSION && typeof started.init.capabilities === 'object' && started.init.capabilities !== null,
    );

    const ajv = createAjv();
    const bad: string[] = [];
    for (const t of started.tools as ToolDecl[]) {
      if (!TOOL_RE.test(t.name)) bad.push(`${t.name}: name must match ${TOOL_RE.source}`);
      if (!(m.tools ?? []).includes(t.name)) bad.push(`${t.name}: not declared in the manifest`);
      if (typeof t.description !== 'string' || t.description.trim() === '') bad.push(`${t.name}: missing description`);
      try {
        ajv.compile(t.inputSchema);
      } catch (err) {
        bad.push(`${t.name}: inputSchema does not compile (${(err as Error).message})`);
      }
    }
    add('tool declarations are valid and declared in the manifest', bad.length === 0, bad.join('; ') || undefined);

    const health = await proc.request<{ ok?: unknown }>('health', {}).catch((err: Error) => ({ ok: err.message }));
    add('health answers { ok: true }', health?.ok === true, health?.ok === true ? undefined : JSON.stringify(health));

    const unknown = await proc.request('no/such/method', {}).then(
      () => 'answered',
      (err: unknown) => (err instanceof RpcError ? err.code : 'other error'),
    );
    add('unknown methods answer MethodNotFound (-32601)', unknown === RPC_ERRORS.MethodNotFound, String(unknown));

    const ctx = { sessionId: 'main', batchId: 'b_check', batchLevel: 1 as Level };
    const noTool = await proc.request<ToolCallResult>('tools/call', { callId: 'x0', name: 'zz_nope', input: {}, context: ctx }).then(
      (r) => (r?.failed ? 'failed' : 'ran'),
      (err: unknown) => (err instanceof RpcError ? err.code : 'other error'),
    );
    add('calling an unknown tool is refused', noTool === RPC_ERRORS.ToolNotFound || noTool === 'failed', String(noTool));

    for (const c of probe.calls ?? []) {
      const r = await proc.callTool(c.tool, c.input, ctx, new AbortController().signal).catch((err: Error) => ({ text: err.message, failed: true }));
      const images = (r as { images?: unknown }).images;
      if (images !== undefined) {
        const known = Array.isArray(images) && images.every((i) => blobs.has((i as { handle?: string })?.handle ?? ''));
        add(`${c.tool} returns images it stored with blob/put`, known, known ? undefined : JSON.stringify(images).slice(0, 200));
      }
      const ok = !r.failed && (c.expect === undefined || r.text.includes(c.expect));
      add(`${c.tool} ${JSON.stringify(c.input)}${c.expect ? ` → "${c.expect}"` : ''}`, ok, ok ? undefined : JSON.stringify(r));
    }

    const declaresChat = m.chat !== undefined;
    const advertisesChat = started.init.capabilities.chat === true;
    if (declaresChat || advertisesChat) add('the manifest block "chat" and the "chat" capability go together', declaresChat && advertisesChat, `manifest: ${declaresChat}, capability: ${advertisesChat}`);
    const declaresLogin = m.login !== undefined;
    const advertisesLogin = started.init.capabilities.login === true;
    if (declaresLogin || advertisesLogin) add('the manifest block "login" and the "login" capability go together', declaresLogin && advertisesLogin, `manifest: ${declaresLogin}, capability: ${advertisesLogin}`);
    if (probe.chat) {
      const r = await proc.chatSend({ text: probe.chat.text }).catch((err: Error) => ({ ok: false, error: err.message }));
      add('chat/send delivers a message', r.ok === true, r.ok ? undefined : JSON.stringify(r));
    }

    if (probe.cancel) {
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort('cancel'), 200);
      const r = await proc.callTool(probe.cancel.tool, probe.cancel.input, ctx, ac.signal).catch((err: Error) => ({ text: err.message, failed: true, partial: false }));
      const ms = Date.now() - t0;
      add(`tools/cancel stops ${probe.cancel.tool} early with a partial result`, !!r.partial && ms < 5000, `${ms} ms: ${JSON.stringify(r)}`);
    }

    const allowed = new Set(triggers);
    const badEvents = events.filter((e) => e.level < levelCap || !allowed.has(e.trigger) || !(LEVEL_TRIGGERS[Math.max(e.level, levelCap) as Level] ?? []).includes(e.trigger));
    add(
      `pushed events are valid and within the level cap L${levelCap}`,
      badEvents.length === 0 && events.length >= (probe.events ?? 0),
      `${events.length} event(s)${badEvents.length ? `, out of bounds: ${badEvents.map((e) => `${e.type} L${e.level} ${e.trigger}`).join(', ')}` : ''}`,
    );
  } finally {
    const how = await proc.stop('conformance check done', 3000);
    add('stop: the process exits on its own', how === 'exited', how);
    add('stdout carries only protocol messages', protocolErrors.length === 0, protocolErrors.slice(0, 3).join(' | ') || undefined);
    add('no unexpected exit', crashed === null, crashed ?? undefined);
  }
  return { plugin: m.id, ok: checks.every((c) => c.ok), checks, events };
}
