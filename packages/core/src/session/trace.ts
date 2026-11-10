import type { ContentBlock, ContextSummary, ModelDeltaTrace, ModelResponseTrace, SessionContextResponse, TranscriptMessage } from '@protea/protocol';
import { estimateMessagesTokens, estimateTokens } from '../util/tokens.js';
import type { ProviderRequest, ProviderResponse } from '../providers/types.js';

const DELTA_MS = 50;

/** Reasoning is shown by its summary text; signatures and encrypted reasoning stay out of every view. */
export function publicContent(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map((b) =>
    b.type === 'thinking' ? { type: 'thinking', thinking: (b as { thinking?: string }).thinking ?? '' } : b.type === 'redacted_thinking' ? { type: 'redacted_thinking' } : b,
  );
}

function toolTokens(t: ProviderRequest['tools'][number]): number {
  return estimateTokens(`${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`);
}

/** The sizes of a request, for the run stream. */
export function summarizeRequest(req: ProviderRequest, prefixChanged: boolean): ContextSummary {
  const segments = req.system.map((s) => ({ id: s.id, tokens: estimateTokens(s.text) }));
  const systemTokens = segments.reduce((a, s) => a + s.tokens, 0);
  const tools = req.tools.reduce((a, t) => a + toolTokens(t), 0);
  const messageTokens = estimateMessagesTokens(req.messages);
  return {
    segments,
    systemTokens,
    toolTokens: tools,
    messageTokens,
    estimatedTokens: systemTokens + tools + messageTokens,
    tools: req.tools.length,
    deferredTools: req.tools.filter((t) => t.deferLoading).length,
    messages: req.messages.length,
    prefixChanged,
  };
}

/** A finished reply as the run stream shows it. */
export function responseTrace(r: ProviderResponse, head: { sessionId: string; batchId: string; round?: number; at: string }): ModelResponseTrace {
  return {
    ...head,
    model: r.model,
    stopReason: r.stopReason,
    content: publicContent(r.content),
    usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens, cacheWriteTokens: r.usage.cacheWriteTokens },
  };
}

/** The next request of a session, laid out for the console. */
export function describeRequest(
  sessionId: string,
  req: ProviderRequest,
  o: { model: string; ownerOf: (tool: string) => string | undefined; from?: number; limit?: number; limits?: { softTokens: number; hardTokens: number }; cacheHitRatio?: number | null },
): SessionContextResponse {
  const system = req.system.map((s) => ({ id: s.id, text: s.text, tokens: estimateTokens(s.text) }));
  const tools = req.tools.map((t) => {
    const owner = o.ownerOf(t.name);
    return { name: t.name, description: t.description, tokens: toolTokens(t), deferred: t.deferLoading === true, ...(owner !== undefined ? { owner } : {}) };
  });
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
  const total = req.messages.length;
  const from = Math.min(Math.max(o.from ?? total - limit, 0), total);
  const messages: TranscriptMessage[] = req.messages.slice(from, from + limit).map((m) => ({ role: m.role, content: publicContent(m.content) }));
  const systemTokens = system.reduce((a, s) => a + s.tokens, 0);
  const toolSum = tools.reduce((a, t) => a + t.tokens, 0);
  const messageTokens = estimateMessagesTokens(req.messages);
  return {
    sessionId,
    role: req.role,
    effort: req.effort,
    model: o.model,
    system,
    tools,
    messages,
    from,
    totalMessages: total,
    totals: { systemTokens, toolTokens: toolSum, messageTokens, estimatedTokens: systemTokens + toolSum + messageTokens },
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.cacheHitRatio !== undefined ? { cacheHitRatio: o.cacheHitRatio } : {}),
  };
}

/** Coalesces streaming fragments so the run stream gets a few messages a second, in order. */
export class DeltaStream {
  private kind: ModelDeltaTrace['kind'] | null = null;
  private text = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (kind: ModelDeltaTrace['kind'], text: string) => void,
    private readonly intervalMs = DELTA_MS,
  ) {}

  push(kind: ModelDeltaTrace['kind'], text: string): void {
    if (text.length === 0) return;
    if (this.kind !== null && this.kind !== kind) this.flush();
    this.kind = kind;
    this.text += text;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.kind !== null && this.text.length > 0) this.emit(this.kind, this.text);
    this.kind = null;
    this.text = '';
  }
}
