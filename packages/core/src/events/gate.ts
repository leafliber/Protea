import {
  LEVEL_TRIGGERS,
  TRIGGERS,
  triggerStrength,
  type EventInput,
  type Level,
  type Origin,
  type SenderRole,
  type Trigger,
} from '@protea/protocol';
import type { OwnerRegistry } from './owner.js';
import { validateEventInput } from './validate.js';

/** What a source is allowed to do, from its manifest (or built-in declaration). */
export interface SourceCaps {
  source: string;
  /** Highest (numerically lowest) level the source may use. */
  maxLevel: Level;
  /** Further restricts the per-level trigger sets. */
  triggers?: readonly Trigger[];
  /** Only Core and audited built-ins may emit origin "internal". */
  mayEmitInternal?: boolean;
}

export interface GatedEvent extends EventInput {
  source: string;
  origin: Origin;
  effLevel: Level;
  effTrigger: Trigger;
  senderRole?: SenderRole;
}

export type GateResult = { ok: true; event: GatedEvent; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Pick the delivery mode to use when `requested` is not allowed:
 * the strongest allowed mode not stronger than requested, else the weakest allowed.
 */
export function pickTrigger(requested: Trigger, allowed: readonly Trigger[]): Trigger {
  if (allowed.includes(requested)) return requested;
  const ordered = TRIGGERS.filter((t) => allowed.includes(t));
  const weaker = ordered.filter((t) => triggerStrength(t) <= triggerStrength(requested));
  const pick = weaker.at(-1) ?? ordered[0];
  if (!pick) throw new Error('no delivery mode allowed');
  return pick;
}

/** Validation and level/trigger gating, in the order of docs/30-specs/01-event-envelope-schema.md §3. */
export function gateEvent(input: unknown, caps: SourceCaps, owner: OwnerRegistry): GateResult {
  const v = validateEventInput(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const ev = input as EventInput;
  const warnings: string[] = [];

  let origin: Origin = ev.origin ?? 'external';
  if (origin === 'internal' && !caps.mayEmitInternal) {
    warnings.push(`source ${caps.source} may not emit internal events; downgraded to external`);
    origin = 'external';
  }

  let effLevel: Level = ev.level;
  if (effLevel < caps.maxLevel) {
    warnings.push(`level ${ev.level} exceeds the cap ${caps.maxLevel} of source ${caps.source}`);
    effLevel = caps.maxLevel;
  }

  const senderRole = owner.resolve(caps.source, ev.senderKey);
  if (origin === 'external' && effLevel <= 1 && senderRole !== 'owner') {
    if (effLevel === 1) warnings.push('level 1 is reserved for the owner; downgraded to level 2');
    effLevel = 2;
  }

  const allowed = LEVEL_TRIGGERS[effLevel].filter((t) => !caps.triggers || caps.triggers.includes(t));
  const effTrigger = pickTrigger(ev.trigger, allowed.length > 0 ? allowed : LEVEL_TRIGGERS[effLevel]);
  if (effTrigger !== ev.trigger) {
    warnings.push(`trigger ${ev.trigger} is not allowed at level ${effLevel}; using ${effTrigger}`);
  }

  const event: GatedEvent = { ...ev, source: caps.source, origin, effLevel, effTrigger };
  if (senderRole !== undefined) event.senderRole = senderRole;
  return { ok: true, event, warnings };
}
