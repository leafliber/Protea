import type { ApprovalRequestParams, ChatPlatformDecl, ChatSendParams, ChatSendResult, EventInput, Level, SenderRole, TerminalOutcome, Trigger } from '@protea/protocol';
import type { KvNamespace } from '../db/repos.js';
import type { PushResult } from '../events/gateway.js';
import type { Logger } from '../observability/logger.js';
import type { ToolSpec } from '../tools/types.js';
import type { Clock } from '../util/time.js';

export type PluginKind = 'source' | 'connector' | 'tool';

/** What Core offers an in-process plugin; mirrors the out-of-process protocol (docs/30-specs/03-plugin-protocol.md). */
export interface PluginContext {
  readonly id: string;
  readonly config: Record<string, unknown>;
  readonly dataDir: string;
  readonly timezone: string;
  readonly log: Logger;
  readonly kv: KvNamespace;
  readonly clock: Clock;
  pushEvent(input: EventInput): PushResult;
  /** To the operator (stream subscribers); stored when the host keeps an output log. Pass the tool call's batch so a notice can be tied to the batch it came from. */
  emitOutput(o: { channel?: string; text: string; batchId?: string; sessionId?: string }): void;
  resolveSender(senderKey: string): SenderRole;
}

/**
 * Built-in plugins that run inside the daemon (console, cron). Third-party plugins
 * use the out-of-process protocol from M2; this interface keeps the same shape.
 */
export interface InprocPlugin {
  readonly id: string;
  readonly kind: PluginKind;
  readonly levelCap: Level;
  readonly triggers?: readonly Trigger[];
  readonly mayEmitInternal?: boolean;
  /** Absolute path of the plugin's ENV_PROMPT.md template. */
  readonly envPromptFile?: string;
  /** Tools whose default permission policy is `ask` (like a manifest's sideEffectTools). */
  readonly sideEffectTools?: readonly string[];
  start(ctx: PluginContext): Promise<void> | void;
  stop(): Promise<void> | void;
  tools?(): ToolSpec<never>[];
  /** Makes the plugin a chat platform: `chat_send` reaches the owner through `send`. */
  chat?: ChatPlatformDecl & { send(req: ChatSendParams): Promise<ChatSendResult> | ChatSendResult };
  envPromptVars?(): Record<string, unknown> | null;
  onEventsSettled?(events: Array<{ cursor: number }>, outcome: TerminalOutcome): void;
  /** Deliver an approval request to the owner through this channel. */
  onApprovalRequest?(req: ApprovalRequestParams): Promise<{ delivered: boolean }> | { delivered: boolean };
}
