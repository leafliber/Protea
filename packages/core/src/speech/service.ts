import type { SpeechSettings } from './settings.js';

export type SpeechErrorCode = 'not_configured' | 'too_large' | 'unsupported' | 'failed';

export class SpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SpeechError';
  }
}

export interface SpeechStatus {
  ready: boolean;
  /** Why it is not ready (no endpoint, no key). */
  problem?: string;
  model?: string;
}

export interface TranscribeOptions {
  /** Who asked: "console", a plugin id. Logged, never the audio or the text. */
  source: string;
  language?: string | null;
  signal?: AbortSignal;
}

export interface SpeechResult {
  text: string;
  ms: number;
}

interface Log {
  info(o: Record<string, unknown>, msg: string): void;
  warn(o: Record<string, unknown>, msg: string): void;
}

/** File names the transcription APIs read the format from. */
const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
};

const SILK_MAGIC = Buffer.from('#!SILK_V3');
const AMR_MAGIC = Buffer.from('#!AMR');

/** QQ and WeChat voice: SILK v3, with or without Tencent's leading 0x02 byte. */
export function isSilk(b: Buffer): boolean {
  return b.subarray(0, SILK_MAGIC.length).equals(SILK_MAGIC) || (b[0] === 0x02 && b.subarray(1, 1 + SILK_MAGIC.length).equals(SILK_MAGIC));
}

/** Mono 16-bit PCM in a WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.byteLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

const SILK_RATE = 24_000;

/** SILK to WAV with silk-wasm (which takes Tencent's form, starting with 0x02). */
export async function silkToWav(b: Buffer): Promise<Buffer> {
  const { decode } = await import('silk-wasm');
  const input = b[0] === 0x02 ? b : Buffer.concat([Buffer.from([0x02]), b]);
  const r = await decode(input, SILK_RATE);
  return pcmToWav(r.data, SILK_RATE);
}

/** A second of silence, for testing an endpoint without the owner's voice. */
export function silentWav(seconds = 1, sampleRate = 16_000): Buffer {
  return pcmToWav(new Uint8Array(seconds * sampleRate * 2), sampleRate);
}

function baseMime(mime: string): string {
  return mime.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Speech-to-text over the OpenAI transcription API. SILK voice (QQ, WeChat) is decoded to WAV
 * first; everything else goes as it came (webm/opus from browsers, ogg from Telegram, m4a).
 */
export class SpeechService {
  constructor(
    private readonly o: {
      settings: () => SpeechSettings;
      secret: (name: string) => string | undefined;
      log: Log;
      fetch?: typeof fetch;
    },
  ) {}

  status(s: SpeechSettings = this.o.settings(), apiKey?: string): SpeechStatus {
    if (s.baseUrl === null) return { ready: false, problem: 'speech-to-text is not set up (console: Models, Speech)' };
    if (!s.model) return { ready: false, problem: 'no speech model set' };
    if (s.apiKeySecret !== null && !apiKey && !this.o.secret(s.apiKeySecret)) return { ready: false, problem: `secret ${s.apiKeySecret} is not set` };
    return { ready: true, model: s.model };
  }

  /** Turn a recording into text. `override` tries settings that are not saved yet (the console's test). */
  async transcribe(audio: Buffer, mime: string, opts: TranscribeOptions, override?: { settings: SpeechSettings; apiKey?: string }): Promise<SpeechResult> {
    const s = override?.settings ?? this.o.settings();
    const st = this.status(s, override?.apiKey);
    if (!st.ready) throw new SpeechError('not_configured', st.problem ?? 'speech-to-text is not set up');
    if (audio.length === 0) throw new SpeechError('unsupported', 'the recording is empty');
    if (audio.length > s.maxMb * 1024 * 1024) throw new SpeechError('too_large', `the recording is larger than ${s.maxMb} MB (speech.maxMb)`);
    const started = Date.now();
    let data = audio;
    let type = baseMime(mime);
    if (isSilk(audio)) {
      try {
        data = await silkToWav(audio);
        type = 'audio/wav';
      } catch (err) {
        throw new SpeechError('unsupported', `could not decode the SILK voice message: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (audio.subarray(0, AMR_MAGIC.length).equals(AMR_MAGIC)) {
      throw new SpeechError('unsupported', 'AMR voice messages are not supported');
    }
    const ext = EXT[type] ?? (type.startsWith('audio/') ? type.slice(6) : 'bin');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: type || 'application/octet-stream' }), `voice.${ext}`);
    form.append('model', s.model);
    form.append('response_format', 'json');
    const language = opts.language ?? s.language;
    if (language) form.append('language', language);
    const key = override?.apiKey ?? (s.apiKeySecret ? this.o.secret(s.apiKeySecret) : undefined);
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(s.timeoutMs)]) : AbortSignal.timeout(s.timeoutMs);
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${s.baseUrl}/audio/transcriptions`, { method: 'POST', body: form, headers: key ? { authorization: `Bearer ${key}` } : {}, signal });
    } catch (err) {
      this.o.log.warn({ source: opts.source, err: err instanceof Error ? err.message : String(err) }, 'speech-to-text request failed');
      throw new SpeechError('failed', `the speech service could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw.slice(0, 300);
      try {
        const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
        detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? detail;
      } catch {
        // not JSON
      }
      this.o.log.warn({ source: opts.source, status: res.status }, 'speech-to-text refused');
      throw new SpeechError('failed', `the speech service answered ${res.status}: ${detail}`);
    }
    let text: string;
    try {
      const j = JSON.parse(raw) as { text?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
      // OpenAI and most servers: { text }; some (GLM-style) answer like a chat completion.
      const t = j.text ?? j.choices?.[0]?.message?.content;
      if (typeof t !== 'string') throw new Error('no text');
      text = t.trim();
    } catch {
      text = raw.trim();
    }
    const ms = Date.now() - started;
    this.o.log.info({ source: opts.source, bytes: audio.length, ms, chars: text.length }, 'speech transcribed');
    return { text, ms };
  }
}
