import type {
  ApprovalInfo,
  BatchEndReason,
  BatchReason,
  ChatDraftUpdate,
  EventEnvelope,
  ForkInfo,
  HandoffKind,
  Level,
  McpServerStatus,
  ModelDeltaTrace,
  ModelRequestTrace,
  ModelResponseTrace,
  PermissionModeInfo,
  PluginStatus,
  RunPhase,
  SchedulerAction,
  TerminalOutcome,
  ToolCallTrace,
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
  /** `id`: the stored row (outputs table); `batchId` and `callId`: the tool call that sent it. */
  'plugin.output': { plugin: string; channel?: string; text: string; at: string; id?: number; batchId?: string; callId?: string };
  /** A chat reply as the model writes it (the chat window); never stored, not external output. */
  'chat.draft': ChatDraftUpdate;
  'usage.recorded': UsageRecord;
  /** A model request is about to be sent (the latency metric measures up to here). */
  'model.request': ModelRequestTrace;
  /** Part of the reply as it streams (the console's run stream); never stored. */
  'model.delta': ModelDeltaTrace;
  /** A finished model reply, after it reached the transcript. */
  'model.response': ModelResponseTrace;
  /** A tool call started or ended. */
  'tool.call': ToolCallTrace;
  'scheduler.action': SchedulerAction;
  'fork.changed': ForkInfo;
  'plugin.changed': PluginStatus;
  'approval.changed': ApprovalInfo;
  'permission.mode': PermissionModeInfo;
  'mcp.changed': McpServerStatus;
  /** The Skills catalog changed (listed names). */
  'skills.changed': { names: string[] };
  /** The main session handed off to a new transcript (M4). */
  'session.handoff': { sessionId: string; from: string; to: string; notes: string; dropped: number; kept: number; kind: HandoffKind };
  /** Persona files or hooks changed on disk (M4). */
  'persona.changed': { files: string[] };
}

export type BusTopic = keyof BusTopics;
type Listener<K extends BusTopic> = (data: BusTopics[K]) => void;

/**
 * In-process typed pub/sub. Not persistent: it announces records that are
 * already persisted. A throwing listener never affects the publisher.
 */
export class Bus {
  private readonly listeners = new Map<BusTopic, Set<Listener<BusTopic>>>();
  private readonly taps = new Set<(topic: BusTopic, data: unknown) => void>();

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

  /** See every record on every topic (the crash trail, the WebSocket fan-out). */
  tap(fn: (topic: BusTopic, data: unknown) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  emit<K extends BusTopic>(topic: K, data: BusTopics[K]): void {
    for (const fn of this.taps) {
      try {
        fn(topic, data);
      } catch (err) {
        this.onListenerError(topic, err);
      }
    }
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
