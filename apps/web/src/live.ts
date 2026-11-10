import { useEffect, useRef, useState } from 'react';
import type { WsServerMessage, WsTopic } from '@protea/protocol';

type Handler = (m: WsServerMessage) => void;
export type LiveState = 'connecting' | 'open' | 'closed';

/**
 * One WebSocket for the whole console (`/ws`, cookie-authenticated), subscribed to every
 * topic, reconnecting with backoff. Pages register handlers by message topic.
 */
class Live {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly stateListeners = new Set<(s: LiveState) => void>();
  private stateValue: LiveState = 'closed';
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  /** Highest event cursor seen, so a reconnect replays what was missed. */
  private lastCursor: number | null = null;
  /** Pages using the topics that are only subscribed while one is open (`trace` is heavy, `chat` is for the chat window). */
  private readonly optional = { trace: 0, chat: 0 };
  runId: string | null = null;

  start(): void {
    this.wanted = true;
    if (!this.ws) this.connect();
  }

  stop(): void {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  get state(): LiveState {
    return this.stateValue;
  }

  private setState(s: LiveState): void {
    this.stateValue = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private topics(): WsTopic[] {
    return ['events', 'phase', 'scheduler', 'output', 'changes', 'usage', 'logs', ...(this.optional.trace > 0 ? (['trace'] as const) : []), ...(this.optional.chat > 0 ? (['chat'] as const) : [])];
  }

  /** While the returned function has not been called, the connection also carries this group. */
  useOptional(group: 'trace' | 'chat'): () => void {
    if (++this.optional[group] === 1) this.resubscribe();
    return () => {
      if (--this.optional[group] === 0) this.resubscribe();
    };
  }

  /** A subscription replaces the previous one; without `since` nothing is replayed. */
  private resubscribe(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ subscribe: this.topics(), logFilter: { level: 'info' } }));
  }

  private connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.setState('connecting');
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ subscribe: this.topics(), ...(this.lastCursor !== null ? { since: this.lastCursor } : {}), logFilter: { level: 'info' } }));
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      let m: WsServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (m.topic === 'hello') {
        // A new daemon run: cursors continue, but replay from where we were is still right.
        this.runId = m.data.runId;
      }
      if (m.topic === 'event') this.lastCursor = Math.max(this.lastCursor ?? 0, m.data.cursor);
      for (const fn of this.handlers.get(m.topic) ?? []) fn(m);
      for (const fn of this.handlers.get('*') ?? []) fn(m);
    };
    ws.onclose = () => {
      this.ws = null;
      this.setState('closed');
      if (!this.wanted) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  on(topics: string | string[], fn: Handler): () => void {
    const list = Array.isArray(topics) ? topics : [topics];
    for (const t of list) {
      let set = this.handlers.get(t);
      if (!set) this.handlers.set(t, (set = new Set()));
      set.add(fn);
    }
    return () => {
      for (const t of list) this.handlers.get(t)?.delete(fn);
    };
  }

  onState(fn: (s: LiveState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
}

export const live = new Live();

/** Call `fn` for live messages of these topics (the latest `fn` is used). */
export function useLive(topics: string | string[], fn: Handler): void {
  const ref = useRef(fn);
  ref.current = fn;
  const key = Array.isArray(topics) ? topics.join(',') : topics;
  useEffect(() => live.on(key.split(','), (m) => ref.current(m)), [key]);
}

/** Keep the run stream (model output, tool calls) coming while this component is mounted. */
export function useTraceStream(): void {
  useEffect(() => live.useOptional('trace'), []);
}

/** Keep the replies being written coming while this component is mounted. */
export function useChatDrafts(): void {
  useEffect(() => live.useOptional('chat'), []);
}

export function useLiveState(): LiveState {
  const [s, setS] = useState<LiveState>(live.state);
  useEffect(() => live.onState(setS), []);
  return s;
}

/** Re-run `reload` (debounced) whenever one of these topics arrives. */
export function useReloadOn(topics: string | string[], reload: () => void, delayMs = 300): void {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLive(topics, () => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(reload, delayMs);
  });
  useEffect(() => () => {
    if (t.current) clearTimeout(t.current);
  }, []);
}
