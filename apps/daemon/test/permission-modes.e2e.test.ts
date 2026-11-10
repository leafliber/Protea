import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, textReply, toolCall, type ProviderRequest } from '@protea/core';
import type { PermissionModeInfo } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const lastText = (req: ProviderRequest): string => JSON.stringify(req.messages.at(-1) ?? '');

/** The main model calls sh_run when told to; the judge answers `verdict`. */
function script(verdict: string): ScriptedProvider {
  return new ScriptedProvider([
    (req) => {
      if (req.role === 'judge') return textReply(verdict);
      if (req.role !== 'main') return textReply('ok');
      const m = /run ([a-z]+)/.exec(lastText(req));
      return m ? reply([toolCall('sh_run', { command: `echo ${m[1]}` })]) : reply([toolCall('idle', {})]);
    },
  ]);
}

async function boot(provider: ScriptedProvider): Promise<{ d: Daemon; dir: string; api: <T>(method: string, p: string, body?: unknown) => Promise<{ status: number; json: T }> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-modes-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'observability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\nplugins:\n  shell:\n    enabled: true\n    config: { backend: local }\n');
  const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: () => undefined });
  running.push(d);
  await waitUntil(() => d.plugins.get('shell')?.state === 'running', 'the shell plugin');
  const api = async <T>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${d.url}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.adminToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  return { d, dir, api };
}

describe('permission modes end to end', () => {
  it('auto: the judge model clears a call with the owner\'s words in front of it', async () => {
    const provider = script('{"decision":"allow","reason":"the owner asked for it"}');
    const { d, dir, api } = await boot(provider);
    expect((await api<PermissionModeInfo>('GET', '/api/permissions/mode')).json.mode).toBe('ask');
    const set = await api<PermissionModeInfo>('POST', '/api/permissions/mode', { mode: 'auto' });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ mode: 'auto', baseline: 'auto' });
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toMatch(/mode: auto/);

    d.console.receive('run alpha', { senderKey: 'local' });
    await waitUntil(() => provider.calls.some((c) => c.role === 'main' && lastText(c).includes('exit code 0')), 'the command result');

    const judgeCall = provider.calls.find((c) => c.role === 'judge') as ProviderRequest;
    const seen = JSON.stringify(judgeCall.messages);
    expect(seen).toContain('run alpha');
    expect(seen).toContain('echo alpha');
    expect(judgeCall.tools).toEqual([]);
    expect((await api<{ approvals: unknown[] }>('GET', '/api/approvals?state=pending')).json.approvals).toEqual([]);
    expect(d.audit.list({ kind: 'permission_judge' })[0]).toMatchObject({ tool: 'sh_run', outcome: 'allow' });
    expect((await api<PermissionModeInfo>('GET', '/api/permissions/mode')).json.auto.allowed).toBe(1);
    expect(JSON.stringify(provider.calls.filter((c) => c.role === 'main').at(-1)?.system)).toContain('Permission mode: auto');
  });

  it('auto: a held call becomes an approval showing why, and the tool did not run', async () => {
    const provider = script('{"decision":"ask","reason":"not what the owner asked"}');
    const { d, api } = await boot(provider);
    await api('POST', '/api/permissions/mode', { mode: 'auto', forMs: 3_600_000 });
    d.console.receive('run beta', { senderKey: 'local' });
    let reason: string | undefined;
    await waitUntil(async () => {
      const r = await api<{ approvals: Array<{ tool: string; reason?: string }> }>('GET', '/api/approvals?state=pending');
      reason = r.json.approvals.find((a) => a.tool === 'sh_run')?.reason;
      return reason !== undefined;
    }, 'the approval request');
    expect(reason).toContain('not what the owner asked');
    expect(provider.calls.some((c) => lastText(c).includes('exit code 0'))).toBe(false);
  });

  it('the control API refuses an open-ended bypass; a limited one needs neither owner nor judge', async () => {
    const provider = script('{"decision":"ask","reason":"never reached"}');
    const { d, api } = await boot(provider);
    expect((await api('POST', '/api/permissions/mode', { mode: 'bypass' })).status).toBe(400);
    expect((await api('POST', '/api/permissions/mode', { mode: 'sideways' })).status).toBe(400);
    const set = await api<PermissionModeInfo>('POST', '/api/permissions/mode', { mode: 'bypass', forMs: 600_000 });
    expect(set.json).toMatchObject({ mode: 'bypass', baseline: 'ask', override: { mode: 'bypass', by: 'api:admin' } });
    d.console.receive('run gamma', { senderKey: 'local' });
    await waitUntil(() => provider.calls.some((c) => c.role === 'main' && lastText(c).includes('exit code 0')), 'the command result');
    expect(provider.calls.some((c) => c.role === 'judge')).toBe(false);
    expect(d.audit.list({ tool: 'sh_run', kind: 'tool_call' })[0]?.policy).toContain('mode bypass');
    expect(d.audit.list({ kind: 'permission_mode' })[0]).toMatchObject({ outcome: 'temporary', owner: 'api:admin' });
  });
});
