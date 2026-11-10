import fs from 'node:fs';
import type { ModelRole } from '@protea/protocol';
import { isAbortError } from '../util/abort.js';
import { errorMessage } from '../util/errors.js';
import { ProviderError, type GenerateOptions, type Provider, type ProviderHealth, type ProviderRequest, type ProviderResponse } from './types.js';

/** One line of <run>/provider.jsonl. */
export interface RecordedCall {
  seq: number;
  at: string;
  role: ModelRole;
  model: string;
  ms: number;
  /** Only in `full` mode; already redacted (the recorder sits inside RedactingProvider). */
  request?: ProviderRequest;
  response?: ProviderResponse;
  error?: { kind?: string; message: string };
}

export type RecordMode = 'responses' | 'full';

/**
 * Records every model call of a run (docs/10-architecture/12-model-providers.md §9): responses
 * always, the requests too in `full` mode (large: every request carries the whole context).
 * Replays and test fixtures read it back with RecordedProvider.
 */
export class ProviderRecorder implements Provider {
  private seq = 0;

  constructor(
    private readonly inner: Provider,
    private readonly file: string,
    private readonly mode: RecordMode,
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

  countTokens(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<number | undefined> {
    return this.inner.countTokens ? this.inner.countTokens(req, opts) : Promise.resolve(undefined);
  }

  async generate(req: ProviderRequest, opts: GenerateOptions): Promise<ProviderResponse> {
    const t0 = Date.now();
    const base = { seq: ++this.seq, at: new Date(t0).toISOString(), role: req.role, model: this.inner.modelFor(req.role) };
    try {
      const response = await this.inner.generate(req, opts);
      this.write({ ...base, ms: Date.now() - t0, ...(this.mode === 'full' ? { request: req } : {}), response });
      return response;
    } catch (err) {
      if (!isAbortError(err)) {
        this.write({ ...base, ms: Date.now() - t0, ...(this.mode === 'full' ? { request: req } : {}), error: { ...(err instanceof ProviderError ? { kind: err.kind } : {}), message: errorMessage(err) } });
      }
      throw err;
    }
  }

  private write(rec: RecordedCall): void {
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    } catch {
      // Recording is best effort; the call itself succeeded.
    }
  }
}

export function readRecording(file: string): RecordedCall[] {
  const out: RecordedCall[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RecordedCall);
    } catch {
      // A torn last line after a crash.
    }
  }
  return out;
}

/**
 * Plays a recording back: each request of a role gets that role's next recorded response (or
 * error), in order, with the text streamed as one delta. Offline and free; when the recording
 * runs out it fails like a provider would, which ends the replayed batch.
 */
export class RecordedProvider implements Provider {
  readonly id = 'recorded';
  private readonly queues = new Map<ModelRole, RecordedCall[]>();
  readonly served: RecordedCall[] = [];

  constructor(calls: readonly RecordedCall[]) {
    for (const c of calls) this.queues.set(c.role, [...(this.queues.get(c.role) ?? []), c]);
  }

  modelFor(role: ModelRole): string {
    return this.queues.get(role)?.[0]?.model ?? 'recorded';
  }

  health(): ProviderHealth {
    return { ready: true };
  }

  /** Calls not played back yet, per role. */
  remaining(): Record<string, number> {
    return Object.fromEntries([...this.queues].map(([r, q]) => [r, q.length]));
  }

  async generate(req: ProviderRequest, opts: GenerateOptions): Promise<ProviderResponse> {
    if (opts.signal.aborted) throw opts.signal.reason ?? new Error('aborted');
    const next = this.queues.get(req.role)?.shift();
    if (!next) throw new ProviderError('fatal', `the recording has no more ${req.role} responses`);
    this.served.push(next);
    if (next.error) throw new ProviderError((next.error.kind as ProviderError['kind']) ?? 'fatal', `recorded error: ${next.error.message}`);
    const response = next.response as ProviderResponse;
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (text && opts.onText) opts.onText(text);
    return structuredClone(response);
  }
}
