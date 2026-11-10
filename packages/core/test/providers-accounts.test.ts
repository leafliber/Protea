import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  AccountError,
  AccountStore,
  ProviderRouter,
  ScriptedProvider,
  compactProfile,
  createProvider,
  defaultProfile,
  hashPassword,
  loadConfig,
  migrateLegacyProviders,
  newSetupCode,
  normalizeProviderProfile,
  normalizeProviders,
  openDatabase,
  providerKeySecretName,
  replaceConfigValue,
  SecretStore,
  setupCodeMatches,
  textReply,
  verifyPassword,
  type ProvidersSettings,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

describe('provider profiles', () => {
  it('fills a profile from its protocol defaults; OpenAI-style fork and cheap fall back to main', () => {
    const p = normalizeProviderProfile('deepseek', { protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1/', models: { main: 'deepseek-chat' } });
    expect(p).toMatchObject({ protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', apiKeySecret: 'PROVIDER_DEEPSEEK_API_KEY', maxOutputTokens: 8192 });
    expect(p.models).toEqual({ main: 'deepseek-chat', fork: 'deepseek-chat', cheap: 'deepseek-chat', judge: 'deepseek-chat' });
    const claude = normalizeProviderProfile('claude', { protocol: 'anthropic' });
    expect(claude.models).toEqual({ main: 'claude-opus-5-5', fork: 'claude-sonnet-5-5', cheap: 'claude-haiku-5-5', judge: 'claude-opus-5-5' });
    expect(claude.anthropic.features).toBe('full');
    expect(providerKeySecretName('my-local')).toBe('PROVIDER_MY_LOCAL_API_KEY');
  });

  it('rejects bad ids, protocols, URLs and secret names', () => {
    expect(() => normalizeProviderProfile('Bad Id', {})).toThrow(/profile id/);
    expect(() => normalizeProviderProfile('x', { protocol: 'grpc' })).toThrow(/protocol must be one of/);
    expect(() => normalizeProviderProfile('x', { protocol: 'openai-chat', baseUrl: 'ftp://h' })).toThrow(/http\(s\) URL/);
    expect(() => normalizeProviderProfile('x', { apiKeySecret: 'lower' })).toThrow(/secret name/);
    expect(() => normalizeProviders({ default: 'missing', roles: {}, profiles: {} })).toThrow(/no profile "missing"/);
    expect(() => normalizeProviders({ default: null, roles: { main: 'nope' }, profiles: {} } as ProvidersSettings)).toThrow(/providers.roles.main/);
  });

  it('keeps only what differs from the defaults, plus protocol and models', () => {
    const full = normalizeProviderProfile('local', { protocol: 'openai-chat', baseUrl: 'http://h:1/v1', apiKeySecret: null, models: { main: 'q' }, openai: { reasoningEffort: true } });
    const compact = compactProfile('local', full);
    expect(compact).toEqual({ protocol: 'openai-chat', baseUrl: 'http://h:1/v1', apiKeySecret: null, models: { main: 'q', fork: 'q', cheap: 'q' }, openai: { reasoningEffort: true } });
    expect(normalizeProviderProfile('local', compact)).toEqual(full);
  });

  it('has a built-in echo profile and no provider by default', () => {
    const dir = tmpDir();
    expect(loadConfig(dir, {}).config.providers).toEqual({ default: null, roles: {}, profiles: {} });
    const echo = loadConfig(dir, { PROTEA_PROVIDERS__DEFAULT: 'echo' }).config.providers;
    expect(echo.default).toBe('echo');
    expect(echo.profiles['echo']).toMatchObject({ protocol: 'echo', apiKeySecret: null });
  });

  it('replaces a profile as a whole, validating first', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), '# my notes\nproviders:\n  default: a\n  profiles:\n    a: { protocol: openai-chat, models: { main: m1 }, openai: { reasoningEffort: true } }\n');
    replaceConfigValue(dir, ['providers', 'profiles', 'a'], { protocol: 'openai-chat', models: { main: 'm2' } }, {});
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect(text).toContain('# my notes');
    expect(loadConfig(dir, {}).config.providers.profiles['a']).toMatchObject({ models: { main: 'm2' }, openai: { reasoningEffort: false } });
    expect(() => replaceConfigValue(dir, ['providers', 'profiles', 'a'], undefined, {})).toThrow(/no profile "a"/);
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe(text);
  });
});

describe('the layout before provider profiles', () => {
  it('is read as profiles, and rewritten at start with the key file renamed', () => {
    const dir = tmpDir();
    const secrets = path.join(dir, 'secrets');
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, 'ANTHROPIC_API_KEY'), 'sk-ant-old\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), '# keep me\nproviders:\n  anthropic:\n    models: { main: claude-fable-5-1 }\n    fallbacks: null\nbudget:\n  dailyUsd: 5\n');
    const before = loadConfig(dir, {});
    expect(before.warnings.some((w) => w.includes('layout before provider profiles'))).toBe(true);
    expect(before.config.providers.default).toBe('anthropic');
    expect(before.config.providers.profiles['anthropic']).toMatchObject({ apiKeySecret: 'ANTHROPIC_API_KEY', models: { main: 'claude-fable-5-1' }, anthropic: { fallbacks: null } });

    expect(migrateLegacyProviders(dir, secrets)).toEqual(['providers moved to the profile layout (providers.profiles)', 'secret ANTHROPIC_API_KEY renamed to PROVIDER_ANTHROPIC_API_KEY']);
    expect(fs.existsSync(path.join(secrets, 'PROVIDER_ANTHROPIC_API_KEY'))).toBe(true);
    expect(fs.existsSync(path.join(secrets, 'ANTHROPIC_API_KEY'))).toBe(false);
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect(text).toContain('# keep me');
    const doc = YAML.parse(text) as { providers: Record<string, unknown>; budget: unknown };
    expect(doc.providers).toEqual({ default: 'anthropic', profiles: { anthropic: { protocol: 'anthropic', models: { main: 'claude-fable-5-1' }, anthropic: { fallbacks: null } } } });
    expect(doc.budget).toEqual({ dailyUsd: 5 });
    const after = loadConfig(dir, {});
    expect(after.warnings).toEqual([]);
    expect(after.config.providers.profiles['anthropic']?.apiKeySecret).toBe('PROVIDER_ANTHROPIC_API_KEY');
    expect(migrateLegacyProviders(dir, secrets)).toEqual([]);
  });

  it('gives a data volume with only the old key file an anthropic profile', () => {
    const dir = tmpDir();
    const secrets = path.join(dir, 'secrets');
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, 'ANTHROPIC_API_KEY'), 'sk-ant-old\n');
    expect(migrateLegacyProviders(dir, secrets)).toHaveLength(2);
    expect(loadConfig(dir, {}).config.providers).toMatchObject({ default: 'anthropic', profiles: { anthropic: { protocol: 'anthropic', apiKeySecret: 'PROVIDER_ANTHROPIC_API_KEY' } } });
  });
});

describe('ProviderRouter', () => {
  const settings = (over: Partial<ProvidersSettings> = {}): ProvidersSettings =>
    normalizeProviders({
      default: 'big',
      roles: { cheap: 'small' },
      profiles: { big: { protocol: 'openai-chat', apiKeySecret: null, models: { main: 'big-1' } }, small: { protocol: 'echo' } } as never,
      ...over,
    });

  it('routes each role to its profile and reports the profile that served', async () => {
    let s = settings();
    const built: string[] = [];
    const router = new ProviderRouter(
      () => s,
      (id, p) => {
        built.push(id);
        return new ScriptedProvider([() => textReply(`${id}:${p.models.main}`)]);
      },
    );
    expect(router.profileFor('main')).toBe('big');
    expect(router.profileFor('cheap')).toBe('small');
    const r = await router.generate({ role: 'cheap', system: [], messages: [], tools: [], effort: 'low' }, { signal: AbortSignal.timeout(1000) });
    expect(r.provider).toBe('small');
    expect(router.effort('main', 1)).toBe('medium');
    expect(router.maxOutputTokens('main')).toBe(8192);
    expect(router.health()).toEqual({ ready: true });
    router.health();
    expect(built.filter((b) => b === 'big')).toHaveLength(1); // built once while the settings stay
    s = settings({ profiles: { ...s.profiles, big: normalizeProviderProfile('big', { protocol: 'openai-chat', apiKeySecret: null, models: { main: 'big-2' } }) } });
    router.health();
    expect(built.filter((b) => b === 'big')).toHaveLength(2); // rebuilt after a change
  });

  it('is not ready without a provider, and names the missing key or model', () => {
    const dir = tmpDir();
    const secrets = new SecretStore(dir, {});
    let s: ProvidersSettings = { default: null, roles: {}, profiles: {} };
    const router = createProvider(() => s, secrets);
    expect(router.health()).toMatchObject({ ready: false, problem: expect.stringContaining('no model provider is configured') });
    expect(router.modelFor('main')).toBe('none');
    s = normalizeProviders({ default: 'x', roles: {}, profiles: { x: { protocol: 'openai-chat', models: { main: '' } } } as never });
    expect(router.health()).toEqual({ ready: false, problem: 'no model set for main, fork, cheap' });
    s = normalizeProviders({ default: 'x', roles: {}, profiles: { x: { protocol: 'openai-chat', models: { main: 'm' } } } as never });
    expect(router.health()).toEqual({ ready: false, problem: 'secret PROVIDER_X_API_KEY is not set' });
    secrets.set('PROVIDER_X_API_KEY', 'sk-123456');
    router.refresh();
    expect(router.health()).toEqual({ ready: true });
    expect(defaultProfile('echo').apiKeySecret).toBeNull();
  });
});

describe('accounts', () => {
  const store = () => {
    const { db } = openDatabase(path.join(tmpDir(), 'protea.db'));
    return new AccountStore(db);
  };

  it('hashes passwords with scrypt and verifies them', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong horse', h)).toBe(false);
  });

  it('creates accounts, signs in, and keeps the last admin', async () => {
    const a = store();
    expect(a.setupRequired()).toBe(true);
    await a.create('owner', 'long enough', 'admin');
    expect(a.setupRequired()).toBe(false);
    await expect(a.create('Owner', 'another one', 'admin')).rejects.toBeInstanceOf(AccountError); // usernames ignore case
    await expect(a.create('x y', 'long enough', 'admin')).rejects.toThrow(/username/);
    await expect(a.create('viewer', 'short', 'readonly')).rejects.toThrow(/at least 8/);
    await a.create('viewer', 'viewer-pass', 'readonly');
    expect(await a.verify('owner', 'nope nope')).toBeNull();
    expect(await a.verify('ghost', 'whatever!')).toBeNull();
    expect((await a.verify('OWNER', 'long enough'))?.username).toBe('owner');
    expect(() => a.delete('owner')).toThrow(/last admin/);
    expect(() => a.setRole('owner', 'readonly')).toThrow(/last admin/);
    a.delete('viewer');
    expect(a.list().map((x) => x.username)).toEqual(['owner']);
  });

  it('keeps sessions server-side; a new password ends the other sessions', async () => {
    const a = store();
    const owner = await a.create('owner', 'long enough', 'admin');
    const s1 = a.createSession({ account: owner, role: 'admin', via: 'password' });
    const s2 = a.createSession({ account: owner, role: 'admin', via: 'password' });
    expect(s1).toMatch(/^v2\./);
    expect(a.session(s1)?.account?.username).toBe('owner');
    await a.setPassword('owner', 'a new password', s1);
    expect(a.session(s1)).not.toBeNull();
    expect(a.session(s2)).toBeNull();
    a.endSession(s1);
    expect(a.session(s1)).toBeNull();
    expect(a.session('v1.admin.forged')).toBeNull();
  });

  it('expires sessions after 30 days', async () => {
    let now = Date.parse('2026-11-05T00:00:00Z');
    const { db } = openDatabase(path.join(tmpDir(), 'protea.db'));
    const a = new AccountStore(db, () => now);
    const owner = await a.create('owner', 'long enough', 'admin');
    const s = a.createSession({ account: owner, role: 'admin', via: 'password' });
    now += 29 * 86_400_000;
    expect(a.session(s)).not.toBeNull();
    now += 2 * 86_400_000;
    expect(a.session(s)).toBeNull();
  });

  it('makes setup codes that ignore case and dashes when typed', () => {
    const code = newSetupCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(setupCodeMatches(code.toLowerCase().replace(/-/g, ' '), code)).toBe(true);
    expect(setupCodeMatches('AAAA-BBBB-CCCC-DDDD', code)).toBe(false);
    expect(setupCodeMatches('', '')).toBe(false);
  });
});
