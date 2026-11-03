import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Secrets resolve from PROTEA_SECRET_<NAME>, then <NAME>, then <dataDir>/secrets/<NAME>.
 * Values never leave this class except to the component that asked for them.
 */
export class SecretStore {
  constructor(
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get(name: string): string | undefined {
    this.check(name);
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

  private check(name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`invalid secret name: ${name}`);
  }
}
