import { createContext, useContext, useEffect, useState } from 'react';
import type { ControlRole, StatusResponse } from '@protea/protocol';
import { get } from './api';
import { useReloadOn } from './live';

export interface ConsoleSession {
  role: ControlRole;
  /** Admin may change things; a read-only account or token may only look. */
  canWrite: boolean;
  /** The signed-in account (absent for a token sign-in). */
  username?: string;
}

export const SessionContext = createContext<ConsoleSession>({ role: 'readonly', canWrite: false });
export const useSession = (): ConsoleSession => useContext(SessionContext);

/** /api/status, refreshed by live changes and every 10 s. */
export function useStatus(): { status: StatusResponse | undefined; reload: () => void } {
  const [status, setStatus] = useState<StatusResponse>();
  const reload = () => {
    get<StatusResponse>('/api/status').then(setStatus, () => undefined);
  };
  useEffect(() => {
    reload();
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, []);
  useReloadOn(['phase', 'batch.started', 'batch.ended', 'plugin', 'mcp', 'fork', 'scheduler', 'handoff', 'usage', 'settled', 'skills'], reload, 500);
  return { status, reload };
}

export type RouteMode = 'chat' | 'console';

/**
 * The URL hash: `#/` (or `#/chat`) is the conversation; `#/console/<page>?…` a console page.
 * Older links without the prefix (`#/events?cursor=12`) still open the console page.
 */
export function parseRoute(hash: string): { mode: RouteMode; page: string; params: URLSearchParams } {
  const h = hash.replace(/^#\/?/, '');
  const [path = '', query] = h.split('?');
  const params = new URLSearchParams(query ?? '');
  if (path === '' || path === 'chat') return { mode: 'chat', page: 'chat', params };
  const page = path === 'console' ? 'overview' : path.startsWith('console/') ? path.slice(8) || 'overview' : path;
  return { mode: 'console', page, params };
}

export function useRoute(): { mode: RouteMode; page: string; params: URLSearchParams } {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** Link to a console page. */
export function consoleHref(page: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `#/console/${page}${q ? `?${q}` : ''}`;
}

/** Open a console page. */
export function go(page: string, params: Record<string, string> = {}): void {
  location.hash = consoleHref(page, params);
}

/** Back to the conversation. */
export function goChat(): void {
  location.hash = '#/';
}
