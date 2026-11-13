/**
 * `speech` in config.yaml: the speech-to-text service that turns the owner's voice into text,
 * for the web chat's microphone and for voice messages on chat platforms. Any server with the
 * OpenAI transcription API (`POST {baseUrl}/audio/transcriptions`, multipart `file` + `model`).
 */
export interface SpeechSettings {
  /** Endpoint root, usually ending in /v1; null: speech-to-text is off. */
  baseUrl: string | null;
  /** Secret holding the API key; null for a server without one (a local Whisper). */
  apiKeySecret: string | null;
  model: string;
  /** ISO-639-1 language hint ("zh"); null lets the service detect it. */
  language: string | null;
  /** Largest recording sent, in MB (OpenAI takes 25). */
  maxMb: number;
  timeoutMs: number;
}

export const SPEECH_KEY_SECRET = 'SPEECH_API_KEY';

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = { baseUrl: null, apiKeySecret: SPEECH_KEY_SECRET, model: '', language: null, maxMb: 20, timeoutMs: 60_000 };

export interface SpeechPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  noKey?: boolean;
  note?: string;
}

/** Starting points for the console's form; endpoints and models as the vendors document them. */
export const SPEECH_PRESETS: readonly SpeechPreset[] = [
  { id: 'siliconflow', label: '硅基流动（SenseVoice）', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', note: '国内可直连，中文识别好' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe' },
  { id: 'groq', label: 'Groq（Whisper）', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  {
    id: 'local',
    label: '本机 Whisper（speaches / faster-whisper-server）',
    baseUrl: 'http://host.docker.internal:8000/v1',
    model: 'Systran/faster-whisper-small',
    noKey: true,
    note: '容器里访问宿主机用 host.docker.internal',
  },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
];

const SECRET_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Fill `speech` from config.yaml with its defaults and check it. */
export function normalizeSpeech(raw: unknown): SpeechSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_SPEECH_SETTINGS };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('speech must be a mapping');
  const s = { ...DEFAULT_SPEECH_SETTINGS, ...(raw as Partial<SpeechSettings>) };
  if (s.baseUrl !== null) {
    if (typeof s.baseUrl !== 'string') throw new Error('speech.baseUrl must be a URL or null');
    s.baseUrl = s.baseUrl.trim().replace(/\/+$/, '') || null;
    if (s.baseUrl !== null) {
      let u: URL;
      try {
        u = new URL(s.baseUrl);
      } catch {
        throw new Error('speech.baseUrl must be an http(s) URL');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('speech.baseUrl must be an http(s) URL');
    }
  }
  if (s.apiKeySecret !== null && (typeof s.apiKeySecret !== 'string' || !SECRET_RE.test(s.apiKeySecret))) throw new Error('speech.apiKeySecret must be a secret name (UPPER_CASE) or null');
  if (typeof s.model !== 'string') throw new Error('speech.model must be a model name');
  s.model = s.model.trim();
  if (s.baseUrl !== null && s.model === '') throw new Error('speech.model is required when speech.baseUrl is set');
  if (s.language !== null && (typeof s.language !== 'string' || !/^[a-z]{2,3}$/.test(s.language.trim()))) throw new Error('speech.language must be a language code such as zh or en, or null');
  if (s.language !== null) s.language = s.language.trim();
  if (!(typeof s.maxMb === 'number' && s.maxMb > 0 && s.maxMb <= 100)) throw new Error('speech.maxMb must be a number from 0 to 100');
  if (!(Number.isInteger(s.timeoutMs) && s.timeoutMs >= 1000)) throw new Error('speech.timeoutMs must be an integer of at least 1000');
  return s;
}
