import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { createFilewatchPlugin, diff } from '../src/plugin.js';

const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(dataDir: string, kv?: Map<string, unknown>) {
  const h = new FakeHost(createFilewatchPlugin(), { id: 'filewatch', levelCap: 3, hostDataDir: dataDir, config: { debounceMs: 50 } });
  if (kv) for (const [k, v] of kv) h.kv.set(k, v);
  hosts.push(h);
  await h.start();
  return h;
}

describe('filewatch source', () => {
  it('reports one aggregated event per quiet period and serves fw_list/fw_read', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-fw-'));
    const h = await setup(data);
    const inbox = path.join(data, 'inbox');
    expect(fs.existsSync(inbox)).toBe(true);
    fs.writeFileSync(path.join(inbox, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(inbox, 'b.txt'), 'beta');
    fs.writeFileSync(path.join(inbox, '.hidden'), 'x');
    await waitFor(() => h.events.length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'filewatch.changed', level: 3, trigger: 'debounce' });
    expect(h.events[0]?.text).toBe(`2 file(s) changed in ${inbox}:\n+ a.txt (5 B)\n+ b.txt (4 B)`);
    expect(h.violations).toEqual([]);

    expect((await h.callTool('fw_read', { path: 'a.txt' })).text).toBe('alpha');
    expect((await h.callTool('fw_list', {})).text).toMatch(/^a\.txt {2}5 B/);
    const escape = await h.callTool('fw_read', { path: '../../etc/passwd' });
    expect(escape).toMatchObject({ failed: true });
    expect(escape.text).toContain('outside the watched folders');
  });

  it('reports changes made while it was stopped', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-fw-'));
    const first = await setup(data);
    const inbox = path.join(data, 'inbox');
    fs.writeFileSync(path.join(inbox, 'keep.txt'), '1');
    await waitFor(() => first.events.length === 1);
    // The snapshot is saved right after the event is pushed (at-least-once); wait for it.
    await waitFor(() => JSON.stringify(first.kv.get(`snapshot:${inbox}`) ?? {}).includes('keep.txt'));
    await first.stop();
    fs.writeFileSync(path.join(inbox, 'new.txt'), 'new');
    fs.rmSync(path.join(inbox, 'keep.txt'));
    const second = await setup(data, new Map(first.kv));
    await waitFor(() => second.events.length === 1);
    expect(second.events[0]?.text).toBe(`2 file(s) changed while the watcher was stopped in ${inbox}:\n- keep.txt\n+ new.txt (3 B)`);
  });

  it('diffs snapshots', () => {
    expect(diff({ a: { size: 1, mtimeMs: 1 }, b: { size: 1, mtimeMs: 1 } }, { a: { size: 2, mtimeMs: 1 }, c: { size: 3, mtimeMs: 3 } })).toEqual([
      { kind: 'changed', file: 'a', size: 2 },
      { kind: 'removed', file: 'b' },
      { kind: 'added', file: 'c', size: 3 },
    ]);
  });
});
