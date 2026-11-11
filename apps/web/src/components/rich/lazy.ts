import { useEffect, useSyncExternalStore } from 'react';

/** Something heavy that is fetched the first time a message needs it, and never on the first paint. */
export interface Lazy<T> {
  get(): T | undefined;
  load(): Promise<T>;
  subscribe(fn: () => void): () => void;
}

export function lazy<T>(loader: () => Promise<T>): Lazy<T> {
  let value: T | undefined;
  let pending: Promise<T> | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    load: () =>
      (pending ??= loader().then(
        (v) => {
          value = v;
          for (const fn of subs) fn();
          return v;
        },
        (err: unknown) => {
          // A failed fetch (offline, a new deploy) can be tried again by the next message.
          pending = null;
          throw err;
        },
      )),
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** The loaded value once it is there; asks for it while `want` is true. */
export function useLazy<T>(l: Lazy<T>, want: boolean): T | undefined {
  const v = useSyncExternalStore(l.subscribe, l.get, l.get);
  useEffect(() => {
    if (want && v === undefined) void l.load().catch(() => undefined);
  }, [l, want, v]);
  return v;
}
