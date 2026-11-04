import { createContext, useContext, useEffect, useState } from 'react';
import type { ControlRole, StatusResponse } from '@protea/protocol';
import { get } from './api';
import { useReloadOn } from './live';

export interface ConsoleSession {
  role: ControlRole;
  /** Admin may change things; the read-only token may only look. */
  canWrite: boolean;
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

/** The page in the URL hash: #/events?cursor=12 → { page: 'events', params }. */
export function useRoute(): { page: string; params: URLSearchParams } {
  const parse = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const [page, query] = h.split('?');
    return { page: page || 'overview', params: new URLSearchParams(query ?? '') };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function go(page: string, params: Record<string, string> = {}): void {
  const q = new URLSearchParams(params).toString();
  location.hash = `#/${page}${q ? `?${q}` : ''}`;
}
