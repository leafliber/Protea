import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { SpeechView, TranscribeResponse } from '@protea/protocol';
import { ApiError, useApi } from './api';

const NOT_SET_UP = '还没有设置语音转文字：控制台 → 模型 → 语音转文字';

/** Recording formats in order of preference: Opus in WebM (Chrome, Firefox), Ogg, then MP4/AAC (Safari). */
const MIME_CHOICES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** The first format this browser records, or '' to let it choose. */
export function pickMime(supported: (type: string) => boolean): string {
  return MIME_CHOICES.find((t) => supported(t)) ?? '';
}

/** A press shorter than this is a tap (dictate into the box); longer is hold-to-talk (send on release). */
export const HOLD_MS = 350;
/** The longest recording: past it the recording stops by itself. */
export const MAX_RECORD_MS = 120_000;

/** What a press means, decided when it ends. */
export function gestureOf(heldMs: number): 'tap' | 'hold' {
  return heldMs < HOLD_MS ? 'tap' : 'hold';
}

/** Send a recording to the speech-to-text service (POST /api/speech/transcribe, the body is the audio). */
export async function transcribe(audio: Blob): Promise<string> {
  const res = await fetch('/api/speech/transcribe', {
    method: 'POST',
    headers: { 'content-type': audio.type || 'audio/webm', 'x-protea-csrf': '1' },
    credentials: 'same-origin',
    body: audio,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    if (err?.code === 'not_configured') throw new ApiError(res.status, err.code, NOT_SET_UP);
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
  }
  return ((json as TranscribeResponse | undefined)?.text ?? '').trim();
}

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  /** Set when the press ended: what to do with the audio once the recorder stops. */
  then: 'dictate' | 'send' | 'cancel' | null;
}

function micProblem(): string | null {
  if (typeof window === 'undefined') return '这里不能录音';
  if (!window.isSecureContext) return '浏览器只在 https 或本机地址（localhost）下允许使用麦克风';
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return '这个浏览器不支持录音';
  return null;
}

/**
 * The microphone button of the chat box. Tap: record until the next tap, then the words go into
 * the box to check before sending. Hold: record while held, release to send at once; release
 * outside the button to cancel.
 */
export function MicButton({ disabled, onDictated, onSend, onError }: { disabled?: boolean; onDictated: (text: string) => void; onSend: (text: string) => Promise<void>; onError: (message: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<'dictate' | 'hold' | null>(null);
  const [outside, setOutside] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<Recording | null>(null);
  const pressedAt = useRef(0);
  const btn = useRef<HTMLButtonElement>(null);
  // Said before anyone speaks: no point recording what cannot be transcribed.
  const speech = useApi<SpeechView>('/api/speech');
  const notSetUp = speech.data !== undefined && !speech.data.ready;

  // Stop the microphone if the page goes away mid-recording.
  useEffect(() => () => rec.current?.stream?.getTracks().forEach((t) => t.stop()), []);
  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    setSeconds(0);
    const t = setInterval(() => {
      const ms = Date.now() - started;
      setSeconds(Math.floor(ms / 1000));
      if (ms >= MAX_RECORD_MS) finish(mode === 'hold' ? 'send' : 'dictate');
    }, 250);
    return () => clearInterval(t);
  }, [phase, mode]);

  const start = async (): Promise<void> => {
    const problem = notSetUp ? NOT_SET_UP : micProblem();
    if (problem) return onError(problem);
    onError(null);
    setPhase('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      rec.current = null;
      setPhase('idle');
      setMode(null);
      const name = (e as { name?: string }).name;
      return onError(name === 'NotAllowedError' ? '没有麦克风权限：在浏览器地址栏里允许使用麦克风' : name === 'NotFoundError' ? '没有找到麦克风' : `无法使用麦克风：${(e as Error).message}`);
    }
    const mime = pickMime((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const r: Recording = { recorder, stream, chunks: [], then: rec.current?.then ?? null };
    rec.current = r;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) r.chunks.push(e.data);
    };
    recorder.onstop = () => void stopped(r);
    recorder.start();
    setPhase('recording');
    // A hold released before the microphone was ready (the permission prompt): nothing was said.
    if (r.then === 'cancel' || r.then === 'send') finish('cancel');
    else if (r.then === 'dictate') r.then = null;
  };

  /** End the recording and say what to do with it; before the microphone is ready, start() acts on it. */
  const finish = (then: 'dictate' | 'send' | 'cancel'): void => {
    const r = rec.current;
    if (!r?.recorder) {
      rec.current = { then } as Recording;
      return;
    }
    r.then = then;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
  };

  const stopped = async (r: Recording): Promise<void> => {
    r.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    setOutside(false);
    setMode(null);
    const audio = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
    if (r.then === 'cancel' || audio.size === 0) return setPhase('idle');
    setPhase('transcribing');
    try {
      const text = await transcribe(audio);
      if (!text) onError('没有听清，再说一次？');
      else if (r.then === 'send') await onSend(text);
      else onDictated(text);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
    }
  };

  const down = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0 || disabled) return;
    e.preventDefault();
    btn.current?.setPointerCapture(e.pointerId);
    // A tap while dictating ends the dictation.
    if (phase === 'recording' && mode === 'dictate') return finish('dictate');
    if (phase !== 'idle') return;
    pressedAt.current = Date.now();
    rec.current = null;
    setMode(null);
    void start();
  };

  const inside = (e: PointerEvent<HTMLButtonElement>): boolean => {
    const b = btn.current?.getBoundingClientRect();
    return !!b && e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
  };

  const move = (e: PointerEvent<HTMLButtonElement>): void => {
    if (mode === 'hold' || (pressedAt.current && phase !== 'idle' && mode === null)) setOutside(!inside(e));
  };

  // Becomes hold-to-talk once the press lasts.
  useEffect(() => {
    if (mode !== null || !pressedAt.current || (phase !== 'recording' && phase !== 'starting')) return;
    const t = setTimeout(() => setMode((m) => m ?? 'hold'), Math.max(0, HOLD_MS - (Date.now() - pressedAt.current)));
    return () => clearTimeout(t);
  }, [phase, mode]);

  const up = (e: PointerEvent<HTMLButtonElement>): void => {
    if (!pressedAt.current) return;
    const held = Date.now() - pressedAt.current;
    pressedAt.current = 0;
    if (gestureOf(held) === 'tap' && mode !== 'hold') {
      setMode('dictate');
      return;
    }
    finish(inside(e) ? 'send' : 'cancel');
  };

  const cancel = (): void => {
    if (!pressedAt.current) return;
    pressedAt.current = 0;
    finish('cancel');
  };

  const key = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (phase === 'recording') return finish('dictate');
    if (phase === 'idle') {
      setMode('dictate');
      void start();
    }
  };

  const recording = phase === 'recording' || phase === 'starting';
  const label =
    phase === 'transcribing' ? '识别中…' : recording ? (mode === 'dictate' ? `${seconds}s 点按结束` : outside ? '松开取消' : `${seconds}s 松开发送`) : '语音';
  return (
    <button
      ref={btn}
      type="button"
      className={`composer-mic${recording ? ' recording' : ''}${outside ? ' cancel' : ''}`}
      disabled={disabled || phase === 'transcribing'}
      title="点按：说完再点一次，文字放进输入框；按住：说话，松开直接发送，移出按钮取消"
      aria-label={recording ? '正在录音' : '语音输入'}
      aria-pressed={recording}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onKeyDown={key}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}
