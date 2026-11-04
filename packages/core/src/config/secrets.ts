import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Secrets resolve from PROTEA_SECRET_<NAME>, then <NAME>, then <dataDir>/secrets/<NAME>.
 * Values never leave this class except to the component that asked for them.
 */
export class SecretStore {
  /** Names looked up so far; their values are redacted even when they came from plain env vars. */
  private readonly seen = new Set<string>();
  /** knownValues() is read for every log line; re-read the directory at most this often. */
  private cached: { at: number; values: Array<{ name: string; value: string }> } | null = null;

  constructor(
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get(name: string): string | undefined {
    this.check(name);
    if (!this.seen.has(name)) this.cached = null;
    this.seen.add(name);
    const fromEnv = this.env[`PROTEA_SECRET_${name}`] ?? this.env[name];
    if (fromEnv) return fromEnv.trim();
    const file = path.join(this.dir, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim() || undefined;
    return undefined;
  }

  set(name: string, value: string): void {
    this.check(name);
    if (value.trim() === '') throw new Error('a secret value cannot be empty');
    const file = path.join(this.dir, name);
    const tmp = path.join(this.dir, `.tmp-${name}-${process.pid}`);
    fs.writeFileSync(tmp, `${value.trim()}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.cached = null;
  }

  /** Remove the stored file. A value from the environment stays in effect (and is reported). */
  delete(name: string): { removed: boolean; fromEnv: boolean } {
    this.check(name);
    const file = path.join(this.dir, name);
    const removed = fs.existsSync(file);
    if (removed) fs.rmSync(file);
    this.cached = null;
    return { removed, fromEnv: !!(this.env[`PROTEA_SECRET_${name}`] ?? (this.seen.has(name) ? this.env[name] : undefined)) };
  }

  /** Names only (never values), with where each one comes from; the environment wins over a file. */
  list(): Array<{ name: string; source: 'env' | 'file'; shadowedFile: boolean }> {
    const files = new Set(fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => NAME_RE.test(f)) : []);
    const names = new Set([...files, ...this.seen]);
    for (const k of Object.keys(this.env)) if (k.startsWith('PROTEA_SECRET_') && NAME_RE.test(k.slice(14))) names.add(k.slice(14));
    const out: Array<{ name: string; source: 'env' | 'file'; shadowedFile: boolean }> = [];
    for (const name of [...names].sort()) {
      const env = this.env[`PROTEA_SECRET_${name}`] ?? (this.seen.has(name) ? this.env[name] : undefined);
      if (env) out.push({ name, source: 'env', shadowedFile: files.has(name) });
      else if (files.has(name)) out.push({ name, source: 'file', shadowedFile: false });
    }
    return out;
  }

  /** Returns the existing value, or generates and stores a random one. */
  ensure(name: string): { value: string; generated: boolean; file: string } {
    const existing = this.get(name);
    const file = path.join(this.dir, name);
    if (existing) return { value: existing, generated: false, file };
    const value = crypto.randomBytes(24).toString('hex');
    this.set(name, value);
    return { value, generated: true, file };
  }

  /** Every secret value this store knows about, longest first (for redaction). */
  knownValues(): Array<{ name: string; value: string }> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < 2000) return this.cached.values;
    const values = this.readValues();
    this.cached = { at: now, values };
    return values;
  }

  private readValues(): Array<{ name: string; value: string }> {
    const names = new Set(this.seen);
    for (const k of Object.keys(this.env)) if (k.startsWith('PROTEA_SECRET_')) names.add(k.slice('PROTEA_SECRET_'.length));
    if (fs.existsSync(this.dir)) for (const f of fs.readdirSync(this.dir)) if (NAME_RE.test(f)) names.add(f);
    const out: Array<{ name: string; value: string }> = [];
    for (const name of names) {
      if (!NAME_RE.test(name)) continue;
      const fromEnv = this.env[`PROTEA_SECRET_${name}`] ?? this.env[name];
      const file = path.join(this.dir, name);
      const value = fromEnv?.trim() || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
      if (value.length >= 6) out.push({ name, value });
    }
    return out.sort((a, b) => b.value.length - a.value.length);
  }

  /** Replace every known secret value in `text` with `[REDACTED:<NAME>]`. */
  redact(text: string): string {
    let out = text;
    for (const { name, value } of this.knownValues()) out = out.split(value).join(`[REDACTED:${name}]`);
    return out;
  }

  /**
   * The same for a serialized JSON line (logs, crash reports): a value with quotes, backslashes
   * or control characters appears escaped there, so both spellings are replaced.
   */
  redactJsonText(text: string): string {
    let out = text;
    for (const { name, value } of this.knownValues()) {
      const mark = `[REDACTED:${name}]`;
      if (out.includes(value)) out = out.split(value).join(mark);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value && out.includes(escaped)) out = out.split(escaped).join(mark);
    }
    return out;
  }

  private check(name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`invalid secret name: ${name}`);
  }
}
