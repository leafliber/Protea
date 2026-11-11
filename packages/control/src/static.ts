import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Same-origin only: the console never loads anything from elsewhere and cannot be framed. The
 * one frame it shows is the widget sandbox below (`frame-src 'self'`), which also keeps a frame
 * from navigating itself to another site.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** The one page that may be framed, and only by the console itself. */
export const WIDGET_FRAME_PATH = '/widget-frame.html';

/**
 * The sandbox that model-written widget code runs in (docs/10-architecture/14-security-and-permissions.md §8).
 * `sandbox` without `allow-same-origin` gives the document an opaque origin, also when someone
 * opens the address directly: no cookies, no storage, and its requests to this host are
 * cross-site. `default-src 'none'` leaves it no network at all. The file itself is static and
 * holds no data; the chat window passes it the code. Do not add `allow-same-origin`, forms,
 * popups, top navigation, modals or downloads, and do not add any network source: that needs an ADR.
 */
export const WIDGET_FRAME_HEADERS: Record<string, string> = {
  'content-security-policy': [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "webrtc 'block'",
    "frame-ancestors 'self'",
  ].join('; '),
  'x-frame-options': 'SAMEORIGIN',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-dns-prefetch-control': 'off',
  'permissions-policy':
    'accelerometer=(), ambient-light-sensor=(), autoplay=(), bluetooth=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()',
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Protea</title>
<body style="font-family:system-ui;margin:3em;max-width:40em">
<h1>Protea</h1><p>The web console is not built. Build it with <code>pnpm --filter @protea/web build</code>
(or <code>pnpm build</code>), or point <code>PROTEA_WEB_DIR</code> at a built console. The control API works without it.</p>`;

/**
 * Serve the built web console (apps/web/dist) at `/`. The console routes with the URL hash,
 * so only real files are served; `/` and unknown non-API paths get index.html.
 */
export function registerConsole(app: Hono, webDir: () => string | null): void {
  const serve = (c: Context): Response => {
    const dir = webDir();
    if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) return c.html(NOT_BUILT, 200, SECURITY_HEADERS);
    const root = path.resolve(dir);
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '') || 'index.html';
    let file = path.resolve(root, rel);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, 'index.html');
    const ext = path.extname(file);
    // Only the real file gets the sandbox headers: a missing one falls back to index.html, which keeps its own.
    const frame = c.req.path === WIDGET_FRAME_PATH && path.basename(file) === 'widget-frame.html';
    const headers: Record<string, string> = {
      ...(frame ? WIDGET_FRAME_HEADERS : SECURITY_HEADERS),
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      // Vite fingerprints assets; index.html must always be revalidated.
      'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    return new Response(c.req.method === 'HEAD' ? null : fs.readFileSync(file), { status: 200, headers });
  };
  app.get('/', serve);
  app.get('/index.html', serve);
  app.get('/assets/*', serve);
  app.get('/favicon.svg', serve);
  app.get(WIDGET_FRAME_PATH, serve);
}
