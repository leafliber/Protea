import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function serve(dataDir: string, port: number, echoDelayMs: number): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/main.ts', 'serve'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PROTEA_DATA_DIR: dataDir,
      PROTEA_PROVIDERS__DEFAULT: 'echo',
      PROTEA_PROVIDERS__ECHO__DELAY_MS: String(echoDelayMs),
      PROTEA_CONTROL__LISTEN: `127.0.0.1:${port}`,
      PROTEA_OBSERVABILITY__LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v as T;
    } catch {
      // not yet
    }
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const exited = (c: ChildProcess): Promise<number | null> => new Promise((r) => c.once('exit', (code) => r(code)));

describe('crash recovery (real process, SIGKILL)', () => {
  it('delivers the interrupted event after kill -9 and repairs nothing it does not need to', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-crash-'));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;

    const first = serve(dataDir, port, 5_000);
    await until(async () => (await fetch(`${url}/healthz`)).ok);
    const token = fs.readFileSync(path.join(dataDir, 'secrets', 'PROTEA_ADMIN_TOKEN'), 'utf8').trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const pushed = (await (await fetch(`${url}/api/events`, { method: 'POST', headers, body: JSON.stringify({ text: 'survive the crash' }) })).json()) as {
      cursor: number;
    };
    const transcript = path.join(dataDir, 'sessions', 'main.0001.jsonl');
    await until(() => fs.readFileSync(transcript, 'utf8').includes('survive the crash'));
    const done = exited(first);
    first.kill('SIGKILL'); // mid model call: the event is in the transcript, the reply is not
    await done;
    expect(fs.existsSync(path.join(dataDir, 'protea.lock'))).toBe(true); // stale lock left behind

    const second = serve(dataDir, port, 0);
    await until(async () => (await fetch(`${url}/healthz`)).ok);
    const messages = await until(async () => {
      const r = (await (await fetch(`${url}/api/sessions/main/transcript`, { headers })).json()) as {
        messages: Array<{ role: string; content: Array<{ type: string; name?: string; input?: { text?: string } }> }>;
      };
      const replied = r.messages.some((m) => m.content.some((b) => b.type === 'tool_use' && b.input?.text === 'echo: survive the crash'));
      return replied && r.messages.at(-1)?.role === 'assistant' ? r.messages : undefined;
    });
    expect(messages.filter((m) => JSON.stringify(m).includes('survive the crash') && m.role === 'user')).toHaveLength(1);

    const ev = (await (await fetch(`${url}/api/events/${pushed.cursor}`, { headers })).json()) as {
      event: { state: string };
      delivery: { outcome: string };
    };
    expect(ev.event.state).toBe('delivered');
    expect(ev.delivery.outcome).toBe('delivered');

    const runs = fs.readdirSync(path.join(dataDir, 'runs')).sort();
    const log = fs.readFileSync(path.join(dataDir, 'runs', runs.at(-1) as string, 'log.jsonl'), 'utf8');
    expect(log).toContain('resuming the interrupted batch');
    expect(log).not.toContain('transcript repaired'); // the crash left a clean record boundary

    const stopped = exited(second);
    second.kill('SIGTERM');
    expect(await stopped).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'protea.lock'))).toBe(false);
  }, 60_000);
});
