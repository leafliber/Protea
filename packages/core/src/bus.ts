import type {
  ApprovalInfo,
  BatchEndReason,
  BatchReason,
  EventEnvelope,
  ForkInfo,
  Level,
  McpServerStatus,
  PluginStatus,
  RunPhase,
  SchedulerAction,
  TerminalOutcome,
} from '@protea/protocol';
import type { UsageRecord } from './db/repos.js';

export interface SettledData {
  cursors: number[];
  outcome: TerminalOutcome;
  batchId?: string;
  events: Array<{ cursor: number; source: string }>;
}

export interface BusTopics {
  'event.stored': EventEnvelope;
  /** A pending or archived event got a new trigger (aging, events_promote). */
  'event.promoted': EventEnvelope;
  'event.settled': SettledData;
  'session.phase': { sessionId: string; phase: RunPhase; batchId?: string; round?: number };
  'batch.started': { batchId: string; level: Level; reason: BatchReason; cursors: number[] };
  'batch.extended': { batchId: string; cursors: number[]; level: Level };
  'batch.ended': { batchId: string; endReason: BatchEndReason; rounds: number };
  'plugin.output': { plugin: string; channel?: string; text: string; at: string };
  'usage.recorded': UsageRecord;
  'scheduler.action': SchedulerAction;
  'fork.changed': ForkInfo;
  'plugin.changed': PluginStatus;
  'approval.changed': ApprovalInfo;
  'mcp.changed': McpServerStatus;
  /** The Skills catalog changed (listed names). */
  'skills.changed': { names: string[] };
}

export type BusTopic = keyof BusTopics;
type Listener<K extends BusTopic> = (data: BusTopics[K]) => void;

/**
 * In-process typed pub/sub. Not persistent: it announces records that are
 * already persisted. A throwing listener never affects the publisher.
 */
export class Bus {
  private readonly listeners = new Map<BusTopic, Set<Listener<BusTopic>>>();

  constructor(private readonly onListenerError: (topic: string, err: unknown) => void = () => {}) {}

  on<K extends BusTopic>(topic: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(fn as Listener<BusTopic>);
    return () => set.delete(fn as Listener<BusTopic>);
  }

  emit<K extends BusTopic>(topic: K, data: BusTopics[K]): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<K>)(data);
      } catch (err) {
        this.onListenerError(topic, err);
      }
    }
  }
}
