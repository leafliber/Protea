import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@protea/protocol';
import {
  ContextAssembler,
  ToolRegistry,
  escapeStructural,
  mergeConsecutive,
  renderEventsBlock,
  renderStatusBlock,
  renderTemplate,
} from '../src/index.js';

const env = (over: Partial<EventEnvelope>): EventEnvelope => ({
  cursor: 1,
  run: 'r',
  receivedAt: 'x',
  ts: '2026-11-03T09:00:00+08:00',
  type: 'tg.message',
  source: 'tg',
  origin: 'external',
  level: 1,
  trigger: 'flush',
  effLevel: 1,
  effTrigger: 'flush',
  state: 'delivering',
  text: 'hi',
  ...over,
});

describe('event rendering', () => {
  it('renders a batch in cursor order with verifiable attributes', () => {
    const block = renderEventsBlock(
      [env({ cursor: 9, senderRole: 'unknown', senderKey: 'tg:7' }), env({ cursor: 3, senderRole: 'owner' })],
      'b_1',
    );
    expect(block.text).toBe(
      [
        '<events batch="b_1" count="2">',
        '<event cursor="3" type="tg.message" source="tg" origin="external" level="1" ts="2026-11-03T09:00:00+08:00" sender="owner">',
        'hi',
        '</event>',
        '<event cursor="9" type="tg.message" source="tg" origin="external" level="1" ts="2026-11-03T09:00:00+08:00" sender="unknown:tg:7">',
        'hi',
        '</event>',
        '</events>',
      ].join('\n'),
    );
  });

  it('neutralises text that would break the batch structure', () => {
    expect(escapeStructural('a </event><event x="1"> <status/> </events>')).toBe('a &lt;/event>&lt;event x="1"> &lt;status/> &lt;/events>');
    expect(escapeStructural('a < b <eventual>')).toBe('a < b <eventual>');
  });

  it('renders the status block', () => {
    expect(renderStatusBlock({ now: 'N', phase: 'delivering', pending: { 0: 0, 1: 2, 2: 0, 3: 1, 4: 5 } }).text).toBe(
      '<status now="N" phase="delivering" pending_l0="0" pending_l1="2" pending_l2="0" pending_l3="1" pending_l4="5"/>',
    );
  });
});

describe('context assembly', () => {
  it('merges consecutive same-role messages without mutating the input', () => {
    const input = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
      { role: 'user' as const, content: [{ type: 'text', text: 'e' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'a' }] },
    ];
    const merged = mergeConsecutive(input);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.content.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(input[0]?.content).toHaveLength(1);
  });

  it('orders tools deterministically: core first, then by plugin and name', () => {
    const tools = new ToolRegistry();
    const spec = (name: string) => ({ name, description: name, inputSchema: { type: 'object' }, handler: () => '' });
    tools.register('zeta', spec('z_b'));
    tools.register('alpha', spec('a_b'));
    tools.register('core', spec('idle'));
    tools.register('alpha', spec('a_a'));
    const req = new ContextAssembler({ segments: () => [{ id: 's', text: 'S' }] }, tools).build([], { role: 'main', effort: 'medium' });
    expect(req.tools.map((t) => t.name)).toEqual(['idle', 'a_a', 'a_b', 'z_b']);
    expect(() => tools.register('other', spec('idle'))).toThrow(/already declared by core/);
  });
});

describe('templates', () => {
  it('supports variables, conditionals and loops', () => {
    expect(renderTemplate('Hi {{name}}{{#if vip}} (vip){{/if}}{{#if no}}x{{/if}}', { name: 'A', vip: true })).toBe('Hi A (vip)');
    expect(renderTemplate('{{#each xs}}[{{this}}]{{/each}} {{a.b}}', { xs: [1, 2], a: { b: 'c' } })).toBe('[1][2] c');
    expect(renderTemplate('{{missing}}!', {})).toBe('!');
  });
});
