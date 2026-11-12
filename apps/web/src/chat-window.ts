import type { ChatItem } from '@protea/protocol';

/** One request of history. */
export const PAGE = 50;
/** More loaded items than this are cut back to WINDOW_KEEP while the reader is at the newest message. */
export const WINDOW_MAX = 400;
export const WINDOW_KEEP = 200;
/** After a reconnect, how many pages to read back before giving up on joining what is on screen. */
export const CATCH_UP_PAGES = 8;

/** Conversation order: by time, a message before a reply of the same instant, then by id. */
export function order(a: ChatItem, b: ChatItem): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  const ka = a.key[0] === 'e' ? 0 : 1;
  const kb = b.key[0] === 'e' ? 0 : 1;
  if (ka !== kb) return ka - kb;
  return Number(a.key.slice(1)) - Number(b.key.slice(1)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Add or update items by key. The usual case (a newer item at the end, an update in place) does not sort. */
export function merge(old: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  if (incoming.length === 0) return old;
  const map = new Map(old.map((i) => [i.key, i]));
  for (const i of incoming) map.set(i.key, { ...map.get(i.key), ...i });
  const out = [...map.values()];
  for (let n = 1; n < out.length; n++) {
    if (order(out[n - 1] as ChatItem, out[n] as ChatItem) > 0) return out.sort(order);
  }
  return out;
}

/** The `before` token that asks for what is older than this item; null for an item the server has not numbered. */
export function beforeOf(i: ChatItem): string | null {
  const m = /^([eo])(\d+)$/.exec(i.key);
  return m ? `${i.at}|${m[1] === 'e' ? 0 : 1}|${m[2]}` : null;
}

/**
 * Drop the oldest items once there are more than `max`, keeping about `keep`. Returns what stays
 * and the token that loads the dropped ones again, or null when there is nothing to drop.
 */
export function trimOldest(items: ChatItem[], max = WINDOW_MAX, keep = WINDOW_KEEP): { items: ChatItem[]; before: string } | null {
  if (items.length <= max) return null;
  for (let n = items.length - keep; n < items.length; n++) {
    const before = beforeOf(items[n] as ChatItem);
    if (before !== null && n > 0) return { items: items.slice(n), before };
  }
  return null;
}

/** A page (oldest first) goes back at least as far as `anchor`: nothing is missing between them. */
export function reaches(page: ChatItem[], anchor: ChatItem): boolean {
  const oldest = page[0];
  return oldest !== undefined && order(oldest, anchor) <= 0;
}
