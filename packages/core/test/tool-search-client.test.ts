import { describe, expect, it } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from '@protea/protocol';
import {
  MCP_CALL,
  MCP_SEARCH,
  ToolDispatcher,
  ToolExposure,
  ToolRegistry,
  clientSearchTools,
  prefixFingerprint,
  silentLogger,
  type GuardDecision,
  type ToolDef,
  type ToolGuard,
  type ToolSearchSettings,
  type ToolSpec,
} from '../src/index.js';

const spec = (name: string, extra: Partial<ToolSpec<never>> = {}): ToolSpec<never> =>
  ({ name, description: `Tool ${name}.`, inputSchema: { type: 'object' }, handler: () => 'ok', ...extra }) as ToolSpec<never>;

/** 3 kernel tools and two MCP servers; `a` has 6 tools, `b` has 2. Nothing can search for the model. */
function setup(s: Partial<ToolSearchSettings> = {}, notes: Record<string, string> = {}) {
  const tools = new ToolRegistry();
  const ran: Array<{ name: string; input: unknown }> = [];
  for (const n of ['idle', 'memory', 'chat_send']) tools.register('core', spec(n));
  for (let i = 0; i < 6; i++) {
    const name = `mcp__a__t${i}`;
    tools.register(
      'mcp:a',
      spec(name, {
        deferrable: true,
        description: i === 4 ? 'Click an element on the page.' : `Tool ${name}.`,
        inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } }, additionalProperties: false },
        flags: { sideEffect: true },
        handler: ((input: unknown) => {
          ran.push({ name, input });
          return `ran ${name}`;
        }) as never,
      }),
    );
  }
  for (let i = 0; i < 2; i++) tools.register('mcp:b', spec(`mcp__b__u${i}`, { deferrable: true }));
  const settings: ToolSearchSettings = { mode: 'always', threshold: 40, thresholdTokens: 0, keepPerServer: 1, ...s };
  const exposure = new ToolExposure({ tools, settings: () => settings, usage: () => 0, supported: () => false, ownerNote: (owner) => notes[owner] });
  for (const t of clientSearchTools(exposure, tools)) tools.register('core', t);
  return { tools, exposure, ran };
}

const names = (set: { tools: Array<{ name: string }> }) => set.tools.map((t) => t.name);
const use = (name: string, input: unknown, id = 'u1'): ToolUseBlock => ({ type: 'tool_use', id, name, input });
const ctx = { signal: new AbortController().signal, sessionId: 'main', batchId: 'b1', batchLevel: 1 as const };
const text = (b: ToolResultBlock | undefined): string => (typeof b?.content === 'string' ? b.content : JSON.stringify(b?.content));

describe('client-side tool search: a provider that cannot search deferred tools', () => {
  it('leaves the deferred tools out of the request and offers mcp_search and mcp_call instead', () => {
    const { exposure } = setup();
    const set = exposure.forRequest([], { role: 'main' });
    expect(exposure.modeFor('main')).toBe('client');
    expect(set.toolSearch).toBe(false);
    expect(set.tools.some((t) => t.deferLoading)).toBe(false);
    // Kernel tools, the two search tools, and each server's one kept tool.
    expect(names(set)).toEqual(['chat_send', 'idle', MCP_CALL, MCP_SEARCH, 'memory', 'mcp__a__t0', 'mcp__b__u0']);
    expect(exposure.deferredNames()).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__a__t4', 'mcp__a__t5', 'mcp__b__u1']);
  });

  it('does not offer the search tools when nothing is held back', () => {
    const { exposure } = setup({ mode: 'never' });
    expect(names(exposure.forRequest([], { role: 'main' }))).not.toContain(MCP_SEARCH);
    expect(exposure.forRequest([], { role: 'main' }).tools).toHaveLength(11);
    expect(exposure.catalog('main')).toBeNull();
  });

  it('turns on by the size of the MCP definitions as well as by the tool count', () => {
    // 12 tools is under the count threshold; their definitions are about 250 tokens.
    expect(setup({ mode: 'auto', thresholdTokens: 100 }).exposure.deferredNames()).toHaveLength(6);
    expect(setup({ mode: 'auto', thresholdTokens: 100_000 }).exposure.deferredNames()).toEqual([]);
    expect(setup({ mode: 'auto', thresholdTokens: 0 }).exposure.deferredNames()).toEqual([]);
    expect(setup({ mode: 'auto', threshold: 5, thresholdTokens: 0 }).exposure.deferredNames()).toHaveLength(6);
  });

  it('keeps the request prefix the same whatever was searched or called', () => {
    const { exposure } = setup();
    const request = (messages: Parameters<typeof exposure.forRequest>[0]) => ({ role: 'main' as const, system: [{ id: 's', text: 'S' }], messages: [...messages], tools: exposure.forRequest(messages, { role: 'main' }).tools, effort: 'medium' as const });
    const before = request([]);
    const after = request([
      { role: 'user', content: [{ type: 'text', text: 'click it' }] },
      { role: 'assistant', content: [use(MCP_SEARCH, { query: 'click' }), use(MCP_CALL, { name: 'mcp__a__t4', arguments: { q: 'x' } }, 'u2')] },
    ]);
    expect(after.tools).toEqual(before.tools);
    expect(prefixFingerprint(after)).toBe(prefixFingerprint(before));
  });

  it('tells the model which servers have tools on demand, with what each server says about itself', () => {
    const { exposure } = setup({}, { 'mcp:a': 'Drives a browser.\nUse it for pages that need JavaScript.' });
    const catalog = exposure.catalog('main') ?? '';
    expect(catalog).toContain('- a (5 tools, full name mcp__a__<tool>): Drives a browser. Use it for pages that need JavaScript.');
    expect(catalog).toContain('  t1, t2, t3, t4, t5');
    expect(catalog).toContain('- b (1 tools, full name mcp__b__<tool>)');
    // A fork is told only about the tools it may use.
    expect(exposure.catalog('fork', new Set(['mcp__b__u1']))).not.toContain('- a (');
    expect(exposure.catalog('fork', new Set(['idle']))).toBeNull();
  });

  it('never defers a server whose tools are not deferrable (alwaysLoad)', () => {
    const { tools, exposure } = setup();
    tools.register('mcp:c', spec('mcp__c__always'));
    expect(exposure.deferredNames()).not.toContain('mcp__c__always');
    expect(names(exposure.forRequest([], { role: 'main' }))).toContain('mcp__c__always');
  });

  it('mcp_search returns the description and schema of what matches', async () => {
    const { tools } = setup();
    const d = new ToolDispatcher(tools, silentLogger());
    const hit = text((await d.runAll([use(MCP_SEARCH, { query: 'click element' })], ctx)).results[0]);
    expect(hit).toContain('## mcp__a__t4\nClick an element on the page.');
    expect(hit).toContain('input schema: {"type":"object","required":["q"],"properties":{"q":{"type":"string"}},"additionalProperties":false}');
    const listed = text((await d.runAll([use(MCP_SEARCH, { server: 'a', limit: 2 })], ctx)).results[0]);
    expect(listed).toContain('## mcp__a__t1');
    expect(listed).toContain('Also matching, without schema (search again to get it): mcp__a__t3, mcp__a__t4, mcp__a__t5');
    expect((await d.runAll([use(MCP_SEARCH, {})], ctx)).results[0]).toMatchObject({ is_error: true });
    expect(text((await d.runAll([use(MCP_SEARCH, { server: 'zzz' })], ctx)).results[0])).toContain('servers with such tools: a, b');
  });

  it('mcp_call runs the real tool: its schema, its permission check and its audit apply', async () => {
    const { tools, ran } = setup();
    const d = new ToolDispatcher(tools, silentLogger());
    const checked: string[] = [];
    const audited: string[] = [];
    const traced: string[] = [];
    const observed: string[] = [];
    const guard: ToolGuard = {
      check: (def: ToolDef, u: ToolUseBlock): GuardDecision => {
        checked.push(`${def.name}:${JSON.stringify(u.input)}`);
        return def.name === 'mcp__a__t5' ? { action: 'block', policy: 'ask', rule: 'test', text: 'pending approval a1', isError: false } : { action: 'run', policy: 'allow', rule: 'test', audit: true };
      },
      after: (def) => audited.push(def.name),
    };
    d.setGuard(guard);
    d.setTrace((t) => traced.push(`${t.phase}:${t.name}`));
    d.observe((name) => observed.push(name));

    const ok = await d.runAll([use(MCP_CALL, { name: 'mcp__a__t4', arguments: { q: 'x' } })], ctx);
    expect(ok.results[0]).toEqual({ type: 'tool_result', tool_use_id: 'u1', content: 'ran mcp__a__t4' });
    expect(ran).toEqual([{ name: 'mcp__a__t4', input: { q: 'x' } }]);
    expect(checked).toEqual(['mcp__a__t4:{"q":"x"}']);
    expect(audited).toEqual(['mcp__a__t4']);
    expect(traced).toEqual(['start:mcp__a__t4', 'end:mcp__a__t4']);
    expect(observed).toEqual(['mcp__a__t4']);

    // The target's own schema decides what input is valid.
    expect(text((await d.runAll([use(MCP_CALL, { name: 'mcp__a__t4', arguments: { nope: 1 } })], ctx)).results[0])).toContain('invalid input for mcp__a__t4');
    // A tool held for approval is held, exactly as if it had been called directly.
    expect(text((await d.runAll([use(MCP_CALL, { name: 'mcp__a__t5', arguments: { q: 'x' } })], ctx)).results[0])).toBe('pending approval a1');
    expect(ran).toHaveLength(1);
    // Only MCP tools go through it.
    expect(text((await d.runAll([use(MCP_CALL, { name: 'chat_send', arguments: {} })], ctx)).results[0])).toContain('chat_send is not an MCP tool: call it directly');
    expect(text((await d.runAll([use(MCP_CALL, { name: 'mcp__a__gone' })], ctx)).results[0])).toContain('there is no tool mcp__a__gone');
    expect(text((await d.runAll([use(MCP_CALL, {})], ctx)).results[0])).toContain(`invalid input for ${MCP_CALL}`);
  });

  it('a fork reaches only the deferred tools on its list', async () => {
    const { tools, exposure, ran } = setup();
    const d = new ToolDispatcher(tools, silentLogger());
    const allowed = new Set(['idle', 'mcp__a__t2']);
    // The search tools come with any deferred tool, although the list does not name them.
    expect(names(exposure.forRequest([], { role: 'fork', allowed }))).toEqual(['idle', MCP_CALL, MCP_SEARCH]);
    const fctx = { ...ctx, sessionId: 'f1', allowed };
    expect(text((await d.runAll([use(MCP_SEARCH, { server: 'a' })], fctx)).results[0])).toMatch(/^1 tool\./);
    expect(text((await d.runAll([use(MCP_CALL, { name: 'mcp__a__t2', arguments: { q: 'x' } })], fctx)).results[0])).toBe('ran mcp__a__t2');
    expect(text((await d.runAll([use(MCP_CALL, { name: 'mcp__a__t3', arguments: { q: 'x' } })], fctx)).results[0])).toBe('tool mcp__a__t3 is not available');
    expect(ran.map((r) => r.name)).toEqual(['mcp__a__t2']);
  });
});
