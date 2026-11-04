import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LogRing,
  SecretStore,
  configSources,
  fetchSource,
  listRuns,
  parseSourceSpec,
  patchConfigFile,
  pruneRuns,
  queryLogFile,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

const line = (o: Record<string, unknown>) => `${JSON.stringify({ time: Date.parse('2026-11-04T08:00:00Z'), level: 30, msg: '', ...o })}\n`;

describe('logs', () => {
  it('LogRing keeps the newest lines, filters and notifies', () => {
    const ring = new LogRing(3);
    const live: string[] = [];
    ring.subscribe((e) => live.push(e.msg));
    ring.write(line({ msg: 'a', component: 'scheduler' }));
    ring.write(line({ msg: 'b', level: 40, component: 'plugins', plugin: 'telegram' }));
    ring.write(`${line({ msg: 'c', level: 20 })}${line({ msg: 'd', level: 50, batch: 'B1' })}`);
    ring.write('not json\n');
    expect(ring.query().map((e) => e.msg)).toEqual(['b', 'c', 'd']);
    expect(ring.query({ level: 'warn' }).map((e) => e.msg)).toEqual(['b', 'd']);
    expect(ring.query({ plugin: 'telegram' }).map((e) => e.msg)).toEqual(['b']);
    expect(ring.query({ fields: { batch: 'B1' } }).map((e) => e.msg)).toEqual(['d']);
    expect(ring.query({ q: 'TELEGRAM' }).map((e) => e.msg)).toEqual(['b']);
    expect(ring.query({}, 1).map((e) => e.msg)).toEqual(['d']);
    expect(live).toEqual(['a', 'b', 'c', 'd']);
    expect(() => ring.query({ level: 'loud' })).toThrow('unknown log level');
  });

  it('queries run logs on disk and prunes old runs', async () => {
    const runs = tmpDir('protea-runs-');
    const ids = ['01JAAAAAAAAAAAAAAAAAAAAAAA', '01JBBBBBBBBBBBBBBBBBBBBBBB', '01JCCCCCCCCCCCCCCCCCCCCCCC'];
    for (const [i, id] of ids.entries()) {
      fs.mkdirSync(path.join(runs, id, i === 0 ? 'crash' : ''), { recursive: true });
      fs.writeFileSync(path.join(runs, id, 'log.jsonl'), line({ msg: `start ${i}`, time: Date.parse(`2026-11-0${i + 1}T00:00:00Z`) }) + line({ msg: 'tool done', tool: 'con_send' }));
      if (i === 0) fs.writeFileSync(path.join(runs, id, 'crash', 'x.json'), '{}');
      if (i === 1) fs.writeFileSync(path.join(runs, id, 'shutdown.json'), '{}');
    }
    const list = listRuns(runs);
    expect(list.map((r) => r.id)).toEqual([...ids].reverse());
    expect(list.find((r) => r.id === ids[0])).toMatchObject({ crashes: 1, hasShutdown: false, startedAt: '2026-11-01T00:00:00.000Z' });
    expect((await queryLogFile(path.join(runs, ids[1] as string, 'log.jsonl'), { fields: { tool: 'con_send' } })).map((e) => e.msg)).toEqual(['tool done']);
    expect(await queryLogFile(path.join(runs, 'missing', 'log.jsonl'))).toEqual([]);
    expect(pruneRuns(runs, 1, ids[0] as string)).toEqual([ids[1]]); // never the current run
    expect(fs.readdirSync(runs).sort()).toEqual([ids[0], ids[2]]);
  });
});

describe('config patches', () => {
  it('merge-patches config.yaml, keeping comments; validates before writing', () => {
    const dir = tmpDir('protea-cfg-');
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, '# keep me\nbudget:\n  dailyUsd: 5 # five dollars\nskills:\n  disabled: [a]\n');
    const r = patchConfigFile(dir, { budget: { dailyUsd: 7 }, skills: { disabled: null }, mcp: { servers: { fetch: { command: 'uvx', args: ['x'], env: null } } }, owner: {} }, {});
    expect(r.changed).toEqual(['budget.dailyUsd', 'skills.disabled', 'mcp']);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('dailyUsd: 7 # five dollars');
    expect(text).not.toContain('disabled');
    expect(text).not.toContain('env');
    expect(r.config.budget.dailyUsd).toBe(7);
    expect(r.config.mcp.servers['fetch']?.command).toBe('uvx');

    expect(() => patchConfigFile(dir, { session: { rounds: { soft: 9, hard: 1 } } }, {})).toThrow('session.rounds');
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(patchConfigFile(dir, { budget: {} }, {}).changed).toEqual([]);

    // Numeric keys in the file are matched, not duplicated as strings.
    fs.appendFileSync(file, 'scheduler:\n  levels:\n    2: { debounceMs: 100, maxWaitMs: 0 }\n');
    expect(patchConfigFile(dir, { scheduler: { levels: { '2': { debounceMs: 250 } } } }, {}).changed).toEqual(['scheduler.levels.2.debounceMs']);
    expect(fs.readFileSync(file, 'utf8')).toContain('2: { debounceMs: 250, maxWaitMs: 0 }');

    const sources = configSources(dir, { PROTEA_SESSION__BACKOFF_MS: '[1,2]' });
    expect(sources['budget.dailyUsd']).toBe('file');
    expect(sources['session.backoffMs']).toBe('environment');
    expect(sources['daemon.timezone']).toBe('defaults');
  });
});

describe('secrets', () => {
  it('lists names with their source, deletes files, never returns values', () => {
    const dir = tmpDir('protea-secrets-');
    const s = new SecretStore(dir, { PROTEA_SECRET_FROM_ENV: 'env-value-123', PLAIN: 'plain-value-123' });
    s.set('STORED', 'stored-value-1');
    s.set('FROM_ENV', 'shadowed-file');
    expect(s.get('PLAIN')).toBe('plain-value-123');
    expect(s.list()).toEqual([
      { name: 'FROM_ENV', source: 'env', shadowedFile: true },
      { name: 'PLAIN', source: 'env', shadowedFile: false },
      { name: 'STORED', source: 'file', shadowedFile: false },
    ]);
    expect(JSON.stringify(s.list())).not.toMatch(/value/);
    expect(s.delete('STORED')).toEqual({ removed: true, fromEnv: false });
    expect(s.delete('FROM_ENV')).toEqual({ removed: true, fromEnv: true });
    expect(s.list().map((x) => x.name)).toEqual(['FROM_ENV', 'PLAIN']);
    expect(() => s.set('OK', '   ')).toThrow('empty');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.tmp'))).toEqual([]);
  });
});

describe('install sources', () => {
  it('parses request bodies', () => {
    expect(parseSourceSpec({ path: '/x' })).toEqual({ source: 'path', path: '/x' });
    expect(parseSourceSpec({ gitUrl: 'https://example.com/r.git', ref: 'v1' })).toEqual({ source: 'git', url: 'https://example.com/r.git', ref: 'v1' });
    expect(parseSourceSpec({ source: 'git', url: 'git@github.com:a/b.git', subdir: 'plugins/x' })).toMatchObject({ subdir: 'plugins/x' });
    expect(() => parseSourceSpec({ source: 'git', url: 'ftp://x' })).toThrow('git url');
    expect(() => parseSourceSpec({ source: 'git', url: 'https://x', ref: '--upload-pack=evil' })).toThrow('invalid ref');
    expect(() => parseSourceSpec({ source: 'tarball', url: 'file:///etc/passwd' })).toThrow('http');
    expect(() => parseSourceSpec({})).toThrow('source must be');
  });

  it('clones a branch and refuses subdirectories and symlinks that leave the source', async () => {
    const repo = tmpDir('protea-repo-');
    fs.mkdirSync(path.join(repo, 'pkg'));
    fs.writeFileSync(path.join(repo, 'pkg', 'SKILL.md'), 'x');
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'one');
    git('branch', 'stable');
    const got = await fetchSource({ source: 'git', url: `file://${repo}`, ref: 'stable', subdir: 'pkg' });
    try {
      expect(fs.readFileSync(path.join(got.dir, 'SKILL.md'), 'utf8')).toBe('x');
    } finally {
      got.cleanup();
    }
    expect(fs.existsSync(got.dir)).toBe(false);
    await expect(fetchSource({ source: 'git', url: `file://${repo}`, subdir: '../..' })).rejects.toThrow('escapes');
    await expect(fetchSource({ source: 'path', path: repo, subdir: '../' })).rejects.toThrow('escapes');

    fs.symlinkSync('/etc', path.join(repo, 'pkg', 'host'));
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'two');
    await expect(fetchSource({ source: 'git', url: `file://${repo}` })).rejects.toThrow('symlink leaves the source');
  });
});
