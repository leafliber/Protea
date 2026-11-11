// Checks the widget sandbox in a real browser (docs/10-architecture/14-security-and-permissions.md §8):
// loads the frame the way the chat window does, hands it code that tries every way out, and
// watches what actually leaves. Prints each check; exits non-zero when one fails.
//
//   node scripts/widget-escape-probe.mjs --url http://127.0.0.1:7788 --token <admin token> --chrome <path to Chrome or Chromium>
//
// Needs a running daemon with the built console and Node 22+. Nothing is installed: the browser
// is driven over the DevTools protocol.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const base = (arg('url') ?? 'http://127.0.0.1:7788').replace(/\/+$/, '');
const token = arg('token') ?? process.env.PROTEA_ADMIN_TOKEN;
const chrome = arg('chrome') ?? process.env.CHROME_PATH;
if (!token || !chrome) {
  console.error('usage: node scripts/widget-escape-probe.mjs --url <daemon> --token <admin token> --chrome <browser binary>');
  process.exit(2);
}

// "Another site": anything that arrives here got out of the sandbox.
const hits = [];
const canary = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('canary');
});
await new Promise((r) => canary.listen(0, '127.0.0.1', r));
const out = `http://127.0.0.1:${canary.address().port}`;
const stun = dgram.createSocket('udp4');
let datagrams = 0;
stun.on('message', () => datagrams++);
await new Promise((r) => stun.bind(0, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'protea-probe-'));
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  browser.stderr.setEncoding('utf8');
  browser.stderr.on('data', (c) => {
    err += c;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
    if (m) resolve(m[1]);
  });
  browser.on('exit', () => reject(new Error(`the browser exited: ${err.slice(0, 400)}`)));
  setTimeout(() => reject(new Error('the browser did not start')), 20_000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = () => j(new Error('could not reach the browser'));
});
let nextId = 0;
const pending = new Map();
const events = [];
const seen = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(new Error(`${m.error.message}`));
    else p?.resolve(m.result);
  } else events.push(m);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp('Page.enable');
await cdp('Network.enable');
await cdp('Runtime.enable');
// A sandboxed frame may live in its own process: follow it, so its requests are seen too.
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const follow = setInterval(() => {
  for (const e of events.splice(0)) {
    seen.push(e);
    if (e.method === 'Target.attachedToTarget') void send('Network.enable', {}, e.params.sessionId).catch(() => undefined);
  }
}, 50);
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await cdp('Page.navigate', { url: `${base}/` });
await sleep(1500);
const signedIn = await evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-protea-csrf': '1' }, body: JSON.stringify({ token: ${JSON.stringify(token)} }) }).then((r) => r.status)`);
if (signedIn !== 200) throw new Error(`could not sign in (${signedIn})`);
const pageUrl = await evaluate('location.href');

/** Run code in a fresh sandbox frame, the way Widget.tsx does, and collect what the frame posts back. */
const inFrame = (code, waitMs = 3500) =>
  evaluate(`new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('allow', '');
    f.referrerPolicy = 'no-referrer';
    f.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px';
    const got = { messages: [], origin: null, loads: 0, nested: 0 };
    f.addEventListener('load', () => got.loads++);
    const on = (e) => {
      if (e.data && e.data.type === 'nested') got.nested++;
      if (e.source !== f.contentWindow) return;
      got.origin = e.origin;
      if (e.data && e.data.type === 'ready') f.contentWindow.postMessage({ type: 'render', code: ${JSON.stringify(code)} }, '*');
      else got.messages.push(e.data);
    };
    window.addEventListener('message', on);
    f.src = './widget-frame.html';
    document.body.appendChild(f);
    setTimeout(() => { window.removeEventListener('message', on); f.remove(); resolve(got); }, ${waitMs});
  })`);

const report = (rows) => `<script>parent.postMessage({ type: 'probe', rows: ${rows} }, '*');</script>`;
const CORPUS = `<script>
  var rows = {};
  function attempt(name, fn) { try { rows[name] = 'allowed: ' + String(fn()).slice(0, 80); } catch (e) { rows[name] = 'blocked: ' + e.name; } }
  attempt('cookie', function () { return document.cookie; });
  attempt('localStorage', function () { return localStorage.length; });
  attempt('sessionStorage', function () { return sessionStorage.length; });
  attempt('indexedDB', function () { return indexedDB.open('x') && 'opened'; });
  attempt('parent.document', function () { return parent.document.title; });
  attempt('top.location.href', function () { return top.location.href; });
  attempt('set top.location', function () { top.location = '${out}/top'; return 'set'; });
  attempt('window.open', function () { var w = window.open('${out}/popup'); if (!w) throw { name: 'null' }; return 'opened'; });
  rows['origin'] = self.origin;
  var pending = 0;
  function later(name, start) { pending++; start(function (v) { rows[name] = v; if (--pending === 0) done(); }); }
  function done() { parent.postMessage({ type: 'probe', rows: rows }, '*'); }
  later('fetch own api', function (cb) { fetch('/api/status').then(function (r) { cb('allowed: ' + r.status); }, function (e) { cb('blocked: ' + e.name); }); });
  later('fetch outside', function (cb) { fetch('${out}/fetch').then(function () { cb('allowed'); }, function (e) { cb('blocked: ' + e.name); }); });
  later('image outside', function (cb) { var i = new Image(); i.onload = function () { cb('allowed'); }; i.onerror = function () { cb('blocked'); }; i.src = '${out}/img.png'; });
  later('image own host', function (cb) { var i = new Image(); i.onload = function () { cb('allowed'); }; i.onerror = function () { cb('blocked'); }; i.src = '/favicon.svg'; });
  later('script outside', function (cb) { var s = document.createElement('script'); s.onload = function () { cb('allowed'); }; s.onerror = function () { cb('blocked'); }; s.src = '${out}/lib.js'; document.head.appendChild(s); });
  later('stylesheet outside', function (cb) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.onload = function () { cb('allowed'); }; l.onerror = function () { cb('blocked'); }; l.href = '${out}/a.css'; document.head.appendChild(l); });
  later('websocket', function (cb) { try { var w = new WebSocket('${out.replace('http', 'ws')}/ws'); w.onopen = function () { cb('allowed'); }; w.onerror = function () { cb('blocked'); }; } catch (e) { cb('blocked: ' + e.name); } });
  later('beacon', function (cb) { try { cb(navigator.sendBeacon('${out}/beacon', 'x') ? 'queued' : 'blocked'); } catch (e) { cb('blocked: ' + e.name); } });
  later('form post', function (cb) { try { var f = document.createElement('form'); f.action = '${out}/form'; f.method = 'post'; f.target = '_blank'; document.body.appendChild(f); f.submit(); cb('called'); } catch (e) { cb('blocked: ' + e.name); } });
  attempt('webrtc', function () { return new RTCPeerConnection() && 'created'; });
  var l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = '${out}'; document.head.appendChild(l);
  var p = document.createElement('link'); p.rel = 'preconnect'; p.href = '${out}'; document.head.appendChild(p);
</script>`;

// WebRTC from inside a child frame: a new document, where the frame's own cleanup has not run.
const RTC_CODE = `top.postMessage({ type: 'nested' }, '*'); var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stun.address().port}' }] }); pc.createDataChannel('x'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });`;
const child = "<script>" + RTC_CODE.replace(/'/g, "\\'") + "<\\/script>";
const WEBRTC = `<script>
  var note = {};
  try { var a = document.createElement('iframe'); document.body.appendChild(a); note.blank = typeof a.contentWindow.RTCPeerConnection; } catch (e) { note.blank = 'blocked: ' + e.name; }
  var b = document.createElement('iframe'); b.srcdoc = '${child}'; document.body.appendChild(b);
  var host = document.createElement('div'); document.body.appendChild(host);
  var c = document.createElement('iframe'); c.srcdoc = '${child}'; host.attachShadow({ mode: 'closed' }).appendChild(c);
  setTimeout(function () { note.left = document.querySelectorAll('iframe').length; parent.postMessage({ type: 'probe', rows: note }, '*'); }, 2500);
</script>`;
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const main = await inFrame(CORPUS, 5000);
const rows = main.messages.find((m) => m?.type === 'probe')?.rows ?? {};
check('the frame runs the code it is handed', Object.keys(rows).length > 0, JSON.stringify(main.messages.map((m) => m?.type)));
check('its origin is opaque', rows.origin === 'null' && main.origin === 'null', `location.origin ${rows.origin}, message origin ${main.origin}`);
for (const k of ['cookie', 'localStorage', 'sessionStorage', 'parent.document', 'top.location.href', 'set top.location', 'window.open', 'webrtc']) check(`${k} is out of reach`, String(rows[k]).startsWith('blocked'), rows[k]);
for (const k of ['fetch own api', 'fetch outside', 'image outside', 'image own host', 'script outside', 'stylesheet outside', 'websocket']) check(`${k} does not load`, String(rows[k]).startsWith('blocked'), rows[k]);
check('the page stayed where it was', (await evaluate('location.href')) === pageUrl);

// The frame navigating itself: to another site (must not go), and to this host's API (must not carry the session).
const before = seen.length;
const away = await inFrame(`<script>setTimeout(function () { location.href = '${out}/navigate?secret=1'; }, 50);</script>`);
const refresh = await inFrame(`<meta http-equiv="refresh" content="0;url=${out}/refresh"><script>var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${out}/refresh2'; document.head.appendChild(m);</script>`);
const api = await inFrame(`<script>setTimeout(function () { location.href = '/api/status'; }, 50);</script>`);
await sleep(500);
const responses = seen.slice(before).filter((e) => e.method === 'Network.responseReceived').map((e) => e.params.response);
const apiResponse = responses.find((r) => r.url.endsWith('/api/status'));
check('a frame that sends itself to its own host arrives without the session', apiResponse === undefined || apiResponse.status === 401, apiResponse ? `status ${apiResponse.status}` : 'the navigation did not happen');
check('the chat window can tell a frame navigated (a second load)', away.loads + refresh.loads + api.loads >= 3, `loads: ${away.loads}, ${refresh.loads}, ${api.loads}`);

await sleep(1500);
check('nothing reached the other site', hits.length === 0, hits.join(', '));
check('no datagram left through WebRTC used directly', datagrams === 0, `${datagrams} datagram(s)`);
check('the page still is where it was', (await evaluate('location.href')) === pageUrl);

// What the sandbox page itself says, and that opening it directly changes nothing.
const head = await fetch(`${base}/widget-frame.html`);
const csp = head.headers.get('content-security-policy') ?? '';
check('the frame is served with a sandbox and no network', csp.startsWith('sandbox allow-scripts;') && csp.includes("default-src 'none'") && csp.includes("connect-src 'none'") && !/allow-same-origin|allow-forms|allow-popups|allow-top-navigation/.test(csp), csp);
await cdp('Page.navigate', { url: `${base}/widget-frame.html` });
await sleep(800);
const direct = await evaluate(`(() => { try { return 'cookie readable: ' + document.cookie; } catch (e) { return 'blocked: ' + e.name; } })() + ' / origin ' + self.origin`);
check('opened directly, it is still sandboxed', direct.startsWith('blocked') && direct.endsWith('origin null'), direct);

console.log(`\nbrowser: ${(await send('Browser.getVersion')).product}`);
console.log('not covered here: a DNS lookup made by dns-prefetch (it leaves no HTTP request to observe), and a nested frame inside a closed shadow tree made by the HTML parser, which the frame cannot see to remove.');
clearInterval(follow);
ws.close();
browser.kill();
canary.close();
stun.close();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
process.exit(checks.every(Boolean) ? 0 : 1);
