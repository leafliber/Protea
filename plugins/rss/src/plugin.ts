import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { definePlugin, type Host, type PluginDefinition } from '@protea/plugin-sdk';

export interface FeedConfig {
  url: string;
  name?: string;
  intervalMin?: number;
  level?: 3 | 4;
}

export interface RssConfig {
  feeds?: FeedConfig[];
  intervalMin?: number;
  level?: 3 | 4;
  firstRunItems?: number;
  maxItemsPerPoll?: number;
  timeoutSec?: number;
}

export interface FeedItem {
  id: string;
  title: string;
  link?: string;
  published?: string;
  summary: string;
}

interface FeedState {
  /** Item ids already reported (newest last), bounded. */
  seen: string[];
  etag?: string;
  lastModified?: string;
  title?: string;
  lastPollAt?: string;
  lastOkAt?: string;
  lastError?: string;
  recent: FeedItem[];
}

const MAX_SEEN = 1000;
const MAX_RECENT = 50;
const SUMMARY_CHARS = 400;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true, htmlEntities: true });

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)['#text']);
  return '';
}

/** HTML to plain text, good enough for a summary line. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function isoDate(v: string): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom; items newest first when they carry dates. */
export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const doc = parser.parse(xml) as Record<string, any>;
  let title = '';
  const items: FeedItem[] = [];
  const push = (raw: { id: string; title: string; link?: string; date: string; summary: string }): void => {
    const id = raw.id || raw.link || crypto.createHash('sha256').update(`${raw.title}\n${raw.date}`).digest('hex').slice(0, 24);
    const published = isoDate(raw.date);
    items.push({
      id,
      title: clip(stripHtml(raw.title) || '(untitled)', 200),
      ...(raw.link ? { link: raw.link } : {}),
      ...(published ? { published } : {}),
      summary: clip(stripHtml(raw.summary), SUMMARY_CHARS),
    });
  };
  if (doc['rss']) {
    const ch = doc['rss']['channel'] ?? {};
    title = text(ch['title']);
    for (const it of asArray<any>(ch['item'])) {
      push({ id: text(it['guid']), title: text(it['title']), link: text(it['link']), date: text(it['pubDate'] ?? it['dc:date']), summary: text(it['description'] ?? it['content:encoded']) });
    }
  } else if (doc['feed']) {
    const f = doc['feed'];
    title = text(f['title']);
    for (const e of asArray<any>(f['entry'])) {
      const links = asArray<any>(e['link']);
      const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
      push({ id: text(e['id']), title: text(e['title']), link: alt?.['@_href'] ?? '', date: text(e['published'] ?? e['updated']), summary: text(e['summary'] ?? e['content']) });
    }
  } else if (doc['rdf:RDF']) {
    const r = doc['rdf:RDF'];
    title = text(r['channel']?.['title']);
    for (const it of asArray<any>(r['item'])) {
      push({ id: it['@_rdf:about'] ?? '', title: text(it['title']), link: text(it['link']), date: text(it['dc:date']), summary: text(it['description']) });
    }
  } else {
    throw new Error('not an RSS or Atom document');
  }
  if (items.every((i) => i.published)) items.sort((a, b) => ((a.published as string) < (b.published as string) ? 1 : -1));
  return { title: clip(stripHtml(title), 120), items };
}

export function feedName(f: FeedConfig): string {
  if (f.name) return f.name;
  try {
    return new URL(f.url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 32);
  } catch {
    return 'feed';
  }
}

/**
 * Polls feeds and reports new items (docs/10-architecture/08-event-source-plugins.md: RSS is
 * L4 piggyback). Conditional requests keep polling cheap; the seen set is saved only after
 * the item's event is stored, so a crash re-reports rather than loses.
 */
export function createRssPlugin(opts: { fetch?: typeof fetch } = {}): PluginDefinition<RssConfig> {
  const doFetch = opts.fetch ?? fetch;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const polling = new Map<string, Promise<void>>();
  let stopped = false;

  const feeds = (host: Host<RssConfig>): Array<FeedConfig & { name: string }> => {
    const out: Array<FeedConfig & { name: string }> = [];
    const names = new Set<string>();
    for (const f of host.config.feeds ?? []) {
      let name = feedName(f);
      for (let i = 2; names.has(name); i++) name = `${feedName(f)}-${i}`;
      names.add(name);
      out.push({ ...f, name });
    }
    return out;
  };
  const stateOf = async (host: Host<RssConfig>, name: string): Promise<FeedState | undefined> => host.kv.get<FeedState>(`feed:${name}`);

  async function poll(host: Host<RssConfig>, feed: FeedConfig & { name: string }): Promise<void> {
    const prev = await stateOf(host, feed.name);
    const state: FeedState = prev ?? { seen: [], recent: [] };
    state.lastPollAt = new Date().toISOString();
    const headers: Record<string, string> = { 'user-agent': 'Protea-RSS/0.1 (+https://github.com/leafliber/Protea)', accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' };
    if (state.etag) headers['if-none-match'] = state.etag;
    if (state.lastModified) headers['if-modified-since'] = state.lastModified;
    let res: Response;
    try {
      res = await doFetch(feed.url, { headers, signal: AbortSignal.timeout((host.config.timeoutSec ?? 20) * 1000) });
    } catch (err) {
      state.lastError = `fetch failed: ${(err as Error).message}`;
      await host.kv.set(`feed:${feed.name}`, state);
      host.log.warn('feed fetch failed', { feed: feed.name, err: (err as Error).message });
      return;
    }
    if (res.status === 304) {
      state.lastOkAt = state.lastPollAt;
      delete state.lastError;
      await host.kv.set(`feed:${feed.name}`, state);
      return;
    }
    if (!res.ok) {
      state.lastError = `HTTP ${res.status}`;
      await host.kv.set(`feed:${feed.name}`, state);
      host.log.warn('feed returned an error', { feed: feed.name, status: res.status });
      return;
    }
    let parsed: { title: string; items: FeedItem[] };
    try {
      parsed = parseFeed(await res.text());
    } catch (err) {
      state.lastError = `unreadable feed: ${(err as Error).message}`;
      await host.kv.set(`feed:${feed.name}`, state);
      return;
    }
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    if (etag) state.etag = etag;
    if (lastModified) state.lastModified = lastModified;
    state.title = parsed.title;
    state.lastOkAt = state.lastPollAt;
    delete state.lastError;
    const seen = new Set(state.seen);
    const fresh = parsed.items.filter((i) => !seen.has(i.id));
    const firstRun = !prev || prev.seen.length === 0;
    const limit = firstRun ? (host.config.firstRunItems ?? 3) : (host.config.maxItemsPerPoll ?? 10);
    const report = fresh.slice(0, limit);
    // Items past the limit (and on a first run, everything older) are only marked seen.
    const skipped = fresh.slice(limit);
    for (const i of skipped) seen.add(i.id);
    state.seen = [...seen].slice(-MAX_SEEN);
    state.recent = [...parsed.items.slice(0, MAX_RECENT)];
    await host.kv.set(`feed:${feed.name}`, state);
    const level = feed.level ?? host.config.level ?? 4;
    // Oldest first, so the event order follows publication.
    for (const item of [...report].reverse()) {
      if (stopped) return;
      const lines = [`New item in feed ${feed.name}${parsed.title ? ` (${parsed.title})` : ''}: ${item.title}`];
      if (item.link) lines.push(item.link);
      if (item.published) lines.push(`Published ${item.published}`);
      if (item.summary) lines.push(item.summary);
      await host.events.push({
        type: 'rss.item',
        ts: new Date().toISOString(),
        level,
        trigger: level === 3 ? 'debounce' : 'piggyback',
        text: lines.join('\n'),
        dedupeKey: `item:${feed.name}:${crypto.createHash('sha256').update(item.id).digest('hex').slice(0, 32)}`,
        meta: { feed: feed.name, ...(item.link ? { link: item.link } : {}), ...(item.published ? { published: item.published } : {}) },
      });
      state.seen = [...state.seen.filter((x) => x !== item.id), item.id].slice(-MAX_SEEN);
      await host.kv.set(`feed:${feed.name}`, state);
    }
    if (skipped.length > 0 && !firstRun) {
      host.log.info('more new items than maxItemsPerPoll; the rest were marked seen', { feed: feed.name, skipped: skipped.length });
    }
  }

  function schedule(host: Host<RssConfig>, feed: FeedConfig & { name: string }, delayMs: number): void {
    if (stopped) return;
    const t = setTimeout(() => {
      const run = poll(host, feed)
        .catch((err: Error) => host.log.error('poll failed', { feed: feed.name, err: err.message }))
        .finally(() => {
          polling.delete(feed.name);
          schedule(host, feed, (feed.intervalMin ?? host.config.intervalMin ?? 30) * 60_000);
        });
      polling.set(feed.name, run);
    }, delayMs);
    t.unref?.();
    timers.set(feed.name, t);
  }

  return definePlugin<RssConfig>({
    displayName: 'RSS / Atom feeds',
    start(host) {
      stopped = false;
      // Stagger the first polls a little so many feeds do not all fetch at once.
      feeds(host).forEach((f, i) => schedule(host, f, i * 500));
    },
    async stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await Promise.allSettled([...polling.values()]);
    },
    async onConfigChanged(host) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      feeds(host).forEach((f, i) => schedule(host, f, i * 500));
    },
    envPromptVars: (host) => ({ feeds: feeds(host).map((f) => f.name).join(', ') }),
    tools: [
      {
        name: 'rss_feeds',
        description: 'Show each configured feed: URL, title, when it was last read, and the last error.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        flags: { readOnly: true },
        handler: async (_i: Record<string, never>, _ctx, host) => {
          const list = feeds(host);
          if (list.length === 0) return 'No feeds are configured (plugins.rss.config.feeds).';
          const lines: string[] = [];
          for (const f of list) {
            const s = await stateOf(host, f.name);
            lines.push(
              `${f.name}: ${f.url}${s?.title ? ` — ${s.title}` : ''}\n  last read ${s?.lastOkAt ?? 'never'}${s?.lastError ? `; last error: ${s.lastError}` : ''}; ${s?.recent.length ?? 0} recent items`,
            );
          }
          return lines.join('\n');
        },
      },
      {
        name: 'rss_items',
        description: 'List recent items of one feed or of all feeds, newest first.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { feed: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
        },
        flags: { readOnly: true },
        handler: async (i: { feed?: string; limit?: number }, _ctx, host) => {
          const list = feeds(host).filter((f) => !i.feed || f.name === i.feed);
          if (list.length === 0) return { text: `Unknown feed ${i.feed}. Feeds: ${feeds(host).map((f) => f.name).join(', ') || 'none'}`, failed: true };
          const all: Array<FeedItem & { feed: string }> = [];
          for (const f of list) for (const it of (await stateOf(host, f.name))?.recent ?? []) all.push({ ...it, feed: f.name });
          all.sort((a, b) => ((a.published ?? '') < (b.published ?? '') ? 1 : -1));
          const items = all.slice(0, i.limit ?? 10);
          if (items.length === 0) return 'No items yet.';
          return items.map((it) => `[${it.feed}] ${it.published ?? ''} ${it.title}${it.link ? `\n  ${it.link}` : ''}${it.summary ? `\n  ${clip(it.summary, 200)}` : ''}`).join('\n');
        },
      },
    ],
  });
}
