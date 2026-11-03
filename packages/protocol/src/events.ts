/** Event model shared by Core, plugins, the control plane and the CLI. See docs/30-specs/01-event-envelope-schema.md. */

export const LEVELS = [0, 1, 2, 3, 4] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_NAMES: Readonly<Record<Level, string>> = {
  0: 'critical',
  1: 'interactive',
  2: 'reactive',
  3: 'scheduled',
  4: 'ambient',
};

/** Delivery modes, ordered from weakest to strongest. */
export const TRIGGERS = ['store', 'piggyback', 'debounce', 'flush', 'preempt', 'interrupt'] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Which delivery modes each level may use (docs/10-architecture/02-event-model.md §4). */
export const LEVEL_TRIGGERS: Readonly<Record<Level, readonly Trigger[]>> = {
  0: ['flush', 'interrupt'],
  1: ['debounce', 'flush', 'preempt', 'interrupt'],
  2: ['debounce', 'flush', 'preempt'],
  3: ['piggyback', 'debounce', 'flush'],
  4: ['store', 'piggyback'],
};

export type Origin = 'external' | 'internal';
export type SenderRole = 'owner' | 'unknown';

export const EVENT_STATES = [
  'pending',
  'archived',
  'delivering',
  'delivered',
  'withdrawn',
  'expired',
  'discarded',
] as const;
export type EventState = (typeof EVENT_STATES)[number];

export const TERMINAL_OUTCOMES = ['delivered', 'withdrawn', 'expired', 'discarded'] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

export interface BlobRef {
  handle: string;
  mime: string;
  name?: string;
  size?: number;
}

/** What a source submits. Core-assigned fields are absent. */
export interface EventInput {
  type: string;
  ts: string;
  origin?: Origin;
  level: Level;
  trigger: Trigger;
  text: string;
  senderKey?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  blobs?: BlobRef[];
  dedupeKey?: string;
  correlation?: string;
  ephemeral?: boolean;
  expiresAt?: string;
}

/** A persisted event. */
export interface EventEnvelope extends EventInput {
  cursor: number;
  run: string;
  receivedAt: string;
  source: string;
  origin: Origin;
  effLevel: Level;
  effTrigger: Trigger;
  state: EventState;
  senderRole?: SenderRole;
  batchId?: string;
}

export const EVENT_INPUT_SCHEMA = {
  $id: 'https://protea.dev/schemas/event-input.json',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'ts', 'level', 'trigger', 'text'],
  properties: {
    type: { type: 'string', pattern: '^[a-z0-9-]+\\.[a-z0-9_.-]+$', maxLength: 128 },
    ts: { type: 'string', format: 'date-time' },
    origin: { type: 'string', enum: ['external', 'internal'] },
    level: { type: 'integer', minimum: 0, maximum: 4 },
    trigger: { type: 'string', enum: [...TRIGGERS] },
    text: { type: 'string', maxLength: 65536 },
    senderKey: { type: 'string', maxLength: 256 },
    tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 32 },
    meta: { type: 'object' },
    blobs: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        required: ['handle', 'mime'],
        properties: {
          handle: { type: 'string', pattern: '^blob:[a-f0-9]{64}$' },
          mime: { type: 'string' },
          name: { type: 'string' },
          size: { type: 'integer', minimum: 0 },
        },
      },
    },
    dedupeKey: { type: 'string', maxLength: 256 },
    correlation: { type: 'string', maxLength: 256 },
    ephemeral: { type: 'boolean' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

export function isLevel(v: unknown): v is Level {
  return typeof v === 'number' && (LEVELS as readonly number[]).includes(v);
}

export function isTrigger(v: unknown): v is Trigger {
  return typeof v === 'string' && (TRIGGERS as readonly string[]).includes(v);
}

export function triggerStrength(t: Trigger): number {
  return TRIGGERS.indexOf(t);
}
