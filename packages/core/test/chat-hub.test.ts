import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatSendParams, ChatSendResult } from '@protea/protocol';
import { Bus, CHAT_SEND, ChatHub, OutboundLimiter, OutputLog, ToolDispatcher, ToolRegistry, openDatabase, silentLogger, type Clock } from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup() {
  const { db } = openDatabase(path.join(tmpDir(), 'p.db'));
  const tools = new ToolRegistry();
  const bus = new Bus();
  const outputs = new OutputLog(db);
  const clock: Clock = { now: () => Date.parse('2026-11-10T08:00:00.000Z') } as Clock;
  const hub = new ChatHub({ tools, bus, outputs, log: silentLogger(), clock });
  const dispatcher = new ToolDispatcher(tools, silentLogger());
  const call = async (input: unknown) => {
    const r = await dispatcher.runAll([{ type: 'tool_use', id: 'u1', name: CHAT_SEND, input }], { signal: new AbortController().signal, sessionId: 'main', batchId: 'b1', batchLevel: 1 });
    return r.results[0] as { content: string; is_error?: boolean };
  };
  const platform = (id: string, send: (r: ChatSendParams) => ChatSendResult = () => ({ ok: true })) => hub.register({ id, send });
  return { tools, bus, outputs, hub, dispatcher, call, platform };
}

describe('ChatHub and chat_send', () => {
  it('exists only while a platform runs, and its schema names the running ones', () => {
    const { tools, hub, platform } = setup();
    expect(tools.get(CHAT_SEND)).toBeUndefined();
    platform('webchat');
    platform('telegram');
    expect(tools.get(CHAT_SEND)?.inputSchema).toMatchObject({ required: ['platform', 'text'], properties: { platform: { enum: ['telegram', 'webchat'] } } });
    hub.unregister('telegram', 'plugin telegram crashed');
    expect(tools.get(CHAT_SEND)?.inputSchema).toMatchObject({ properties: { platform: { enum: ['webchat'] } } });
    hub.unregister('webchat', 'plugin webchat is stopped');
    expect(tools.get(CHAT_SEND)).toBeUndefined();
    expect(tools.unavailableReason(CHAT_SEND)).toBe('plugin webchat is stopped');
  });

  it('requires a platform and says which ones there are', async () => {
    const { call, platform, outputs } = setup();
    platform('webchat');
    expect(await call({ text: 'hi' })).toMatchObject({ is_error: true, content: expect.stringContaining("platform") });
    expect(await call({ platform: 'telegram', text: 'hi' })).toMatchObject({ is_error: true, content: expect.stringContaining('webchat') });
    expect(outputs.chat({ platform: 'all' }).items).toEqual([]);
  });

  it('routes to the named platform, records what was sent and announces it', async () => {
    const { call, platform, outputs, bus } = setup();
    const sent: Array<[string, ChatSendParams]> = [];
    platform('webchat', (r) => (sent.push(['webchat', r]), { ok: true }));
    platform('telegram', (r) => (sent.push(['telegram', r]), { ok: true, messageIds: ['41', '42'] }));
    const announced: Array<{ plugin: string; channel?: string; id?: number; batchId?: string }> = [];
    bus.on('plugin.output', (o) => announced.push(o));
    const r = await call({ platform: 'telegram', text: 'hello', reply_to: '40' });
    expect(r.is_error).toBeUndefined();
    expect(r.content).toBe('sent to telegram as message 41, 42 (5 characters)');
    expect(sent).toEqual([['telegram', { text: 'hello', replyTo: '40', sessionId: 'main', batchId: 'b1' }]]);
    expect(announced).toMatchObject([{ plugin: 'telegram', channel: 'chat', batchId: 'b1', id: 1 }]);
    expect(outputs.chat({ platform: 'telegram' }).items).toMatchObject([{ kind: 'reply', text: 'hello', platform: 'telegram', channel: 'chat' }]);
    expect(outputs.chat({ platform: 'webchat' }).items).toEqual([]);
  });

  it('turns a platform failure into a failed receipt and records nothing', async () => {
    const { call, platform, outputs } = setup();
    platform('refuses', () => ({ ok: false, error: 'the owner is unknown' }));
    platform('throws', () => {
      throw new Error('network down');
    });
    expect(await call({ platform: 'refuses', text: 'x' })).toMatchObject({ is_error: true, content: 'the owner is unknown' });
    expect(await call({ platform: 'throws', text: 'x' })).toMatchObject({ is_error: true, content: expect.stringContaining('network down') });
    expect(outputs.chat({ platform: 'all' }).items).toEqual([]);
  });

  it('remembers where the owner last wrote, only while that platform runs', () => {
    const { bus, hub, platform } = setup();
    platform('telegram');
    const stored = (source: string, senderRole: 'owner' | 'unknown', type = 'chat.message') => bus.emit('event.stored', { source, senderRole, type } as never);
    stored('telegram', 'unknown');
    expect(hub.lastPlatform).toBeUndefined();
    stored('telegram', 'owner', 'telegram.edited');
    expect(hub.lastPlatform).toBeUndefined();
    stored('telegram', 'owner');
    expect(hub.lastPlatform).toBe('telegram');
    hub.unregister('telegram', 'stopped');
    expect(hub.lastPlatform).toBeUndefined();
  });

  it('sends its own notices where the owner last wrote, then to whichever platform takes them', async () => {
    const { bus, hub, platform } = setup();
    const tried: string[] = [];
    const recorded: string[] = [];
    bus.on('plugin.output', (o) => recorded.push(o.plugin));
    let wechatOpen = true;
    platform('webchat', () => (tried.push('webchat'), { ok: true }));
    platform('wechat', () => (tried.push('wechat'), wechatOpen ? { ok: true } : { ok: false, error: 'window closed' }));
    bus.emit('event.stored', { source: 'wechat', senderRole: 'owner', type: 'chat.message' } as never);
    expect(await hub.notifyOwner('first')).toBe(true);
    expect(tried).toEqual(['wechat']);
    wechatOpen = false;
    tried.length = 0;
    expect(await hub.notifyOwner('second')).toBe(true);
    expect(tried).toEqual(['wechat', 'webchat']);
    expect(recorded).toEqual(['wechat', 'webchat']);
  });

  it('reports a notice no platform would take', async () => {
    const { hub, platform } = setup();
    expect(await hub.notifyOwner('nobody here')).toBe(false);
    platform('wechat', () => ({ ok: false, error: 'window closed' }));
    platform('telegram', () => {
      throw new Error('down');
    });
    expect(await hub.notifyOwner('still nobody')).toBe(false);
  });

  it('counts chat_send against the platform it sends to', async () => {
    const { dispatcher, call, platform, tools } = setup();
    platform('webchat');
    platform('telegram');
    let now = 0;
    const limiter = new OutboundLimiter({ perMinute: () => 1, isConnector: () => false, clock: { now: () => now }, log: silentLogger(), pushInternal: () => undefined });
    dispatcher.setLimiter((def, use) => limiter.check(def, use));
    expect((await call({ platform: 'webchat', text: 'a' })).is_error).toBeUndefined();
    expect((await call({ platform: 'telegram', text: 'b' })).is_error).toBeUndefined();
    expect(await call({ platform: 'webchat', text: 'c' })).toMatchObject({ is_error: true, content: expect.stringContaining('webchat already made 1 outbound calls') });
    now += 60_001;
    expect((await call({ platform: 'webchat', text: 'd' })).is_error).toBeUndefined();
    expect(tools.get(CHAT_SEND)?.flags).toMatchObject({ sideEffect: true, barrierAfter: true });
  });
});
