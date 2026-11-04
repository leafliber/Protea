import type { Bus } from '../bus.js';
import type { ModelRole } from '@protea/protocol';
import type { Provider, ProviderHealth, ProviderRequest, ProviderResponse } from '../providers/types.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from './logger.js';

/**
 * Trace lines for real-world testing (docs/10-architecture/15-observability.md §2): one line per
 * model call, per stored event, per batch and per approval change. They carry metadata only —
 * sizes, levels, tokens, timings — never message or event text unless `observability.logEventText`
 * is on, so a log file can be shared for debugging.
 */

/** Share of the prompt read from the cache: cacheRead / (input + cacheRead + cacheWrite). */
export function cacheHitRatio(u: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | null {
  const total = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return total > 0 ? Math.round((u.cacheReadTokens / total) * 1000) / 1000 : null;
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

/** Logs every model call (all roles: main, fork, cheap/handoff notes) with tokens, cache share and time. */
export class TracingProvider implements Provider {
  constructor(
    private readonly inner: Provider,
    private readonly log: Logger,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  modelFor(role: ModelRole): string {
    return this.inner.modelFor(role);
  }

  health(): ProviderHealth {
    return this.inner.health();
  }

  supportsToolSearch(role: ModelRole): boolean {
    return this.inner.supportsToolSearch?.(role) ?? false;
  }

  contextWindow(role: ModelRole): number | undefined {
    return this.inner.contextWindow?.(role);
  }

  countTokens(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<number | undefined> {
    return this.inner.countTokens ? this.inner.countTokens(req, opts) : Promise.resolve(undefined);
  }

  async generate(req: ProviderRequest, opts: { signal: AbortSignal; onText?: (delta: string) => void }): Promise<ProviderResponse> {
    const t0 = Date.now();
    const base = { role: req.role, messages: req.messages.length, tools: req.tools?.length ?? 0 };
    try {
      const r = await this.inner.generate(req, opts);
      const u = r.usage;
      this.log.info(
        {
          ...base,
          model: r.model,
          ...(r.model !== r.requestedModel ? { requested: r.requestedModel } : {}),
          ms: Date.now() - t0,
          stop: r.stopReason,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          cacheHit: cacheHitRatio(u),
          ...(r.costUsd !== undefined ? { costUsd: Math.round(r.costUsd * 1e6) / 1e6 } : {}),
        },
        'model call',
      );
      return r;
    } catch (err) {
      const ms = Date.now() - t0;
      if (isAbort(err, opts.signal)) this.log.debug({ ...base, model: this.inner.modelFor(req.role), ms }, 'model call cancelled');
      else {
        const kind = (err as { kind?: unknown }).kind;
        this.log.warn(
          { ...base, model: this.inner.modelFor(req.role), ms, ...(typeof kind === 'string' ? { kind } : {}), err: errorMessage(err) },
          'model call failed',
        );
      }
      throw err;
    }
  }
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Subscribes trace lines to the bus; returns the unsubscribe function. */
export function traceBus(bus: Bus, log: Logger, o: { eventText: () => boolean }): () => void {
  const offs = [
    bus.on('event.stored', (e) => {
      log.info(
        {
          cursor: e.cursor,
          source: e.source,
          type: e.type,
          origin: e.origin,
          eventLevel: e.effLevel,
          trigger: e.effTrigger,
          ...(e.effLevel !== e.level ? { declaredLevel: e.level } : {}),
          state: e.state,
          ...(e.senderRole ? { sender: e.senderRole } : {}),
          chars: e.text.length,
          ...(o.eventText() ? { text: clip(e.text, 2000) } : {}),
        },
        'event stored',
      );
    }),
    bus.on('event.promoted', (e) => log.info({ cursor: e.cursor, trigger: e.effTrigger, state: e.state }, 'event promoted')),
    bus.on('event.settled', (s) =>
      log.debug({ cursors: s.cursors.slice(0, 50), count: s.cursors.length, outcome: s.outcome, ...(s.batchId ? { batch: s.batchId } : {}) }, 'events settled'),
    ),
    bus.on('batch.started', (b) =>
      log.info({ batch: b.batchId, batchLevel: b.level, reason: b.reason, events: b.cursors.length, cursors: b.cursors.slice(0, 20) }, 'batch started'),
    ),
    bus.on('batch.extended', (b) => log.info({ batch: b.batchId, batchLevel: b.level, added: b.cursors.length, cursors: b.cursors.slice(0, 20) }, 'batch extended')),
    bus.on('approval.changed', (a) =>
      log.info({ approval: a.id, tool: a.tool, state: a.state, ...(a.decidedBy ? { by: a.decidedBy } : {}) }, 'approval changed'),
    ),
    bus.on('fork.changed', (f) => log.debug({ fork: f.id, state: f.state, forkLevel: f.level, rounds: f.rounds }, 'fork changed')),
  ];
  return () => {
    for (const off of offs) off();
  };
}
