import type { EventInput, ToolUseBlock } from '@protea/protocol';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../util/time.js';
import type { ToolDef } from './types.js';

const WINDOW_MS = 60_000;

export interface OutboundLimiterOptions {
  /** `pluginHost.outboundPerMinute`; null: unlimited. */
  perMinute: () => number | null;
  /** Tools of these owners send things out (connector plugins); tools with an `outboundKey` always do. */
  isConnector: (owner: string) => boolean;
  clock: Clock;
  log: Logger;
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
}

/**
 * Outbound rate limit per connector (docs/10-architecture/14-security-and-permissions.md §7):
 * at most `perMinute` calls of a connector's tools (other than read-only ones) in any sliding
 * minute, shared by the main session and forks. `chat_send` counts against its platform. Protects the owner from a send loop; the
 * refused call returns an error the model can act on, and each burst is recorded once.
 */
export class OutboundLimiter {
  private readonly calls = new Map<string, number[]>();
  private readonly noticedAt = new Map<string, number>();

  constructor(private readonly o: OutboundLimiterOptions) {}

  check(def: Pick<ToolDef, 'owner' | 'flags' | 'name' | 'outboundKey'>, use?: ToolUseBlock): string | null {
    if (def.flags?.readOnly || (!def.outboundKey && !this.o.isConnector(def.owner))) return null;
    const key = def.outboundKey ? def.outboundKey(use?.input as never) : def.owner;
    const limit = this.o.perMinute();
    if (limit === null) return null;
    const now = this.o.clock.now();
    const hits = (this.calls.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (hits.length < limit) {
      hits.push(now);
      this.calls.set(key, hits);
      return null;
    }
    this.calls.set(key, hits);
    const waitS = Math.max(1, Math.ceil((WINDOW_MS - (now - (hits[0] as number))) / 1000));
    const last = this.noticedAt.get(key);
    if (last === undefined || now - last >= WINDOW_MS) {
      this.noticedAt.set(key, now);
      this.o.log.warn({ plugin: key, tool: def.name, limit }, 'outbound rate limit reached');
      this.o.pushInternal({
        type: 'outbound.rate_limited',
        level: 4,
        trigger: 'store',
        text: `${key} reached its outbound limit (${limit} calls per minute); further calls such as ${def.name} were refused for about ${waitS}s.`,
        correlation: key,
      });
    }
    return `${key} already made ${hits.length} outbound calls in the last minute (limit ${limit}, pluginHost.outboundPerMinute). Wait about ${waitS}s, and combine what you want to say into fewer messages.`;
  }
}
