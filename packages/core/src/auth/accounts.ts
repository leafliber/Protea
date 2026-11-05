import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from '../db/database.js';

export type AccountRole = 'admin' | 'readonly';

export interface Account {
  id: number;
  username: string;
  role: AccountRole;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface AuthSession {
  role: AccountRole;
  via: 'password' | 'token';
  account: Account | null;
  /** Fingerprint of the token a token sign-in used (the session ends when the token changes). */
  tokenFp: string | null;
  createdAt: string;
  expiresAt: string;
}

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
/** Console sessions last 30 days from sign-in. */
export const SESSION_TTL_MS = 30 * 86_400_000;

// scrypt: N = 2^15, r = 8 (32 MiB, about 0.1 s): costly to guess offline, cheap enough for a sign-in.
const SCRYPT = { N: 32_768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

export class AccountError extends Error {
  override readonly name = 'AccountError';
  constructor(
    readonly code: 'invalid' | 'exists' | 'not_found' | 'last_admin',
    message: string,
  ) {
    super(message);
  }
}

/** "scrypt$N$r$p$salt$hash" (base64url), so the cost can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

export function checkUsername(username: string): void {
  if (!USERNAME_RE.test(username)) throw new AccountError('invalid', 'a username is 1–32 letters, digits, ".", "_" or "-", starting with a letter or digit');
}

export function checkPassword(password: string): void {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw new AccountError('invalid', `a password has at least ${MIN_PASSWORD} characters`);
  if (password.length > MAX_PASSWORD) throw new AccountError('invalid', `a password has at most ${MAX_PASSWORD} characters`);
}

/** Session cookies carry a random value; the database keeps only its hash. */
function sessionKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** A fingerprint of an API token (sessions started with it end when it changes). */
export function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(`protea-token:${token}`).digest('hex').slice(0, 32);
}

interface AccountRow {
  id: number;
  username: string;
  password: string;
  role: AccountRole;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

function toAccount(r: AccountRow): Account {
  return { id: r.id, username: r.username, role: r.role, createdAt: r.created_at, updatedAt: r.updated_at, lastLoginAt: r.last_login_at };
}

/**
 * Console accounts (username, scrypt password hash, role) and their sign-in sessions, in the
 * daemon's SQLite database. The first admin account is created with the setup code
 * (docs/10-architecture/13-control-plane.md §2).
 */
export class AccountStore {
  /** A hash to compare against when the username is unknown, so both cases take as long. */
  private dummy: Promise<string> | null = null;
  private lastPrune = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  count(role?: AccountRole): number {
    const r = (role
      ? this.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE role = ?').get(role)
      : this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get()) as { n: number };
    return r.n;
  }

  /** No admin account yet: the console offers the setup page. */
  setupRequired(): boolean {
    return this.count('admin') === 0;
  }

  list(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY username').all() as AccountRow[]).map(toAccount);
  }

  get(username: string): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow | undefined;
    return r ? toAccount(r) : null;
  }

  async create(username: string, password: string, role: AccountRole): Promise<Account> {
    checkUsername(username);
    checkPassword(password);
    if (role !== 'admin' && role !== 'readonly') throw new AccountError('invalid', 'role must be admin or readonly');
    if (this.get(username)) throw new AccountError('exists', `account ${username} already exists`);
    const hash = await hashPassword(password);
    const at = this.iso();
    try {
      this.db.prepare('INSERT INTO accounts (username, password, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(username, hash, role, at, at);
    } catch (err) {
      if (/UNIQUE/.test(String(err))) throw new AccountError('exists', `account ${username} already exists`);
      throw err;
    }
    return this.get(username) as Account;
  }

  /** The account when the password matches; null otherwise (unknown users take as long). */
  async verify(username: string, password: string): Promise<Account | null> {
    const r = USERNAME_RE.test(username) ? (this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow | undefined) : undefined;
    if (!r) {
      this.dummy ??= hashPassword(crypto.randomBytes(12).toString('hex'));
      await verifyPassword(password, await this.dummy);
      return null;
    }
    if (!(await verifyPassword(password, r.password))) return null;
    this.db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(this.iso(), r.id);
    return toAccount({ ...r, last_login_at: this.iso() });
  }

  /** Set a new password; every session of the account ends except `keepSession` (the caller's own). */
  async setPassword(username: string, password: string, keepSession?: string): Promise<void> {
    checkPassword(password);
    const a = this.get(username);
    if (!a) throw new AccountError('not_found', `no account ${username}`);
    const hash = await hashPassword(password);
    this.db.prepare('UPDATE accounts SET password = ?, updated_at = ? WHERE id = ?').run(hash, this.iso(), a.id);
    if (keepSession) this.db.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND id != ?').run(a.id, sessionKey(keepSession));
    else this.db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(a.id);
  }

  setRole(username: string, role: AccountRole): Account {
    const a = this.get(username);
    if (!a) throw new AccountError('not_found', `no account ${username}`);
    if (a.role === 'admin' && role !== 'admin' && this.count('admin') <= 1) throw new AccountError('last_admin', 'the last admin account cannot lose its role');
    this.db.prepare('UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?').run(role, this.iso(), a.id);
    this.db.prepare('UPDATE auth_sessions SET role = ? WHERE account_id = ?').run(role, a.id);
    return this.get(username) as Account;
  }

  /** Delete an account and its sessions; the last admin stays. */
  delete(username: string): void {
    const a = this.get(username);
    if (!a) throw new AccountError('not_found', `no account ${username}`);
    if (a.role === 'admin' && this.count('admin') <= 1) throw new AccountError('last_admin', 'the last admin account cannot be deleted');
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
  }

  /** Start a console session; returns the cookie value. */
  createSession(o: { account: Account | null; role: AccountRole; via: 'password' | 'token'; tokenFp?: string; address?: string; userAgent?: string }): string {
    const token = `v2.${crypto.randomBytes(32).toString('base64url')}`;
    const at = this.now();
    this.db
      .prepare('INSERT INTO auth_sessions (id, account_id, role, via, token_fp, created_at, expires_at, last_seen_at, address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionKey(token), o.account?.id ?? null, o.role, o.via, o.tokenFp ?? null, this.iso(at), this.iso(at + SESSION_TTL_MS), this.iso(at), o.address ?? null, o.userAgent?.slice(0, 200) ?? null);
    this.prune();
    return token;
  }

  /** The live session behind a cookie value, or null (unknown, expired, or its account is gone). */
  session(token: string): AuthSession | null {
    if (!token.startsWith('v2.')) return null;
    const r = this.db
      .prepare(
        `SELECT s.role AS s_role, s.via, s.token_fp, s.created_at AS s_created, s.expires_at, s.last_seen_at, s.account_id, a.*
         FROM auth_sessions s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`,
      )
      .get(sessionKey(token)) as (AccountRow & { s_role: AccountRole; via: 'password' | 'token'; token_fp: string | null; s_created: string; expires_at: string; last_seen_at: string; account_id: number | null }) | undefined;
    if (!r) return null;
    const now = this.now();
    if (Date.parse(r.expires_at) <= now || (r.via === 'password' && r.account_id === null)) {
      this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionKey(token));
      return null;
    }
    if (now - Date.parse(r.last_seen_at) > 60_000) this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(this.iso(now), sessionKey(token));
    return {
      role: r.s_role,
      via: r.via,
      account: r.account_id !== null && r.id !== null ? toAccount(r) : null,
      tokenFp: r.token_fp,
      createdAt: r.s_created,
      expiresAt: r.expires_at,
    };
  }

  endSession(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionKey(token));
  }

  private prune(): void {
    const now = this.now();
    if (now - this.lastPrune < 3_600_000) return;
    this.lastPrune = now;
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(this.iso(now));
  }
}

const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U

/** A one-time setup code: four groups of four characters (about 78 bits), e.g. K7QM-2XRP-9HTD-WB4C. */
export function newSetupCode(): string {
  const chars = Array.from({ length: 16 }, () => SETUP_ALPHABET[crypto.randomInt(SETUP_ALPHABET.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** Compare a typed setup code with the stored one (case, spaces and dashes do not matter). */
export function setupCodeMatches(typed: string, stored: string): boolean {
  const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const a = crypto.createHash('sha256').update(norm(typed)).digest();
  const b = crypto.createHash('sha256').update(norm(stored)).digest();
  return crypto.timingSafeEqual(a, b) && norm(stored).length > 0;
}
