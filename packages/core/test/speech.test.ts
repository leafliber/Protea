import { encode } from 'silk-wasm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEECH_SETTINGS, SpeechError, SpeechService, isSilk, normalizeSpeech, silentWav, type SpeechSettings } from '../src/index.js';

interface Seen {
  url: string;
  auth: string | null;
  fields: Record<string, string>;
  file: { name: string; type: string; bytes: Buffer } | null;
}

function service(settings: Partial<SpeechSettings>, answer: (seen: Seen) => Response, secrets: Record<string, string> = { SPEECH_API_KEY: 'sk-voice' }) {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    const s: Seen = { url: String(url), auth: new Headers(init?.headers).get('authorization'), fields: {}, file: null };
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') s.fields[k] = v;
      else s.file = { name: (v as File).name, type: v.type, bytes: Buffer.from(await v.arrayBuffer()) };
    }
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
  const svc = new SpeechService({
    settings: () => ({ ...DEFAULT_SPEECH_SETTINGS, baseUrl: 'https://stt.example/v1', model: 'whisper-x', ...settings }),
    secret: (n) => secrets[n],
    log: { info: (_o, m) => logs.push(m), warn: (_o, m) => logs.push(m) },
    fetch: fake,
  });
  return { svc, seen, logs };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('speech-to-text', () => {
  it('sends the recording as an OpenAI transcription request and returns the text', async () => {
    const { svc, seen } = service({ language: 'zh' }, () => ok({ text: ' 明天八点叫我 ' }));
    const r = await svc.transcribe(Buffer.from('webm-bytes'), 'audio/webm;codecs=opus', { source: 'console' });
    expect(r.text).toBe('明天八点叫我');
    expect(seen[0]).toMatchObject({ url: 'https://stt.example/v1/audio/transcriptions', auth: 'Bearer sk-voice', fields: { model: 'whisper-x', language: 'zh', response_format: 'json' } });
    expect(seen[0]?.file).toMatchObject({ name: 'voice.webm', type: 'audio/webm' });
  });

  it('decodes SILK voice (QQ, WeChat) to WAV first, with or without the leading 0x02', async () => {
    const silk = Buffer.from((await encode(silentWav(1, 24_000), 0)).data);
    expect(isSilk(silk)).toBe(true);
    const { svc, seen } = service({}, () => ok({ text: '' }));
    await svc.transcribe(silk, 'audio/silk', { source: 'qq' });
    const plain = silk[0] === 0x02 ? silk.subarray(1) : silk;
    await svc.transcribe(plain, 'application/octet-stream', { source: 'wechat' });
    for (const s of seen) {
      expect(s.file?.name).toBe('voice.wav');
      expect(s.file?.bytes.subarray(0, 4).toString()).toBe('RIFF');
    }
  });

  it('reads chat-completion shaped answers too', async () => {
    const { svc } = service({}, () => ok({ choices: [{ message: { content: '你好' } }] }));
    expect((await svc.transcribe(silentWav(), 'audio/wav', { source: 't' })).text).toBe('你好');
  });

  it('says why it cannot: not set up, no key, too large, refused', async () => {
    const off = service({ baseUrl: null }, () => ok({ text: 'x' }));
    await expect(off.svc.transcribe(silentWav(), 'audio/wav', { source: 't' })).rejects.toMatchObject({ code: 'not_configured' });
    const noKey = service({}, () => ok({ text: 'x' }), {});
    await expect(noKey.svc.transcribe(silentWav(), 'audio/wav', { source: 't' })).rejects.toThrow('secret SPEECH_API_KEY is not set');
    const small = service({ maxMb: 0.0001 }, () => ok({ text: 'x' }));
    await expect(small.svc.transcribe(silentWav(), 'audio/wav', { source: 't' })).rejects.toMatchObject({ code: 'too_large' });
    const refused = service({}, () => new Response(JSON.stringify({ error: { message: 'invalid model' } }), { status: 400 }));
    const err = (await refused.svc.transcribe(silentWav(), 'audio/wav', { source: 't' }).catch((e: unknown) => e)) as SpeechError;
    expect(err).toBeInstanceOf(SpeechError);
    expect(err.message).toBe('the speech service answered 400: invalid model');
    expect(refused.seen).toHaveLength(1);
  });

  it('works without a key for a local server, and logs no text', async () => {
    const { svc, seen, logs } = service({ apiKeySecret: null }, () => ok({ text: 'secret words' }));
    await svc.transcribe(silentWav(), 'audio/wav', { source: 't' });
    expect(seen[0]?.auth).toBeNull();
    expect(logs.join(' ')).not.toContain('secret words');
  });

  it('checks the settings', () => {
    expect(normalizeSpeech(undefined)).toEqual(DEFAULT_SPEECH_SETTINGS);
    expect(normalizeSpeech({ baseUrl: 'https://api.groq.com/openai/v1/', model: ' whisper-large-v3-turbo ' })).toMatchObject({ baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' });
    expect(() => normalizeSpeech({ baseUrl: 'https://x.example/v1' })).toThrow('speech.model is required');
    expect(() => normalizeSpeech({ baseUrl: 'ftp://x' , model: 'm'})).toThrow('http(s) URL');
    expect(() => normalizeSpeech({ language: 'Chinese' })).toThrow('language code');
  });
});
