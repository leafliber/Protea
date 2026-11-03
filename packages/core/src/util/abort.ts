export class AbortedError extends Error {
  override readonly name = 'AbortedError';
  constructor(reason?: unknown) {
    super(typeof reason === 'string' ? reason : 'aborted');
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortedError) return true;
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError(signal.reason);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
