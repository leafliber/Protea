import crypto from 'node:crypto';
import type { ContentBlock, ModelRole, TranscriptMessage } from '@protea/protocol';
import { THINKING_TYPES } from '../context/prefix.js';
import type { Provider, ProviderHealth, ProviderRequest, ProviderResponse } from './types.js';

export interface SecretValues {
  /** Every known secret value, longest first. */
  knownValues(): Array<{ name: string; value: string }>;
}

class Scrubber {
  readonly hits = new Set<string>();
  constructor(private readonly values: ReadonlyArray<{ name: string; value: string }>) {}

  text(s: string): string {
    let out = s;
    for (const { name, value } of this.values) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(`[REDACTED:${name}]`);
      this.hits.add(name);
    }
    return out;
  }

  /** Strings anywhere inside a JSON value (tool inputs). */
  json(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.json(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.json(x)]));
    return v;
  }

  block(b: ContentBlock): ContentBlock {
    // Reasoning blocks are signed and opaque; the model only reasons about what it was shown.
    if (THINKING_TYPES.has(b.type)) return b;
    const out: ContentBlock = { ...b };
    if (typeof out['text'] === 'string') out['text'] = this.text(out['text']);
    if (b.type === 'tool_use' && 'input' in b) out['input'] = this.json(b['input']);
    if (b.type === 'tool_result') {
      const c = b['content'];
      if (typeof c === 'string') out['content'] = this.text(c);
      else if (Array.isArray(c)) out['content'] = (c as ContentBlock[]).map((x) => this.block(x));
    }
    return out;
  }

  message(m: TranscriptMessage): TranscriptMessage {
    return { role: m.role, content: m.content.map((b) => this.block(b)) };
  }
}

/** Replace every known secret value in the request text (invariant I-7). Deterministic for a given secret set. */
export function redactRequest(req: ProviderRequest, secrets: SecretValues): { req: ProviderRequest; hits: string[] } {
  const values = secrets.knownValues();
  if (values.length === 0) return { req, hits: [] };
  const s = new Scrubber(values);
  const out: ProviderRequest = {
    ...req,
    system: req.system.map((seg) => ({ id: seg.id, text: s.text(seg.text) })),
    messages: req.messages.map((m) => s.message(m)),
    tools: req.tools.map((t) => ({ ...t, description: s.text(t.description) })),
  };
  return { req: out, hits: [...s.hits].sort() };
}

/** Changes whenever the redacted secret set changes (part of the thinking-prefix fingerprint). */
export function secretsEpoch(secrets: SecretValues): string {
  const h = crypto.createHash('sha256');
  for (const { name, value } of secrets.knownValues()) h.update(`${name}\0${value}\0`);
  return h.digest('hex').slice(0, 12);
}

/**
 * Wraps a provider so no request carries a secret value (invariant I-7): the last line of
 * defence after secrets are kept out of prompts by construction. `onHit` hears which
 * secrets were found (names only).
 */
export class RedactingProvider implements Provider {
  constructor(
    private readonly inner: Provider,
    private readonly secrets: SecretValues,
    private readonly onHit?: (names: string[]) => void,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  modelFor(role: ModelRole): string {
    return this.inner.modelFor(role);
  }

  health(): ProviderHealth {
    return this.inner.health();
  }

  supportsToolSearch(role: ModelRole): boolean {
    return this.inner.supportsToolSearch?.(role) ?? false;
  }

  contextWindow(role: ModelRole): number | undefined {
    return this.inner.contextWindow?.(role);
  }

  cacheHorizonMs(role: ModelRole): number | undefined {
    return this.inner.cacheHorizonMs?.(role);
  }

  async countTokens(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<number | undefined> {
    if (!this.inner.countTokens) return undefined;
    return this.inner.countTokens(redactRequest(req, this.secrets).req, opts);
  }

  generate(req: ProviderRequest, opts: { signal: AbortSignal; onText?: (delta: string) => void }): Promise<ProviderResponse> {
    const { req: clean, hits } = redactRequest(req, this.secrets);
    if (hits.length > 0) this.onHit?.(hits);
    return this.inner.generate(clean, opts);
  }
}
