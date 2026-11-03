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

  constructor(
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get(name: string): string | undefined {
    this.check(name);
    this.seen.add(name);
    const fromEnv = this.env[`PROTEA_SECRET_${name}`] ?? this.env[name];
    if (fromEnv) return fromEnv.trim();
    const file = path.join(this.dir, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim() || undefined;
    return undefined;
  }

  set(name: string, value: string): void {
    this.check(name);
    fs.writeFileSync(path.join(this.dir, name), `${value}\n`, { mode: 0o600 });
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

  private check(name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`invalid secret name: ${name}`);
  }
}
