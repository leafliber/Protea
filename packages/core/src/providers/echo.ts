import { isTextBlock, isToolResultBlock, type ModelRole } from '@protea/protocol';
import { estimateTokens } from '../util/tokens.js';
import { estimateRequestTokens } from './tokens.js';
import { sleep } from '../util/abort.js';
import { CHAT_SEND } from '../chat/hub.js';
import { reply, toolCall } from './scripted.js';
import type { Provider, ProviderHealth, ProviderRequest, ProviderResponse } from './types.js';

/** The owner's chat messages (answered with `chat_send`) and operator injections (answered with text). */
const CHAT_RE = /<event [^>]*type="chat\.message"[^>]*source="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/event>/g;
const CONSOLE_RE = /<event [^>]*source="console"[^>]*>\n([\s\S]*?)\n<\/event>/g;

/**
 * Offline development provider. For a batch containing the owner's chat messages it calls
 * `chat_send` with "echo: <text>" on the platform they came from, and it answers operator
 * injections with plain text; after tool results it ends the turn. Lets the
 * whole pipeline run without credentials (`providers.default: echo`). Usage is an estimate
 * of the request and the reply, so context handoff happens as it would with a real model
 * (long-running tests on echo would otherwise keep one ever-growing conversation).
 */
export class EchoProvider implements Provider {
  private seq = 0;

  constructor(
    private readonly delayMs = 0,
    readonly id = 'echo',
  ) {}

  async listModels(): Promise<string[]> {
    return ['echo'];
  }

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
    const chat: Array<{ platform: string; text: string }> = [];
    const injected: string[] = [];
    for (const t of texts) {
      for (const m of t.matchAll(CHAT_RE)) chat.push({ platform: m[1] as string, text: m[2] as string });
      for (const m of t.matchAll(CONSOLE_RE)) injected.push(m[1] as string);
    }
    const canSend = req.tools.some((t) => t.name === CHAT_SEND);
    const afterTools = blocks.some(isToolResultBlock);
    const first = chat[0];
    const out =
      first && canSend
        ? reply([toolCall(CHAT_SEND, { platform: first.platform, text: `echo: ${chat.map((c) => c.text).join('\n')}` }, `toolu_echo_${Date.now()}_${++this.seq}`)])
        : reply([{ type: 'text', text: injected.length > 0 ? `echo: ${injected.join('\n')}` : afterTools ? 'done' : 'nothing to do' }]);
    out.usage = { inputTokens: estimateRequestTokens(req), outputTokens: estimateTokens(JSON.stringify(out.content)), cacheReadTokens: 0, cacheWriteTokens: 0 };
    out.model = 'echo';
    out.requestedModel = 'echo';
    return out;
  }
}
