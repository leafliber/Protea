import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { SandboxAgent } from '@protea/sandbox';
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
    const h = new FakeHost(createShellPlugin(), { id: 'shell', hostDataDir: dir, config: { backend: 'local', maxOutputKb: 1 } });
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

describe('sh_* through the sandbox', () => {
  async function withSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
    const socket = path.join(root, 'a.sock');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const agent = new SandboxAgent({ socket, home, workspace: path.join(root, 'ws'), env: { PATH: process.env['PATH'] as string } });
    await agent.start();
    const h = new FakeHost(createShellPlugin(), { id: 'shell', levelCap: 3, hostDataDir: dataDir(), config: { socket } });
    hosts.push(h);
    await h.start();
    return {
      h,
      stop: () => agent.stop(),
    };
  }

  it('keeps the shell going, runs jobs, and tells the session when one ends', async () => {
    const { h, stop } = await withSandbox();
    try {
      await h.callTool('sh_run', { command: 'mkdir -p sub && cd sub && export X=1' });
      const r = await h.callTool('sh_run', { command: 'basename "$PWD"; echo "X=$X"' });
      expect(r.failed).toBeFalsy();
      expect(r.text).toMatch(/^exit code 0 · .* · cwd .*\/sub\n/);
      expect(r.text).toContain('sub\nX=1');

      const started = await h.callTool('sh_job_start', { command: 'echo done-output', name: 'quick' });
      expect(started.text).toMatch(/^started j1 quick/);
      await vi.waitFor(() => expect(h.events.length).toBe(1), { timeout: 5000 });
      expect(h.violations).toEqual([]);
      expect(h.events[0]).toMatchObject({ type: 'shell.job_exited', level: 3, trigger: 'flush', correlation: 'j1' });
      expect(h.events[0]?.text).toContain('done-output');
      expect(h.events[0]?.dedupeKey).toMatch(/^job:[a-f0-9]+:j1:exited$/);

      expect((await h.callTool('sh_job_list', {})).text).toContain('j1 quick [exited (exit 0)]');
      expect((await h.callTool('sh_job_logs', { id: 'j1' })).text).toContain('done-output');
      await h.callTool('sh_reset', {});
      expect((await h.callTool('sh_run', { command: 'echo "X=[$X]"' })).text).toContain('X=[]');
    } finally {
      await h.stop();
      await stop();
    }
  });

  it('fails with a reason when the sandbox is not there, and never runs the command here', async () => {
    const dir = dataDir();
    const marker = path.join(dir, 'ran');
    const h = new FakeHost(createShellPlugin(), { id: 'shell', hostDataDir: dir, config: { socket: path.join(dir, 'nope.sock') } });
    hosts.push(h);
    await h.start();
    const r = await h.callTool('sh_run', { command: `touch ${marker}` });
    expect(r).toMatchObject({ failed: true });
    expect(r.text).toContain('the sandbox is not reachable');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('has background jobs only with the sandbox', async () => {
    const h = new FakeHost(createShellPlugin(), { id: 'shell', hostDataDir: dataDir(), config: { backend: 'local' } });
    hosts.push(h);
    await h.start();
    expect(await h.callTool('sh_job_start', { command: 'true' })).toMatchObject({ failed: true });
  });
});
