import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkConformance, resolveDevLoader } from '../src/index.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const dev = { loader: resolveDevLoader() as string };
const pythonPath = path.join(REPO, 'sdks', 'python');

describe('plugin protocol conformance', () => {
  for (const [name, dir] of [
    ['Python example (protea_plugin SDK)', 'examples/plugins/py-notes'],
    ['TypeScript example (@protea/plugin-sdk)', 'examples/plugins/ts-notes'],
  ] as const) {
    it(`${name} passes`, async () => {
      const r = await checkConformance(path.join(REPO, dir), { dev, pythonPath });
      const failed = r.checks.filter((c) => !c.ok);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
      expect(r.checks.length).toBeGreaterThanOrEqual(12);
      expect(r.events.map((e) => e.type)).toEqual([`${r.plugin}.added`]);
    });
  }

  it('the WeChat connector passes while it waits to be signed in', async () => {
    const r = await checkConformance(path.join(REPO, 'plugins/wechat'), { dev, pythonPath });
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toContain('the manifest block "login" and the "login" capability go together');
    expect(r.checks.map((c) => c.name)).toContain('the manifest block "chat" and the "chat" capability go together');
  });

  it('the QQ connector passes while it waits to be signed in', async () => {
    const r = await checkConformance(path.join(REPO, 'plugins/qq'), { dev, pythonPath });
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toContain('the manifest block "login" and the "login" capability go together');
    expect(r.checks.map((c) => c.name)).toContain('the manifest block "chat" and the "chat" capability go together');
  });

  it('the example chat platform passes, with a draft and choices sent through it', async () => {
    const r = await checkConformance(path.join(REPO, 'examples/plugins/ts-chat'), { dev, pythonPath });
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    const names = r.checks.map((c) => c.name);
    expect(names).toContain('"chat.drafts" in the manifest and the "chatDrafts" capability go together');
    expect(names).toContain('the chat probe sends a draft only to a platform that declares drafts');
    expect(names).toContain('the chat probe offers choices only to a platform that declares choices');
    expect(names).toContain('chat/send delivers a message');
  });

  it('reports what is wrong with a broken plugin', async () => {
    const r = await checkConformance(path.join(REPO, 'packages/core/test/fixtures/broken-plugin'), { dev, pythonPath });
    expect(r.ok).toBe(false);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('stdout carries only protocol messages');
    expect(failed).toContain('tool declarations are valid and declared in the manifest');
  });
});
