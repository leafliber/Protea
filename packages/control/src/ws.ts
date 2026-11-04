import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { WS_TOPICS, type ControlRole, type WsClientMessage, type WsServerMessage, type WsTopic } from '@protea/protocol';
import { logMatcher, type Bus, type EventStore, type LogEntry, type LogRing, type Logger } from '@protea/core';
import { SESSION_COOKIE, cookieFrom, principalOf, type AuthSettings } from './auth.js';
import { subscribeStream } from './stream.js';

export interface WsDeps {
  bus: Bus;
  store: EventStore;
  log: Logger;
  auth: () => AuthSettings;
  runId: () => string;
  logs?: LogRing;
  /** Ping interval; a client that misses a pong is dropped. */
  heartbeatMs?: number;
  /** Drop a client whose unsent data exceeds this (it is not keeping up). */
  maxBufferedBytes?: number;
}

const TOPIC_OF = new Map<string, WsTopic>(
  (Object.entries(WS_TOPICS) as Array<[WsTopic, readonly string[]]>).flatMap(([group, topics]) => topics.map((t) => [t, group] as [string, WsTopic])),
);

/**
 * WebSocket `/ws` (docs/30-specs/05-control-api.md): the same projection as `/api/stream`,
 * plus `usage` and `logs`, behind the same tokens or console cookie. Browsers send the cookie;
 * other clients send `Authorization: Bearer`. Returns the upgrade handler and a closer.
 */
export function createWebSocketEndpoint(d: WsDeps): {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  clients: () => number;
  close: () => void;
} {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const heartbeatMs = d.heartbeatMs ?? 30_000;
  const maxBuffered = d.maxBufferedBytes ?? 8 * 1024 * 1024;
  const alive = new WeakMap<WebSocket, boolean>();

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, heartbeatMs);
  timer.unref();

  const connect = (ws: WebSocket, role: ControlRole): void => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    let topics = new Set<WsTopic>();
    let matchLog: ((e: LogEntry) => boolean) | null = null;
    let lastCursor = -1;
    let replaying = false;
    const held: WsServerMessage[] = [];

    const send = (m: WsServerMessage): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > maxBuffered) {
        d.log.warn({ buffered: ws.bufferedAmount }, 'WebSocket client is not keeping up; closing it');
        ws.close(1013, 'too slow');
        return;
      }
      ws.send(JSON.stringify(m));
    };
    const deliver = (m: WsServerMessage): void => {
      const group = TOPIC_OF.get(m.topic);
      if (!group || !topics.has(group)) return;
      if (replaying) {
        held.push(m);
        return;
      }
      if (m.topic === 'event') {
        if (m.data.cursor <= lastCursor) return;
        lastCursor = m.data.cursor;
      }
      send(m);
    };

    const offStream = subscribeStream(d.bus, deliver, { extended: true });
    const offLogs = d.logs?.subscribe((e) => {
      if (topics.has('logs') && matchLog?.(e) !== false) deliver({ topic: 'log', data: e });
    });

    ws.on('message', (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(String(raw)) as WsClientMessage;
        if (!Array.isArray(msg.subscribe)) throw new Error('subscribe must be a list of topics');
        const unknown = msg.subscribe.filter((t) => !(t in WS_TOPICS));
        if (unknown.length > 0) throw new Error(`unknown topic(s): ${unknown.join(', ')}; known: ${Object.keys(WS_TOPICS).join(', ')}`);
        matchLog = msg.logFilter ? logMatcher(msg.logFilter) : null;
      } catch (err) {
        send({ topic: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
        return;
      }
      topics = new Set(msg.subscribe);
      send({ topic: 'subscribed', data: { topics: [...topics] } });
      if (msg.since !== undefined && Number.isInteger(msg.since) && topics.has('events')) {
        // Replay what is stored after `since`, holding live messages until it is done (no gaps, no duplicates).
        replaying = true;
        try {
          let from = msg.since;
          for (;;) {
            const page = d.store.query({ sinceCursor: from, limit: 1000, order: 'asc' });
            for (const e of page) {
              if (e.cursor > lastCursor) {
                lastCursor = e.cursor;
                send({ topic: 'event', data: e });
              }
            }
            if (page.length < 1000) break;
            from = page[page.length - 1]?.cursor ?? from;
          }
        } finally {
          replaying = false;
        }
        for (const m of held.splice(0)) deliver(m);
      }
    });
    ws.on('close', () => {
      offStream();
      offLogs?.();
    });
    ws.on('error', (err) => d.log.debug({ err: err.message }, 'WebSocket error'));
    send({ topic: 'hello', data: { runId: d.runId(), role } });
  };

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return false;
      const p = principalOf(d.auth(), req.headers.authorization, cookieFrom(req.headers.cookie, SESSION_COOKIE));
      // A browser always sends Origin; the cookie alone must not let another site connect.
      const origin = req.headers.origin;
      const hostOf = (o: string): string | null => {
        try {
          return new URL(o).host;
        } catch {
          return null;
        }
      };
      const crossSite = p?.via === 'cookie' && origin !== undefined && hostOf(origin) !== req.headers.host;
      if (!p || crossSite) {
        socket.write(`HTTP/1.1 ${p ? '403 Forbidden' : '401 Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => connect(ws, p.role));
      return true;
    },
    clients: () => wss.clients.size,
    close() {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
