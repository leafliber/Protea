import crypto from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ControlRole } from '@protea/protocol';
import { AccountError, SESSION_TTL_MS, setupCodeMatches, tokenFingerprint, type AccountRole, type AccountStore } from '@protea/core';

/** The console's session cookie (HttpOnly, SameSite=Strict); its value is a random session key. */
export const SESSION_COOKIE = 'protea_session';
/** Cookie-authenticated writes must carry this header; a cross-site form cannot set it. */
export const CSRF_HEADER = 'x-protea-csrf';

export interface AuthSettings {
  adminToken: string;
  /** Optional token that may only read (monitoring panels); null when not configured. */
  readonlyToken?: string | null;
}

export interface AuthDeps {
  /** API tokens (Bearer), read on every request so they can change. */
  tokens: () => AuthSettings;
  accounts: AccountStore;
  /** The pending setup code (null once an admin account exists), and what to do once it is used. */
  setup?: { code: () => string | null; complete: (username: string) => void };
}

export interface Principal {
  role: ControlRole;
  via: 'bearer' | 'cookie';
  /** The signed-in account (cookie sessions started with a password). */
  username?: string;
  /** The session cookie value (cookie callers). */
  session?: string;
}

function digest(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

function same(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function tokenRole(s: AuthSettings, token: string): ControlRole | null {
  if (same(token, s.adminToken)) return 'admin';
  if (s.readonlyToken && same(token, s.readonlyToken)) return 'readonly';
  return null;
}

/** Resolve the caller from `Authorization: Bearer` or the session cookie (raw header values). */
export function authenticate(d: AuthDeps, authorization: string | undefined, cookieValue: string | undefined): Principal | null {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
  if (bearer) {
    const role = tokenRole(d.tokens(), bearer);
    return role ? { role, via: 'bearer' } : null;
  }
  if (!cookieValue) return null;
  const s = d.accounts.session(cookieValue);
  if (!s) return null;
  if (s.via === 'token') {
    // A token sign-in lasts as long as that token: rotating it ends those sessions.
    const t = d.tokens();
    const current = s.role === 'admin' ? t.adminToken : t.readonlyToken;
    if (!current || s.tokenFp !== tokenFingerprint(current)) {
      d.accounts.endSession(cookieValue);
      return null;
    }
  }
  return { role: s.role, via: 'cookie', session: cookieValue, ...(s.account ? { username: s.account.username } : {}) };
}

/** Who did something, for the audit log and "paused by": console:<user> | console:<role> | api:<role>. */
export function actorOf(p: Principal): string {
  return p.via === 'cookie' ? `console:${p.username ?? p.role}` : `api:${p.role}`;
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
const ADMIN_ONLY = [/^\/api\/sessions\/[^/]+\/context$/, /^\/api\/memory(\/|$)/, /^\/api\/persona(\/|$)/, /^\/api\/secrets(\/|$)/, /^\/api\/diagnostics(\/|$)/, /^\/api\/accounts(\/|$)/];

function deny(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429, code: string, message: string) {
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
export function requireAuth(d: AuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const p = authenticate(d, c.req.header('authorization'), getCookie(c, SESSION_COOKIE));
    if (!p) return deny(c, 401, 'unauthorized', 'missing or invalid credentials');
    const read = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (p.role === 'readonly' && (!read || ADMIN_ONLY.some((re) => re.test(c.req.path)))) {
      return deny(c, 403, 'forbidden', 'a read-only account or token cannot do this');
    }
    if (p.via === 'cookie' && !read && c.req.header(CSRF_HEADER) !== '1') {
      return deny(c, 403, 'csrf', `cookie-authenticated requests must send ${CSRF_HEADER}: 1`);
    }
    c.set('principal' as never, p as never);
    await next();
  };
}

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
}

function startSession(c: Context, d: AuthDeps, o: { account: ReturnType<AccountStore['get']>; role: AccountRole; via: 'password' | 'token'; tokenFp?: string; address: string }): void {
  const value = d.accounts.createSession({
    account: o.account,
    role: o.role,
    via: o.via,
    address: o.address,
    ...(o.tokenFp ? { tokenFp: o.tokenFp } : {}),
    ...(c.req.header('user-agent') ? { userAgent: c.req.header('user-agent') as string } : {}),
  });
  setCookie(c, SESSION_COOKIE, value, { httpOnly: true, sameSite: 'Strict', path: '/', secure: isSecure(c), maxAge: Math.floor(SESSION_TTL_MS / 1000) });
}

function accountError(c: Context, err: unknown) {
  if (err instanceof AccountError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'exists' || err.code === 'last_admin' ? 409 : 400;
    return deny(c, status, err.code, err.message);
  }
  throw err;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Sign-in, sign-out, first-run setup and the caller's own password. Failed sign-ins and setup
 * attempts are rate-limited per client address (10 per minute).
 */
export function registerAuthRoutes(app: Hono, d: AuthDeps, clientAddress: (c: Context) => string): void {
  const failures = new Map<string, number[]>();
  const WINDOW_MS = 60_000;
  const MAX_FAILURES = 10;
  const limited = (addr: string): boolean => (failures.get(addr) ?? []).filter((t) => Date.now() - t < WINDOW_MS).length >= MAX_FAILURES;
  const failed = (addr: string): void => {
    const now = Date.now();
    failures.set(addr, [...(failures.get(addr) ?? []).filter((t) => now - t < WINDOW_MS), now]);
  };

  app.post('/api/auth/login', async (c) => {
    const addr = clientAddress(c);
    if (limited(addr)) return deny(c, 429, 'too_many_attempts', 'too many failed sign-ins; wait a minute');
    const b = await body(c);
    const token = str(b['token']).trim();
    if (token) {
      const role = tokenRole(d.tokens(), token);
      if (!role) {
        failed(addr);
        return deny(c, 401, 'unauthorized', 'invalid token');
      }
      failures.delete(addr);
      startSession(c, d, { account: null, role, via: 'token', tokenFp: tokenFingerprint(token), address: addr });
      return c.json({ role, via: 'cookie' });
    }
    const username = str(b['username']).trim();
    const password = str(b['password']);
    const account = username && password ? await d.accounts.verify(username, password) : null;
    if (!account) {
      failed(addr);
      return deny(c, 401, 'unauthorized', 'wrong username or password');
    }
    failures.delete(addr);
    startSession(c, d, { account, role: account.role, via: 'password', address: addr });
    return c.json({ role: account.role, via: 'cookie', username: account.username });
  });

  app.post('/api/auth/logout', (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) d.accounts.endSession(cookie);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/auth/whoami', (c) => {
    const p = authenticate(d, c.req.header('authorization'), getCookie(c, SESSION_COOKIE));
    if (!p) return deny(c, 401, 'unauthorized', 'not signed in');
    return c.json({ role: p.role, via: p.via, ...(p.username ? { username: p.username } : {}) });
  });

  // The caller's own password (read-only accounts too); other sessions of the account end.
  app.post('/api/auth/password', async (c) => {
    const p = authenticate(d, c.req.header('authorization'), getCookie(c, SESSION_COOKIE));
    if (!p) return deny(c, 401, 'unauthorized', 'not signed in');
    if (!p.username || !p.session) return deny(c, 400, 'no_account', 'only an account signed in with a password can change its password');
    if (c.req.header(CSRF_HEADER) !== '1') return deny(c, 403, 'csrf', `cookie-authenticated requests must send ${CSRF_HEADER}: 1`);
    const addr = clientAddress(c);
    if (limited(addr)) return deny(c, 429, 'too_many_attempts', 'too many failed attempts; wait a minute');
    const b = await body(c);
    if (!(await d.accounts.verify(p.username, str(b['current'])))) {
      failed(addr);
      return deny(c, 401, 'unauthorized', 'the current password is wrong');
    }
    try {
      await d.accounts.setPassword(p.username, str(b['password']), p.session);
    } catch (err) {
      return accountError(c, err);
    }
    return c.json({ ok: true });
  });

  // First run: no admin account yet. The setup code is printed at start and kept in secrets/.
  app.get('/api/setup', (c) => c.json({ required: d.accounts.setupRequired() }));

  app.post('/api/setup', async (c) => {
    if (!d.accounts.setupRequired()) return deny(c, 409, 'done', 'setup is complete; sign in instead');
    const addr = clientAddress(c);
    if (limited(addr)) return deny(c, 429, 'too_many_attempts', 'too many failed attempts; wait a minute');
    const b = await body(c);
    const stored = d.setup?.code() ?? null;
    if (!stored || !setupCodeMatches(str(b['code']), stored)) {
      failed(addr);
      return deny(c, 401, 'bad_code', 'the setup code is wrong (it is printed in the daemon log at start, and stored in secrets/PROTEA_SETUP_CODE)');
    }
    failures.delete(addr);
    let account;
    try {
      account = await d.accounts.create(str(b['username']).trim(), str(b['password']), 'admin');
    } catch (err) {
      return accountError(c, err);
    }
    d.setup?.complete(account.username);
    startSession(c, d, { account, role: 'admin', via: 'password', address: addr });
    return c.json({ role: 'admin', via: 'cookie', username: account.username }, 201);
  });
}

/** Account management for admins (behind `requireAuth`; /api/accounts is admin-only). */
export function registerAccountRoutes(app: Hono, d: AuthDeps): void {
  app.get('/api/accounts', (c) => c.json({ accounts: d.accounts.list() }));

  app.post('/api/accounts', async (c) => {
    const b = await body(c);
    const role = b['role'] === undefined ? 'admin' : b['role'];
    if (role !== 'admin' && role !== 'readonly') return deny(c, 400, 'invalid', 'role must be admin or readonly');
    const pending = d.accounts.setupRequired();
    try {
      const account = await d.accounts.create(str(b['username']).trim(), str(b['password']), role);
      // An admin created another way (an API-token session) also ends the first-run setup.
      if (pending && role === 'admin') d.setup?.complete(account.username);
      return c.json({ account }, 201);
    } catch (err) {
      return accountError(c, err);
    }
  });

  app.patch('/api/accounts/:username', async (c) => {
    const username = c.req.param('username');
    const b = await body(c);
    try {
      if (b['role'] !== undefined) {
        if (b['role'] !== 'admin' && b['role'] !== 'readonly') return deny(c, 400, 'invalid', 'role must be admin or readonly');
        d.accounts.setRole(username, b['role']);
      }
      if (b['password'] !== undefined) {
        const p = principal(c);
        await d.accounts.setPassword(username, str(b['password']), p.username === username ? p.session : undefined);
      }
      const a = d.accounts.get(username);
      return a ? c.json({ account: a }) : deny(c, 404, 'not_found', `no account ${username}`);
    } catch (err) {
      return accountError(c, err);
    }
  });

  app.delete('/api/accounts/:username', (c) => {
    try {
      d.accounts.delete(c.req.param('username'));
    } catch (err) {
      return accountError(c, err);
    }
    return c.json({ ok: true });
  });
}
