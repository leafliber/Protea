import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { BoardCommand, ForkInfo, MemoryCheck } from '@protea/protocol';
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
  IdleMaintenance,
  ResidentMemory,
  chunkText,
  compactionTrigger,
  ftsTerm,
  notesRoleAfter,
  renderNotesIndex,
  retryIntervalMs,
  isBoardText,
  kvNamespace,
  memoryTools,
  migrate,
  parseNote,
  segmentText,
  silentLogger,
  type CompactionState,
  type ForkRequest,
  type NoteEntry,
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
    const tool = memoryTools({ store, index, board }).find((t) => t.name === 'board') as ToolSpec<Record<string, unknown>>;
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

  it('builds one expression per term, split by script', () => {
    expect(ftsTerm('例会')).toBe('"例会"');
    expect(ftsTerm('张伟例会')).toBe('"张伟 伟例 例会"');
    expect(ftsTerm('config.yaml')).toBe('"config yaml" *');
    expect(ftsTerm('猫')).toBe('chars : "猫"');
    expect(ftsTerm('A股')).toBe('("a" * AND chars : "股")'.replace('"a"', '"A"'));
    expect(ftsTerm('…')).toBeNull();
  });

  it('ranks two-character Chinese words, with summary and keywords above the body', () => {
    const { store, index } = setup();
    store.write('/memories/notes/a.md', `---\nsummary: 例会安排\nkeywords: [周会, weekly sync]\nupdated: 2026-11-09\nsources: [journal/2026-11-05.md]\n---\n${'这里说的是别的事情。'.repeat(5)}`);
    store.writeText('notes/b.md', `${'很长的一段话，'.repeat(40)}顺带提到例会。`);
    index.sync();
    const hits = index.search('例会');
    expect(hits.map((h) => h.path)).toEqual(['/memories/notes/a.md', '/memories/notes/b.md']);
    expect(hits[0]?.summary).toBe('例会安排');
    expect(hits[1]?.summary).toBeUndefined();
    expect(hits[1]?.chunks[0]?.snippet).toContain('[例会]');
  });

  it('finds synonyms from keywords, mixed scripts, prefixes and lone characters', () => {
    const { store, index } = setup();
    store.write('/memories/notes/a.md', '---\nsummary: 周三的会\nkeywords: [周会, weekly sync]\n---\n正文');
    store.writeText('notes/c.md', 'T3测试步骤写在这里');
    store.writeText('notes/d.md', '养了一只猫。configuration notes，A股收盘');
    index.sync();
    expect(index.search('周会').map((h) => h.path)).toEqual(['/memories/notes/a.md']);
    expect(index.search('"weekly sync"').map((h) => h.path)).toEqual(['/memories/notes/a.md']);
    expect(index.search('T3测试').map((h) => h.path)).toEqual(['/memories/notes/c.md']);
    expect(index.search('config').map((h) => h.path)).toEqual(['/memories/notes/d.md']);
    // A character inside a longer run is found too (the single-character column).
    expect(index.search('猫').map((h) => h.path)).toEqual(['/memories/notes/d.md']);
    expect(index.search('股').map((h) => h.path)).toEqual(['/memories/notes/d.md']);
    expect(index.search('A股').map((h) => h.path)).toEqual(['/memories/notes/d.md']);
    // Not every term has to match: each file says which did.
    expect(index.search('周会 猫').map((h) => [h.path, h.matched])).toEqual([
      ['/memories/notes/a.md', ['周会']],
      ['/memories/notes/d.md', ['猫']],
    ]);
    expect(index.search('+周会 +猫')).toEqual([]);
  });

  it('keeps the record of what happened out of a search unless asked', async () => {
    const { store, index } = setup();
    store.writeText('notes/a.md', '例会在周三');
    store.write('/memories/journal/2026-11-05.md', '今天的例会取消了');
    store.writeText('raw/2026-11-05T00-00-00Z.md', '当时的原话：例会取消');
    store.writeText('handoff/2026-11-05T00-00-00Z.md', '笔记：只有水果');
    index.sync();
    expect(index.search('例会', { scope: 'notes' }).map((h) => h.path)).toEqual(['/memories/notes/a.md']);
    expect(index.search('例会', { scope: 'raw' }).map((h) => h.path).sort()).toEqual(['/memories/journal/2026-11-05.md', '/memories/raw/2026-11-05T00-00-00Z.md']);
    expect(index.search('例会')).toHaveLength(3);

    const tools = memoryTools({ store, index });
    const search = tools.find((t) => t.name === 'memory_search') as ToolSpec<Record<string, unknown>>;
    const ctx = { signal: new AbortController().signal, callId: 'c', sessionId: 'main', batchId: 'b', batchLevel: 2 as const };
    expect(await search.handler({ query: '例会' }, ctx)).toBe('1 file(s) for "例会":\n/memories/notes/a.md\n  lines 1-1: [例会]在周三');
    const hint = (await search.handler({ query: '水果' }, ctx)) as string;
    expect(hint).toContain('1 file(s) in the record');
    expect(hint).not.toContain('只有水果');
    expect(await search.handler({ query: '水果', paths: ['handoff'] }, ctx)).toContain('/memories/handoff/');
    expect(await search.handler({ query: '不存在的词' }, ctx)).toBe('no memory file matches "不存在的词"');
  });

  it('reads optional frontmatter and treats broken frontmatter as text', () => {
    expect(parseNote('---\nsummary: S\nkeywords: a, b，c\n---\nbody')).toEqual({ summary: 'S', hasSummary: true, keywords: ['a', 'b', 'c'], body: 'body', headerLines: 4 });
    expect(parseNote('# Title\n\ntext')).toEqual({ summary: 'Title', hasSummary: false, keywords: [], body: '# Title\n\ntext', headerLines: 0 });
    const broken = '---\n: [\n---\nbody';
    expect(parseNote(broken).body).toBe(broken);
  });

  it('splits files at headings, archived messages and, when long, at list items', () => {
    expect(chunkText('---\nsummary: S\n---\n# A\none\n# B\ntwo')).toEqual([
      { start: 4, end: 5, heading: 'A', text: '# A\none' },
      { start: 6, end: 7, heading: 'B', text: '# B\ntwo' },
    ]);
    expect(chunkText('--- assistant ---\nhello\n\n--- runtime → assistant ---\nhi').map((c) => [c.start, c.end, c.heading])).toEqual([
      [1, 3, 'assistant'],
      [4, 5, 'runtime → assistant'],
    ]);
    const entries = Array.from({ length: 40 }, (_, i) => `- entry ${i} ${'x'.repeat(60)}`).join('\n');
    const pieces = chunkText(entries);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((c) => c.text.startsWith('- entry'))).toBe(true);
    expect(pieces.at(-1)?.end).toBe(40);
  });

  it('indexes every file again after the migration', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.slice(0, 6));
    const store = new MemoryStore(tmpDir('protea-layers-'));
    store.writeText('notes/a.md', '咖啡豆');
    const file = store.listFiles()[0] as { path: string; size: number; mtimeMs: number };
    db.prepare('INSERT INTO memory_files (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)').run(file.path, file.mtimeMs, file.size, 'x');
    db.prepare('INSERT INTO memory_fts (path, body) VALUES (?, ?)').run(file.path, '咖啡豆');
    migrate(db);
    const index = new MemoryIndex(db, store);
    expect(index.sync()).toEqual({ indexed: 1, removed: 0 });
    expect(index.search('咖啡')).toHaveLength(1);
  });
});

describe('the resident layer', () => {
  const note = (path: string, summary: string, extra: Partial<NoteEntry> = {}): NoteEntry => ({ path, summary, hasSummary: true, size: 100, mtimeMs: 0, ...extra });

  it('lists notes by summary, archived ones as one line, and directories when there are too many', () => {
    expect(renderNotesIndex([])).toBeNull();
    expect(renderNotesIndex([note('notes/owner.md', '主人'), note('notes/archive/old.md', 'old'), note('notes/projects/dida.md', '滴答清单')])).toBe(
      '- notes/owner.md — 主人\n- notes/projects/dida.md — 滴答清单\n- notes/archive/ (1 files)',
    );
    const many = Array.from({ length: 30 }, (_, i) => note(`notes/people/p${i}.md`, `person ${i} ${'x'.repeat(30)}`));
    expect(renderNotesIndex([note('notes/owner.md', '主人'), ...many], 500)).toBe('- notes/owner.md — 主人\n- notes/people/ (30 files: p0.md, p1.md, p2.md, p3.md, …)');
  });

  it('publishes on request only, and reports usage and what needs care', () => {
    const { db } = setup();
    const store = new MemoryStore(tmpDir('protea-resident-'));
    const index = new MemoryIndex(db, store);
    const wired = new MemoryStore(store.dir, (p) => index.update(p));
    wired.write('core/owner.md', '主人说中文');
    wired.write('notes/a.md', '---\nsummary: A 笔记\n---\nbody');
    const resident = new ResidentMemory(wired, index);
    expect(resident.published()).toEqual({ owner: '主人说中文', rules: null, index: '- notes/a.md — A 笔记' });
    wired.append('core/rules.md', '- 图片走 QQ');
    wired.writeText('notes/b.md', 'x'.repeat(9000));
    expect(resident.published().rules).toBeNull();
    expect(resident.stale).toBe(true);
    expect(resident.publish()).toBe(true);
    expect(resident.published().rules).toBe('- 图片走 QQ');
    expect(resident.publish()).toBe(false);
    expect(resident.usage()).toEqual([
      { path: 'core/owner.md', chars: 5, limit: 2000 },
      { path: 'core/rules.md', chars: 9, limit: 4000 },
    ]);
    expect(resident.checks()).toEqual([
      { path: 'notes/b.md', problem: 'no_summary' },
      { path: 'notes/b.md', problem: 'too_long', detail: '9000 bytes' },
    ]);
  });
});

describe('the memory tool', () => {
  it('may read the record but not change it; the runtime can', () => {
    const { store } = setup();
    store.writeText('raw/a.md', 'original');
    store.writeText('handoff/b.md', 'notes');
    expect(store.run({ command: 'read', path: '/memories/raw/a.md' })).toContain('original');
    expect(() => store.run({ command: 'edit', path: '/memories/raw/a.md', old: 'original', new: 'x' })).toThrow(MemoryError);
    expect(() => store.run({ command: 'write', path: 'raw/new.md', text: 'x' })).toThrow(/read-only/);
    expect(() => store.run({ command: 'append', path: 'raw/a.md', text: 'x' })).toThrow(/read-only/);
    expect(() => store.run({ command: 'delete', path: '/memories/handoff' })).toThrow(/read-only/);
    expect(() => store.run({ command: 'move', from: '/memories/raw/a.md', to: '/memories/notes/a.md' })).toThrow(/read-only/);
    expect(() => store.run({ command: 'move', from: 'notes/x.md', to: 'handoff/x.md' })).toThrow(/read-only/);
    expect(store.readText('raw/a.md')).toBe('original');
  });

  it('shows a long file a piece at a time', () => {
    const { store } = setup();
    store.writeText('notes/long.md', Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
    const first = store.read('/memories/notes/long.md');
    expect(first).toMatch(/^\/memories\/notes\/long\.md, lines 1-200 of 300:/);
    expect(first).toContain('line 200');
    expect(first).not.toContain('line 201');
    expect(first).toContain('100 more line(s); read with range [201, 300]');
    expect(store.read('/memories/notes/long.md', [201, 203])).toContain('line 203');
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

  it('waits longer after each failure and hands the notes to a bigger model every three', () => {
    expect([0, 1, 2, 3, 5].map((n) => retryIntervalMs(10 * min, n) / min)).toEqual([10, 20, 40, 40, 40]);
    expect([0, 2, 3, 5, 6, 8, 9].map(notesRoleAfter)).toEqual(['cheap', 'cheap', 'fork', 'fork', 'main', 'main', null]);
  });

  it('escalates, then stops and says so until the conversation grows', async () => {
    const bus = new Bus();
    const clock = { nowMs: 0, now() { return this.nowMs; } };
    const roles: Array<string | undefined> = [];
    const notices: Array<{ type: string; level: number }> = [];
    let tokens = 50_000;
    const m = new IdleMaintenance({
      main: {
        busy: false,
        idleSince: 0,
        needsResume: () => false,
        compactionStats: () => ({ conversationTokens: tokens, droppableTokens: tokens - 8_000 }),
        compactWhileIdle: async (_r: string, _k: number, o: { notesRole?: string } = {}) => {
          roles.push(o.notesRole);
          return null;
        },
        abortIdleWork: () => undefined,
      } as never,
      bus,
      urgentPending: () => 0,
      paused: () => false,
      budgetRefusal: () => null,
      settings: () => cfg,
      cacheHorizonMs: () => 5 * min,
      clock,
      log: silentLogger(),
      notify: { pushInternal: (e: { type: string; level: number }) => (notices.push(e), { ok: true, warnings: [] }) } as never,
    });
    for (let i = 0; i < 12; i++) {
      clock.nowMs += 41 * min;
      await m.tick();
    }
    expect(roles).toEqual([undefined, undefined, undefined, 'fork', 'fork', 'fork', 'main', 'main', 'main']);
    expect(notices).toMatchObject([{ type: 'memory.compaction_failed', level: 3 }]);
    expect(m.compactionFailures).toEqual({ count: 9, exhaustedAt: 50_000 });
    tokens = 52_000;
    clock.nowMs += 41 * min;
    await m.tick();
    expect(roles.at(-1)).toBeUndefined();
    expect(roles).toHaveLength(10);
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
    const checks: MemoryCheck[] = [];
    const writes = new Map<string, number>();
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
        inputs: {
          usage: () => [{ path: 'core/owner.md', chars: 120, limit: 2000 }],
          checks: () => checks,
          recall: (days) => ({ days, searches: 3, used: [], unused: ['notes/old.md'], misses: [{ query: '日记', times: 2, last: 'x' }] }),
          writesBy: (session) => writes.get(session) ?? 0,
        },
        bus,
        clock,
        timezone: 'UTC',
        settings: () => DEFAULT_DREAM,
        budgetRefusal: () => refusal,
        onCompleted: () => completed++,
        notify: { pushInternal: (e: unknown) => (notices.push(e), { ok: true, warnings: [] }) } as never,
        log: silentLogger(),
      });
    const end = (id: string, state: ForkInfo['state'], summary?: string, extra: Partial<ForkInfo> = {}): void => {
      const f = { ...(forks.get(id) as ForkInfo), state, ...(summary ? { summary } : {}), ...extra };
      forks.set(id, f);
      bus.emit('fork.changed', f);
    };
    return { make, clock, files, checks, writes, spawned, notices, end, setRefusal: (r: string | null) => (refusal = r), completedCount: () => completed };
  }
  const idleSince = (nowMs: number): number => nowMs - 3_600_000;

  it('runs once a day, after its time, when idle and when there is something new, and says what changed', () => {
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
    expect(t.spawned[0]).toMatchObject({ tools: ['memory', 'memory_search', 'board', 'skill_load'], model: 'main', maxTurns: 40, uncapped: true, level: 4, reportTo: 'none' });
    expect(t.spawned[0]?.goal).toContain('memory-dream');
    const context = t.spawned[0]?.context ?? '';
    expect(context).toContain('This is the first consolidation.');
    expect(context).toContain('journal/2026-11-09.md (1 bytes)');
    expect(context).toContain('core/owner.md 120/2000 characters');
    expect(context).toContain('notes never read or found: notes/old.md');
    expect(context).toContain('searches that found nothing: "日记" ×2');
    expect(r.status()).toMatchObject({ running: true, date: '2026-11-10', forkId: 'f1' });
    expect(r.runningForkId).toBe('f1');
    expect(r.run()).toMatchObject({ started: false });
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(false);
  });

  it('accepts a run with a summary and a write; its own writes are not something new', () => {
    const t = dream();
    const r = t.make();
    r.start();
    r.run();
    t.files.push({ path: 'notes/a.md', size: 1, mtimeMs: t.clock.nowMs + 1 });
    t.writes.set('f1', 3);
    t.clock.nowMs += 60_000;
    t.end('f1', 'completed', 'merged two notes');
    expect(t.completedCount()).toBe(1);
    expect(r.status()).toMatchObject({ running: false, result: 'completed', summary: 'merged two notes', failures: 0, acceptedAt: '2026-11-10T04:01:00.000Z' });
    expect(r.runningForkId).toBeNull();

    t.clock.nowMs += 86_400_000;
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(false);
    t.files.push({ path: 'journal/2026-11-11.md', size: 1, mtimeMs: t.clock.nowMs - 1 });
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(true);
    r.run();
    expect(t.spawned[1]?.context).toContain('The previous accepted consolidation ended at 2026-11-10T04:01:00.000Z.');
    expect(t.spawned[1]?.context).toContain('<changed since="2026-11-10T04:01:00.000Z" files="1">');
  });

  it.each<[string, Partial<ForkInfo>, number, MemoryCheck[], string]>([
    ['without a final summary', { summary: '(no final text)', unfinished: 'no_final_text' }, 2, [], 'it gave no final summary'],
    ['out of rounds', { unfinished: 'round_limit' }, 2, [], 'it ran out of rounds before finishing'],
    ['without a write', {}, 0, [], 'it wrote nothing'],
    ['with a resident file over its limit', {}, 2, [{ path: 'core/rules.md', problem: 'over_limit', detail: '4100/4000' }], 'core/rules.md over the limit'],
  ])('does not accept a run %s, and tries the same input again', (_name, extra, writes, checks, why) => {
    const t = dream();
    const r = t.make();
    r.start();
    r.run();
    t.writes.set('f1', writes);
    t.checks.push(...checks);
    t.end('f1', 'completed', 'summary', extra);
    expect(t.completedCount()).toBe(0);
    expect(r.status()).toMatchObject({ result: 'failed', rejected: why, failures: 1 });
    expect(r.status().acceptedAt).toBeUndefined();
    t.clock.nowMs += 86_400_000;
    expect(r.due(t.clock.nowMs, idleSince(t.clock.nowMs))).toBe(true);
  });

  it('settles a run that ended while the process was down', () => {
    const t = dream();
    const first = t.make();
    first.start();
    first.run();
    first.stop();
    t.writes.set('f1', 1);
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
