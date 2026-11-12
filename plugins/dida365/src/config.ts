import type { Host } from '@protea/plugin-sdk';
import { DEFAULT_API_BASE } from './api.js';
import { isTimeZone } from './time.js';

export const TOOLSETS = ['tasks', 'projects', 'tags', 'focus', 'habits', 'countdowns'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface RemindersConfig {
  enabled?: boolean;
  intervalMin?: number;
  leadMin?: number;
  dailyAt?: string;
  overdue?: boolean;
  level?: 2 | 3 | 4;
  projectIds?: string[];
}

/** `plugins.dida365.config` (config.schema.json). */
export interface Dida365Config {
  apiBase?: string;
  timeZone?: string;
  defaultProjectId?: string;
  toolsets?: Toolset[];
  maxResults?: number;
  timeoutSec?: number;
  reminders?: RemindersConfig;
}

/** The configuration with its defaults filled in. */
export interface Settings {
  apiBase: string;
  /** Zone in which times are read and shown. */
  tz: string;
  defaultProjectId: string | undefined;
  toolsets: ReadonlySet<Toolset>;
  maxResults: number;
  timeoutMs: number;
  reminders: { enabled: boolean; intervalMs: number; leadMs: number; dailyAt: { hour: number; minute: number }; overdue: boolean; level: 2 | 3 | 4; projectIds: string[] | undefined };
}

export function settingsOf(host: Host<Dida365Config>): Settings {
  const c = host.config;
  const r = c.reminders ?? {};
  const at = /^(\d{2}):(\d{2})$/.exec(r.dailyAt ?? '') ?? ['', '09', '00'];
  return {
    apiBase: c.apiBase || DEFAULT_API_BASE,
    tz: c.timeZone && isTimeZone(c.timeZone) ? c.timeZone : isTimeZone(host.timezone) ? host.timezone : 'UTC',
    defaultProjectId: c.defaultProjectId || undefined,
    toolsets: new Set(c.toolsets ?? TOOLSETS),
    maxResults: c.maxResults ?? 50,
    timeoutMs: (c.timeoutSec ?? 20) * 1000,
    reminders: {
      enabled: r.enabled === true,
      intervalMs: (r.intervalMin ?? 5) * 60_000,
      leadMs: (r.leadMin ?? 0) * 60_000,
      dailyAt: { hour: Number(at[1]), minute: Number(at[2]) },
      overdue: r.overdue !== false,
      level: r.level ?? 3,
      projectIds: r.projectIds?.length ? r.projectIds : undefined,
    },
  };
}
