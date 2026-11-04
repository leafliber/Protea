import { useCallback, useEffect, useRef, useState } from 'react';

/** Error from the control API: `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Listeners for "the session is gone" (401), so the app can show the login page. */
const unauthorized = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  unauthorized.add(fn);
  return () => unauthorized.delete(fn);
}

/**
 * Same-origin request with the session cookie. Writes carry the CSRF header the API requires
 * for cookie sessions. A string body with `text` is sent as plain text.
 */
export async function api<T>(method: string, path: string, body?: unknown, opts: { text?: boolean } = {}): Promise<T> {
  const plain = opts.text === true && typeof body === 'string';
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-protea-csrf'] = '1';
  if (body !== undefined) headers['content-type'] = plain ? 'text/plain; charset=utf-8' : 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: plain ? (body as string) : JSON.stringify(body) } : {}),
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
    if (res.status === 401 && !path.startsWith('/api/auth/')) for (const fn of unauthorized) fn();
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
  }
  return json as T;
}

export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});

/** GET a resource; `reload()` fetches again, `refreshMs` polls. */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    get<T>(path).then(
      (d) => {
        if (n !== seq.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (n !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, [path]);
  useEffect(() => {
    load();
    if (!opts.refreshMs) return;
    const t = setInterval(load, opts.refreshMs);
    return () => clearInterval(t);
  }, [load, opts.refreshMs]);
  return { data, error, loading, reload: load, setData };
}

/** Run an action, keeping its error and busy state for the button that started it. */
export function useAction(): { busy: boolean; error: string | null; run: (fn: () => Promise<unknown>) => Promise<boolean>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

export const enc = encodeURIComponent;

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}
