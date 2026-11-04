import crypto from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ControlRole } from '@protea/protocol';

/** The console's session cookie (HttpOnly, SameSite=Strict). */
export const SESSION_COOKIE = 'protea_session';
/** Cookie-authenticated writes must carry this header; a cross-site form cannot set it. */
export const CSRF_HEADER = 'x-protea-csrf';
const COOKIE_MAX_AGE = 30 * 86_400;

export interface AuthSettings {
  adminToken: string;
  /** Optional token that may only read (monitoring panels); null when not configured. */
  readonlyToken?: string | null;
}

export interface Principal {
  role: ControlRole;
  via: 'bearer' | 'cookie';
}

function digest(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

function same(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/** The cookie value for a role: an HMAC of the token, so rotating the token ends every console session. */
function sessionValue(token: string, role: ControlRole): string {
  return `v1.${role}.${crypto.createHmac('sha256', token).update(`protea-console:${role}`).digest('base64url')}`;
}

/** Resolve the caller from `Authorization: Bearer` or the session cookie (raw header values). */
export function principalOf(s: AuthSettings, authorization: string | undefined, cookieValue: string | undefined): Principal | null {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
  if (bearer) {
    if (same(bearer, s.adminToken)) return { role: 'admin', via: 'bearer' };
    if (s.readonlyToken && same(bearer, s.readonlyToken)) return { role: 'readonly', via: 'bearer' };
    return null;
  }
  if (cookieValue) {
    if (same(cookieValue, sessionValue(s.adminToken, 'admin'))) return { role: 'admin', via: 'cookie' };
    if (s.readonlyToken && same(cookieValue, sessionValue(s.readonlyToken, 'readonly'))) return { role: 'readonly', via: 'cookie' };
  }
  return null;
}

/** Parse one cookie out of a raw Cookie header (for the WebSocket upgrade, outside Hono). */
export function cookieFrom(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Paths the read-only role may not read even with GET (docs/10-architecture/13-control-plane.md §2). */
const ADMIN_ONLY = [/^\/api\/memory(\/|$)/, /^\/api\/persona(\/|$)/, /^\/api\/secrets(\/|$)/, /^\/api\/diagnostics(\/|$)/];

function deny(c: Context, status: 401 | 403 | 429, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Who made the request (set by `requireAuth`). */
export function principal(c: Context): Principal {
  return c.get('principal' as never) as Principal;
}

/**
 * Bearer token or console cookie; read-only callers may only GET, and cookie callers must
 * send the CSRF header on anything but GET/HEAD.
 */
export function requireAuth(s: () => AuthSettings): MiddlewareHandler {
  return async (c, next) => {
    const p = principalOf(s(), c.req.header('authorization'), getCookie(c, SESSION_COOKIE));
    if (!p) return deny(c, 401, 'unauthorized', 'missing or invalid token');
    const read = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (p.role === 'readonly' && (!read || ADMIN_ONLY.some((re) => re.test(c.req.path)))) {
      return deny(c, 403, 'forbidden', 'the read-only token cannot do this');
    }
    if (p.via === 'cookie' && !read && c.req.header(CSRF_HEADER) !== '1') {
      return deny(c, 403, 'csrf', `cookie-authenticated requests must send ${CSRF_HEADER}: 1`);
    }
    c.set('principal' as never, p as never);
    await next();
  };
}

/** Login/logout for the console; failed logins are rate-limited per client address. */
export function registerAuthRoutes(app: Hono, s: () => AuthSettings, clientAddress: (c: Context) => string): void {
  const failures = new Map<string, number[]>();
  const WINDOW_MS = 60_000;
  const MAX_FAILURES = 10;

  app.post('/api/auth/login', async (c) => {
    const addr = clientAddress(c);
    const now = Date.now();
    const recent = (failures.get(addr) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_FAILURES) return deny(c, 429, 'too_many_attempts', 'too many failed logins; wait a minute');
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const p = token ? principalOf(s(), `Bearer ${token}`, undefined) : null;
    if (!p) {
      recent.push(now);
      failures.set(addr, recent);
      return deny(c, 401, 'unauthorized', 'invalid token');
    }
    failures.delete(addr);
    const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
    setCookie(c, SESSION_COOKIE, sessionValue(token, p.role), { httpOnly: true, sameSite: 'Strict', path: '/', secure, maxAge: COOKIE_MAX_AGE });
    return c.json({ role: p.role });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/auth/whoami', (c) => {
    const p = principalOf(s(), c.req.header('authorization'), getCookie(c, SESSION_COOKIE));
    return p ? c.json(p) : deny(c, 401, 'unauthorized', 'not signed in');
  });
}
