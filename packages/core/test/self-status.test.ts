import { describe, expect, it } from 'vitest';
import type { StatusResponse } from '@protea/protocol';
import { kernelTools, type EventStore, type ToolContext, type ToolSpec } from '../src/index.js';

function status(plugins: Array<{ id: string; state: string; enabled: boolean }>): StatusResponse {
  return {
    runId: 'r',
    uptimeSec: 1,
    phase: 'idle',
    pending: {},
    provider: { id: 'p', mainModel: 'm', ready: true },
    plugins,
    usage24h: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    budget: { enforced: false, levels: {}, hardDailyUsd: null },
    forks: [],
  } as unknown as StatusResponse;
}

async function selfStatus(plugins: Parameters<typeof status>[0]): Promise<string> {
  const tool = kernelTools({ store: {} as EventStore, status: () => status(plugins) }).find((t) => t.name === 'self_status') as unknown as ToolSpec<Record<string, never>>;
  return (await tool.handler({}, {} as ToolContext)) as string;
}

describe('self_status', () => {
  it('does not present an installed plugin as one in use', async () => {
    const text = await selfStatus([
      { id: 'cron', state: 'running', enabled: true },
      { id: 'imap', state: 'loaded', enabled: false },
      { id: 'rss', state: 'loaded', enabled: false },
    ]);
    expect(text).toContain('plugins: cron(running)\n');
    expect(text).toContain('plugins installed but not enabled (no tools, no events): imap, rss\n');
    expect(text).not.toContain('imap(loaded)');
  });

  it('keeps the state of an enabled plugin that is not running', async () => {
    const text = await selfStatus([{ id: 'telegram', state: 'failed', enabled: true }]);
    expect(text).toContain('plugins: telegram(failed)\n');
    expect(text).not.toContain('not enabled');
  });
});
