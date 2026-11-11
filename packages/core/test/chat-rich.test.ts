import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatDraftParams, ChatPlatformDecl, ChatSendParams, ChatSendResult } from '@protea/protocol';
import {
  BlobStore,
  Bus,
  CHAT_SEND,
  ChatDraftStream,
  ChatHub,
  MIGRATIONS,
  OutputLog,
  ToolDispatcher,
  ToolRegistry,
  WidgetStore,
  checkWidget,
  migrate,
  openDatabase,
  partialObject,
  silentLogger,
  type Clock,
} from '../src/index.js';
import Database from 'better-sqlite3';
import { tmpDir, waitFor } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const FULL: ChatPlatformDecl = { markdown: 'full', images: true, choices: true, widgets: true };

function setup(limits: { widgets?: boolean; maxImages?: number } = {}) {
  const dir = tmpDir();
  const { db } = openDatabase(path.join(dir, 'p.db'));
  const tools = new ToolRegistry();
  const bus = new Bus();
  const outputs = new OutputLog(db);
  let now = Date.parse('2026-11-11T08:00:00.000Z');
  const clock = { now: () => now } as Clock;
  const blobs = new BlobStore({ dir: path.join(dir, 'blobs'), db, clock, maxImageBytes: () => 64 * 1024 });
  const widgets = new WidgetStore(db);
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  let publicUrl: string | null = null;
  const hub = new ChatHub({
    tools,
    bus,
    outputs,
    log: silentLogger(),
    clock,
    blobs,
    workspace,
    widgets,
    limits: () => ({ maxImages: limits.maxImages ?? 4, maxImageBytes: 64 * 1024, widgets: limits.widgets ?? true, widgetMaxBytes: 2048 }),
    publicUrl: () => publicUrl,
  });
  const dispatcher = new ToolDispatcher(tools, silentLogger());
  let n = 0;
  const call = async (input: unknown, id = `u${++n}`) => {
    const r = await dispatcher.runAll([{ type: 'tool_use', id, name: CHAT_SEND, input }], { signal: new AbortController().signal, sessionId: 'main', batchId: 'b1', batchLevel: 1 });
    return r.results[0] as { content: string; is_error?: boolean };
  };
  const sent: Array<[string, ChatSendParams]> = [];
  const platform = (id: string, decl: ChatPlatformDecl = {}, extra: { send?: (r: ChatSendParams) => ChatSendResult; draft?: (d: ChatDraftParams) => void } = {}) =>
    hub.register({ ...decl, id, send: (r) => (sent.push([id, r]), extra.send?.(r) ?? { ok: true }), ...(extra.draft ? { draft: extra.draft } : {}) });
  return { dir, db, tools, bus, outputs, blobs, widgets, workspace, hub, call, platform, sent, tick: (ms: number) => (now += ms), setPublicUrl: (u: string | null) => (publicUrl = u) };
}

describe('what a reply can carry', () => {
  it('offers images, choices and widget only when a running platform declares them, and says who shows what', () => {
    const { tools, platform, hub } = setup();
    platform('telegram', { markdown: 'none', maxChars: 3500 });
    let spec = tools.get(CHAT_SEND);
    expect(Object.keys((spec?.inputSchema as { properties: object }).properties)).toEqual(['platform', 'text', 'reply_to']);
    expect(spec?.description).toContain('telegram: plain text, up to 3500 characters a message');
    platform('webchat', FULL);
    spec = tools.get(CHAT_SEND);
    expect(Object.keys((spec?.inputSchema as { properties: object }).properties)).toEqual(['platform', 'text', 'reply_to', 'images', 'choices', 'widget']);
    expect(spec?.description).toContain('webchat: full Markdown, images, choices, widget');
    expect(hub.list()).toMatchObject([
      { id: 'telegram', images: false, choices: false, widgets: false, drafts: false },
      { id: 'webchat', images: true, choices: true, widgets: true, drafts: false },
    ]);
  });

  it('refuses a part the platform did not declare, and sends nothing', async () => {
    const { call, platform, sent, outputs } = setup();
    platform('webchat', FULL);
    platform('telegram', { markdown: 'none' });
    const choices = { options: [{ label: 'Yes' }, { label: 'No' }] };
    expect(await call({ platform: 'telegram', text: 'ok?', choices })).toMatchObject({ is_error: true, content: 'telegram does not show choices; put the options in the text' });
    expect(await call({ platform: 'telegram', text: 'look', images: ['a.png'] })).toMatchObject({ is_error: true, content: expect.stringContaining('telegram does not show images') });
    expect(await call({ platform: 'telegram', text: 'look', widget: { title: 't', code: '<b>x</b>' } })).toMatchObject({ is_error: true, content: expect.stringContaining('telegram does not show widgets') });
    expect(sent).toEqual([]);
    expect(outputs.chat({ platform: 'all' }).items).toEqual([]);
  });

  it('sends choices, records them, and the answer points back at the reply', async () => {
    const { call, platform, sent, outputs, db } = setup();
    platform('webchat', FULL);
    const r = await call({ platform: 'webchat', text: 'When?', choices: { options: [{ label: 'Friday ', detail: '3 pm' }, { label: 'Monday' }], multiple: true } }, 'call_q');
    expect(r).toEqual({ content: 'sent to webchat (5 characters, 2 choices); the answer will arrive as a chat.message', tool_use_id: 'call_q', type: 'tool_result' });
    expect(sent[0]?.[1]).toMatchObject({ callId: 'call_q', choices: { options: [{ label: 'Friday', detail: '3 pm' }, { label: 'Monday' }], multiple: true } });
    db.prepare(
      "INSERT INTO events (run, source, type, origin, level, eff_level, trigger, eff_trigger, ts, received_at, text, state, sender_key, sender_role, meta) VALUES ('r1', 'webchat', 'chat.message', 'external', 1, 1, 'flush', 'flush', ?, ?, 'Friday', 'delivered', 'console:me', 'owner', ?)",
    ).run('2026-11-11T08:01:00.000Z', '2026-11-11T08:01:00.000Z', JSON.stringify({ answer: { to: 'call_q', labels: ['Friday'] } }));
    const items = outputs.chat().items;
    expect(items).toMatchObject([
      { kind: 'reply', text: 'When?', callId: 'call_q', choices: { options: [{ label: 'Friday', detail: '3 pm' }, { label: 'Monday' }], multiple: true } },
      { kind: 'owner', text: 'Friday', answer: { to: 'call_q', labels: ['Friday'] } },
    ]);
    // A label may not look like a command, and labels must differ.
    expect(await call({ platform: 'webchat', text: 'x', choices: { options: [{ label: '/approve 1' }, { label: 'No' }] } })).toMatchObject({ is_error: true });
    expect(await call({ platform: 'webchat', text: 'x', choices: { options: [{ label: 'Same' }, { label: 'Same ' }] } })).toMatchObject({ is_error: true, content: 'two choices have the same label' });
    expect(await call({ platform: 'webchat', text: 'x', choices: { options: [{ label: 'Only' }] } })).toMatchObject({ is_error: true });
  });

  it('sends images from the workspace or by handle, stored once, and limits how many', async () => {
    const { call, platform, sent, outputs, blobs, workspace } = setup({ maxImages: 2 });
    platform('webchat', FULL);
    fs.writeFileSync(path.join(workspace, 'plot.png'), PNG);
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'not a picture');
    const stored = blobs.putImage(PNG, 'test');
    const handle = stored.ok ? stored.blob.handle : '';
    const r = await call({ platform: 'webchat', text: 'Here.', images: ['plot.png', handle] });
    expect(r.is_error).toBeUndefined();
    expect(r.content).toBe('sent to webchat (5 characters, 2 images)');
    expect(sent[0]?.[1].images).toEqual([{ handle, mime: 'image/png' }, { handle, mime: 'image/png' }]);
    expect(outputs.chat().items[0]).toMatchObject({ images: [{ handle }, { handle }] });
    expect(outputs.showsImage(handle)).toBe(true);
    expect(outputs.showsImage(`blob:${'0'.repeat(64)}`)).toBe(false);
    expect(await call({ platform: 'webchat', text: 'x', images: ['notes.txt'] })).toMatchObject({ is_error: true, content: 'notes.txt is not a PNG, JPEG, WebP or GIF image' });
    expect(await call({ platform: 'webchat', text: 'x', images: ['../secret.png'] })).toMatchObject({ is_error: true });
    expect(await call({ platform: 'webchat', text: 'x', images: [`blob:${'0'.repeat(64)}`] })).toMatchObject({ is_error: true, content: expect.stringContaining('no longer stored') });
    expect(await call({ platform: 'webchat', text: 'x', images: ['plot.png', 'plot.png', 'plot.png'] })).toMatchObject({ is_error: true });
    expect(sent).toHaveLength(1);
  });

  it('stores a widget, passes a reference to the platform, and refuses one that cannot work', async () => {
    const { call, platform, sent, outputs, widgets, setPublicUrl } = setup();
    platform('webchat', FULL);
    const code = '<div id="x"></div><script>document.getElementById("x").textContent = 1 + 1;</script>';
    const r = await call({ platform: 'webchat', text: 'Try it.', widget: { title: 'Adder', code } });
    expect(r.content).toBe('sent to webchat (7 characters, a widget)');
    const ref = sent[0]?.[1].widget;
    expect(ref).toMatchObject({ id: expect.stringMatching(/^w[a-f0-9]{32}$/), title: 'Adder' });
    expect(ref?.url).toBeUndefined();
    expect(widgets.get(ref?.id ?? '')).toEqual({ id: ref?.id, title: 'Adder', code });
    expect(widgets.get('../etc')).toBeNull();
    expect(outputs.chat().items[0]).toMatchObject({ widget: { id: ref?.id, title: 'Adder' } });
    expect(JSON.stringify(outputs.chat().items[0])).not.toContain('getElementById');

    // The same widget again is the same row; with a public address the platform gets its page.
    setPublicUrl('https://protea.example/');
    await call({ platform: 'webchat', text: 'Again.', widget: { title: 'Adder', code } });
    expect(sent[1]?.[1].widget).toEqual({ id: ref?.id, title: 'Adder', url: `https://protea.example/#/widget/${ref?.id}` });

    const bad = async (c: string) => (await call({ platform: 'webchat', text: 'x', widget: { title: 't', code: c } })).content;
    expect(await bad('<script src="https://cdn.example/x.js"></script>')).toContain('remove <script src>');
    expect(await bad('<link rel="stylesheet" href="a.css">')).toContain('remove <link>');
    expect(await bad('<iframe src="https://example.com"></iframe>')).toContain('remove <iframe>');
    expect(await bad('<p>ok</p><script>\nlet a = ;\n</script>')).toMatch(/script 1 of the widget does not parse \(line 2 of that script\)/);
    expect(await bad(`<p>${'x'.repeat(3000)}</p>`)).toContain('must NOT have more than 2048 characters');
    expect(checkWidget('表'.repeat(1000), 2048)).toBe('the widget is 3 KB, over the limit of 2 KB');
    expect(sent).toHaveLength(2);
  });

  it('turns widgets off with the setting', async () => {
    const { call, platform, tools, hub } = setup({ widgets: false });
    platform('webchat', FULL);
    expect(Object.keys((tools.get(CHAT_SEND)?.inputSchema as { properties: object }).properties)).not.toContain('widget');
    expect(hub.list()[0]).toMatchObject({ widgets: false });
    expect(await call({ platform: 'webchat', text: 'x', widget: { title: 't', code: '<b>x</b>' } })).toMatchObject({ is_error: true });
  });

  it('checks a widget without running it', () => {
    const g = globalThis as { ranWidget?: boolean };
    expect(checkWidget('<script>globalThis.ranWidget = true;</script><svg viewBox="0 0 1 1"></svg>', 4096)).toBeNull();
    expect(g.ranWidget).toBeUndefined();
    expect(checkWidget('<script type="application/json">{ not: js }</script>', 4096)).toBeNull();
    expect(checkWidget('   ', 4096)).toBe('the widget is empty');
    expect(checkWidget('<meta http-equiv="refresh" content="0;url=https://example.com">', 4096)).toContain('<meta http-equiv>');
  });
});

describe('drafts for a platform that takes them', () => {
  it('passes the whole text so far, no more often than asked, and the reply replaces the preview', async () => {
    const { bus, platform, call, tick } = setup();
    const seen: ChatDraftParams[] = [];
    platform('relay', { ...FULL, drafts: { minIntervalMs: 250 } }, { draft: (d) => seen.push(d) });
    const draft = (offset: number, text: string, pending?: Array<'images' | 'choices' | 'widget'>) =>
      bus.emit('chat.draft', { batchId: 'b1', callId: 'c1', platform: 'relay', state: 'writing', offset, text, ...(pending ? { pending } : {}) });
    draft(0, 'Hel');
    draft(3, 'lo');
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ callId: 'c1', batchId: 'b1', state: 'writing', text: 'Hello' }]);
    // The next update waits out the interval, then carries everything.
    draft(5, ' there');
    draft(11, '', ['widget']);
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(1);
    tick(250);
    await waitFor(() => seen.length === 2, 2000);
    expect(seen[1]).toEqual({ callId: 'c1', batchId: 'b1', state: 'writing', text: 'Hello there', pending: ['widget'] });
    // A fragment after a gap is ignored.
    draft(40, 'lost');
    // The reply itself ends the preview: nothing is withdrawn.
    await call({ platform: 'relay', text: 'Hello there' }, 'c1');
    bus.emit('chat.draft', { batchId: 'b1', callId: 'c1', platform: 'relay', state: 'discarded' });
    expect(seen).toHaveLength(2);
  });

  it('withdraws a preview that was shown when the reply does not come, and says nothing about one that was not', async () => {
    const { bus, platform, call } = setup();
    const seen: ChatDraftParams[] = [];
    platform('relay', { drafts: {} }, { draft: (d) => seen.push(d), send: () => ({ ok: false, error: 'the window is closed' }) });
    bus.emit('chat.draft', { batchId: 'b1', callId: 'never-shown', platform: 'relay', state: 'writing', offset: 0, text: 'x' });
    bus.emit('chat.draft', { batchId: 'b1', callId: 'never-shown', platform: 'relay', state: 'discarded' });
    expect(seen).toEqual([]);

    bus.emit('chat.draft', { batchId: 'b1', callId: 'c2', platform: 'relay', state: 'writing', offset: 0, text: 'Hi' });
    await waitFor(() => seen.length === 1, 3000);
    bus.emit('chat.draft', { batchId: 'b1', callId: 'c2', platform: 'relay', state: 'discarded' });
    expect(seen.at(-1)).toEqual({ callId: 'c2', batchId: 'b1', state: 'discarded' });

    // A send that fails also takes the preview away.
    bus.emit('chat.draft', { batchId: 'b1', callId: 'c3', platform: 'relay', state: 'writing', offset: 0, text: 'Hi' });
    await waitFor(() => seen.length === 3, 3000);
    expect(await call({ platform: 'relay', text: 'Hi' }, 'c3')).toMatchObject({ is_error: true, content: 'the window is closed' });
    expect(seen.at(-1)).toEqual({ callId: 'c3', batchId: 'b1', state: 'discarded' });
  });

  it('a platform without a draft handler is left alone (the web chat reads the bus)', () => {
    const { bus, platform, hub } = setup();
    platform('webchat', { ...FULL, drafts: {} });
    expect(hub.showsDrafts('webchat')).toBe(true);
    expect(() => bus.emit('chat.draft', { batchId: 'b1', callId: 'c1', platform: 'webchat', state: 'writing', offset: 0, text: 'x' })).not.toThrow();
  });
});

describe('the draft of a reply with structured parts', () => {
  it('reads the fields that have begun from a cut-off object', () => {
    expect(partialObject('{"platform":"webchat","text":"Hi","widget":{"title":"A').started).toEqual(['platform', 'text', 'widget']);
    expect(partialObject('{"platform":"webchat","choices":{"options":[]},"te').started).toEqual(['platform', 'choices']);
    expect(partialObject('{"platform":"webchat","images":').started).toEqual(['platform']);
  });

  it('announces what is still on its way, once', () => {
    const seen: unknown[] = [];
    const s = new ChatDraftStream('b1', () => true, (d) => seen.push(d), 5);
    const push = (json: string) => (s.push({ id: 'c1', name: 'chat_send', json }), s.flush());
    push('{"platform":"webchat","text":"Look');
    push('.","widget":{"title":"A","code":"<b');
    push('>x</b>"');
    push('}}');
    expect(seen).toEqual([
      { state: 'writing', batchId: 'b1', callId: 'c1', platform: 'webchat', offset: 0, text: 'Look' },
      { state: 'writing', batchId: 'b1', callId: 'c1', platform: 'webchat', offset: 4, text: '.', pending: ['widget'] },
    ]);
    s.discard();
    expect(seen.at(-1)).toEqual({ state: 'discarded', batchId: 'b1', callId: 'c1', platform: 'webchat' });
  });
});

describe('migration 9', () => {
  it('adds the reply parts to an existing database and keeps old replies as they were', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 8));
    db.prepare("INSERT INTO outputs (at, plugin, channel, text) VALUES ('2026-11-10T08:00:00.000Z', 'webchat', 'chat', 'old reply')").run();
    expect(migrate(db).applied).toEqual(['9_chat-rich-content']);
    const outputs = new OutputLog(db);
    expect(outputs.chat().items).toEqual([{ key: 'o1', kind: 'reply', platform: 'webchat', at: '2026-11-10T08:00:00.000Z', text: 'old reply', channel: 'chat' }]);
    expect(new WidgetStore(db).get(`w${'a'.repeat(32)}`)).toBeNull();
  });
});
