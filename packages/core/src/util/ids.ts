import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/** Sortable unique id, optionally prefixed: `b_01JC...`. */
export function newId(prefix?: string): string {
  const id = next();
  return prefix ? `${prefix}_${id}` : id;
}
