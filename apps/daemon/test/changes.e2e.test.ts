import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, toolCall, type ProviderRequest } from '@protea/core';
import type { ChangeRequestDetail, ChangeRequestInfo, McpServerStatus, PermissionModeInfo, SkillInfo } from '@protea/protocol';
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

const SKILL = `---
name: invoice-check
description: How to check the open invoices and report them to the owner.
---

# Checking invoices

List the open invoices, oldest first.
`;

const said = (req: ProviderRequest): string => JSON.stringify(req.messages);

describe('change requests end to end (ADR-0019)', () => {
  it('the assistant proposes an MCP server and a skill; only an administrator decides, and Core applies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-changes-e2e-'));
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'observability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n');
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets', 'PROTEA_READONLY_TOKEN'), 'readonly-token-for-the-test\n');
    let proposed = false;
    const provider = new ScriptedProvider([
      (req) => {
        if (!proposed && said(req).includes('add the fetch server')) {
          proposed = true;
          return reply([
            toolCall('mcp_propose', { action: 'add', id: 'fetch', server: { command: 'node', args: ['-e', '0'], enabled: false }, reason: 'The owner asked for a way to read web pages.' }),
            toolCall('skill_propose', { action: 'add', name: 'invoice-check', content: SKILL, reason: 'The owner asks for this every Monday.' }),
          ]);
        }
        return reply([toolCall('idle', {})]);
      },
    ]);
    const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: () => undefined });
    running.push(d);
    const call = async <T>(token: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> => {
      const res = await fetch(`${d.url}${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json()) as T };
    };
    const api = <T>(method: string, p: string, body?: unknown) => call<T>(d.adminToken, method, p, body);
    const pending = async (): Promise<ChangeRequestInfo[]> => (await api<{ changes: ChangeRequestInfo[] }>('GET', '/api/changes?state=pending')).json.changes;

    await api('POST', '/api/chat/messages', { text: 'add the fetch server and a skill for the invoice check' });
    await waitUntil(async () => (await pending()).length === 2, 'the two requests');
    expect((await pending()).map((c) => [c.id, c.kind, c.action, c.target]).sort()).toEqual([
      ['c1', 'mcp', 'add', 'fetch'],
      ['c2', 'skill', 'add', 'invoice-check'],
    ]);
    // Nothing happened yet.
    expect((await api<{ servers: McpServerStatus[] }>('GET', '/api/mcp/servers')).json.servers).toEqual([]);
    expect((await api<{ skills: SkillInfo[] }>('GET', '/api/skills')).json.skills.map((s) => s.name)).not.toContain('invoice-check');
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).not.toContain('fetch');

    // The review sees the whole thing.
    const detail = (await api<ChangeRequestDetail>('GET', '/api/changes/c2')).json;
    expect(detail).toMatchObject({ before: null, after: SKILL, reason: 'The owner asks for this every Monday.', files: [{ path: 'SKILL.md' }] });
    expect((await api<{ text: string }>('GET', '/api/changes/c2/file?path=SKILL.md')).json.text).toBe(SKILL);

    // What cannot decide it: the owner's chat command, a permission mode that waives approvals, a read-only caller.
    await api('POST', '/api/chat/messages', { text: '/approve c1' });
    expect((await api<PermissionModeInfo>('POST', '/api/permissions/mode', { mode: 'bypass', forMs: 600_000 })).status).toBe(200);
    await waitUntil(() => d.main.phase === 'idle', 'the main session to settle');
    expect((await call('readonly-token-for-the-test', 'POST', '/api/changes/c1/decide', { decision: 'approve' })).status).toBe(403);
    expect((await call('readonly-token-for-the-test', 'GET', '/api/changes/c1')).status).toBe(200);
    expect((await api('POST', '/api/changes/c1/decide', { decision: 'maybe' })).status).toBe(400);
    expect((await pending()).map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect((await api<{ approvals: unknown[] }>('GET', '/api/approvals')).json.approvals).toEqual([]);

    // An administrator approves: it is applied at once, and written to the configuration.
    const applied = await api<ChangeRequestDetail>('POST', '/api/changes/c1/decide', { decision: 'approve', note: 'fine' });
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ state: 'applied', decidedBy: 'api:admin', note: 'fine', result: 'the MCP server fetch is disabled.' });
    expect((await api<{ servers: McpServerStatus[] }>('GET', '/api/mcp/servers')).json.servers).toMatchObject([{ id: 'fetch', enabled: false, transport: 'stdio' }]);
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toContain('fetch');
    expect((await api('POST', '/api/changes/c1/decide', { decision: 'approve' })).status).toBe(409);

    expect((await api<ChangeRequestDetail>('POST', '/api/changes/c2/decide', { decision: 'approve' })).json).toMatchObject({ state: 'applied', result: 'the skill invoice-check is installed and listed.' });
    expect((await api<{ skills: SkillInfo[] }>('GET', '/api/skills')).json.skills.find((s) => s.name === 'invoice-check')).toMatchObject({ origin: 'user', enabled: true, listed: true });
    expect(fs.readFileSync(path.join(dir, 'skills', 'invoice-check', 'SKILL.md'), 'utf8')).toBe(SKILL);
    expect(fs.existsSync(path.join(dir, 'changes', 'c2'))).toBe(false);

    // The assistant hears the outcome.
    await waitUntil(() => provider.calls.some((c) => said(c).includes('Change request c2') && said(c).includes('was approved by the owner and applied')), 'the decision to reach the assistant');
    const audit = (await api<{ audit: Array<{ kind: string; outcome?: string }> }>('GET', '/api/audit?kind=change_decided')).json.audit;
    expect(audit.map((a) => a.outcome).sort()).toEqual(['applied', 'applied']);
  });
});
