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

/** Same-origin only: the console never loads anything from elsewhere and cannot be framed. */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
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
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
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
}
