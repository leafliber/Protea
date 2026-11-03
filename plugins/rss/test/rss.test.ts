import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { createRssPlugin, feedName, parseFeed, stripHtml } from '../src/plugin.js';

const rss = (items: Array<{ id: string; title: string; date: string }>) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example &amp; Co</title>
${items.map((i) => `<item><guid>${i.id}</guid><title>${i.title}</title><link>https://ex.com/${i.id}</link><pubDate>${i.date}</pubDate><description><![CDATA[<p>About <b>${i.title}</b></p>]]></description></item>`).join('\n')}
</channel></rss>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Atom feed</title>
<entry><id>urn:a:2</id><title>Second</title><link rel="alternate" href="https://atom.ex/2"/><updated>2026-11-02T10:00:00Z</updated><summary>Two</summary></entry>
<entry><id>urn:a:1</id><title>First</title><link href="https://atom.ex/1"/><updated>2026-11-01T10:00:00Z</updated><content type="html">&lt;p&gt;One&lt;/p&gt;</content></entry>
</feed>`;

const servers: http.Server[] = [];
const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function feedServer(): Promise<{ url: string; body: { xml: string; etag: string }; hits: Array<{ ifNoneMatch?: string }> }> {
  const body = { xml: '', etag: '"v1"' };
  const hits: Array<{ ifNoneMatch?: string }> = [];
  const srv = http.createServer((req, res) => {
    const inm = req.headers['if-none-match'];
    hits.push(typeof inm === 'string' ? { ifNoneMatch: inm } : {});
    if (inm === body.etag) return res.writeHead(304).end();
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: body.etag }).end(body.xml);
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/feed.xml`, body, hits };
}

describe('feed parsing', () => {
  it('reads RSS 2.0 and Atom, newest first, with plain-text summaries', () => {
    const r = parseFeed(rss([{ id: 'a', title: 'Old', date: 'Mon, 02 Nov 2026 08:00:00 GMT' }, { id: 'b', title: 'New', date: 'Tue, 03 Nov 2026 08:00:00 GMT' }]));
    expect(r.title).toBe('Example & Co');
    expect(r.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(r.items[0]).toEqual({ id: 'b', title: 'New', link: 'https://ex.com/b', published: '2026-11-03T08:00:00.000Z', summary: 'About New' });
    const a = parseFeed(atom);
    expect(a.title).toBe('Atom feed');
    expect(a.items.map((i) => [i.id, i.link, i.summary])).toEqual([
      ['urn:a:2', 'https://atom.ex/2', 'Two'],
      ['urn:a:1', 'https://atom.ex/1', 'One'],
    ]);
    expect(() => parseFeed('<html><body>nope</body></html>')).toThrow(/not an RSS or Atom/);
    expect(stripHtml('<p>a&nbsp;<i>b</i></p><script>x()</script>')).toBe('a b');
    expect(feedName({ url: 'https://www.Example.com/rss' })).toBe('example-com');
  });
});

describe('rss source', () => {
  it('reports the newest items on the first poll, then only new ones, with conditional requests', async () => {
    const srv = await feedServer();
    srv.body.xml = rss([
      { id: '1', title: 'One', date: 'Sun, 01 Nov 2026 08:00:00 GMT' },
      { id: '2', title: 'Two', date: 'Mon, 02 Nov 2026 08:00:00 GMT' },
      { id: '3', title: 'Three', date: 'Tue, 03 Nov 2026 08:00:00 GMT' },
    ]);
    const plugin = createRssPlugin();
    const h = new FakeHost(plugin, { id: 'rss', levelCap: 3, config: { feeds: [{ url: srv.url, name: 'ex', intervalMin: 0.002 }], firstRunItems: 2 } });
    hosts.push(h);
    await h.start();
    await waitFor(() => h.events.length === 2);
    // Oldest of the reported first: event order follows publication.
    expect(h.events.map((e) => e.text.split('\n')[0])).toEqual(['New item in feed ex (Example & Co): Two', 'New item in feed ex (Example & Co): Three']);
    expect(h.events[0]).toMatchObject({ type: 'rss.item', level: 4, trigger: 'piggyback', meta: { feed: 'ex', link: 'https://ex.com/2' } });
    expect(h.events[0]?.text).toBe('New item in feed ex (Example & Co): Two\nhttps://ex.com/2\nPublished 2026-11-02T08:00:00.000Z\nAbout Two');
    // Unchanged feed: 304 and nothing new.
    await waitFor(() => srv.hits.some((x) => x.ifNoneMatch === '"v1"'));
    expect(h.events).toHaveLength(2);
    // A new item appears.
    srv.body.xml = rss([
      { id: '1', title: 'One', date: 'Sun, 01 Nov 2026 08:00:00 GMT' },
      { id: '2', title: 'Two', date: 'Mon, 02 Nov 2026 08:00:00 GMT' },
      { id: '3', title: 'Three', date: 'Tue, 03 Nov 2026 08:00:00 GMT' },
      { id: '4', title: 'Four', date: 'Wed, 04 Nov 2026 08:00:00 GMT' },
    ]);
    srv.body.etag = '"v2"';
    await waitFor(() => h.events.length === 3);
    expect(h.events[2]?.text.split('\n')[0]).toBe('New item in feed ex (Example & Co): Four');
    expect(h.violations).toEqual([]);

    expect((await h.callTool('rss_items', { limit: 2 })).text).toMatch(/^\[ex\] 2026-11-04T08:00:00.000Z Four\n {2}https:\/\/ex.com\/4/);
    expect((await h.callTool('rss_feeds', {})).text).toMatch(new RegExp(`^ex: ${srv.url.replace(/[.?]/g, '\\$&')} — Example & Co\\n {2}last read 20`));
    expect(await h.callTool('rss_items', { feed: 'nope' })).toMatchObject({ failed: true });
  });

  it('survives a restart without repeating items, and reports fetch errors in rss_feeds', async () => {
    const srv = await feedServer();
    srv.body.xml = atom;
    const config = { feeds: [{ url: srv.url, name: 'atom', intervalMin: 60 }, { url: 'http://127.0.0.1:9/none.xml', name: 'down', intervalMin: 60 }], level: 3 as const };
    const first = new FakeHost(createRssPlugin(), { id: 'rss', levelCap: 3, config });
    await first.start();
    await waitFor(() => first.events.length === 2 && first.kv.get('feed:down') !== undefined);
    expect(first.events[0]).toMatchObject({ level: 3, trigger: 'debounce' });
    expect((await first.callTool('rss_feeds', {})).text).toContain('down: http://127.0.0.1:9/none.xml\n  last read never; last error: fetch failed');
    const kv = new Map(first.kv);
    await first.stop();

    srv.body.etag = '"v9"'; // force a full response: the items are the same
    const second = new FakeHost(createRssPlugin(), { id: 'rss', levelCap: 3, config });
    for (const [k, v] of kv) second.kv.set(k, v);
    hosts.push(second);
    await second.start();
    await waitFor(() => srv.hits.length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(second.events).toEqual([]);
  });
});
