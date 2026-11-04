import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { clipOutput, commandEnv, createShellPlugin, resolveCwd, runCommand } from '../src/plugin.js';

const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

function dataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'protea-shell-'));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('shell helpers', () => {
  it('builds a whitelisted environment without secrets', () => {
    const env = commandEnv('/ws', { FOO: 'bar', GITHUB_TOKEN: 'x', PROTEA_ADMIN: 'y', MY_API_KEY: 'z' }, {
      PATH: '/bin',
      LANG: 'C.UTF-8',
      ANTHROPIC_API_KEY: 'sk-secret',
      TELEGRAM_BOT_TOKEN: 'tg',
      PROTEA_PLUGIN_ID: 'shell',
      npm_config_cache: '/data/cache/npm',
    });
    expect(env).toEqual({
      PATH: '/bin',
      LANG: 'C.UTF-8',
      npm_config_cache: '/data/cache/npm',
      HOME: '/ws',
      TMPDIR: '/ws/.tmp',
      TERM: 'dumb',
      FOO: 'bar',
    });
  });

  it('keeps cwd inside the workspace', () => {
    const ws = path.join(dataDir(), 'workspace');
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
    const outside = dataDir();
    fs.symlinkSync(outside, path.join(ws, 'escape'));
    expect(resolveCwd(ws, undefined)).toBe(fs.realpathSync(ws));
    expect(resolveCwd(ws, 'sub')).toBe(fs.realpathSync(path.join(ws, 'sub')));
    expect(() => resolveCwd(ws, '..')).toThrow(/outside the workspace/);
    expect(() => resolveCwd(ws, 'escape')).toThrow(/outside the workspace/);
    expect(() => resolveCwd(ws, 'missing')).toThrow(/does not exist/);
  });

  it('keeps the head and tail of long output', () => {
    const s = `${'a'.repeat(100)}${'b'.repeat(100)}`;
    expect(clipOutput(s, 1000)).toBe(s);
    const c = clipOutput(s, 40);
    expect(c.startsWith('a'.repeat(20))).toBe(true);
    expect(c.endsWith('b'.repeat(20))).toBe(true);
    expect(c).toContain('[160 bytes cut]');
  });

  it('kills the whole process group on timeout', async () => {
    const ws = dataDir();
    const pidFile = path.join(ws, 'child.pid');
    const r = await runCommand({
      shell: '/bin/sh',
      command: `sleep 30 & echo $! > ${pidFile}; echo started; wait`,
      cwd: ws,
      env: commandEnv(ws),
      timeoutMs: 400,
      captureBytes: 1000,
    });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toContain('started');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  });
});

describe('sh_run', () => {
  it('runs in the workspace and reports exit code, stdout and stderr', async () => {
    const dir = dataDir();
    const h = new FakeHost(createShellPlugin(), { id: 'shell', hostDataDir: dir, config: { maxOutputKb: 1 } });
    hosts.push(h);
    await h.start();
    const ok = await h.callTool('sh_run', { command: 'pwd; echo "$HOME"; echo oops >&2; echo hi > note.txt' });
    expect(ok.failed).toBeFalsy();
    expect(ok.text).toMatch(/^exit code 0 · /);
    const ws = fs.realpathSync(path.join(dir, 'workspace'));
    expect(ok.text).toContain(`--- stdout ---\n${ws}\n`);
    expect(ok.text).toContain('--- stderr ---\noops');
    expect(fs.readFileSync(path.join(dir, 'workspace', 'note.txt'), 'utf8')).toBe('hi\n');

    const bad = await h.callTool('sh_run', { command: 'exit 3' });
    expect(bad).toMatchObject({ failed: true });
    expect(bad.text).toMatch(/^exit code 3/);

    const big = await h.callTool('sh_run', { command: 'head -c 5000 /dev/zero | tr "\\0" x' });
    expect(big.text.length).toBeLessThan(1200);
    expect(big.text).toContain('bytes cut');

    const stdin = await h.callTool('sh_run', { command: 'wc -c', stdin: 'abcd' });
    expect(stdin.text).toMatch(/4/);

    const slow = await h.callTool('sh_run', { command: 'sleep 5', timeoutSec: 1 });
    expect(slow).toMatchObject({ failed: true });
    expect(slow.text).toMatch(/^timed out after 1s/);

    expect(await h.callTool('sh_run', { command: 'ls', cwd: '../..' })).toMatchObject({ failed: true });
  });
});
