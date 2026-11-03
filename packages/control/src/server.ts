import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

export interface ControlServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Listen on "host:port" (port 0 picks a free port). */
export function startControlServer(app: Hono, listen: string): Promise<ControlServer> {
  const idx = listen.lastIndexOf(':');
  const hostname = idx > 0 ? listen.slice(0, idx) : '0.0.0.0';
  const port = Number(idx >= 0 ? listen.slice(idx + 1) : listen);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid listen address "${listen}"`);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
      const host = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
      resolve({
        url: `http://${host}:${info.port}`,
        port: info.port,
        close: () =>
          new Promise<void>((res) => {
            const s = server as unknown as { close(cb: () => void): void; closeAllConnections?: () => void };
            s.closeAllConnections?.();
            s.close(() => res());
          }),
      });
    });
    server.once('error', reject);
  });
}
