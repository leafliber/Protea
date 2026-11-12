import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryAccess, MemoryIndex, MemoryStore, memoryTools, openDatabase, queryTerms, type ToolSpec } from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup() {
  const dir = tmpDir('protea-memory-');
  const changed: string[][] = [];
  let now = Date.parse('2026-11-12T08:00:00Z');
  const store = new MemoryStore(path.join(dir, 'memory'), (p) => changed.push(p), { now: () => now });
  const { db } = openDatabase(path.join(dir, 'protea.db'));
  const index = new MemoryIndex(db, store);
  return { dir, store, db, index, changed, tick: (ms: number) => (now += ms) };
}

const NOTE = (summary: string, body: string, keywords: string[] = []): string => `---\nsummary: ${summary}\nkeywords: [${keywords.join(', ')}]\n---\n${body}`;

describe('MemoryStore (memory tool commands)', () => {
  it('reads, writes, appends, edits, moves and deletes files under /memories', () => {
    const { store, changed } = setup();
    expect(store.write('/memories/notes/coffee.md', NOTE('Coffee', 'beans: geisha\nroast: light'))).toBe('Created /memories/notes/coffee.md (6 lines).');
    expect(store.read('/memories/notes/coffee.md')).toBe(
      '/memories/notes/coffee.md (6 lines):\n     1\t---\n     2\tsummary: Coffee\n     3\tkeywords: []\n     4\t---\n     5\tbeans: geisha\n     6\troast: light',
    );
    expect(store.read('notes/coffee.md', [5, -1])).toBe('/memories/notes/coffee.md, lines 5-6 of 6:\n     5\tbeans: geisha\n     6\troast: light');
    expect(store.read('/memories')).toMatch(/^\/memories\/ \(two levels\):\n\/memories\/notes\/\n.*\t\/memories\/notes\/coffee\.md$/);

    expect(store.edit('memories/notes/coffee.md', 'light', 'medium')).toContain('     6\troast: medium');
    expect(() => store.edit('/memories/notes/coffee.md', 'nothing', 'x')).toThrow('does not appear in /memories/notes/coffee.md');
    expect(() => store.edit('/memories/notes/coffee.md', 'e', 'x')).toThrow(/appears \d+ times in \/memories\/notes\/coffee\.md \(lines 2, 3, 5, 6\)/);

    // append creates the file and keeps one entry per line.
    expect(store.append('journal/2026-11-12.md', '- 08:00 brewed coffee')).toBe('Appended 1 line(s) to /memories/journal/2026-11-12.md, a new file (1 lines).');
    store.append('journal/2026-11-12.md', '- 09:00 second cup\n');
    expect(store.readText('journal/2026-11-12.md')).toBe('- 08:00 brewed coffee\n- 09:00 second cup\n');

    expect(store.move('/memories/notes/coffee.md', '/memories/notes/drinks/coffee.md')).toBe('Moved /memories/notes/coffee.md to /memories/notes/drinks/coffee.md.');
    expect(store.delete('/memories/notes')).toBe('Deleted /memories/notes.');
    expect(() => store.read('/memories/notes')).toThrow('/memories/notes does not exist.');
    expect(() => store.read('/memories/journal/2026-11-13.md')).toThrow('append or write creates it');
    expect(changed.flat()).toEqual([
      'notes/coffee.md',
      'notes/coffee.md',
      'journal/2026-11-12.md',
      'journal/2026-11-12.md',
      'notes/coffee.md',
      'notes/drinks/coffee.md',
      'notes/drinks/coffee.md',
    ]);
  });

  it('keeps every path inside the memory directory', () => {
    const { dir, store } = setup();
    expect(() => store.read('/etc/passwd')).toThrow('Paths are inside /memories');
    expect(() => store.write('/memories/../escape.md', 'x')).toThrow('would leave /memories');
    expect(() => store.write('a/./b.md', 'x')).toThrow('would leave');
    expect(() => store.delete('/memories')).toThrow('/memories itself cannot be changed');
    expect(() => store.move('/memories', '/memories/x')).toThrow('cannot be changed');
    expect(() => store.write('notes/.secret.md', 'x')).toThrow('hidden');
    // A symlink inside the directory that points outside it is refused, for reads and writes.
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.symlinkSync(outside, path.join(store.dir, 'link'));
    expect(() => store.read('/memories/link/secret.txt')).toThrow('through a symlink');
    expect(() => store.write('/memories/link/new.md', 'x')).toThrow('through a symlink');
    expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
    // Not listed either (the index never follows it).
    expect(store.listFiles().map((f) => f.path)).toEqual([]);
  });

  it('refuses files over the size limit', () => {
    const { store } = setup();
    expect(() => store.write('/memories/big.md', 'x'.repeat(1024 * 1024 + 1))).toThrow('would exceed 1M');
  });

  it('holds notes to a summary, so the index can list them', () => {
    const { store } = setup();
    expect(() => store.write('notes/a.md', 'no header')).toThrow(/has no summary.*summary: one line/s);
    store.write('journal/x.md', 'no header is fine here');
    expect(() => store.move('journal/x.md', 'notes/x.md')).toThrow('has no summary');
    store.write('notes/a.md', NOTE('A', 'body'));
    expect(() => store.edit('notes/a.md', 'summary: A', 'title: A')).toThrow('has no summary');
    // The owner and the runtime are not held to it.
    store.writeText('notes/b.md', '');
    expect(store.readText('notes/b.md')).toBe('');
  });

  it('limits the resident files, keeps their earlier versions, and allows nothing else under core/', () => {
    const { store, tick } = setup();
    expect(store.write('core/owner.md', '# Owner\n- speaks Chinese')).toBe('Created /memories/core/owner.md (24/2000 characters).');
    expect(() => store.write('core/owner.md', 'x'.repeat(2001))).toThrow('would be 2001 characters; its limit is 2000. Nothing was written.');
    expect(() => store.append('core/rules.md', 'y'.repeat(4000))).toThrow('its limit is 4000');
    expect(() => store.write('core/other.md', 'x')).toThrow('/memories/core holds only /memories/core/owner.md and /memories/core/rules.md');
    expect(() => store.delete('core/owner.md')).toThrow('cannot be deleted');
    expect(() => store.move('core/owner.md', 'notes/owner.md')).toThrow('cannot be moved');
    tick(1_000);
    store.edit('core/owner.md', 'Chinese', 'Simplified Chinese');
    tick(1_000);
    store.append('core/owner.md', '- time zone Asia/Shanghai');
    expect(store.history('core/owner.md').map((v) => v.text)).toEqual(['# Owner\n- speaks Simplified Chinese', '# Owner\n- speaks Chinese']);
    expect(store.history('core/owner.md')[1]?.at).toBe('2026-11-12T08:00:01.000Z');
    // Hidden: not listed, not writable by the model, not part of the index.
    expect(store.listFiles().map((f) => f.path)).toEqual(['core/owner.md']);
    expect(() => store.write('core/.history/owner-x.md', 'x')).toThrow('hidden');
    // The console is held to the limits too.
    expect(() => store.writeText('core/rules.md', 'z'.repeat(4001))).toThrow('its limit is 4000');
    for (let i = 0; i < 25; i++) {
      tick(1_000);
      store.writeText('core/rules.md', `rule ${i}`);
    }
    expect(store.history('core/rules.md')).toHaveLength(20);
    expect(store.history('core/rules.md')[0]?.text).toBe('rule 23');
  });
});

describe('MemoryIndex (memory_search)', () => {
  it('finds Chinese and English text, short terms and phrases, and follows edits', () => {
    const { store, index } = setup();
    store.write('/memories/journal/2026-11-02.md', '我们说好的三件事：买咖啡豆、预约牙医、周五交报告。');
    store.write('/memories/notes/people.md', NOTE('People', 'Alice prefers tea. Bob owns a coffee grinder.'));
    store.writeText('blobs/raw.md', '咖啡豆 should not be indexed');
    expect(index.sync()).toEqual({ indexed: 2, removed: 0 });

    expect(index.search('三件事').map((h) => h.path)).toEqual(['/memories/journal/2026-11-02.md']);
    expect(index.search('三件事')[0]?.chunks[0]?.snippet).toContain('[三件事]');
    expect(index.search('牙医')[0]?.chunks[0]).toMatchObject({ start: 1, end: 1 });
    expect(index.search('coffee').map((h) => h.path)).toEqual(['/memories/notes/people.md']);
    expect(index.search('"coffee grinder" Bob').length).toBe(1);
    // Files with more of the terms come first; one with only some of them still shows, marked.
    const partial = index.search('coffee tea zebra');
    expect(partial).toMatchObject([{ path: '/memories/notes/people.md', matched: ['coffee', 'tea'], terms: 3 }]);
    // A quoted or +term must appear.
    expect(index.search('coffee +zebra')).toEqual([]);
    expect(index.search('coffee', { paths: ['journal'] })).toEqual([]);
    expect(index.search('咖啡豆', { paths: ['/memories/journal/'] }).length).toBe(1);
    expect(index.search('咖啡豆', { paths: ['notes/*.md'] })).toEqual([]);

    // The index follows the store's own writes when wired through onChange…
    const wired = new MemoryStore(store.dir, (p) => index.update(p));
    wired.edit('/memories/notes/people.md', 'tea', 'oolong');
    expect(index.search('oolong').length).toBe(1);
    wired.move('/memories/notes/people.md', '/memories/notes/friends.md');
    expect(index.search('oolong').map((h) => h.path)).toEqual(['/memories/notes/friends.md']);
    // …and catches up with edits made behind its back.
    fs.writeFileSync(path.join(store.dir, 'notes', 'friends.md'), 'Carol likes matcha.');
    fs.utimesSync(path.join(store.dir, 'notes', 'friends.md'), new Date(), new Date(Date.now() + 5_000));
    fs.rmSync(path.join(store.dir, 'journal'), { recursive: true });
    expect(index.sync()).toEqual({ indexed: 1, removed: 1 });
    expect(index.search('matcha').length).toBe(1);
    expect(index.search('三件事')).toEqual([]);
  });

  it('returns the places in a long file where the terms are, with their lines', () => {
    const { store, index } = setup();
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `- 第 ${i} 条无关的记录，写得长一点以便分块。`.repeat(3)).join('\n');
    store.write('journal/2026-11-11.md', `# 2026-11-11\n${filler(20)}\n- 主人定了每晚 23:00 写日记\n${filler(20)}\n- 日记标题用「2026年11月X日｜主题词」`);
    index.sync();
    const [hit] = index.search('日记');
    expect(hit?.chunks.length).toBe(2);
    expect(hit?.chunks.map((c) => c.snippet).join(' ')).toMatch(/\[日记\]/);
    const lines = (store.readText('journal/2026-11-11.md') ?? '').split('\n');
    for (const c of hit?.chunks ?? []) expect(lines.slice(c.start - 1, c.end).join('\n')).toContain('日记');
  });

  it('splits queries into terms, phrases and required terms', () => {
    expect(queryTerms('a "b c"  +d a')).toEqual([
      { text: 'a', required: false },
      { text: 'b c', required: true },
      { text: 'd', required: true },
    ]);
  });
});

describe('memory tools', () => {
  const ctx = (sessionId = 'main', batchId = 'b') => ({ signal: new AbortController().signal, callId: 'c', sessionId, batchId, batchLevel: 2 as const });

  it('run commands, report errors as failed receipts, and record what they read, found and wrote', async () => {
    const { store, index, db } = setup();
    const access = new MemoryAccess(db);
    const tools = memoryTools({ store, index, access }) as unknown as Array<ToolSpec<Record<string, unknown>>>;
    const byName = (n: string) => tools.find((t) => t.name === n) as ToolSpec<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toEqual(['memory', 'memory_search']);
    expect(await byName('memory').handler({ command: 'append', path: 'journal/2026-11-03.md', text: 'today' }, ctx())).toContain('a new file');
    expect(await byName('memory').handler({ command: 'read', path: '/nope' }, ctx())).toEqual({ text: 'Paths are inside /memories, got: /nope', failed: true });
    expect(await byName('memory').handler({ command: 'read', path: 'journal/2026-11-03.md' }, ctx())).toContain('today');
    await byName('memory').handler({ command: 'read', path: 'journal' }, ctx());
    index.sync();
    expect(await byName('memory_search').handler({ query: 'today', scope: 'raw' }, ctx())).toBe('1 file(s) for "today":\n/memories/journal/2026-11-03.md\n  lines 1-1: [today]');
    expect(await byName('memory_search').handler({ query: 'nothing here' }, ctx())).toBe('no memory file matches "nothing here"');
    expect(access.writesBy('main')).toBe(1);
    const recall = access.recall(30, ['notes/a.md']);
    expect(recall).toMatchObject({ searches: 2, unused: ['notes/a.md'], misses: [{ query: 'nothing here', times: 1 }] });
    expect(recall.used).toMatchObject([{ path: 'journal/2026-11-03.md', reads: 1, hits: 1 }]);
  });

  it('asks the owner before a resident file changes when the batch holds someone else’s messages', () => {
    const { store, index } = setup();
    const memory = memoryTools({ store, index, coreWriteCheck: ({ batchId }) => (batchId === 'mixed' ? 'someone else spoke' : null) })[0] as ToolSpec<Record<string, unknown>>;
    const ask = (input: Record<string, unknown>, batchId: string) => memory.askWhen?.(input, ctx('main', batchId)) ?? null;
    expect(ask({ command: 'append', path: 'core/rules.md', text: 'x' }, 'mixed')).toBe('someone else spoke');
    expect(ask({ command: 'append', path: 'core/rules.md', text: 'x' }, 'owner')).toBeNull();
    expect(ask({ command: 'append', path: 'journal/x.md', text: 'x' }, 'mixed')).toBeNull();
    expect(ask({ command: 'read', path: 'core/rules.md' }, 'mixed')).toBeNull();
    expect(ask({ command: 'move', from: 'notes/a.md', to: '/memories/core/owner.md' }, 'mixed')).toBe('someone else spoke');
  });
});
