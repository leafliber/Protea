import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSse, resolveClient } from '../src/client.js';

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe('parseSse', () => {
  it('reassembles messages split across chunks, with comments, ids, CRLF and multi-line data', async () => {
    const out = [];
    for await (const m of parseSse(chunks('event: hel', 'lo\ndata: {"a":1}\n\n: keep-alive\n\n', 'id: 7\r\nevent: event\r\ndata: line1\r\ndata: line2\r\n\r\n'))) {
      out.push(m);
    }
    expect(out).toEqual([
      { event: 'hello', data: '{"a":1}' },
      { event: 'event', data: 'line1\nline2', id: '7' },
    ]);
  });
});

describe('resolveClient', () => {
  it('reads the admin token from the data directory when no token is given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-cli-'));
    fs.mkdirSync(path.join(dir, 'secrets'));
    fs.writeFileSync(path.join(dir, 'secrets', 'PROTEA_ADMIN_TOKEN'), 'tok\n');
    expect(resolveClient({ dataDir: dir }, {})).toEqual({ url: 'http://127.0.0.1:7788', token: 'tok' });
    expect(resolveClient({ token: 'x', url: 'http://h:1/' }, {})).toEqual({ url: 'http://h:1', token: 'x' });
    expect(() => resolveClient({ dataDir: path.join(dir, 'nope') }, {})).toThrow(/no admin token/);
  });
});
