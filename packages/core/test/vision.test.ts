import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobImageBlock, type ContentBlock, type EventEnvelope, type ToolUseBlock, type TranscriptMessage } from '@protea/protocol';
import {
  BROWSER_DENIED_TOOLS,
  BlobStore,
  ImageResolvingProvider,
  ScriptedProvider,
  ToolDispatcher,
  ToolRegistry,
  browserPreset,
  normalizeProviderProfile,
  openDatabase,
  redactRequest,
  renderCallResult,
  renderEventImages,
  resolveImageBlocks,
  silentLogger,
  sniffImageMime,
  textReply,
  toChatMessages,
  toResponsesInput,
  viewImageTool,
  estimateMessagesTokens,
  normalizeMcpServer,
  type ProviderRequest,
  type ToolSpec,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

function store(maxBytes = 1024) {
  const dir = tmpDir();
  const { db } = openDatabase(path.join(dir, 'protea.db'));
  let now = Date.parse('2026-11-10T00:00:00Z');
  const blobs = new BlobStore({ dir: path.join(dir, 'blobs'), db, clock: { now: () => now }, maxImageBytes: () => maxBytes });
  return { dir, blobs, advance: (ms: number) => (now += ms) };
}

const put = (blobs: BlobStore, bytes = PNG) => {
  const r = blobs.putImage(bytes);
  if (!r.ok) throw new Error(r.reason);
  return r.blob;
};

describe('blob store', () => {
  it('recognises images by their bytes and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageMime(Buffer.from('sk-secret-token'))).toBeNull();
  });

  it('stores by content, refuses what it should, and expires', () => {
    const { blobs, advance, dir } = store();
    const a = put(blobs);
    expect(a.handle).toMatch(/^blob:[a-f0-9]{64}$/);
    expect(a.mime).toBe('image/png');
    expect(put(blobs).handle).toBe(a.handle);
    expect(blobs.get(a.handle)?.bytes.equals(PNG)).toBe(true);
    expect(blobs.putImage(Buffer.from('not an image'))).toMatchObject({ ok: false });
    expect(blobs.putImage(Buffer.concat([PNG, Buffer.alloc(2048)]))).toMatchObject({ ok: false, reason: expect.stringContaining('over the limit') });
    expect(blobs.get('blob:../../secrets')).toBeNull();

    advance(10 * 86_400_000);
    const fresh = put(blobs, JPEG);
    advance(25 * 86_400_000);
    expect(blobs.sweep(30 * 86_400_000)).toBe(1);
    expect(blobs.get(a.handle)).toBeNull();
    expect(blobs.get(fresh.handle)).not.toBeNull();
    expect(fs.existsSync(path.join(dir, 'blobs', a.handle.slice(5, 7), a.handle.slice(5)))).toBe(false);
  });
});

describe('view_image', () => {
  function tool() {
    const s = store();
    const workspace = path.join(s.dir, 'workspace');
    fs.mkdirSync(workspace);
    const spec = viewImageTool({ blobs: s.blobs, workspace, maxBytes: () => 1024 }) as unknown as ToolSpec<{ path: string }>;
    const call = (p: string) => spec.handler({ path: p }, {} as never) as { text: string; failed?: boolean; images?: Array<{ handle: string }> };
    return { ...s, workspace, call };
  }

  it('shows an image from the workspace under either of its names', () => {
    const { workspace, call } = tool();
    fs.mkdirSync(path.join(workspace, 'browser'));
    fs.writeFileSync(path.join(workspace, 'browser', 'a.png'), PNG);
    const r = call('browser/a.png');
    expect(r.failed).toBeUndefined();
    expect(r.images).toHaveLength(1);
    expect(call('/workspace/browser/a.png').images).toEqual(r.images);
  });

  it('is not fooled by what the sandbox can plant in the workspace', () => {
    const { dir, workspace, call } = tool();
    const secret = path.join(dir, 'secret.png');
    fs.writeFileSync(secret, PNG);
    fs.symlinkSync(secret, path.join(workspace, 'link.png'));
    expect(call('link.png')).toMatchObject({ failed: true, text: expect.stringContaining('outside the workspace') });
    expect(call('../secret.png')).toMatchObject({ failed: true });
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'sk-very-secret');
    expect(call('notes.txt')).toMatchObject({ failed: true, text: expect.stringContaining('not a PNG') });
    fs.mkdirSync(path.join(workspace, 'd'));
    expect(call('d')).toMatchObject({ failed: true });
  });

  it('takes a stored image by handle', () => {
    const { blobs, call } = tool();
    const b = put(blobs);
    expect(call(b.handle).images).toEqual([{ handle: b.handle, mime: 'image/png' }]);
    expect(call(`blob:${'a'.repeat(64)}`)).toMatchObject({ failed: true });
  });
});

describe('images on the way to the model', () => {
  const req = (messages: TranscriptMessage[]): ProviderRequest => ({ role: 'main', system: [], messages, tools: [], effort: 'low' });
  const bytes = (b: ContentBlock) => (b as unknown as { source: { data: string } }).source.data;

  it('becomes bytes only inside the last wrapper, the same bytes every time', async () => {
    const { blobs } = store();
    const b = put(blobs);
    const inner = new ScriptedProvider([() => textReply('ok')]);
    const p = new ImageResolvingProvider(inner, blobs, () => true);
    const original: TranscriptMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, blobImageBlock(b.handle, b.mime)] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'shot' }, blobImageBlock(b.handle, b.mime)] }] },
    ];
    await p.generate(req(original), { signal: new AbortController().signal });
    await p.generate(req(original), { signal: new AbortController().signal });
    expect(JSON.stringify(original)).not.toContain(PNG.toString('base64'));
    expect(JSON.stringify(inner.calls[0])).toContain(PNG.toString('base64'));
    expect(JSON.stringify(inner.calls[0])).toBe(JSON.stringify(inner.calls[1]));
    expect(bytes(inner.calls[0]?.messages[0]?.content[1] as ContentBlock)).toBe(PNG.toString('base64'));
  });

  it('turns into a line of text when the model cannot see or the image is gone', () => {
    const { blobs } = store();
    const b = put(blobs);
    const msg: TranscriptMessage[] = [{ role: 'user', content: [blobImageBlock(b.handle, b.mime)] }];
    expect(resolveImageBlocks(msg, blobs, false)[0]?.content[0]).toEqual({ type: 'text', text: `[image image/png, ${b.handle}: the current model cannot see images]` });
    const gone: TranscriptMessage[] = [{ role: 'user', content: [blobImageBlock(`blob:${'b'.repeat(64)}`, 'image/png')] }];
    expect(String(resolveImageBlocks(gone, blobs, true)[0]?.content[0]?.['text'])).toContain('no longer stored');
  });

  it('leaves references alone during redaction and counts them at a flat rate', () => {
    const b = blobImageBlock(`blob:${'c'.repeat(64)}`, 'image/png');
    const { req: clean } = redactRequest(req([{ role: 'user', content: [b] }]), { knownValues: () => [{ name: 'X', value: 'cccccc' }] });
    expect(clean.messages[0]?.content[0]).toEqual(b);
    expect(estimateMessagesTokens([{ role: 'user', content: [b] }])).toBe(1604);
  });

  it('maps to Chat Completions: tool messages stay text, images follow in a user message', () => {
    const image: ContentBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } };
    const out = toChatMessages(
      req([
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'shot', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'saved' }, image] }, { type: 'text', text: '<status/>' }] },
      ]),
    );
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'saved' });
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '<tool_images call_id="c1" count="1"/>' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'text', text: '<status/>' },
      ],
    });
    // Without images nothing changes: the same plain string as before.
    expect(toChatMessages(req([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]))).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps to Responses input items', () => {
    const image: ContentBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } };
    expect(toResponsesInput(req([{ role: 'user', content: [{ type: 'text', text: 'what is this' }, image] }]))).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'what is this' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' }] },
    ]);
  });

  it('is a per-role setting of a profile', () => {
    const base = { protocol: 'openai-chat', baseUrl: 'http://x/v1', models: { main: 'm' } };
    expect(normalizeProviderProfile('a', base).vision).toEqual({ main: false, fork: false, cheap: false, judge: false });
    expect(normalizeProviderProfile('a', { ...base, vision: true }).vision).toEqual({ main: true, fork: true, cheap: true, judge: true });
    expect(normalizeProviderProfile('a', { ...base, vision: { main: true } }).vision).toEqual({ main: true, fork: false, cheap: false, judge: false });
    expect(normalizeProviderProfile('a', { protocol: 'anthropic' }).vision.main).toBe(true);
    expect(() => normalizeProviderProfile('a', { ...base, vision: 'yes' })).toThrow(/vision/);
  });
});

describe('images from tools', () => {
  function dispatch(outcome: unknown, limit = 2) {
    const reg = new ToolRegistry();
    reg.register('t', { name: 'shot', description: 'x', inputSchema: { type: 'object' }, handler: () => outcome } as never);
    const d = new ToolDispatcher(reg, silentLogger(), 500);
    d.setImageLimit(() => limit);
    const use: ToolUseBlock = { type: 'tool_use', id: 'u', name: 'shot', input: {} };
    return d.runAll([use], { signal: new AbortController().signal, sessionId: 's', batchId: 'b', batchLevel: 1 });
  }
  const img = (c: string) => ({ handle: `blob:${c.repeat(64)}`, mime: 'image/png' });

  it('puts them in the tool result, within the limit', async () => {
    const r = await dispatch({ text: 'three shots', images: [img('a'), img('b'), img('c')] });
    expect(r.results[0]?.content).toEqual([
      { type: 'text', text: 'three shots\n[1 more image(s) not shown]' },
      blobImageBlock(img('a').handle, 'image/png'),
      blobImageBlock(img('b').handle, 'image/png'),
    ]);
  });

  it('keeps a failed result to text, as the Messages API requires', async () => {
    const r = await dispatch({ text: 'broke', failed: true, images: [img('a')] });
    expect(r.results[0]).toMatchObject({ content: 'broke', is_error: true });
  });

  it('takes what an MCP server returns, and falls back to text', () => {
    const kept = renderCallResult({ content: [{ type: 'text', text: 'done' }, { type: 'image', mimeType: 'image/png', data: 'QUJD' }] }, () => ({ handle: 'blob:x', mime: 'image/png' }));
    expect(kept).toEqual({ text: 'done', images: [{ handle: 'blob:x', mime: 'image/png' }] });
    expect(renderCallResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }] }, () => ({ handle: 'blob:x', mime: 'image/png' }))).toEqual({ text: '[1 image(s)]', images: [{ handle: 'blob:x', mime: 'image/png' }] });
    const refused = renderCallResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }] }, () => ({ reason: 'too big' }));
    expect(refused.text).toBe('[image image/png, 3 bytes] (not shown: too big)');
    expect(renderCallResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }] })).toEqual({ text: '[image image/png, 3 bytes]' });
  });
});

describe('images in events', () => {
  const ev = (cursor: number, blobs?: EventEnvelope['blobs']) => ({ cursor, origin: 'external', ...(blobs ? { blobs } : {}) }) as EventEnvelope;
  const b = (c: string, mime = 'image/png') => ({ handle: `blob:${c.repeat(64)}`, mime });

  it('labels each group with its event and respects the limit', () => {
    const out = renderEventImages([ev(9, [b('a'), b('b'), b('c')]), ev(7), ev(8, [{ ...b('d'), mime: 'application/pdf' }])], 2);
    expect(out).toEqual([
      { type: 'text', text: '<event_images cursor="9" origin="external" count="2" omitted="1"/>' },
      blobImageBlock(b('a').handle, 'image/png'),
      blobImageBlock(b('b').handle, 'image/png'),
    ]);
  });
});

describe('the browser preset', () => {
  const preset = browserPreset({ dataDir: '/data', controlPort: 7788, browsersPath: '/ms-playwright' });

  it('is a valid server entry with its restrictions in place', () => {
    const s = normalizeMcpServer('browser', preset);
    expect(s.tools.deny).toEqual(expect.arrayContaining([...BROWSER_DENIED_TOOLS]));
    expect(BROWSER_DENIED_TOOLS).toContain('browser_run_code_unsafe');
    expect(s.roots).toEqual(['workspace/browser']);
    expect(s.memoryMb).toBe(1536);
    expect(s.args).toContain('--sandbox');
    expect(s.args).not.toContain('--no-sandbox');
    expect(s.args).not.toContain('--allow-unrestricted-file-access');
    expect(s.args[s.args.indexOf('--blocked-origins') + 1]).toContain('http://127.0.0.1:7788');
    expect(s.env['PLAYWRIGHT_BROWSERS_PATH']).toBe('/ms-playwright');
    expect(s.trust).toBe('normal');
  });

  it('can be told to run without Chromium\'s sandbox', () => {
    expect((browserPreset({ dataDir: '/data', noSandbox: true })['args'] as string[])).toContain('--no-sandbox');
  });

  it('refuses roots outside the data directory', () => {
    expect(() => normalizeMcpServer('x', { command: 'c', roots: ['/etc'] })).toThrow(/inside the data directory/);
    expect(() => normalizeMcpServer('x', { command: 'c', roots: ['../secrets'] })).toThrow(/inside the data directory/);
  });
});
