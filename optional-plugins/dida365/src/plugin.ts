import { definePlugin, type PluginDefinition } from '@protea/plugin-sdk';
import { DidaApi, TOKEN_SECRET, type Project } from './api.js';
import { settingsOf, type Dida365Config } from './config.js';
import { Reminders } from './reminders.js';
import { buildTools } from './tools.js';

export type { Dida365Config } from './config.js';

export interface Dida365Options {
  /** For tests: the HTTP client and the clock. */
  fetch?: typeof fetch;
  now?: () => number;
}

const PROJECT_NAMES_TTL_MS = 5 * 60_000;

/**
 * Dida365 (滴答清单) through its Open API (https://developer.dida365.com/docs#/openapi): every
 * endpoint as a tool, and optional events for tasks that reach their time. The owner's API token
 * is the secret DIDA365_TOKEN; the same code talks to TickTick when `apiBase` points there.
 */
export function createDida365Plugin(opts: Dida365Options = {}): PluginDefinition<Dida365Config> {
  const now = opts.now ?? Date.now;
  // The host is known from the first hook on; the API client reads the configuration through it on every request.
  let settings: (() => ReturnType<typeof settingsOf>) | undefined;
  let token: (() => string | undefined) | undefined;
  const api = new DidaApi({
    fetch: (...args) => (opts.fetch ?? fetch)(...args),
    base: () => settings?.().apiBase ?? '',
    token: () => token?.(),
    timeoutMs: () => settings?.().timeoutMs ?? 20_000,
  });

  let names: { at: number; map: Map<string, string> } | undefined;
  /** Names are a convenience in listings: when they cannot be read, the ids alone are shown. */
  const projectNames = async (signal?: AbortSignal): Promise<ReadonlyMap<string, string>> => {
    if (names && now() - names.at < PROJECT_NAMES_TTL_MS) return names.map;
    try {
      const list = (await api.get<Project[]>('/project', signal ? { signal } : {})) ?? [];
      names = { at: now(), map: new Map(list.map((p) => [p.id, p.name ?? ''])) };
      return names.map;
    } catch {
      return names?.map ?? new Map();
    }
  };

  const reminders = new Reminders({ api, now, projectNames: () => projectNames() });

  return definePlugin<Dida365Config>({
    displayName: 'Dida365 (滴答清单)',
    start(host) {
      settings = () => settingsOf(host);
      token = () => host.secret(TOKEN_SECRET);
      if (!host.secret(TOKEN_SECRET)?.trim()) throw new Error(`secret ${TOKEN_SECRET} is not set`);
      reminders.start(host);
    },
    async stop() {
      await reminders.stop();
    },
    onConfigChanged(host) {
      names = undefined;
      reminders.restart(host);
    },
    envPromptVars: (host) => {
      const s = settingsOf(host);
      return { timeZone: s.tz, reminders: s.reminders.enabled };
    },
    tools: (host) => {
      settings = () => settingsOf(host);
      token = () => host.secret(TOKEN_SECRET);
      const s = settingsOf(host);
      return buildTools({ api, now, settings: settingsOf, projectNames, forgetProjects: () => (names = undefined), reminderStatus: (h) => reminders.status(h) }, s.toolsets).map((e) => e.tool);
    },
  });
}
