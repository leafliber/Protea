import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxAgent, SandboxClient, type JobEnded, type ShellRunParams } from '../src/index.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function dirs() {
  // A short base: unix socket paths are limited to about 100 characters.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, socket: path.join(root, 'a.sock'), home: path.join(root, 'home'), workspace: path.join(root, 'ws') };
}

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function boot(d = dirs()) {
  fs.mkdirSync(d.home, { recursive: true });
  const agent = new SandboxAgent({ socket: d.socket, home: d.home, workspace: d.workspace, env: { PATH: process.env['PATH'] as string } });
  await agent.start();
  let agentUp = true;
  const stopAgent = async () => {
    if (agentUp) await agent.stop();
    agentUp = false;
  };
  cleanups.push(stopAgent);
  const ended: JobEnded[] = [];
  const client = new SandboxClient({ socket: d.socket, onJobEnded: (e) => ended.push(e), connectWaitMs: 5000 });
  client.start();
  cleanups.push(() => client.stop());
  await waitFor(() => client.connected, 'the connection');
  let n = 0;
  const run = (command: string, more: Partial<ShellRunParams> = {}) => client.run({ runId: `r${++n}`, session: 'main', command, timeoutMs: 10_000, captureBytes: 1 << 20, ...more });
  return { d, agent, client, run, ended, stopAgent };
}

describe('sandbox agent', () => {
  it('carries the directory, exported variables and functions from one command to the next', async () => {
    const { run, d } = await boot();
    fs.mkdirSync(path.join(d.workspace, 'proj'), { recursive: true });
    const first = await run('cd proj && export GREETING="hello  world\nsecond" && say() { echo "said $1"; }; not_exported=1');
    expect(first.exitCode).toBe(0);
    expect(first.cwd).toBe(fs.realpathSync(path.join(d.workspace, 'proj')));
    const second = await run('pwd; printf "%s\\n" "$GREETING"; say it; echo "[$not_exported]"');
    expect(second.stdout).toBe(`${fs.realpathSync(path.join(d.workspace, 'proj'))}\nhello  world\nsecond\nsaid it\n[]\n`);
  });

  it('keeps the state of a failing command but not of one that was killed', async () => {
    const { run } = await boot();
    const failed = await run('export A=1; exit 3');
    expect(failed.exitCode).toBe(3);
    expect((await run('echo "A=$A"')).stdout).toBe('A=1\n');
    const slow = await run('export A=2; sleep 5', { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.cwd).toBeUndefined();
    expect((await run('echo "A=$A"')).stdout).toBe('A=1\n');
  });

  it('keeps sessions apart and forgets on reset', async () => {
    const { run, client } = await boot();
    await run('export WHO=main');
    await run('export WHO=fork', { session: 'f1' });
    expect((await run('echo $WHO')).stdout).toBe('main\n');
    expect((await run('echo $WHO', { session: 'f1' })).stdout).toBe('fork\n');
    await client.reset('main');
    expect((await run('echo "[$WHO]"')).stdout).toBe('[]\n');
  });

  it('does not wait for a background process that holds the output open, and kills it', async () => {
    const { run, d } = await boot();
    const t0 = Date.now();
    const r = await run(`sleep 30 & echo $! > ${d.root}/pid; echo started`);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.stdout).toBe('started\n');
    const pid = Number(fs.readFileSync(path.join(d.root, 'pid'), 'utf8'));
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'the background process to end');
  });

  it('cancels a command and still returns what it printed', async () => {
    const { client } = await boot();
    const ac = new AbortController();
    const call = client.run({ runId: 'x', session: 'main', command: 'echo before; sleep 20', timeoutMs: 30_000, captureBytes: 4096 }, ac.signal);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await call;
    expect(r.aborted).toBe(true);
    expect(r.stdout).toContain('before');
  });

  it('has no secrets in the environment, and installs under the home volume', async () => {
    process.env['SBX_API_KEY'] = 'should-not-pass';
    try {
      const { run, d } = await boot();
      const r = await run('env');
      expect(r.stdout).not.toContain('should-not-pass');
      expect(r.stdout).toContain(`HOME=${d.home}\n`);
      expect(r.stdout).toContain(`npm_config_prefix=${path.join(d.home, '.npm-global')}\n`);
    } finally {
      delete process.env['SBX_API_KEY'];
    }
  });

  it('runs a job past the command that started it and reports its end', async () => {
    const { client, ended } = await boot();
    const job = await client.jobStart({ session: 'main', command: 'echo out; echo err >&2; sleep 0.2; exit 4', name: 'demo', maxRunning: 2, logBytes: 1 << 20 });
    expect(job).toMatchObject({ id: 'j1', state: 'running', name: 'demo' });
    await waitFor(() => ended.length === 1, 'the end of the job');
    expect(ended[0]).toMatchObject({ job: { id: 'j1', state: 'exited', exitCode: 4 } });
    expect(ended[0]?.tail).toContain('out');
    expect(ended[0]?.tail).toContain('err');
    expect((await client.jobLogs('j1', 4096)).text).toContain('err');
    expect(await client.jobList()).toMatchObject([{ id: 'j1', state: 'exited' }]);
  });

  it('enforces the job limit, stops a job with everything it started, and caps its log', async () => {
    const { client, ended } = await boot();
    const j = await client.jobStart({ session: 'main', command: 'while :; do head -c 4096 /dev/zero | tr "\\0" x; echo; done', maxRunning: 1, logBytes: 20_000 });
    await expect(client.jobStart({ session: 'main', command: 'true', maxRunning: 1, logBytes: 1024 })).rejects.toThrow(/already running/);
    await new Promise((r) => setTimeout(r, 300));
    const stopped = await client.jobStop(j.id);
    expect(stopped.state).toBe('stopped');
    expect(ended).toEqual([]); // the assistant stopped it; nothing to report
    expect((await client.jobLogs(j.id, 1 << 20)).text.length).toBeLessThanOrEqual(20_000);
  });

  it('reports jobs lost with a restart, and what ended while nobody was connected', async () => {
    const d = dirs();
    const first = await boot(d);
    await first.client.jobStart({ session: 'main', command: 'sleep 30', maxRunning: 2, logBytes: 4096 });
    first.client.stop();
    await first.stopAgent();

    const second = await boot(d);
    await waitFor(() => second.ended.length === 1, 'the report');
    expect(second.ended[0]).toMatchObject({ job: { id: 'j1', state: 'lost' } });
    expect(second.ended[0]?.instance).toMatch(/^[a-f0-9]{12}$/);
    await second.client.jobAck(['j1']);
    second.client.stop();
    await second.stopAgent();

    const third = await boot(d);
    await new Promise((r) => setTimeout(r, 100));
    expect(third.ended).toEqual([]);
    // State and job numbers outlive restarts.
    expect((await third.client.jobStart({ session: 'main', command: 'true', maxRunning: 2, logBytes: 4096 })).id).toBe('j2');
  });

  it('keeps a job running while the client is away and tells it on return', async () => {
    const { d, client } = await boot();
    await client.jobStart({ session: 'main', command: 'sleep 0.5; echo finished', name: 'away', maxRunning: 2, logBytes: 4096 });
    client.stop();
    await new Promise((r) => setTimeout(r, 900));
    const ended: JobEnded[] = [];
    const again = new SandboxClient({ socket: d.socket, onJobEnded: (e) => ended.push(e), connectWaitMs: 5000 });
    again.start();
    cleanups.push(() => again.stop());
    await waitFor(() => ended.length === 1, 'the report after reconnecting');
    expect(ended[0]).toMatchObject({ job: { id: 'j1', state: 'exited', exitCode: 0 } });
    expect(ended[0]?.tail).toContain('finished');
  });

  it('refuses a bad session name', async () => {
    const { run } = await boot();
    await expect(run('true', { session: '../../etc' })).rejects.toThrow(/invalid session/);
  });

  it('says why when nobody is listening', async () => {
    const d = dirs();
    const client = new SandboxClient({ socket: d.socket, connectWaitMs: 50 });
    client.start();
    cleanups.push(() => client.stop());
    await expect(client.jobList()).rejects.toThrow(/not reachable.*nothing is listening/);
    expect(client.problem).toContain('nothing is listening');
  });
});
