import type { Context, Hono } from 'hono';
import type { PutSpeechRequest, SpeechTestResponse, SpeechView, TranscribeResponse } from '@protea/protocol';

/** What the daemon does for the speech routes (docs/30-specs/05-control-api.md §Speech). */
export interface SpeechOps {
  view(): SpeechView;
  /** Validate, write `speech` to config.yaml, store or remove the key, apply. */
  put(req: PutSpeechRequest): Promise<SpeechView>;
  /** A second of silence through the endpoint: the settings given, or the saved ones. */
  test(req: { settings?: Record<string, unknown>; apiKey?: string }): Promise<SpeechTestResponse>;
  /** The owner's recording from the web chat. Throws a SpeechError-like `{ code }` error when it cannot. */
  transcribe(audio: Buffer, mime: string, language: string | undefined, actor: string): Promise<TranscribeResponse>;
}

/** Largest body POST /api/speech/transcribe reads before the service's own limit applies. */
const MAX_UPLOAD = 100 * 1024 * 1024;

function bad(c: Context, err: unknown) {
  return c.json({ error: { code: 'invalid', message: err instanceof Error ? err.message : String(err) } }, 400);
}

/** /api/speech: the speech-to-text settings, a test, and transcription for the web chat's microphone. */
export function registerSpeechRoutes(app: Hono, ops: SpeechOps | undefined, actor: (c: Context) => string): void {
  const missing = (c: Context) => c.json({ error: { code: 'not_found', message: 'speech-to-text is not available' } }, 404);
  app.get('/api/speech', (c) => (ops ? c.json(ops.view()) : missing(c)));

  app.put('/api/speech', async (c) => {
    if (!ops) return missing(c);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b['settings'] !== 'object' || b['settings'] === null) return bad(c, new Error('body must be { settings, apiKey? }'));
    const apiKey = b['apiKey'];
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') return bad(c, new Error('apiKey must be text or null'));
    try {
      return c.json(await ops.put({ settings: b['settings'] as Record<string, unknown>, ...(apiKey !== undefined ? { apiKey: apiKey as string | null } : {}) }));
    } catch (err) {
      return bad(c, err);
    }
  });

  app.post('/api/speech/test', async (c) => {
    if (!ops) return missing(c);
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    try {
      return c.json(
        await ops.test({
          ...(typeof b['settings'] === 'object' && b['settings'] !== null ? { settings: b['settings'] as Record<string, unknown> } : {}),
          ...(typeof b['apiKey'] === 'string' && b['apiKey'].trim() ? { apiKey: b['apiKey'].trim() } : {}),
        }),
      );
    } catch (err) {
      return bad(c, err);
    }
  });

  app.post('/api/speech/transcribe', async (c) => {
    if (!ops) return missing(c);
    const mime = c.req.header('content-type') ?? '';
    if (!/^(audio|video)\//i.test(mime)) return c.json({ error: { code: 'bad_request', message: 'send the recording as the body, with an audio/* Content-Type' } }, 400);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_UPLOAD) return c.json({ error: { code: 'too_large', message: 'the recording is too large' } }, 413);
    const audio = Buffer.from(await c.req.arrayBuffer());
    if (audio.length > MAX_UPLOAD) return c.json({ error: { code: 'too_large', message: 'the recording is too large' } }, 413);
    try {
      return c.json(await ops.transcribe(audio, mime, c.req.query('language') || undefined, actor(c)));
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'not_configured') return c.json({ error: { code, message } }, 409);
      if (code === 'too_large') return c.json({ error: { code, message } }, 413);
      if (code === 'unsupported') return c.json({ error: { code, message } }, 415);
      return c.json({ error: { code: 'speech_failed', message } }, 502);
    }
  });
}
