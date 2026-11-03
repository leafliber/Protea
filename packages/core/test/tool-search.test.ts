import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '@protea/protocol';
import {
  AnthropicProvider,
  DEFAULT_MCP_SETTINGS,
  McpManager,
  ScriptedProvider,
  ToolExposure,
  ToolRegistry,
  defaultConfig,
  normalizeMcpServer,
  reply,
  silentLogger,
  systemClock,
  textReply,
  toolCall,
  type ProviderRequest,
  type ToolSearchSettings,
  type ToolSpec,
} from '../src/index.js';
import { makeHarness, waitFor } from './helpers.js';
import { FIXTURE } from './mcp-fixtures.js';

const spec = (name: string, extra: Partial<ToolSpec<never>> = {}): ToolSpec<never> =>
  ({ name, description: `Tool ${name}.`, inputSchema: { type: 'object' }, handler: () => 'ok', ...extra }) as ToolSpec<never>;

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  for (let i = 0; i < 10; i++) tools.register('core', spec(`core_${i}`));
  tools.register('telegram', spec('tg_send'));
  for (const server of ['a', 'b']) for (let i = 0; i < 20; i++) tools.register(`mcp:${server}`, spec(`mcp__${server}__t${String(i).padStart(2, '0')}`, { deferrable: true }));
  return tools;
}

function exposure(tools: ToolRegistry, s: Partial<ToolSearchSettings> = {}, usage: Record<string, number> = {}, supported = true) {
  const settings: ToolSearchSettings = { mode: 'auto', threshold: 40, keepPerServer: 3, ...s };
  return new ToolExposure({ tools, settings: () => settings, usage: (n) => usage[n] ?? 0, supported: () => supported });
}

const deferred = (req: { tools: Array<{ name: string; deferLoading?: boolean }> }) => req.tools.filter((t) => t.deferLoading).map((t) => t.name);

describe('tool search exposure', () => {
  it('defers MCP tools past the threshold, keeping kernel, plugin and each server’s most-used tools loaded', () => {
    const tools = registry();
    const usage = { mcp__a__t07: 9, mcp__a__t12: 4, mcp__b__t19: 1 };
    const set = exposure(tools, {}, usage).forRequest([], { role: 'main' });
    expect(set.toolSearch).toBe(true);
    const loaded = set.tools.filter((t) => !t.deferLoading).map((t) => t.name);
    expect(loaded).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `core_${i}`),
      'tg_send',
      'mcp__a__t00',
      'mcp__a__t07',
      'mcp__a__t12',
      'mcp__b__t00',
      'mcp__b__t01',
      'mcp__b__t19',
    ]);
    expect(deferred(set)).toHaveLength(34);
    // Order of the whole list (deferred included) stays kernel → plugins → MCP.
    expect(set.tools.map((t) => t.name).slice(0, 12)).toEqual([...Array.from({ length: 10 }, (_, i) => `core_${i}`), 'tg_send', 'mcp__a__t00']);
  });

  it('loads everything below the threshold, with mode never, or when the provider cannot search', () => {
    const tools = registry();
    expect(exposure(tools, { threshold: 100 }).forRequest([], { role: 'main' })).toMatchObject({ toolSearch: false });
    expect(deferred(exposure(tools, { mode: 'never' }).forRequest([], { role: 'main' }))).toEqual([]);
    expect(deferred(exposure(tools, {}, {}, false).forRequest([], { role: 'main' }))).toEqual([]);
    expect(deferred(exposure(tools, { mode: 'always', threshold: 1000 }).forRequest([], { role: 'main' }))).toHaveLength(34);
  });

  it('keeps the loaded set stable while the tool set is unchanged, and per server while only another server changes', () => {
    const tools = registry();
    const usage: Record<string, number> = {};
    const x = exposure(tools, {}, usage);
    const first = x.forRequest([], { role: 'main' });
    usage['mcp__a__t15'] = 50;
    usage['mcp__b__t15'] = 50;
    expect(x.forRequest([], { role: 'main' })).toEqual(first);
    // Server b's tool list changes: b is re-ranked, a keeps its loaded tools.
    tools.register('mcp:b', spec('mcp__b__t99', { deferrable: true }));
    const after = x.forRequest([], { role: 'main' }).tools.filter((t) => !t.deferLoading).map((t) => t.name);
    expect(after.filter((n) => n.startsWith('mcp__a__'))).toEqual(['mcp__a__t00', 'mcp__a__t01', 'mcp__a__t02']);
    expect(after.filter((n) => n.startsWith('mcp__b__'))).toEqual(['mcp__b__t00', 'mcp__b__t01', 'mcp__b__t15']);
  });

  it('keeps tool search on once the history used it, with stubs for tools that went away', () => {
    const tools = new ToolRegistry();
    tools.register('core', spec('idle'));
    tools.register('mcp:a', spec('mcp__a__x', { deferrable: true }));
    const history: TranscriptMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { pattern: 'x' } },
          {
            type: 'tool_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'mcp__a__x' }, { type: 'tool_reference', tool_name: 'mcp__gone__y' }] },
          },
        ] as never,
      },
    ];
    tools.registerAll('mcp:gone', [spec('mcp__gone__y', { deferrable: true })]);
    tools.unregisterOwner('mcp:gone', 'the MCP server gone was removed');
    const set = exposure(tools).forRequest(history, { role: 'main' });
    expect(set.toolSearch).toBe(true); // 2 tools, far below the threshold, but the history refers to search results
    expect(set.tools).toEqual([
      { name: 'idle', description: 'Tool idle.', inputSchema: { type: 'object' } },
      { name: 'mcp__a__x', description: 'Tool mcp__a__x.', inputSchema: { type: 'object' } },
      {
        name: 'mcp__gone__y',
        description: 'No longer available: the MCP server gone was removed. Do not call it.',
        inputSchema: { type: 'object', properties: {} },
        deferLoading: true,
      },
    ]);
  });

  it('declares the regex search tool and defer_loading in Anthropic requests', () => {
    const cfg = defaultConfig().providers.anthropic;
    const p = new AnthropicProvider(cfg, 'sk-test');
    expect(p.supportsToolSearch('main')).toBe(true);
    const params = p.buildParams({
      role: 'main',
      system: [{ id: 's', text: 'S' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        { name: 'idle', description: 'd', inputSchema: { type: 'object' } },
        { name: 'mcp__a__x', description: 'd', inputSchema: { type: 'object' }, deferLoading: true },
      ],
      toolSearch: true,
      effort: 'medium',
    });
    expect(params.tools).toEqual([
      { name: 'idle', description: 'd', input_schema: { type: 'object' }, eager_input_streaming: true },
      { name: 'mcp__a__x', description: 'd', input_schema: { type: 'object' }, eager_input_streaming: true, defer_loading: true },
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
    ]);
    expect(new AnthropicProvider({ ...cfg, models: { ...cfg.models, main: 'claude-3-7-sonnet-latest' } }, 'k').supportsToolSearch('main')).toBe(false);
  });
});

/**
 * Prompt-cache simulation: the API caches the longest prefix shared with the previous request,
 * in the order tools → system → messages, and deferred tool definitions are not part of the
 * prefix (platform docs, "Tool search tool"). Returns cached characters / sent characters.
 */
function simulatedHitRatio(calls: readonly ProviderRequest[]): number {
  const head = (r: ProviderRequest) => JSON.stringify([r.tools.filter((t) => !t.deferLoading), r.system]);
  const flat = (r: ProviderRequest) => r.messages.flatMap((m) => m.content.map((b) => `${m.role}:${JSON.stringify(b)}`));
  let cached = 0;
  let sent = 0;
  for (let i = 0; i < calls.length; i++) {
    const cur = calls[i] as ProviderRequest;
    const h = head(cur);
    const msgs = flat(cur);
    sent += h.length + msgs.join('').length;
    const prev = calls[i - 1];
    if (!prev || head(prev) !== h) continue; // a changed prefix head misses everything after it
    const before = flat(prev);
    let n = 0;
    while (n < before.length && n < msgs.length && before[n] === msgs[n]) n++;
    cached += h.length + msgs.slice(0, n).join('').length;
  }
  return cached / sent;
}

async function runSession(withMcp: boolean): Promise<{ ratio: number; calls: ProviderRequest[]; deferredSeen: number }> {
  const provider = new ScriptedProvider([
    (_req, i) => {
      if (withMcp && i % 7 === 3) return reply([toolCall('mcp__a__echo', { text: `q${i}` })]);
      switch (i % 5) {
        case 0:
          return reply([toolCall('say', { text: `r${i}` })]);
        case 2:
          return reply([toolCall('idle', {})]);
        default:
          return textReply(`ok ${i}`);
      }
    },
  ]);
  const h = makeHarness({ provider, toolSearch: { mode: 'auto', threshold: 40, keepPerServer: 3 } });
  const mcp = new McpManager({
    tools: h.tools,
    bus: h.bus,
    log: silentLogger(),
    clock: systemClock,
    dataDir: h.dir,
    version: 'test',
    settings: () => ({ ...DEFAULT_MCP_SETTINGS, pingIntervalMs: 0, listChangedDebounceMs: 10 }),
    supervision: () => ({ restartBackoffMs: [50], maxCrashes: 3, stableAfterMs: 60_000, initializeTimeoutMs: 10_000, drainTimeoutMs: 1000 }),
    pushInternal: () => {},
    pushEvent: () => {},
    redirectUrl: () => 'http://127.0.0.1/cb',
  });
  const server = (name: string) => normalizeMcpServer(name, { command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_EXTRA: '30', MCP_FIXTURE_NAME: name } });
  let deferredSeen = 0;
  try {
    if (withMcp) await mcp.apply({ a: server('a') });
    for (let i = 0; i < 100; i++) {
      if (withMcp && i === 30) await mcp.apply({ a: server('a'), b: server('b') }); // a server connects mid-session
      if (withMcp && i === 60) {
        await h.tools.get('mcp__a__grow')?.handler({ name: 'late_tool' } as never, { signal: new AbortController().signal, callId: 'x', sessionId: 'main', batchId: 'b', batchLevel: 1 });
        await waitFor(() => h.tools.get('mcp__a__late_tool') !== undefined, 5000, 'list_changed');
      }
      if (withMcp && i === 80) await mcp.apply({ a: server('a') }); // and leaves again
      const r = h.push({ text: `message ${i}`, trigger: i % 3 === 0 ? 'debounce' : 'flush' });
      await waitFor(() => h.store.get(r.cursor as number)?.state === 'delivered', 10_000, `delivery ${i}`);
      await h.idle();
    }
    for (const c of provider.calls) deferredSeen = Math.max(deferredSeen, c.tools.filter((t) => t.deferLoading).length);
    return { ratio: simulatedHitRatio(provider.calls), calls: provider.calls, deferredSeen };
  } finally {
    await mcp.stopAll();
    await h.close();
  }
}

describe('M3 acceptance: tool search keeps the cache hit ratio with 60+ MCP tools', () => {
  it('stays within 90% of the ratio without MCP while servers connect, change and leave', async () => {
    const baseline = await runSession(false);
    const withMcp = await runSession(true);
    const mcpTools = (r: ProviderRequest) => r.tools.filter((t) => t.name.startsWith('mcp__')).length;
    expect(Math.max(...withMcp.calls.map(mcpTools))).toBeGreaterThanOrEqual(78); // 2 servers × 39 tools
    expect(withMcp.deferredSeen).toBeGreaterThanOrEqual(72);
    expect(withMcp.calls.every((c) => c.toolSearch === true)).toBe(true);
    expect(withMcp.ratio).toBeGreaterThanOrEqual(0.9 * baseline.ratio);
    expect(baseline.ratio).toBeGreaterThan(0.8);
  }, 180_000);
});
