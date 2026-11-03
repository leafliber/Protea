import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, deepMerge, envOverlay, isoInZone, loadConfig, parseDateTime, tzOffsetMinutes } from '../src/index.js';
import { tmpDir } from './helpers.js';

describe('config', () => {
  it('maps PROTEA_ environment variables to config paths', () => {
    expect(
      envOverlay({
        PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS: '500',
        PROTEA_PROVIDERS__DEFAULT: 'echo',
        PROTEA_PROVIDERS__ANTHROPIC__FALLBACKS: 'null',
        PROTEA_ADMIN_TOKEN: 'not-a-path',
        PROTEA_SECRET__X: 'never',
      }),
    ).toEqual({ scheduler: { levels: { '1': { debounceMs: 500 } } }, providers: { default: 'echo', anthropic: { fallbacks: null } } });
  });

  it('merges objects and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] } });
  });

  it('layers defaults, file and environment, and writes a starter file', () => {
    const dir = tmpDir();
    const first = loadConfig(dir, {});
    expect(fs.existsSync(path.join(dir, 'config.yaml'))).toBe(true);
    expect(first.config.providers.anthropic.models.main).toBe('claude-opus-5-5');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'daemon:\n  timezone: Asia/Shanghai\nsession:\n  rounds: { soft: 3 }\n');
    const second = loadConfig(dir, { PROTEA_SESSION__ROUNDS__HARD: '4' });
    expect(second.config.daemon.timezone).toBe('Asia/Shanghai');
    expect(second.config.session.rounds).toEqual({ soft: 3, hard: 4 });
    expect(second.sources).toEqual(['defaults', path.join(dir, 'config.yaml'), 'environment']);
  });

  it('rejects invalid values and repairs an invalid time zone', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'daemon:\n  timezone: Mars/Olympus\n');
    const r = loadConfig(dir, {});
    expect(r.config.daemon.timezone).toBe('UTC');
    expect(r.warnings[0]).toMatch(/not a valid IANA zone/);
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'session:\n  rounds: { soft: 5, hard: 2 }\n');
    expect(() => loadConfig(dir, {})).toThrow(/rounds/);
  });
});

describe('secrets', () => {
  it('prefers the environment, then the secrets directory, and generates on demand', () => {
    const dir = tmpDir();
    const s = new SecretStore(path.join(dir, 'secrets'), { PROTEA_SECRET_A: 'from-env', B: 'plain-env' });
    expect(s.get('A')).toBe('from-env');
    expect(s.get('B')).toBe('plain-env');
    expect(s.get('C')).toBeUndefined();
    const gen = s.ensure('C');
    expect(gen.generated).toBe(true);
    expect(s.ensure('C')).toMatchObject({ value: gen.value, generated: false });
    expect(fs.statSync(gen.file).mode & 0o777).toBe(0o600);
    expect(() => s.get('../etc')).toThrow(/invalid secret name/);
  });
});

describe('time zones', () => {
  it('formats instants with the zone offset', () => {
    const t = Date.UTC(2026, 10, 3, 1, 2, 3, 456);
    expect(isoInZone(t, 'Asia/Shanghai')).toBe('2026-11-03T09:02:03+08:00');
    expect(isoInZone(t, 'UTC')).toBe('2026-11-03T01:02:03+00:00');
    expect(tzOffsetMinutes(Date.UTC(2026, 6, 1), 'America/New_York')).toBe(-240);
    expect(tzOffsetMinutes(Date.UTC(2026, 11, 1), 'America/New_York')).toBe(-300);
  });

  it('parses local times in a zone and explicit offsets as given', () => {
    expect(parseDateTime('2026-11-03T08:00', 'Asia/Shanghai')).toBe(Date.UTC(2026, 10, 3, 0, 0));
    expect(parseDateTime('2026-07-01 08:00:30', 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 12, 0, 30));
    expect(parseDateTime('2026-11-03T08:00:00Z', 'Asia/Shanghai')).toBe(Date.UTC(2026, 10, 3, 8));
    expect(parseDateTime('2026-11-03T08:00+02:00', 'UTC')).toBe(Date.UTC(2026, 10, 3, 6));
    expect(parseDateTime('tomorrow', 'UTC')).toBeNull();
  });
});
