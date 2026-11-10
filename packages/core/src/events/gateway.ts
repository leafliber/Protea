import type { EventEnvelope, EventInput, Level, Trigger } from '@protea/protocol';
import type { Logger } from '../observability/logger.js';
import { stampInZone, type Clock } from '../util/time.js';
import { gateEvent, type GatedEvent, type SourceCaps } from './gate.js';
import type { OwnerRegistry } from './owner.js';
import type { EventStore } from './store.js';

/** The source of Core's own events. */
export const CORE_SOURCE = 'core';

export interface PushResult {
  ok: boolean;
  cursor?: number;
  effectiveLevel?: Level;
  effectiveTrigger?: Trigger;
  deduped?: boolean;
  warnings: string[];
  errors?: string[];
}

/** An event Core raises itself; the gateway sets the origin and, when absent, the time. */
export type InternalEventInput = Omit<EventInput, 'ts' | 'origin'> & { ts?: string };

/** Scheduling change for a new event after gating (budget enforcement); null keeps it. */
export type Admission = (ev: GatedEvent) => { trigger: Trigger; onStored(e: EventEnvelope): void } | null;

export interface EventGatewayOptions {
  store: EventStore;
  owner: OwnerRegistry;
  log: Logger;
  clock: Clock;
  /** Every stored `ts` is written in this zone, whatever offset the source used. */
  timezone: string;
}

/**
 * The single entry point for events into the store: plugins, MCP servers and Core itself
 * all come through here (docs/10-architecture/02-event-model.md). Gates each event against
 * what its source may do, applies budget admission and appends it.
 */
export class EventGateway {
  private admission: Admission | null = null;

  constructor(private readonly o: EventGatewayOptions) {}

  /** Budget enforcement depends on Core events of its own, so it is attached after construction. */
  setAdmission(admission: Admission): void {
    this.admission = admission;
  }

  /** Gate and store an event on behalf of a source. */
  push(caps: SourceCaps, input: EventInput): PushResult {
    const gated = gateEvent(input, caps, this.o.owner);
    if (!gated.ok) {
      this.o.log.warn({ source: caps.source, errors: gated.errors }, 'event rejected');
      return { ok: false, warnings: [], errors: gated.errors };
    }
    // One notation for every source, so the model never has to convert between offsets.
    gated.event.ts = stampInZone(gated.event.ts, this.o.timezone);
    // Budget enforcement changes the delivery mode of new events (not a downgrade notice per event).
    const admission = this.admission?.(gated.event) ?? null;
    if (admission) gated.event.effTrigger = admission.trigger;
    const { envelope, deduped } = this.o.store.append(gated.event);
    if (admission && !deduped) admission.onStored(envelope);
    if (gated.warnings.length > 0 && !deduped) {
      this.o.log.warn({ source: caps.source, cursor: envelope.cursor, warnings: gated.warnings }, 'event downgraded');
      if (caps.source !== CORE_SOURCE) {
        this.pushInternal({
          type: 'core.event_downgraded',
          level: 4,
          trigger: 'piggyback',
          text: `Event #${envelope.cursor} from ${caps.source} was adjusted: ${gated.warnings.join('; ')}.`,
          correlation: String(envelope.cursor),
        });
      }
    }
    return {
      ok: true,
      cursor: envelope.cursor,
      effectiveLevel: envelope.effLevel,
      effectiveTrigger: envelope.effTrigger,
      deduped,
      warnings: gated.warnings,
    };
  }

  /** Core's own events: origin internal, may use level 0. */
  pushInternal(input: InternalEventInput): PushResult {
    return this.push(
      { source: CORE_SOURCE, maxLevel: 0, mayEmitInternal: true },
      { ...input, ts: input.ts ?? new Date(this.o.clock.now()).toISOString(), origin: 'internal' },
    );
  }
}
