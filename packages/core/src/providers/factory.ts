import type { ModelRole } from '@protea/protocol';
import type { ProviderProfile, ProvidersSettings } from '../config/types.js';
import type { SecretStore } from '../config/secrets.js';
import { errorMessage } from '../util/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { EchoProvider } from './echo.js';
import { OpenAiChatProvider, OpenAiResponsesProvider } from './openai.js';
import { profileProblem } from './profiles.js';
import { ProviderRouter } from './router.js';
import { ProviderError, type Provider } from './types.js';

/** One profile's provider, for its protocol. The key is handed over in memory only. */
export function providerForProfile(id: string, profile: ProviderProfile, apiKey: string | undefined): Provider {
  switch (profile.protocol) {
    case 'anthropic':
      return new AnthropicProvider(profile, apiKey, id);
    case 'openai-chat':
      return new OpenAiChatProvider(profile, apiKey, id);
    case 'openai-responses':
      return new OpenAiResponsesProvider(profile, apiKey, id);
    case 'echo':
      return new EchoProvider(profile.echo.delayMs, id);
  }
}

/**
 * The daemon's provider: a router over providers.profiles whose keys come from the secret
 * store (read when a profile is built; `refresh()` after a key changes). Key values go into
 * the HTTP clients' headers, never into a request body.
 */
export function createProvider(settings: () => ProvidersSettings, secrets: SecretStore): ProviderRouter {
  return new ProviderRouter(settings, (id, profile) => providerForProfile(id, profile, profile.apiKeySecret ? secrets.get(profile.apiKeySecret) : undefined));
}

export type ProbeResult =
  | { ok: true; ms: number; model: string; reply?: string; stopReason?: string; models?: string[] }
  | { ok: false; ms: number; kind: string; error: string; status?: number };

/**
 * Check a profile from the console before (or after) it is saved: a tiny request to the main
 * model ("test"), or the endpoint's model list ("models"). `apiKey` is a key typed into the form
 * and not stored yet; otherwise the stored secret is used. Nothing is logged or kept.
 */
export async function probeProfile(
  id: string,
  profile: ProviderProfile,
  secrets: SecretStore,
  opts: { what: 'test' | 'models'; apiKey?: string; role?: ModelRole; timeoutMs?: number },
): Promise<ProbeResult> {
  const t0 = Date.now();
  const key = opts.apiKey?.trim() || (profile.apiKeySecret ? secrets.get(profile.apiKeySecret) : undefined);
  const p = providerForProfile(id, { ...profile, maxRetries: 0 }, key);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const fail = (err: unknown) => ({
    ok: false as const,
    ms: Date.now() - t0,
    kind: err instanceof ProviderError ? err.kind : signal.aborted ? 'timeout' : 'fatal',
    error: signal.aborted ? 'no answer within the time limit' : errorMessage(err),
    ...(err instanceof ProviderError && err.status !== undefined ? { status: err.status } : {}),
  });
  const h = p.health();
  if (!h.ready) return { ok: false, ms: 0, kind: 'config', error: h.problem ?? 'not ready' };
  if (opts.what === 'models') {
    if (!p.listModels) return { ok: false, ms: 0, kind: 'fatal', error: 'this protocol cannot list models' };
    try {
      return { ok: true, ms: Date.now() - t0, model: '', models: await p.listModels(signal) };
    } catch (err) {
      return fail(err);
    }
  }
  const problem = profileProblem(profile);
  if (problem) return { ok: false, ms: 0, kind: 'config', error: problem };
  const role = opts.role ?? 'main';
  try {
    const r = await p.generate(
      {
        role,
        system: [{ id: 'probe', text: 'This is a connection test.' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
        tools: [],
        effort: 'low',
        maxOutputTokens: 256,
      },
      { signal },
    );
    const reply = r.content
      .filter((b) => b.type === 'text')
      .map((b) => String(b['text'] ?? ''))
      .join('')
      .slice(0, 200);
    return { ok: true, ms: Date.now() - t0, model: r.model, stopReason: r.stopReason, ...(reply ? { reply } : {}) };
  } catch (err) {
    return fail(err);
  }
}
