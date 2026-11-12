/** Shapes of the Dida365 Open API (https://developer.dida365.com/docs#/openapi), only the fields this plugin reads. */
export interface ChecklistItem {
  id?: string;
  title?: string;
  status?: number;
  completedTime?: string;
  isAllDay?: boolean;
  sortOrder?: number;
  startDate?: string;
  timeZone?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title?: string;
  content?: string;
  desc?: string;
  isAllDay?: boolean;
  startDate?: string | null;
  dueDate?: string | null;
  timeZone?: string;
  reminders?: string[];
  tags?: string[];
  repeatFlag?: string | null;
  repeatFrom?: string;
  priority?: number;
  status?: number;
  completedTime?: string;
  sortOrder?: number;
  items?: ChecklistItem[];
  kind?: string;
  parentId?: string;
  assigneeUsername?: string;
  focusSummaries?: Array<{ pomoCount?: number; estimatedPomo?: number; estimatedDuration?: number; pomoDuration?: number; stopwatchDuration?: number }>;
  etag?: string;
}

export interface Project {
  id: string;
  name?: string;
  color?: string;
  sortOrder?: number;
  closed?: boolean;
  groupId?: string;
  viewMode?: string;
  permission?: string;
  kind?: string;
}

export interface Column {
  id: string;
  projectId?: string;
  name?: string;
  sortOrder?: number;
}

export interface ProjectData {
  project?: Project;
  tasks?: Task[];
  columns?: Column[];
}

export interface ProjectGroup {
  id: string;
  name?: string;
  sortOrder?: number;
  showAll?: boolean;
  viewMode?: string;
}

export interface Member {
  username?: string;
  displayName?: string;
  self?: boolean;
}

export interface Comment {
  id: string;
  title?: string;
  createdTime?: string;
  modifiedTime?: string;
  userId?: number;
  replyCommentId?: string;
}

export interface Tag {
  name: string;
  label?: string;
  sortOrder?: number;
  color?: string;
  parent?: string;
  type?: number;
}

export interface Focus {
  id: string;
  type?: number;
  taskId?: string;
  note?: string;
  status?: number;
  startTime?: string;
  endTime?: string;
  pauseDuration?: number;
  duration?: number;
  tasks?: Array<{ taskId?: string; title?: string; habitId?: string; timerName?: string }>;
}

export interface Habit {
  id: string;
  name?: string;
  iconRes?: string;
  color?: string;
  status?: number;
  encouragement?: string;
  totalCheckIns?: number;
  type?: string;
  goal?: number;
  step?: number;
  unit?: string;
  repeatRule?: string;
  reminders?: string[];
  recordEnable?: boolean;
  sectionId?: string;
  targetDays?: number;
  targetStartDate?: number;
  completedCycles?: number;
  archivedTime?: string;
}

export interface HabitSection {
  id: string;
  name?: string;
  sortOrder?: number;
}

export interface HabitCheckin {
  habitId?: string;
  year?: number;
  checkins?: Array<{ stamp?: number; time?: string; value?: number; goal?: number; status?: number }>;
}

export interface Countdown {
  id: string;
  name?: string;
  date?: number;
  type?: number;
  ignoreYear?: boolean;
  repeatFlag?: string;
  remark?: string;
  status?: number;
}

export interface Preference {
  timeZone?: string;
}

export interface BatchResult {
  id2etag?: Record<string, string>;
  id2error?: Record<string, string>;
}

/** A request Dida365 refused or that never reached it. The message is written for the model. */
export class DidaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DidaError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface DidaApiOptions {
  fetch: typeof fetch;
  /** Read on every request, so configuration changes apply without a restart. */
  base: () => string;
  token: () => string | undefined;
  timeoutMs: () => number;
}

export const DEFAULT_API_BASE = 'https://api.dida365.com';
export const TOKEN_SECRET = 'DIDA365_TOKEN';

const HINTS: Record<number, string> = {
  401: `the API token is missing, wrong or revoked; the owner creates one in Dida365 under Settings > Account > API Token and stores it as the secret ${TOKEN_SECRET}`,
  403: 'this account may not do that',
  404: 'not found; check the ids',
  429: 'too many requests; wait before trying again',
};

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** What the error body says, without trusting its shape. */
function errorDetail(body: string): string {
  if (!body.trim()) return '';
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const parts = [j['errorCode'], j['errorMessage'] ?? j['error_description'] ?? j['error'] ?? j['message']].filter((x): x is string => typeof x === 'string' && x !== '');
    if (parts.length > 0) return clip(parts.join(': '), 300);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return clip(body, 300);
}

/** Path below `/open/v1`, each segment escaped. */
export function apiPath(...segments: string[]): string {
  return `/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

/** The Open API over HTTPS with a bearer token. One instance per plugin. */
export class DidaApi {
  constructor(private readonly o: DidaApiOptions) {}

  get base(): string {
    return this.o.base().replace(/\/+$/, '');
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    const token = this.o.token()?.trim();
    if (!token) throw new DidaError(`the secret ${TOKEN_SECRET} is not set`);
    const url = new URL(`${this.base}/open/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const what = `${method} ${path}`;
    const timeout = AbortSignal.timeout(this.o.timeoutMs());
    let res: Response;
    let text: string;
    try {
      res = await this.o.fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
      text = await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw new DidaError(`${what} was cancelled`);
      if (timeout.aborted) throw new DidaError(`Dida365 did not answer ${what} within ${Math.round(this.o.timeoutMs() / 1000)} s`);
      throw new DidaError(`could not reach Dida365 for ${what}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = errorDetail(text);
      const hint = HINTS[res.status];
      throw new DidaError(`Dida365 answered ${res.status} to ${what}${detail ? `: ${detail}` : ''}${hint ? ` (${hint})` : ''}`, res.status);
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DidaError(`Dida365 answered ${what} with something that is not JSON: ${clip(text, 120)}`, res.status);
    }
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, { ...opts, ...(body !== undefined ? { body } : {}) });
  }

  delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, opts);
  }
}
