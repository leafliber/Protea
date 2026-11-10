import type { ContentBlock, ModelRole } from '@protea/protocol';
import { AbortedError, sleep } from '../util/abort.js';
import type { GenerateOptions, Provider, ProviderHealth, ProviderRequest, ProviderResponse } from './types.js';

export type ScriptStep = (
  req: ProviderRequest,
  index: number,
  ctx: GenerateOptions,
) => ProviderResponse | Error | Promise<ProviderResponse | Error>;

let toolSeq = 0;

export function reply(content: ContentBlock[], stopReason?: string): ProviderResponse {
  const hasTool = content.some((b) => b.type === 'tool_use');
  return {
    content,
    stopReason: stopReason ?? (hasTool ? 'tool_use' : 'end_turn'),
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'scripted',
    requestedModel: 'scripted',
  };
}

export function textReply(text: string): ProviderResponse {
  return reply([{ type: 'text', text }]);
}

export function toolCall(name: string, input: unknown, id = `toolu_${++toolSeq}`): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

/** Deterministic provider for tests: each call consumes the next step (the last one repeats). */
export class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly steps: ScriptStep[],
    private readonly delayMs = 0,
  ) {}

  modelFor(_role: ModelRole): string {
    return 'scripted';
  }

  health(): ProviderHealth {
    return { ready: true };
  }

  async generate(req: ProviderRequest, opts: GenerateOptions): Promise<ProviderResponse> {
    const index = this.calls.length;
    this.calls.push(structuredClone(req));
    if (this.delayMs > 0) await sleep(this.delayMs, opts.signal);
    const step = this.steps[Math.min(index, this.steps.length - 1)];
    if (!step) return textReply('');
    const out = await step(req, index, opts);
    if (opts.signal.aborted) throw new AbortedError(opts.signal.reason);
    if (out instanceof Error) throw out;
    return out;
  }
}
