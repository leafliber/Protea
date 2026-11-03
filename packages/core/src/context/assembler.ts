import type { ContentBlock, Effort, ModelRole, TranscriptMessage } from '@protea/protocol';
import type { ProviderRequest, SystemSegment } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * Merge consecutive same-role messages. Deterministic, so the merged prefix of an
 * append-only history is stable across requests (prompt caching).
 */
export function mergeConsecutive(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (prev && prev.role === m.role) {
      prev.content = [...prev.content, ...m.content];
    } else {
      out.push({ role: m.role, content: [...m.content] as ContentBlock[] });
    }
  }
  return out;
}

export interface SegmentSource {
  /** Ordered system segments; changes only at turn boundaries. */
  segments(): SystemSegment[];
}

/** Builds provider requests: stable prefix (tools, system) first, append-only history after. */
export class ContextAssembler {
  constructor(
    private readonly source: SegmentSource,
    private readonly tools: ToolRegistry,
  ) {}

  build(
    messages: readonly TranscriptMessage[],
    opts: { role: ModelRole; effort: Effort; tools?: ReadonlySet<string> },
  ): ProviderRequest {
    const allowed = opts.tools;
    return {
      role: opts.role,
      system: this.source.segments(),
      messages: mergeConsecutive(messages),
      tools: this.tools.forProvider(allowed ? (d) => allowed.has(d.name) : undefined),
      effort: opts.effort,
    };
  }
}
