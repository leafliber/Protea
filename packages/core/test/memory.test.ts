import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryIndex, MemoryStore, memoryTools, openDatabase, queryTerms, type ToolSpec } from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup() {
  const dir = tmpDir('protea-memory-');
  const changed: string[][] = [];
  const store = new MemoryStore(path.join(dir, 'memory'), (p) => changed.push(p));
  const { db } = openDatabase(path.join(dir, 'protea.db'));
  const index = new MemoryIndex(db, store);
  return { dir, store, db, index, changed };
}

describe('MemoryStore (memory tool commands)', () => {
  it('creates, views, edits, inserts, renames and deletes files under /memories', () => {
    const { store, changed } = setup();
    expect(store.create('/memories/notes/coffee.md', 'beans: geisha\nroast: light')).toBe('File created successfully at: /memories/notes/coffee.md');
    expect(() => store.create('/memories/notes/coffee.md', 'x')).toThrow('Error: File /memories/notes/coffee.md already exists');
    expect(store.view('/memories/notes/coffee.md')).toBe("Here's the content of /memories/notes/coffee.md with line numbers:\n     1\tbeans: geisha\n     2\troast: light");
    expect(store.view('/memories/notes/coffee.md', [2, -1])).toContain('     2\troast: light');
    expect(store.view('/memories')).toMatch(/^Here're the files and directories up to 2 levels deep in \/memories[^\n]*\n.*\t\/memories\n.*\t\/memories\/notes\/\n.*\t\/memories\/notes\/coffee\.md$/);

    expect(store.strReplace('/memories/notes/coffee.md', 'light', 'medium')).toContain('     2\troast: medium');
    expect(() => store.strReplace('/memories/notes/coffee.md', 'nothing', 'x')).toThrow('did not appear verbatim');
    store.insert('/memories/notes/coffee.md', 0, 'title: coffee\n');
    expect(() => store.strReplace('/memories/notes/coffee.md', 'e', 'x')).toThrow(/Multiple occurrences .* in lines: 1, 2, 3/);
    expect(() => store.insert('/memories/notes/coffee.md', 9, 'x')).toThrow('Invalid `insert_line` parameter: 9. It should be within the range of lines of the file: [0, 3]');
    expect(store.readText('notes/coffee.md')).toBe('title: coffee\nbeans: geisha\nroast: medium');

    expect(store.rename('/memories/notes/coffee.md', '/memories/notes/drinks/coffee.md')).toBe('Successfully renamed /memories/notes/coffee.md to /memories/notes/drinks/coffee.md');
    expect(store.delete('/memories/notes')).toBe('Successfully deleted /memories/notes');
    expect(() => store.view('/memories/notes')).toThrow('The path /memories/notes does not exist. Please provide a valid path.');
    expect(changed.flat()).toEqual(['notes/coffee.md', 'notes/coffee.md', 'notes/coffee.md', 'notes/coffee.md', 'notes/drinks/coffee.md', 'notes/drinks/coffee.md']);
  });

  it('keeps every path inside the memory directory', () => {
    const { dir, store } = setup();
    expect(() => store.view('/etc/passwd')).toThrow('Path must start with /memories');
    expect(() => store.create('/memories/../escape.md', 'x')).toThrow('would escape /memories directory');
    expect(() => store.create('/memories/a/./b.md', 'x')).toThrow('would escape');
    expect(() => store.delete('/memories')).toThrow('Cannot delete the /memories directory itself');
    expect(() => store.rename('/memories', '/memories/x')).toThrow('Cannot rename');
    // A symlink inside the directory that points outside it is refused, for reads and writes.
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.symlinkSync(outside, path.join(store.dir, 'link'));
    expect(() => store.view('/memories/link/secret.txt')).toThrow('via symlink');
    expect(() => store.create('/memories/link/new.md', 'x')).toThrow('via symlink');
    expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
    // Not listed either (the index never follows it).
    expect(store.listFiles().map((f) => f.path)).toEqual([]);
  });

  it('refuses files over the size limit', () => {
    const { store } = setup();
    expect(() => store.create('/memories/big.md', 'x'.repeat(1024 * 1024 + 1))).toThrow('would exceed 1M');
  });
});

describe('MemoryIndex (memory_search)', () => {
  it('finds Chinese and English text, short terms and phrases, and follows edits', () => {
    const { store, index } = setup();
    store.create('/memories/journal/2026-11-02.md', '我们说好的三件事：买咖啡豆、预约牙医、周五交报告。');
    store.create('/memories/notes/people.md', 'Alice prefers tea. Bob owns a coffee grinder.');
    store.create('/memories/blobs/raw.md', '咖啡豆 should not be indexed');
    expect(index.sync()).toEqual({ indexed: 2, removed: 0 });

    expect(index.search('三件事').map((h) => h.path)).toEqual(['/memories/journal/2026-11-02.md']);
    expect(index.search('三件事')[0]?.snippet).toContain('[三件事]');
    // Two-character CJK words are below the trigram length: matched by substring.
    expect(index.search('牙医').map((h) => h.path)).toEqual(['/memories/journal/2026-11-02.md']);
    expect(index.search('牙医')[0]?.snippet).toContain('[牙医]');
    expect(index.search('coffee').map((h) => h.path)).toEqual(['/memories/notes/people.md']);
    expect(index.search('"coffee grinder" Bob').length).toBe(1);
    expect(index.search('coffee tea zebra')).toEqual([]);
    expect(index.search('coffee', { paths: ['journal'] })).toEqual([]);
    expect(index.search('咖啡豆', { paths: ['/memories/journal/'] }).length).toBe(1);
    expect(index.search('咖啡豆', { paths: ['notes/*.md'] })).toEqual([]);

    // The index follows the store's own writes when wired through onChange…
    const wired = new MemoryStore(store.dir, (p) => index.update(p));
    wired.strReplace('/memories/notes/people.md', 'tea', 'oolong');
    expect(index.search('oolong').length).toBe(1);
    wired.rename('/memories/notes/people.md', '/memories/notes/friends.md');
    expect(index.search('oolong').map((h) => h.path)).toEqual(['/memories/notes/friends.md']);
    // …and catches up with edits made behind its back.
    fs.writeFileSync(path.join(store.dir, 'notes', 'friends.md'), 'Carol likes matcha.');
    fs.utimesSync(path.join(store.dir, 'notes', 'friends.md'), new Date(), new Date(Date.now() + 5_000));
    fs.rmSync(path.join(store.dir, 'journal'), { recursive: true });
    expect(index.sync()).toEqual({ indexed: 1, removed: 1 });
    expect(index.search('matcha').length).toBe(1);
    expect(index.search('三件事')).toEqual([]);
  });

  it('splits queries into terms and phrases', () => {
    expect(queryTerms('a "b c"  d')).toEqual(['a', 'b c', 'd']);
  });
});

describe('memory tools', () => {
  it('run commands, report errors as failed receipts and list recent journal days', async () => {
    const { store, index } = setup();
    const now = Date.parse('2026-11-03T09:00:00+08:00');
    const tools = memoryTools({ store, index, clock: { now: () => now }, timezone: 'Asia/Shanghai' }) as unknown as Array<ToolSpec<Record<string, unknown>>>;
    const byName = (n: string) => tools.find((t) => t.name === n) as ToolSpec<Record<string, unknown>>;
    const ctx = { signal: new AbortController().signal, callId: 'c', sessionId: 'main', batchId: 'b', batchLevel: 2 as const };
    expect(tools.map((t) => t.name)).toEqual(['memory', 'memory_search', 'memory_recent']);
    expect(byName('memory').providerType).toBeUndefined();
    expect(await byName('memory').handler({ command: 'create', path: '/memories/journal/2026-11-03.md', file_text: 'today' }, ctx)).toContain('File created');
    store.create('/memories/journal/2026-11-01.md', 'two days ago');
    store.create('/memories/journal/2026-10-20.md', 'long ago');
    expect(await byName('memory').handler({ command: 'view', path: '/nope' }, ctx)).toEqual({ text: 'Path must start with /memories, got: /nope', failed: true });
    expect(await byName('memory_recent').handler({ days: 3 }, ctx)).toBe('/memories/journal/2026-11-03.md (5 bytes)\n/memories/journal/2026-11-01.md (12 bytes)');
    index.sync();
    expect(await byName('memory_search').handler({ query: 'ago', scope: 'raw' }, ctx)).toMatch(/^2 file\(s\) match "ago":/);
    const native = memoryTools({ store, index, clock: { now: () => now }, timezone: 'UTC', nativeType: true })[0];
    expect(native?.providerType).toBe('memory_20250818');
  });
});
