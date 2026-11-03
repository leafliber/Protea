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
import type { Bus, EventStore, Logger, PushResult, Transcript } from '@protea/core';

export interface ControlDeps {
  adminToken: string;
  bus: Bus;
  store: EventStore;
  log: Logger;
  transcript: () => Transcript;
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

function intParam(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * HTTP control plane (M0 subset of docs/30-specs/05-control-api.md): health,
 * status, events, the main transcript and a Server-Sent Events stream.
 */
export function createControlApp(d: ControlDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) => {
    const r = d.ready();
    return c.json(r, r.ready ? 200 : 503);
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

  app.get('/api/sessions/main/transcript', (c) => {
    const all = d.transcript().messages;
    const limit = Math.min(Math.max(intParam(c, 'limit') ?? 50, 1), 500);
    const from = intParam(c, 'from') ?? Math.max(0, all.length - limit);
    return c.json({ total: all.length, from, messages: all.slice(from, from + limit) });
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
