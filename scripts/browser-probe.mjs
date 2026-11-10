// Drives the image's Playwright MCP over stdio with the arguments of the Protea preset: used by
// scripts/sandbox-smoke.sh. Prints what it checked; exits non-zero on any failure.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noSandbox = process.argv.includes('--no-sandbox');
const dir = mkdtempSync(join(tmpdir(), 'probe-'));
const root = join(dir, 'root');
mkdirSync(root);
writeFileSync(join(dir, 'outside.txt'), 'outside-the-root');
writeFileSync(join(root, 'page.html'), '<title>probe</title><h1>hello from the probe</h1>');
const child = spawn(
  'playwright-mcp',
  ['--headless', '--browser', 'chromium', noSandbox ? '--no-sandbox' : '--sandbox', '--user-data-dir', join(dir, 'profile'), '--output-dir', root, '--file-paths', 'absolute', '--viewport-size', '1280x800', '--snapshot-mode', 'none'],
  { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] },
);
let buffer = '';
let nextId = 1;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.id !== undefined && msg.method === 'roots/list') {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { roots: [{ uri: `file://${root}`, name: 'root' }] } })}\n`);
    }
  }
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 90_000);
    pending.set(id, (m) => (clearTimeout(t), resolve(m)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
const call = async (name, args = {}) => {
  const r = await send('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return { text: r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), images: r.result.content.filter((c) => c.type === 'image'), isError: r.result.isError === true };
};
const check = (ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: ${String(detail).slice(0, 600)}`}`);
  if (!ok) process.exitCode = 1;
};

try {
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'probe', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const nav = await call('browser_navigate', { url: 'data:text/html,<title>probe</title><h1>hello from the probe</h1>' });
  check(!nav.isError, 'a page opens', nav.text);
  const page = await call('browser_snapshot');
  check(page.text.includes('heading "hello from the probe"'), 'the page reads as text', page.text);
  const shot = await call('browser_take_screenshot', {});
  check(shot.images.length === 1 && shot.images[0].mimeType.startsWith('image/'), 'a screenshot comes back as an image', shot.text);
  const file = await call('browser_navigate', { url: `file://${join(dir, 'outside.txt')}` });
  check(file.isError || !(await call('browser_snapshot')).text.includes('outside-the-root'), 'a file:// URL does not open', file.text);
  const secrets = await call('browser_navigate', { url: 'file:///data/secrets/PROTEA_ADMIN_TOKEN' });
  check(secrets.isError, 'the secrets directory stays closed', secrets.text);
  const write = await call('browser_take_screenshot', { filename: '/data/secrets/planted.png' });
  check(write.isError && write.text.includes('outside allowed roots'), 'files cannot be written outside its directory', write.text);
  if (!noSandbox) {
    const box = await call('browser_navigate', { url: 'chrome://sandbox' });
    const status = box.isError ? box : await call('browser_snapshot');
    check(/adequately sandboxed/i.test(status.text), "Chromium's own sandbox is on", status.text);
  }
} catch (err) {
  check(false, 'the probe ran', err.message);
}
child.kill();
process.exit(process.exitCode ?? 0);
