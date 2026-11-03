import { isTextBlock, isToolResultBlock, type ModelRole } from '@protea/protocol';
import { sleep } from '../util/abort.js';
import { reply, toolCall } from './scripted.js';
import type { Provider, ProviderHealth, ProviderRequest, ProviderResponse } from './types.js';

const EVENT_RE = /<event [^>]*source="console"[^>]*>\n([\s\S]*?)\n<\/event>/g;

/**
 * Offline development provider. For a batch containing console messages it calls
 * `con_send` with "echo: <text>"; after tool results it ends the turn. Lets the
 * whole pipeline run without credentials (`providers.default: echo`).
 */
export class EchoProvider implements Provider {
  readonly id = 'echo';
  private seq = 0;

  constructor(private readonly delayMs = 0) {}

  modelFor(_role: ModelRole): string {
    return 'echo';
  }

  health(): ProviderHealth {
    return { ready: true };
  }

  async generate(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResponse> {
    if (this.delayMs > 0) await sleep(this.delayMs, opts.signal);
    const last = req.messages.at(-1);
    const blocks = last?.role === 'user' ? last.content : [];
    const texts = blocks.filter(isTextBlock).map((b) => b.text);
    const lines: string[] = [];
    for (const t of texts) for (const m of t.matchAll(EVENT_RE)) if (m[1] !== undefined) lines.push(m[1]);
    const canSend = req.tools.some((t) => t.name === 'con_send');
    if (lines.length > 0 && canSend) {
      return reply([toolCall('con_send', { text: `echo: ${lines.join('\n')}` }, `toolu_echo_${Date.now()}_${++this.seq}`)]);
    }
    const afterTools = blocks.some(isToolResultBlock);
    return reply([{ type: 'text', text: afterTools ? 'done' : 'nothing to do' }]);
  }
}
