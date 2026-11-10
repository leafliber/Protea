import type { Context, Hono } from 'hono';
import { isLevel, isTrigger, type BatchInfo, type BatchTraceResponse, type BatchTraceStep, type ConfigResponse, type SecretInfo } from '@protea/protocol';
import {
  DIAG_NAME_RE,
  fetchSource,
  listRuns,
  isGitTarget,
  parseSourceSpec,
  queryLogFile,
  type AuditLog,
  type AuditRecord,
  type BatchRepo,
  type EventStore,
  type ForkManager,
  type LogFilter,
  type LogRing,
  type PluginHost,
  type SkillRegistry,
  type UsageRepo,
} from '@protea/core';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { actorOf, principal } from './auth.js';

/** What the M5 operations need from the daemon; every part is optional (tests wire a subset). */
export interface OpsDeps {
  store: EventStore;
  batches?: BatchRepo;
  /** The steps of a batch, rebuilt from its transcript and outputs. */
  batchSteps?: (batchId: string) => BatchTraceStep[];
  usage?: UsageRepo;
  forks?: ForkManager;
  plugins?: PluginHost;
  skills?: SkillRegistry;
  scheduler?: {
    readonly paused: string | null;
    pause(by: string): boolean;
    resume(by: string): boolean;
    discard(levels: readonly number[], by: string): number[];
    cooldowns(): Array<{ source: string; untilMs: number }>;
  };
  config?: {
    get(): ConfigResponse;
    /** JSON Merge Patch on config.yaml: validated, written, applied. */
    patch(patch: Record<string, unknown>): Promise<{ changed: string[]; restartRequired: string[] }>;
  };
  secrets?: {
    list(): SecretInfo[];
    set(name: string, value: string): void;
    delete(name: string): { removed: boolean; fromEnv: boolean };
  };
  permissions?: () => Record<string, unknown>;
  budget?: () => Record<string, unknown>;
  /** Lift budget enforcement for a while (M6); held events return to their normal delivery. */
  budgetRelease?: (opts: { levels?: number[]; hardCap?: boolean; hours?: number; by: string }) => {
    levels: number[];
    hardCap: boolean;
    untilMs: number;
    promoted: number[];
  };
  /** Backups under <data>/backups (M6). The API never takes a filesystem path: only the default directory or a Git URL. */
  backups?: {
    dir: string;
    list(): Array<{ name: string; createdAt?: string; bytes?: number; archive: boolean }>;
    create(o: { archive?: boolean; includeWorkspace?: boolean; includeRuns?: boolean }): Promise<{ path: string; manifest: Record<string, unknown> }>;
    git(url: string): Promise<{ commit: string | null; changed: number }>;
  };
  logs?: { ring: LogRing; runsDir: string; runId: string };
  /** Diagnostics bundles under <data>/exports (admin only; they hold logs and the event store's metadata). */
  diagnostics?: {
    dir: string;
    list(): Array<{ name: string; bytes: number; createdAt: string }>;
    create(o: { sinceHours?: number; runs?: number; content?: boolean; recordings?: boolean; transcripts?: boolean }): Promise<{
      name: string;
      bytes: number;
      manifest: Record<string, unknown>;
    }>;
  };
  persona?: {
    listFiles(): Array<{ path: string; size: number; mtime: string }>;
    readFile(rel: string): string | undefined;
    writeFile(rel: string, text: string): string;
  };
  onPersonaWrite?: () => void;
  audit?: AuditLog;
}

const notFound = (c: Context, what: string) => c.json({ error: { code: 'not_found', message: what } }, 404);
const bad = (c: Context, message: string) => c.json({ error: { code: 'bad_request', message } }, 400);
const failed = (c: Context, status: 400 | 409 | 422 | 502, code: string, err: unknown) =>
  c.json({ error: { code, message: err instanceof Error ? err.message : String(err) } }, status);

function int(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

function time(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function logFilterOf(c: Context): LogFilter {
  const since = time(c.req.query('since'));
  const until = time(c.req.query('until'));
  const f: LogFilter = {};
  for (const k of ['level', 'component', 'plugin', 'q'] as const) {
    const v = c.req.query(k);
    if (v) f[k] = v;
  }
  if (since !== undefined) f.since = since;
  if (until !== undefined) f.until = until;
  const fields: Record<string, string> = {};
  for (const k of ['batch', 'session', 'cursor', 'tool', 'mcp', 'fork']) {
    const v = c.req.query(k);
    if (v) fields[k] = v;
  }
  if (Object.keys(fields).length > 0) f.fields = fields;
  return f;
}

async function body(c: Context): Promise<Record<string, unknown> | null> {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** M5 routes of docs/30-specs/05-control-api.md beside the M0–M4 ones in app.ts. */
export function registerOpsRoutes(app: Hono, d: OpsDeps): void {
  // —— Events ——
  app.post('/api/events/:cursor/promote', async (c) => {
    const cursor = Number(c.req.param('cursor'));
    const b = await body(c);
    const trigger = b?.['trigger'] ?? 'flush';
    if (!isTrigger(trigger) || trigger === 'store') return bad(c, 'trigger must be flush, debounce, piggyback, preempt or interrupt');
    const e = Number.isInteger(cursor) ? d.store.promote(cursor, trigger) : undefined;
    if (!e) {
      const cur = Number.isInteger(cursor) ? d.store.get(cursor) : undefined;
      return cur ? c.json({ error: { code: 'conflict', message: `event #${cursor} is ${cur.state}` } }, 409) : notFound(c, 'no such event');
    }
    return c.json({ event: e });
  });
  app.post('/api/events/:cursor/withdraw', (c) => {
    const cursor = Number(c.req.param('cursor'));
    const e = Number.isInteger(cursor) ? d.store.withdraw(cursor) : undefined;
    if (!e) {
      const cur = Number.isInteger(cursor) ? d.store.get(cursor) : undefined;
      return cur ? c.json({ error: { code: 'conflict', message: `event #${cursor} is ${cur.state}` } }, 409) : notFound(c, 'no such event');
    }
    return c.json({ event: e });
  });

  // —— Batches ——
  app.get('/api/batches', (c) => {
    if (!d.batches) return c.json({ batches: [] });
    const before = c.req.query('before');
    const session = c.req.query('session');
    const batches: BatchInfo[] = d.batches.list({
      ...(int(c.req.query('limit')) !== undefined ? { limit: int(c.req.query('limit')) as number } : {}),
      ...(before ? { before } : {}),
      ...(session ? { sessionId: session } : {}),
    });
    return c.json({ batches });
  });
  app.get('/api/batches/:id/trace', (c) => {
    const b = d.batches?.get(c.req.param('id'));
    if (!b) return notFound(c, 'no such batch');
    const steps = d.batchSteps?.(b.id) ?? [];
    const events = (d.batches?.cursorsOf(b.id) ?? []).map((n) => d.store.get(n)).filter((e) => e !== undefined);
    const res: BatchTraceResponse = { batch: b, events, steps };
    return c.json(res);
  });
  app.get('/api/batches/:id', (c) => {
    const b = d.batches?.get(c.req.param('id'));
    if (!b) return notFound(c, 'no such batch');
    const cursors = d.batches?.cursorsOf(b.id) ?? [];
    const events = cursors.map((n) => d.store.get(n)).filter((e) => e !== undefined);
    return c.json({ batch: b, events, rounds: d.usage?.forBatch(b.id) ?? [] });
  });

  // —— Forks ——
  app.post('/api/sessions/forks', async (c) => {
    if (!d.forks) return notFound(c, 'forks are not available');
    const b = await body(c);
    if (!b || typeof b['goal'] !== 'string' || !b['goal'].trim()) return bad(c, 'goal is required');
    const level = b['level'] ?? 3;
    if (!isLevel(level)) return bad(c, 'level must be 0–4');
    const model = b['model'];
    if (model !== undefined && model !== 'fork' && model !== 'main' && model !== 'cheap') return bad(c, 'model must be fork, main or cheap');
    const tools = b['tools'];
    if (tools !== undefined && !(Array.isArray(tools) && tools.every((t) => typeof t === 'string'))) return bad(c, 'tools must be a list of names');
    try {
      const f = d.forks.spawn({
        goal: b['goal'].trim(),
        level,
        reportTo: b['reportTo'] === 'none' ? 'none' : 'main',
        ...(typeof b['context'] === 'string' ? { context: b['context'] } : {}),
        ...(tools !== undefined ? { tools: tools as string[] } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(Number.isInteger(b['maxTurns']) ? { maxTurns: b['maxTurns'] as number } : {}),
      });
      return c.json(f, 201);
    } catch (err) {
      return failed(c, 422, 'refused', err);
    }
  });
  for (const action of ['pause', 'resume'] as const) {
    app.post(`/api/sessions/forks/:id/${action}`, (c) => {
      const id = c.req.param('id');
      if (!d.forks?.get(id)) return notFound(c, 'no such fork');
      try {
        return c.json(d.forks[action](id));
      } catch (err) {
        return failed(c, 409, `${action}_failed`, err);
      }
    });
  }

  // —— Plugins: details, configuration with schema, logs, remote installs ——
  app.get('/api/plugins/:id/config', (c) => {
    const cfg = d.plugins?.configOf(c.req.param('id'));
    return cfg ? c.json(cfg) : notFound(c, 'no such plugin');
  });
  app.get('/api/plugins/:id/logs', (c) => {
    const id = c.req.param('id');
    if (!d.plugins?.get(id)) return notFound(c, 'no such plugin');
    const limit = Math.min(Math.max(int(c.req.query('limit')) ?? 200, 1), 2000);
    return c.json({ logs: d.logs?.ring.query({ ...logFilterOf(c), plugin: id }, limit) ?? [] });
  });

  // —— Configuration ——
  app.get('/api/config', (c) => (d.config ? c.json(d.config.get()) : notFound(c, 'configuration is not available')));
  app.patch('/api/config', async (c) => {
    if (!d.config) return notFound(c, 'configuration is not available');
    const b = await body(c);
    if (!b) return bad(c, 'body must be a JSON object (JSON Merge Patch)');
    try {
      return c.json(await d.config.patch(b));
    } catch (err) {
      return failed(c, 400, 'invalid_config', err);
    }
  });
  const sectionRoutes: Array<['permissions' | 'budget', (() => Record<string, unknown>) | undefined]> = [
    ['permissions', d.permissions],
    ['budget', d.budget],
  ];
  for (const [section, get] of sectionRoutes) {
    app.get(`/api/${section}`, (c) => (get ? c.json(get()) : notFound(c, `${section} are not available`)));
    app.patch(`/api/${section}`, async (c) => {
      if (!d.config || !get) return notFound(c, `${section} are not available`);
      const b = await body(c);
      if (!b) return bad(c, 'body must be a JSON object (JSON Merge Patch of the section)');
      try {
        const r = await d.config.patch({ [section]: b });
        return c.json({ ...r, ...get() });
      } catch (err) {
        return failed(c, 400, 'invalid_config', err);
      }
    });
  }

  app.post('/api/budget/release', async (c) => {
    if (!d.budgetRelease) return notFound(c, 'budget release is not available');
    const b = (await body(c)) ?? {};
    const levels = b['levels'];
    if (levels !== undefined && !(Array.isArray(levels) && levels.every((l) => Number.isInteger(l) && (l as number) >= 2 && (l as number) <= 4))) {
      return bad(c, 'levels must be a list of 2, 3, 4');
    }
    if (b['hardCap'] !== undefined && typeof b['hardCap'] !== 'boolean') return bad(c, 'hardCap must be a boolean');
    if (b['hours'] !== undefined && typeof b['hours'] !== 'number') return bad(c, 'hours must be a number');
    try {
      const r = d.budgetRelease({
        ...(levels !== undefined ? { levels: levels as number[] } : {}),
        ...(b['hardCap'] !== undefined ? { hardCap: b['hardCap'] as boolean } : {}),
        ...(b['hours'] !== undefined ? { hours: b['hours'] as number } : {}),
        by: actorOf(principal(c)),
      });
      return c.json({ ...r, until: new Date(r.untilMs).toISOString() });
    } catch (err) {
      return failed(c, 400, 'bad_request', err);
    }
  });

  // —— Backups ——
  app.get('/api/backups', (c) => (d.backups ? c.json({ dir: d.backups.dir, backups: d.backups.list() }) : notFound(c, 'backups are not available')));
  app.post('/api/backups', async (c) => {
    if (!d.backups) return notFound(c, 'backups are not available');
    const b = (await body(c)) ?? {};
    const to = b['to'];
    try {
      if (to !== undefined) {
        if (typeof to !== 'string' || !isGitTarget(to)) return bad(c, 'to must be a Git URL (git@…, ssh://…, https://….git); directory backups always go to <data>/backups');
        return c.json(await d.backups.git(to));
      }
      const flags = Object.fromEntries((['archive', 'includeWorkspace', 'includeRuns'] as const).filter((k) => b[k] === true).map((k) => [k, true]));
      return c.json(await d.backups.create(flags));
    } catch (err) {
      return failed(c, 422, 'backup_failed', err);
    }
  });

  // —— Diagnostics bundles ——
  app.get('/api/diagnostics', (c) =>
    d.diagnostics ? c.json({ dir: d.diagnostics.dir, archives: d.diagnostics.list() }) : notFound(c, 'diagnostics are not available'),
  );
  app.post('/api/diagnostics', async (c) => {
    if (!d.diagnostics) return notFound(c, 'diagnostics are not available');
    const b = (await body(c)) ?? {};
    const num = (k: string, max: number): number | undefined | null => {
      const v = b[k];
      if (v === undefined) return undefined;
      return typeof v === 'number' && v > 0 && v <= max ? v : null;
    };
    const sinceHours = num('sinceHours', 24 * 90);
    const runs = num('runs', 100);
    if (sinceHours === null) return bad(c, 'sinceHours must be a number of hours from 0 to 2160');
    if (runs === null || (runs !== undefined && !Number.isInteger(runs))) return bad(c, 'runs must be an integer from 1 to 100');
    const flags = Object.fromEntries((['content', 'recordings', 'transcripts'] as const).filter((k) => b[k] === true).map((k) => [k, true]));
    try {
      return c.json(await d.diagnostics.create({ ...flags, ...(sinceHours !== undefined ? { sinceHours } : {}), ...(runs !== undefined ? { runs } : {}) }));
    } catch (err) {
      return failed(c, 422, 'diagnostics_failed', err);
    }
  });
  app.get('/api/diagnostics/:name', (c) => {
    if (!d.diagnostics) return notFound(c, 'diagnostics are not available');
    const name = c.req.param('name');
    if (!DIAG_NAME_RE.test(name)) return bad(c, 'not a diagnostics archive name');
    const file = path.join(d.diagnostics.dir, name);
    if (!fs.existsSync(file)) return notFound(c, `no diagnostics archive ${name}`);
    const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(fs.statSync(file).size),
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  });

  // —— Secrets: names only ——
  app.get('/api/secrets', (c) => c.json({ secrets: d.secrets?.list() ?? [] }));
  app.put('/api/secrets/:name', async (c) => {
    if (!d.secrets) return notFound(c, 'secrets are not available');
    const value = (await c.req.text()).trim();
    if (!value) return bad(c, 'the body is the secret value (plain text) and cannot be empty');
    try {
      d.secrets.set(c.req.param('name'), value);
    } catch (err) {
      return failed(c, 400, 'invalid_secret', err);
    }
    return c.json({ ok: true, secret: d.secrets.list().find((s) => s.name === c.req.param('name')) ?? null });
  });
  app.delete('/api/secrets/:name', (c) => {
    if (!d.secrets) return notFound(c, 'secrets are not available');
    try {
      const r = d.secrets.delete(c.req.param('name'));
      if (!r.removed && !r.fromEnv) return notFound(c, 'no such secret');
      return c.json({ ok: r.removed, stillSetByEnvironment: r.fromEnv });
    } catch (err) {
      return failed(c, 400, 'invalid_secret', err);
    }
  });

  // —— Scheduler ——
  app.get('/api/scheduler', (c) => {
    if (!d.scheduler) return notFound(c, 'no scheduler');
    return c.json({ paused: d.scheduler.paused, cooldowns: d.scheduler.cooldowns(), pending: d.store.pendingCounts() });
  });
  app.post('/api/scheduler/pause', (c) => {
    if (!d.scheduler) return notFound(c, 'no scheduler');
    const changed = d.scheduler.pause(actorOf(principal(c)));
    return c.json({ paused: d.scheduler.paused, changed });
  });
  app.post('/api/scheduler/resume', (c) => {
    if (!d.scheduler) return notFound(c, 'no scheduler');
    const changed = d.scheduler.resume(actorOf(principal(c)));
    return c.json({ paused: d.scheduler.paused, changed });
  });
  app.post('/api/scheduler/discard', async (c) => {
    if (!d.scheduler) return notFound(c, 'no scheduler');
    const b = await body(c);
    const levels = b?.['levels'];
    if (!Array.isArray(levels) || levels.length === 0 || !levels.every((l) => isLevel(l) && l >= 2)) {
      return bad(c, 'levels must be a non-empty list of levels 2–4 (L0/L1 events are never discarded in bulk)');
    }
    const cursors = d.scheduler.discard(levels as number[], actorOf(principal(c)));
    return c.json({ discarded: cursors.length, cursors });
  });

  // —— Logs and runs ——
  app.get('/api/logs', async (c) => {
    if (!d.logs) return c.json({ logs: [] });
    const limit = Math.min(Math.max(int(c.req.query('limit')) ?? 200, 1), 5000);
    let filter: LogFilter;
    try {
      filter = logFilterOf(c);
      const run = c.req.query('run');
      if (run && run !== d.logs.runId) {
        if (!/^[0-9A-Z]{26}$/.test(run)) return bad(c, 'invalid run id');
        return c.json({ run, logs: await queryLogFile(path.join(d.logs.runsDir, run, 'log.jsonl'), filter, limit) });
      }
      return c.json({ run: d.logs.runId, logs: d.logs.ring.query(filter, limit) });
    } catch (err) {
      return failed(c, 400, 'bad_filter', err);
    }
  });
  app.get('/api/runs', (c) => c.json({ current: d.logs?.runId ?? null, runs: d.logs ? listRuns(d.logs.runsDir) : [] }));
  app.get('/api/runs/:id', (c) => {
    const id = c.req.param('id');
    if (!d.logs || !/^[0-9A-Z]{26}$/.test(id)) return notFound(c, 'no such run');
    const dir = path.join(d.logs.runsDir, id);
    if (!fs.existsSync(dir)) return notFound(c, 'no such run');
    const read = (f: string): unknown => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
      } catch {
        return null;
      }
    };
    const crashDir = path.join(dir, 'crash');
    const crashes = fs.existsSync(crashDir) ? fs.readdirSync(crashDir).sort().map((f) => ({ file: f, report: read(path.join(crashDir, f)) })) : [];
    return c.json({ id, info: listRuns(d.logs.runsDir).find((r) => r.id === id) ?? null, shutdown: read(path.join(dir, 'shutdown.json')), crashes });
  });

  // —— Persona files (Markdown only) ——
  app.get('/api/persona/files', (c) => c.json({ files: d.persona?.listFiles() ?? [] }));
  app.get('/api/persona/file', (c) => {
    if (!d.persona) return notFound(c, 'no persona');
    try {
      const rel = c.req.query('path') ?? '';
      const text = d.persona.readFile(rel);
      return text === undefined ? notFound(c, 'no such persona file') : c.json({ path: rel.replace(/^\/+/, ''), text });
    } catch (err) {
      return failed(c, 400, 'invalid_path', err);
    }
  });
  app.put('/api/persona/file', async (c) => {
    if (!d.persona) return notFound(c, 'no persona');
    try {
      const rel = d.persona.writeFile(c.req.query('path') ?? '', await c.req.text());
      d.onPersonaWrite?.();
      return c.json({ ok: true, path: rel });
    } catch (err) {
      return failed(c, 400, 'invalid_path', err);
    }
  });

  // —— Audit ——
  app.get('/api/audit', (c) => {
    const kind = c.req.query('kind') as AuditRecord['kind'] | undefined;
    const tool = c.req.query('tool');
    const limit = int(c.req.query('limit'));
    return c.json({ audit: d.audit?.list({ ...(kind ? { kind } : {}), ...(tool ? { tool } : {}), ...(limit !== undefined ? { limit } : {}) }) ?? [] });
  });

}

/** Install a plugin or skill from a path, git repository or tarball (`{ path }`, `{ gitUrl }`, `{ source, url, ref?, subdir? }`). */
export async function installFrom<T>(raw: Record<string, unknown>, install: (dir: string) => Promise<T> | T): Promise<T> {
  const spec = parseSourceSpec(raw);
  const { dir, cleanup } = await fetchSource(spec);
  try {
    return await install(dir);
  } finally {
    cleanup();
  }
}
