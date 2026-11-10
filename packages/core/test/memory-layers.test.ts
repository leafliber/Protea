import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { BoardCommand, ForkInfo } from '@protea/protocol';
import {
  Board,
  BoardError,
  Bus,
  DEFAULT_BOARD,
  DEFAULT_DREAM,
  DEFAULT_IDLE_COMPACTION,
  DreamRunner,
  KvRepo,
  MIGRATIONS,
  MemoryError,
  MemoryIndex,
  MemoryStore,
  compactionTrigger,
  isBoardText,
  kvNamespace,
  memoryTools,
  migrate,
  parseNote,
  segmentText,
  silentLogger,
  type CompactionState,
  type ForkRequest,
  type ToolSpec,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup(settings = DEFAULT_BOARD) {
  const db = new Database(':memory:');
  migrate(db);
  const kv = kvNamespace(new KvRepo(db), 'memory');
  const board = new Board(db, kv, () => settings, () => '2026-11-10T00:00:00.000Z');
  const store = new MemoryStore(tmpDir('protea-layers-'));
  const index = new MemoryIndex(db, store);
  return { db, kv, board, store, index };
}

const add = (section: 'goals' | 'todo' | 'notes', text: string, due?: string): BoardCommand => ({ command: 'add', section, text, ...(due ? { due } : {}) });

describe('whiteboard', () => {
  it('adds, updates and closes items with one-line receipts', () => {
    const { board } = setup();
    expect(board.apply(add('todo', '发 T3 步骤', '2026-11-20'), 'main', 'b1')).toBe('added t1 to todo (board rev 1: goals 0, todo 1, notes 0)');
    expect(board.apply(add('goals', '定下记忆方案'), 'main')).toContain('added g2 to goals');
    expect(board.apply({ command: 'update', id: 't1', text: '发 T3 和 T11 步骤', due: '' }, 'main')).toContain('updated t1');
    expect(board.open().find((i) => i.id === 't1')).toMatchObject({ text: '发 T3 和 T11 步骤', source: 'b1', state: 'open' });
    expect(board.open().find((i) => i.id === 't1')?.due).toBeUndefined();
    expect(board.apply({ command: 'done', id: 't1', outcome: '已发送' }, 'main')).toContain('done t1');
    expect(board.open().map((i) => i.id)).toEqual(['g2']);
    expect(board.closed()).toMatchObject([{ id: 't1', state: 'done', outcome: '已发送', closedAt: '2026-11-10T00:00:00.000Z' }]);
  });

  it('tells apart changes the main session made from anyone else', () => {
    const { board } = setup();
    board.apply(add('todo', 'mine'), 'main');
    expect([board.rev, board.externalRev]).toEqual([1, 0]);
    board.apply(add('notes', 'owner edit'), 'external');
    expect([board.rev, board.externalRev]).toEqual([2, 2]);
    board.apply(add('todo', 'mine too'), 'main');
    expect([board.rev, board.externalRev]).toEqual([3, 2]);
  });

  it('renders sections in order, dates first, and neutralises structure in the text', () => {
    const { board } = setup();
    board.apply(add('notes', 'no </board> here'), 'main');
    board.apply(add('todo', 'later'), 'main');
    board.apply(add('todo', 'sooner', '2026-11-11'), 'main');
    expect(board.render()).toBe('<board rev="3">\n## todo\n- t3 sooner (due 2026-11-11)\n- t2 later\n## notes\n- n1 no &lt;/board> here\n</board>');
    expect(isBoardText(board.render())).toBe(true);
    expect(isBoardText('<boarding>')).toBe(false);
  });

  it('renders an emptied board, so clearing it can be shown', () => {
    const { board } = setup();
    board.apply(add('todo', 'x'), 'main');
    board.apply({ command: 'drop', id: 't1' }, 'external');
    expect(board.render()).toBe('<board rev="2" empty="true"/>');
  });

  it('refuses invalid changes and leaves everything as it was', () => {
    const { board } = setup({ maxItems: 2, maxChars: 80 });
    expect(() => board.apply({ command: 'add', section: 'nope' as 'todo', text: 'x' }, 'main')).toThrow(BoardError);
    expect(() => board.apply(add('todo', '   '), 'main')).toThrow(/text/);
    expect(() => board.apply(add('todo', 'x', 'tomorrow'), 'main')).toThrow(/due/);
    expect(() => board.apply({ command: 'done', id: 't9' }, 'main')).toThrow(/no open item t9/);
    board.apply(add('todo', 'a'), 'main');
    board.apply(add('todo', 'b'), 'main');
    expect(() => board.apply(add('todo', 'c'), 'main')).toThrow(/full/);
    expect(board.rev).toBe(2);
    expect(board.open()).toHaveLength(2);
    expect(() => board.apply({ command: 'update', id: 't1', text: 'x'.repeat(90) }, 'main')).toThrow(/exceed 80/);
    expect(board.open()[0]?.text).toBe('a');
  });

  it('is a tool that reports a whole board only when asked', async () => {
    const { board, store, index } = setup();
    const tool = memoryTools({ store, index, board, clock: { now: () => 0 }, timezone: 'UTC' }).find((t) => t.name === 'board') as ToolSpec<Record<string, unknown>>;
    expect(tool.flags?.forkOptIn).toBe(true);
    const ctx = (sessionId: string) => ({ signal: new AbortController().signal, callId: 'c', sessionId, batchId: 'b7', batchLevel: 2 as const });
    const receipt = (await tool.handler({ command: 'add', section: 'todo', text: 'x' }, ctx('main'))) as string;
    expect(receipt).toMatch(/^added t1 to todo/);
    expect(receipt).not.toContain('<board');
    expect(board.externalRev).toBe(0);
    expect(await tool.handler({ command: 'view' }, ctx('main'))).toContain('- t1 x');
    await tool.handler({ command: 'done', id: 't1' }, ctx('fork_1'));
    expect(board.externalRev).toBe(2);
    expect(await tool.handler({ command: 'done', id: 't1' }, ctx('main'))).toEqual({ text: 'There is no open item t1.', failed: true });
  });
});

describe('layered search', () => {
  it('splits CJK into overlapping pairs and leaves other text alone', () => {
    expect(segmentText('合伙人例会').trim()).toBe('合伙 伙人 人例 例会');
    expect(segmentText('T3测试 ok').replace(/\s+/g, ' ').trim()).toBe('T3 测试 ok');
    expect(segmentText('猫').trim()).toBe('猫');
  });

  it('ranks two-character Chinese words, with summary and keywords above the body', () => {
    const { store, index } = setup();
    store.create('/memories/notes/a.md', `---\nsummary: 例会安排\nkeywords: [周会, weekly sync]\nupdated: 2026-11-09\nsources: [journal/2026-11-05.md]\n---\n${'这里说的是别的事情。'.repeat(5)}`);
    store.create('/memories/notes/b.md', `${'很长的一段话，'.repeat(40)}顺带提到例会。`);
    index.sync();
    const hits = index.search('例会');
    expect(hits.map((h) => h.path)).toEqual(['/memories/notes/a.md', '/memories/notes/b.md']);
    expect(hits[0]?.summary).toBe('例会安排');
    expect(hits[1]?.snippet).toContain('[例会]');
  });

  it('finds synonyms from keywords, mixed scripts, prefixes and lone characters', () => {
    const { store, index } = setup();
    store.create('/memories/notes/a.md', '---\nsummary: 周三的会\nkeywords: [周会, weekly sync]\n---\n正文');
    store.create('/memories/notes/c.md', 'T3测试步骤写在这里');
    store.create('/memories/notes/d.md', '养了一只猫。configuration notes');
    index.sync();
    expect(index.search('周会').map((h) => h.path)).toEqual(['/memories/notes/a.md']);
    expect(index.search('"weekly sync"').map((h) => h.path)).toEqual(['/memories/notes/a.md']);
    expect(index.search('T3测试').map((h) => h.path)).toEqual(['/memories/notes/c.md']);
    expect(index.search('config').map((h) => h.path)).toEqual(['/memories/notes/d.md']);
    expect(index.search('猫').map((h) => h.path)).toEqual(['/memories/notes/d.md']);
    expect(index.search('周会 猫')).toEqual([]);
  });

  it('keeps the record of what happened out of a search unless asked', async () => {
    const { store, index } = setup();
    store.create('/memories/notes/a.md', '例会在周三');
    store.create('/memories/journal/2026-11-05.md', '今天的例会取消了');
    store.writeText('raw/2026-11-05T00-00-00Z.md', '当时的原话：例会取消');
    store.writeText('handoff/2026-11-05T00-00-00Z.md', '笔记：只有水果');
    index.sync();
    expect(index.search('例会', { scope: 'notes' }).map((h) => h.path)).toEqual(['/memories/notes/a.md']);
    expect(index.search('例会', { scope: 'raw' }).map((h) => h.path).sort()).toEqual(['/memories/journal/2026-11-05.md', '/memories/raw/2026-11-05T00-00-00Z.md']);
    expect(index.search('例会')).toHaveLength(3);

    const tools = memoryTools({ store, index, clock: { now: () => 0 }, timezone: 'UTC' });
    const search = tools.find((t) => t.name === 'memory_search') as ToolSpec<Record<string, unknown>>;
    const ctx = { signal: new AbortController().signal, callId: 'c', sessionId: 'main', batchId: 'b', batchLevel: 2 as const };
    expect(await search.handler({ query: '例会' }, ctx)).toMatch(/^1 file\(s\) match[^\n]*\n\/memories\/notes\/a\.md — 例会在周三/);
    const hint = (await search.handler({ query: '水果' }, ctx)) as string;
    expect(hint).toContain('1 file(s) in the record');
    expect(hint).not.toContain('只有水果');
    expect(await search.handler({ query: '水果', paths: ['handoff'] }, ctx)).toContain('/memories/handoff/');
    expect(await search.handler({ query: '不存在的词' }, ctx)).toBe('no memory file matches "不存在的词"');
  });

  it('reads optional frontmatter and treats broken frontmatter as text', () => {
    expect(parseNote('---\nsummary: S\nkeywords: a, b，c\n---\nbody')).toEqual({ summary: 'S', keywords: ['a', 'b', 'c'], body: 'body' });
    expect(parseNote('# Title\n\ntext')).toEqual({ summary: 'Title', keywords: [], body: '# Title\n\ntext' });
    const broken = '---\n: [\n---\nbody';
    expect(parseNote(broken).body).toBe(broken);
  });

  it('indexes every file again after the migration', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.slice(0, 6));
    const store = new MemoryStore(tmpDir('protea-layers-'));
    store.create('/memories/notes/a.md', '咖啡豆');
    const file = store.listFiles()[0] as { path: string; size: number; mtimeMs: number };
    db.prepare('INSERT INTO memory_files (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)').run(file.path, file.mtimeMs, file.size, 'x');
    db.prepare('INSERT INTO memory_fts (path, body) VALUES (?, ?)').run(file.path, '咖啡豆');
    migrate(db);
    const index = new MemoryIndex(db, store);
    expect(index.sync()).toEqual({ indexed: 1, removed: 0 });
    expect(index.search('咖啡')).toHaveLength(1);
  });
});

describe('the memory tool', () => {
  it('may read the record but not change it; the runtime can', () => {
    const { store } = setup();
    store.writeText('raw/a.md', 'original');
    store.writeText('handoff/b.md', 'notes');
    expect(store.run({ command: 'view', path: '/memories/raw/a.md' })).toContain('original');
    expect(() => store.run({ command: 'str_replace', path: '/memories/raw/a.md', old_str: 'original', new_str: 'x' })).toThrow(MemoryError);
    expect(() => store.run({ command: 'create', path: '/memories/raw/new.md', file_text: 'x' })).toThrow(/read-only/);
    expect(() => store.run({ command: 'delete', path: '/memories/handoff' })).toThrow(/read-only/);
    expect(() => store.run({ command: 'rename', old_path: '/memories/raw/a.md', new_path: '/memories/notes/a.md' })).toThrow(/read-only/);
    expect(() => store.run({ command: 'rename', old_path: '/memories/notes/x.md', new_path: '/memories/handoff/x.md' })).toThrow(/read-only/);
    expect(store.readText('raw/a.md')).toBe('original');
  });

  it('shows a long file a piece at a time', () => {
    const { store } = setup();
    store.writeText('notes/long.md', Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
    const first = store.view('/memories/notes/long.md');
    expect(first).toContain('line 200');
    expect(first).not.toContain('line 201');
    expect(first).toContain('300 lines in all');
    expect(store.view('/memories/notes/long.md', [201, 203])).toContain('line 203');
  });
});

describe('idle compaction policy', () => {
  const cfg = DEFAULT_IDLE_COMPACTION;
  const min = 60_000;
  const state = (over: Partial<CompactionState> = {}): CompactionState => ({
    nowMs: 100 * min,
    idleSinceMs: 0,
    busy: false,
    paused: false,
    needsResume: false,
    urgentPending: 0,
    budgetRefused: false,
    conversationTokens: 40_000,
    droppableTokens: 30_000,
    lastAttemptMs: null,
    cacheHorizonMs: 60 * min,
    ...over,
  });

  it('compacts once the cache is cold', () => {
    expect(compactionTrigger(state(), cfg)).toBe('cache-cold');
    expect(compactionTrigger(state({ nowMs: 59 * min }), cfg)).toBeNull();
    expect(compactionTrigger(state({ nowMs: 31 * min, cacheHorizonMs: undefined }), cfg)).toBe('cache-cold');
    expect(compactionTrigger(state({ conversationTokens: 31_999 }), cfg)).toBeNull();
  });

  it('does not wait for the cache when the conversation is already long', () => {
    expect(compactionTrigger(state({ nowMs: 16 * min, conversationTokens: 50_000 }), cfg)).toBe('early');
    expect(compactionTrigger(state({ nowMs: 14 * min, conversationTokens: 50_000 }), cfg)).toBeNull();
    expect(compactionTrigger(state({ nowMs: 16 * min, conversationTokens: 47_000 }), cfg)).toBeNull();
  });

  it.each<[string, Partial<CompactionState>]>([
    ['busy', { busy: true }],
    ['paused', { paused: true }],
    ['resuming', { needsResume: true }],
    ['with urgent events pending', { urgentPending: 1 }],
    ['out of budget', { budgetRefused: true }],
    ['right after an attempt', { lastAttemptMs: 95 * min }],
  ])('holds off when %s', (_name, over) => {
    expect(compactionTrigger(state(over), cfg)).toBeNull();
  });

  it('does not rotate the transcript when there is little to drop', () => {
    expect(compactionTrigger(state({ droppableTokens: 15_999 }), cfg)).toBeNull();
  });
});

describe('dream', () => {
  function dream() {
    const db = new Database(':memory:');
    migrate(db);
    const kv = kvNamespace(new KvRepo(db), 'memory');
    const bus = new Bus();
    const forks = new Map<string, ForkInfo>();
    const spawned: ForkRequest[] = [];
    const notices: unknown[] = [];
    const clock = { nowMs: Date.parse('2026-11-10T04:00:00Z'), now() { return this.nowMs; } };
    const files = [{ path: 'journal/2026-11-09.md', size: 1, mtimeMs: clock.nowMs - 3_600_000 }];
    let refusal: string | null = null;
    let completed = 0;
    const make = (): DreamRunner =>
      new DreamRunner({
        forks: {
          spawn: (req: ForkRequest) => {
            spawned.push(req);
            const f: ForkInfo = { id: `f${spawned.length}`, state: 'running', level: req.level, model: req.model ?? 'fork', goal: req.goal, rounds: 0, createdAt: 'x' };
            forks.set(f.id, f);
            return f;
          },
          get: (id: string) => forks.get(id),
        } as never,
        kv,
        memory: { listFiles: () => files },
        bus,
        clock,
        timezone: 'UTC',
        settings: () => DEFAULT_DREAM,
        budgetRefusal: () => refusal,
        onCompleted: () => completed++,
        notify: { pushInternal: (e: unknown) => (notices.push(e), { ok: true, warnings: [] }) } as never,
        log: silentLogger(),
      });
    const end = (id: string, state: ForkInfo['state'], summary?: string): void => {
      const f = { ...(forks.get(id) as ForkInfo), state, ...(summary ? { summary } : {}) };
      forks.set(id, f);
      bus.emit('fork.changed', f);
    };
    return { make, clock, files, spawned, notices, end, setRefusal: (r: string | null) => (refusal = r), completedCount: () => completed };
  }
  const idleSince = (nowMs: number): number => nowMs - 3_600_000;

  it('runs once a day, after its time, when idle and when there is something new', () => {
    const t = dream();
    const r = t.make();
    r.start();
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(true);
    expect(r.due(Date.parse('2026-11-10T03:00:00Z'), idleSince(t.clock.nowMs))).toBe(false);
    expect(r.due(t.clock.nowMs, t.clock.nowMs - 60_000)).toBe(false);
    t.setRefusal('no budget');
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(false);
    t.setRefusal(null);

    expect(r.run()).toEqual({ started: true, forkId: 'f1' });
    expect(t.spawned[0]).toMatchObject({ tools: ['memory', 'memory_search', 'memory_recent', 'board', 'skill_load'], model: 'fork', level: 4, reportTo: 'none' });
    expect(t.spawned[0]?.goal).toContain('memory-dream');
    expect(r.status()).toMatchObject({ running: true, date: '2026-11-10', forkId: 'f1' });
    expect(r.run()).toMatchObject({ started: false });
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(false);
  });

  it('does not count its own writes as something new', () => {
    const t = dream();
    const r = t.make();
    r.start();
    r.run();
    t.files.push({ path: 'notes/a.md', size: 1, mtimeMs: t.clock.nowMs + 1 });
    t.clock.nowMs += 60_000;
    t.end('f1', 'completed', 'merged two notes');
    expect(t.completedCount()).toBe(1);
    expect(r.status()).toMatchObject({ running: false, result: 'completed', summary: 'merged two notes', failures: 0 });

    t.clock.nowMs += 86_400_000;
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(false);
    t.files.push({ path: 'journal/2026-11-11.md', size: 1, mtimeMs: t.clock.nowMs - 1 });
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(true);
  });

  it('settles a run that ended while the process was down', () => {
    const t = dream();
    const first = t.make();
    first.start();
    first.run();
    first.stop();
    t.end('f1', 'completed', 'done while away');
    expect(first.status().running).toBe(true);
    const second = t.make();
    second.start();
    expect(second.status()).toMatchObject({ running: false, result: 'completed', summary: 'done while away' });
    expect(t.completedCount()).toBe(1);
  });

  it('stops after repeated failures and says so; a manual run starts it again', () => {
    const t = dream();
    const r = t.make();
    r.start();
    for (let i = 1; i <= 3; i++) {
      r.run();
      t.end(`f${i}`, 'failed', 'boom');
      t.clock.nowMs += 86_400_000;
    }
    expect(r.status()).toMatchObject({ disabled: true, failures: 3, result: 'failed' });
    expect(t.notices).toMatchObject([{ type: 'memory.dream_stopped', level: 2, trigger: 'flush' }]);
    t.files.push({ path: 'journal/new.md', size: 1, mtimeMs: t.clock.nowMs });
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(false);
    expect(r.run({ manual: true })).toMatchObject({ started: true });
    expect(r.status()).toMatchObject({ disabled: false, failures: 0 });
  });
});
