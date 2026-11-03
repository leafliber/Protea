import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KvRepo,
  SkillRegistry,
  kvNamespace,
  openDatabase,
  parseSkillFile,
  silentLogger,
  skillTools,
  systemClock,
  type PromptSource,
  type SkillRoot,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

const BUILTIN = fileURLToPath(new URL('../../../skills/', import.meta.url));

function skill(dir: string, name: string, front: string, body = 'Do the thing.\n', files: Record<string, string> = {}): string {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\n${front}\n---\n\n${body}`);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), text);
  }
  return d;
}

function setup(opts: { tools?: string[]; disabled?: string[]; prompts?: PromptSource; db?: string } = {}) {
  const data = tmpDir('protea-skills-');
  const user = path.join(data, 'skills');
  fs.mkdirSync(user, { recursive: true });
  const { db } = openDatabase(opts.db ?? path.join(data, 'protea.db'));
  const changes: string[][] = [];
  const disabled = new Set(opts.disabled ?? []);
  const tools = opts.tools ?? ['self_status', 'events_query'];
  const roots: SkillRoot[] = [
    { dir: BUILTIN, origin: 'builtin' },
    { dir: user, origin: 'user' },
  ];
  const reg = new SkillRegistry({
    roots: () => roots,
    userDir: user,
    disabled: () => disabled,
    mcpPrompts: () => true,
    toolNames: () => tools,
    ...(opts.prompts ? { prompts: opts.prompts } : {}),
    kv: kvNamespace(new KvRepo(db), 'skills'),
    log: silentLogger(),
    clock: systemClock,
    onChanged: (names) => changes.push(names),
  });
  reg.rescan();
  const ctx = (callId = 'tu_1', sessionId = 'main') => ({ sessionId, callId, signal: new AbortController().signal });
  return { data, user, reg, changes, disabled, tools, roots, ctx, dbFile: path.join(data, 'protea.db') };
}

describe('SKILL.md parsing', () => {
  it('reads the Agent Skills frontmatter and Protea extensions', () => {
    const p = parseSkillFile(
      '---\nname: weekly-report\ndescription: Weekly report every Monday.\nallowed-tools: mcp__github__*, tg_send\nmetadata:\n  level: 3\n  version: 1.2\n  requires-tools: [mcp__github__*]\n---\n\n# Steps\n1. Go\n',
      'weekly-report',
    );
    expect(p.errors).toEqual([]);
    expect(p.meta).toMatchObject({
      name: 'weekly-report',
      description: 'Weekly report every Monday.',
      allowedTools: ['mcp__github__*', 'tg_send'],
      requiresTools: ['mcp__github__*'],
      level: 3,
      version: '1.2',
    });
    expect(p.body).toBe('# Steps\n1. Go\n');
  });

  it('rejects broken files with a reason', () => {
    expect(parseSkillFile('# no frontmatter', 'x').errors).toEqual(['SKILL.md has no YAML frontmatter (it must start with a "---" line)']);
    expect(parseSkillFile('---\nname: other\ndescription: d\n---\nbody', 'mine').errors).toEqual(['name "other" does not match the directory name "mine"']);
    expect(parseSkillFile('---\nname: x\n---\nbody', 'x').errors).toEqual(['description is missing or empty']);
    expect(parseSkillFile('---\nname: x\ndescription: [unclosed\n---\n', 'x').errors[0]).toMatch(/not valid YAML/);
    expect(parseSkillFile('---\nname: Bad Name\ndescription: d\n---\n', 'Bad Name').errors[0]).toMatch(/must match/);
    const long = parseSkillFile(`---\nname: x\ndescription: ${'a'.repeat(1100)}\n---\nbody`, 'x');
    expect(long.meta?.description).toHaveLength(1024);
    expect(long.warnings).toContain('description is 1100 characters; truncated to 1024');
  });
});

describe('skills registry', () => {
  it('lists built-in skills, sorted, hiding those whose required tools are missing', () => {
    const t = setup();
    expect(t.reg.listedNames()).toEqual(['daily-brief', 'protea-self-ops']);
    const catalog = t.reg.catalog() as string;
    expect(catalog.startsWith('# Skills\n')).toBe(true);
    expect(catalog).toMatch(/\n- daily-brief: Prepare the owner's morning brief.*\(source: builtin\)\n- protea-self-ops: /);
    expect(t.reg.get('memory-hygiene')).toMatchObject({ listed: false, requiresTools: ['memory', 'memory_search'] });
    // Once the memory tools exist (M4) it appears.
    t.tools.push('memory', 'memory_search');
    expect(t.reg.refreshCatalog()).toBe(true);
    expect(t.reg.listedNames()).toContain('memory-hygiene');
  });

  it('picks up a copied skill on rescan, rejects a broken one with its reason, and lets user skills override built-ins', () => {
    const t = setup();
    skill(t.user, 'weekly-report', 'name: weekly-report\ndescription: Weekly report.', '# Weekly\n', { 'scripts/collect.py': 'print(1)\n', 'references/format.md': '# Format\n' });
    skill(t.user, 'broken', 'name: something-else\ndescription: d');
    fs.mkdirSync(path.join(t.user, 'empty-dir'));
    skill(t.user, 'daily-brief', 'name: daily-brief\ndescription: My own brief.');
    expect(t.reg.rescan()).toBe(true);
    expect(t.changes.at(-1)).toEqual(['daily-brief', 'protea-self-ops', 'weekly-report']);
    expect(t.reg.catalog()).toContain('- weekly-report: Weekly report. (source: user)');
    expect(t.reg.get('daily-brief')).toMatchObject({ origin: 'user', description: 'My own brief.', warnings: ['overrides the builtin skill of the same name'] });
    const all = t.reg.list();
    expect(all.find((s) => s.name === 'broken')).toMatchObject({ listed: false, errors: ['name "something-else" does not match the directory name "broken"'] });
    expect(all.find((s) => s.name === 'empty-dir')).toMatchObject({ errors: ['SKILL.md is missing'] });
    expect(t.reg.rescan()).toBe(false); // nothing changed: the prefix stays put
  });

  it('loads a skill once per session and reports its files', async () => {
    const t = setup();
    skill(t.user, 'weekly-report', 'name: weekly-report\ndescription: Weekly report.\nallowed-tools: tg_send\nmetadata:\n  version: 1.2', '# Weekly\nCollect, then send.\n', {
      'scripts/collect.py': 'print(1)\n',
      'references/format.md': '# Format\n',
    });
    t.reg.rescan();
    const [load, read] = skillTools(t.reg);
    const first = await load?.handler({ name: 'weekly-report' } as never, { ...t.ctx('tu_1'), batchId: 'b', batchLevel: 1 });
    expect(first).toEqual({
      text: [
        '# Skill: weekly-report (user, v1.2)',
        '# Weekly\nCollect, then send.',
        '',
        '## Files',
        'references/format.md (9 B)',
        'scripts/collect.py (9 B)',
        '',
        'Read these with skill_read {"name": "weekly-report", "path": "<file>"}.',
        '',
        'Suggested tools: tg_send',
      ].join('\n'),
    });
    expect(await t.reg.load('weekly-report', t.ctx('tu_2'))).toEqual({
      text: 'Skill weekly-report is already loaded in this session (tool call tu_1); follow the instructions there.',
    });
    // Another session (a fork) gets the body.
    expect((await t.reg.load('weekly-report', t.ctx('tu_3', 'fork_1'))).text).toMatch(/^# Skill: weekly-report/);
    // An edited skill loads again, marked as updated.
    fs.appendFileSync(path.join(t.user, 'weekly-report', 'SKILL.md'), 'Also archive it.\n');
    expect((await t.reg.load('weekly-report', t.ctx('tu_4'))).text).toMatch(/^# Skill: weekly-report \(user, v1.2\) — updated since it was last loaded\n/);
    expect(t.reg.get('weekly-report')).toMatchObject({ loads: 4 });

    expect(read?.handler({ name: 'weekly-report', path: 'references/format.md' } as never, { ...t.ctx(), batchId: 'b', batchLevel: 1 })).toEqual({ text: '# Format\n' });
    expect(t.reg.read('weekly-report', 'references')).toEqual({ text: 'format.md (9 B)' });
    expect(t.reg.read('weekly-report', '../../protea.db')).toMatchObject({ failed: true, text: '../../protea.db is outside the skill directory' });
    fs.symlinkSync(path.join(t.data, 'protea.db'), path.join(t.user, 'weekly-report', 'link.db'));
    expect(t.reg.read('weekly-report', 'link.db')).toMatchObject({ failed: true, text: 'link.db is outside the skill directory' });
    expect(t.reg.read('weekly-report', 'nope.md')).toMatchObject({ failed: true });

    expect(await t.reg.load('nope', t.ctx())).toMatchObject({ failed: true, text: 'Unknown skill nope. Available: daily-brief, protea-self-ops, weekly-report.' });
    skill(t.user, 'broken', 'name: broken');
    t.reg.rescan();
    expect(await t.reg.load('broken', t.ctx())).toEqual({ failed: true, text: 'Skill broken is invalid: description is missing or empty' });
    t.disabled.add('weekly-report');
    t.reg.refreshCatalog();
    expect(t.reg.catalog()).not.toContain('weekly-report');
    expect(await t.reg.load('weekly-report', t.ctx())).toEqual({ failed: true, text: 'Skill weekly-report is disabled.' });
  });

  it('remembers what the main session loaded across restarts, until the session starts over', async () => {
    const t = setup();
    await t.reg.load('daily-brief', t.ctx('tu_9'));
    const again = setup({ db: t.dbFile });
    expect((await again.reg.load('daily-brief', again.ctx('tu_10'))).text).toMatch(/already loaded in this session \(tool call tu_9\)/);
    again.reg.resetSession('main');
    expect((await again.reg.load('daily-brief', again.ctx('tu_11'))).text).toMatch(/^# Skill: daily-brief \(builtin, v1\)/);
  });

  it('installs from a directory and uninstalls user skills', () => {
    const t = setup();
    const src = skill(tmpDir(), 'checkout-name', 'name: release-notes\ndescription: Write release notes.', 'Body\n', { '.git/HEAD': 'x' });
    expect(t.reg.install(src)).toMatchObject({ name: 'release-notes', origin: 'user', listed: true });
    expect(fs.existsSync(path.join(t.user, 'release-notes', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(t.user, 'release-notes', '.git'))).toBe(false);
    expect(fs.readdirSync(t.user).filter((f) => f.startsWith('.'))).toEqual([]);
    expect(() => t.reg.install(skill(tmpDir(), 'bad', 'name: bad'))).toThrow(/invalid skill: description is missing/);
    t.reg.uninstall('release-notes');
    expect(t.reg.get('release-notes')).toBeUndefined();
    expect(() => t.reg.uninstall('daily-brief')).toThrow(/not an installed user skill/);
  });

  it('offers MCP prompts as read-only skills', async () => {
    const prompts: PromptSource = {
      prompts: () => [{ server: 'gh', prompt: 'review', description: 'Review a pull request.', arguments: [{ name: 'pr', required: true }] }],
      render: async (_s, _p, args) => `Review PR ${args['pr']}.`,
    };
    const t = setup({ prompts });
    expect(t.reg.catalog()).toContain('- mcp:gh/review: Review a pull request. (source: mcp)');
    expect(await t.reg.load('mcp:gh/review', t.ctx())).toEqual({ failed: true, text: 'Skill mcp:gh/review needs arguments: pr. Parameters:\npr (required)' });
    expect(await t.reg.load('mcp:gh/review', { ...t.ctx(), arguments: { pr: '42' } })).toEqual({ text: '# Skill: mcp:gh/review (mcp prompt)\nReview PR 42.' });
    expect(t.reg.read('mcp:gh/review', 'x')).toMatchObject({ failed: true });
  });
});
