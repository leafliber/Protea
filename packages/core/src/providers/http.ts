import { AbortedError, sleep } from '../util/abort.js';
import { ProviderError } from './types.js';

/** Context-overflow messages of OpenAI-style servers (OpenAI, vLLM, llama.cpp, DeepSeek, …). */
const OVERFLOW_RE = /context_length_exceeded|context length|maximum context|too many tokens|prompt is too long|reduce the length|input is too long/i;

/** One line of an error body for messages and logs (never the request). */
function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; code?: string } | string; message?: string };
    const e = j.error;
    if (typeof e === 'string') return e;
    if (e?.message) return e.code ? `${e.message} (${e.code})` : e.message;
    if (j.message) return j.message;
  } catch {
    // not JSON
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** An HTTP error status mapped to retry semantics, as for the Anthropic SDK's errors. */
export function classifyHttpStatus(status: number, body: string): ProviderError {
  const text = errorText(body) || `HTTP ${status}`;
  if (status === 401 || status === 403) return new ProviderError('config', `credentials rejected: ${text}`, status);
  if (status === 404) return new ProviderError('fatal', `model or endpoint not found: ${text}`, 404);
  if (status === 429) return new ProviderError('retryable', `rate limited: ${text}`, 429);
  if (status === 413 || ((status === 400 || status === 422) && OVERFLOW_RE.test(text))) return new ProviderError('overflow', `input too long: ${text}`, status);
  if (status >= 500 || status === 408 || status === 409) return new ProviderError('retryable', `server error ${status}: ${text}`, status);
  return new ProviderError('fatal', `API error ${status}: ${text}`, status);
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Send a request; connection errors, 429 and 5xx are retried (before any of the body is read)
 * with exponential backoff that honours Retry-After. Resolves with an OK response.
 */
export async function request(r: HttpRequest): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    if (r.signal.aborted) throw new AbortedError(r.signal.reason);
    const timeout = AbortSignal.timeout(r.timeoutMs);
    const signal = AbortSignal.any([r.signal, timeout]);
    let res: Response;
    try {
      res = await fetch(r.url, {
        method: r.method ?? 'POST',
        headers: { ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}), ...r.headers },
        ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
        signal,
      });
    } catch (err) {
      if (r.signal.aborted) throw new AbortedError(r.signal.reason);
      const e = timeout.aborted
        ? new ProviderError('retryable', `no response within ${r.timeoutMs} ms`, undefined, { cause: err })
        : new ProviderError('retryable', `connection error: ${connectionMessage(err)}`, undefined, { cause: err });
      if (attempt < r.maxRetries) {
        await sleep(backoff(attempt, null), r.signal);
        continue;
      }
      throw e;
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    const e = classifyHttpStatus(res.status, body);
    if (e.kind === 'retryable' && attempt < r.maxRetries) {
      await sleep(backoff(attempt, res.headers.get('retry-after')), r.signal);
      continue;
    }
    throw e;
  }
}

function connectionMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return [e.message, e.cause?.code ?? e.cause?.message].filter(Boolean).join(': ');
}

function backoff(attempt: number, retryAfter: string | null): number {
  const s = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

export interface SseMessage {
  event: string | null;
  data: string;
}

/** Server-Sent Events of a response body. */
export async function* sseMessages(res: Response, signal: AbortSignal): AsyncGenerator<SseMessage> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  const onAbort = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal.aborted) throw new AbortedError(signal.reason);
        throw new ProviderError('retryable', `the response stream broke off: ${connectionMessage(err)}`, undefined, { cause: err });
      }
      if (signal.aborted) throw new AbortedError(signal.reason);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const msg = parseSse(raw);
        if (msg) yield msg;
      }
    }
    const tail = parseSse(buf);
    if (tail) yield tail;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function parseSse(raw: string): SseMessage | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

/** Parse a tool call's JSON arguments; text that is not a JSON object comes back as `{ _raw }` (schema validation then rejects it). */
export function parseArguments(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { _raw: text };
  } catch {
    return { _raw: text };
  }
}

/** Tool result content as plain text (OpenAI-style tool messages carry a string). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : `[${String((b as { type?: unknown }).type ?? 'block')}]`))
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}

/** Join a base URL and a path ("…/v1" + "/chat/completions"). */
export function joinUrl(base: string, p: string): string {
  return `${base.replace(/\/+$/, '')}${p}`;
}
