import fs from 'node:fs';
import path from 'node:path';
import type { AccountInfo, ModelRole, ProbeProviderResponse, ProviderProfileInfo, ProvidersResponse } from '@protea/protocol';
import { api, defaultDataDir, readHidden, readNewPassword, type ClientOptions } from './client.js';
import { bold, dim, green, red, yellow } from './format.js';
import type { Flags } from './ops.js';

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
const enc = encodeURIComponent;
const ROLES: ModelRole[] = ['main', 'fork', 'cheap'];

function baseUrl(f: Flags, env = process.env): string {
  return (str(f, 'url') ?? env['PROTEA_URL'] ?? 'http://127.0.0.1:7788').replace(/\/$/, '');
}

/** The pending setup code from the data directory (or PROTEA_SECRET_PROTEA_SETUP_CODE). */
function setupCode(f: Flags, env = process.env): string | null {
  const fromEnv = env['PROTEA_SECRET_PROTEA_SETUP_CODE'];
  if (fromEnv) return fromEnv.trim();
  const file = path.join(str(f, 'data-dir') ?? defaultDataDir(env), 'secrets', 'PROTEA_SETUP_CODE');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || null : null;
}

function printProfile(p: ProviderProfileInfo, view: ProvidersResponse): void {
  const m = p.profile.models;
  const models = m.main === m.fork && m.main === m.cheap ? m.main : `main ${m.main} · fork ${m.fork} · cheap ${m.cheap}`;
  const key = !p.key.required ? dim('no key') : p.key.set ? `${p.profile.apiKeySecret} ${dim(`(${p.key.source})`)}` : yellow(`${p.profile.apiKeySecret} not set`);
  console.log(`${bold(p.id)}${view.default === p.id ? green(' default') : ''} ${p.ready ? green('ready') : red('not ready')}  ${dim(p.profile.protocol)}`);
  if (p.endpoint) console.log(`  endpoint ${p.endpoint}`);
  console.log(`  models   ${models}`);
  console.log(`  key      ${key}`);
  if (p.roles.length) console.log(`  serves   ${p.roles.join(', ')}`);
  if (p.problem) console.log(`  ${red(p.problem)}`);
}

function printProbe(r: ProbeProviderResponse): number {
  if (r.ok) {
    if (r.models) for (const m of r.models) console.log(m);
    else console.log(`${green('ok')} ${r.model} ${dim(`${r.ms} ms`)}${r.reply ? ` · "${r.reply}"` : ''}`);
    return 0;
  }
  console.log(`${red('failed')} ${r.kind}${r.status ? ` (HTTP ${r.status})` : ''}: ${r.error}`);
  return 1;
}

/** A new or changed profile from the flags, starting from the saved one, a preset, or the protocol's defaults. */
function profileFromFlags(view: ProvidersResponse, id: string, f: Flags): Record<string, unknown> {
  const saved = view.profiles.find((p) => p.id === id);
  const presetId = str(f, 'preset') ?? (saved ? undefined : (view.presets.find((p) => p.id === id)?.id ?? (str(f, 'protocol') ? undefined : 'custom')));
  const preset = presetId ? view.presets.find((p) => p.id === presetId) : undefined;
  if (presetId && !preset) throw new Error(`unknown preset ${presetId} (protea providers presets)`);
  const protocol = (str(f, 'protocol') ?? preset?.protocol ?? saved?.profile.protocol ?? 'openai-chat') as keyof ProvidersResponse['defaults'];
  if (!view.defaults[protocol]) throw new Error(`unknown protocol ${protocol} (${view.protocols.map((p) => p.id).join(', ')})`);
  let p: Record<string, unknown>;
  if (saved && saved.profile.protocol === protocol && !preset) p = JSON.parse(JSON.stringify(saved.profile)) as Record<string, unknown>;
  else {
    p = JSON.parse(JSON.stringify(view.defaults[protocol])) as Record<string, unknown>;
    if (saved) p['apiKeySecret'] = saved.profile.apiKeySecret;
    else delete p['apiKeySecret'];
    if (preset) {
      p['baseUrl'] = preset.baseUrl;
      if (preset.noKey) p['apiKeySecret'] = null;
      if (preset.models) p['models'] = { ...(p['models'] as object), ...preset.models };
      if (preset.anthropic) p['anthropic'] = { ...(p['anthropic'] as object), ...preset.anthropic };
      if (preset.openai) p['openai'] = { ...(p['openai'] as object), ...preset.openai };
    }
  }
  if (str(f, 'base-url') !== undefined) p['baseUrl'] = str(f, 'base-url') || null;
  if (str(f, 'label') !== undefined) p['label'] = str(f, 'label') || null;
  if (f['no-key']) p['apiKeySecret'] = null;
  const models = { ...(p['models'] as Record<ModelRole, string>) };
  const one = str(f, 'model');
  if (one !== undefined) for (const r of ROLES) models[r] = one;
  for (const r of ROLES) if (str(f, r) !== undefined) models[r] = str(f, r) as string;
  p['models'] = models;
  return p;
}

/** setup, accounts and providers (docs/30-specs/05-control-api.md); null when `cmd` is none of them. */
export async function accountsCommand(cmd: string, sub: string | undefined, args: string[], f: Flags, client: () => ClientOptions): Promise<number | null> {
  switch (cmd) {
    case 'setup': {
      const url = baseUrl(f);
      let required: boolean;
      try {
        required = ((await (await fetch(`${url}/api/setup`)).json()) as { required: boolean }).required;
      } catch (err) {
        throw new Error(`cannot reach the daemon at ${url}: ${(err as Error).message}`);
      }
      if (!required) {
        console.log(`setup is complete: sign in at ${url}/ (accounts: protea accounts)`);
        return 0;
      }
      const code = setupCode(f);
      if (!code) throw new Error('no setup code found: point --data-dir at the daemon data directory (the code is in secrets/PROTEA_SETUP_CODE)');
      const user = str(f, 'user');
      if (!user) {
        console.log(`No admin account yet. Open ${url}/ and create one with the setup code:\n\n    ${bold(code)}\n\nor here: protea setup --user <name> (asks for the password)`);
        return 0;
      }
      const password = await readNewPassword(`password for ${user}`);
      const res = await fetch(`${url}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, username: user, password }) });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      console.log(`${green('created')} admin account ${user}; sign in at ${url}/ and add a model provider (模型) or: protea providers set …`);
      return 0;
    }
    case 'accounts': {
      const o = client();
      if (sub === undefined || sub === 'ls') {
        const { accounts } = await api<{ accounts: AccountInfo[] }>(o, 'GET', '/api/accounts');
        if (accounts.length === 0) console.log(dim('no accounts yet (protea setup)'));
        for (const a of accounts) console.log(`${a.username.padEnd(20)} ${a.role.padEnd(9)} ${dim(a.lastLoginAt ? `last sign-in ${a.lastLoginAt}` : 'never signed in')}`);
        return 0;
      }
      const user = args[0];
      if (!user) throw new Error(`accounts ${sub} needs a USERNAME`);
      if (sub === 'add') {
        const password = await readNewPassword(`password for ${user}`);
        await api(o, 'POST', '/api/accounts', { username: user, password, role: f['readonly'] ? 'readonly' : 'admin' });
        console.log(`${green('added')} ${user} (${f['readonly'] ? 'readonly' : 'admin'})`);
        return 0;
      }
      if (sub === 'passwd') {
        const password = await readNewPassword(`new password for ${user}`);
        await api(o, 'PATCH', `/api/accounts/${enc(user)}`, { password });
        console.log(`${green('changed')} the password of ${user}; its sessions were signed out`);
        return 0;
      }
      if (sub === 'role') {
        const role = args[1];
        if (role !== 'admin' && role !== 'readonly') throw new Error('accounts role <user> admin|readonly');
        await api(o, 'PATCH', `/api/accounts/${enc(user)}`, { role });
        console.log(`${user} is now ${role}`);
        return 0;
      }
      if (sub === 'rm') {
        await api(o, 'DELETE', `/api/accounts/${enc(user)}`);
        console.log(`removed ${user}`);
        return 0;
      }
      return null;
    }
    case 'providers': {
      const o = client();
      const view = await api<ProvidersResponse>(o, 'GET', '/api/providers');
      if (sub === undefined || sub === 'ls') {
        if (view.profiles.length === 0) console.log(dim('no providers yet: protea providers set <id> --preset <preset> --model <model> --key-stdin'));
        for (const p of view.profiles) printProfile(p, view);
        const roles = Object.entries(view.roles);
        if (roles.length) console.log(`roles: ${roles.map(([r, id]) => `${r} → ${id}`).join(', ')}`);
        if (!view.ready) console.log(red(`not ready: ${view.problem ?? ''}`));
        return 0;
      }
      if (sub === 'presets') {
        for (const p of view.presets) console.log(`${p.id.padEnd(22)} ${p.protocol.padEnd(17)} ${p.baseUrl ?? dim('(protocol default)')}  ${dim(p.label)}`);
        return 0;
      }
      const id = args[0];
      if (sub === 'role') {
        const role = args[0] as ModelRole;
        const target = args[1];
        if (!ROLES.includes(role) || !target) throw new Error('providers role main|fork|cheap <id|default>');
        await api(o, 'PATCH', '/api/providers', { roles: { [role]: target === 'default' ? null : target } });
        console.log(`${role} → ${target}`);
        return 0;
      }
      if (!id) throw new Error(`providers ${sub} needs a provider id`);
      if (sub === 'set') {
        const profile = profileFromFlags(view, id, f);
        const apiKey = f['key-stdin'] ? (await readHidden('API key: ')).trim() : undefined;
        if (f['key-stdin'] && !apiKey) throw new Error('empty API key');
        const next = await api<ProvidersResponse>(o, 'PUT', `/api/providers/${enc(id)}`, { profile, ...(apiKey ? { apiKey } : {}), ...(f['default'] ? { makeDefault: true } : {}) });
        const p = next.profiles.find((x) => x.id === id);
        console.log(`${green('saved')} ${id}${next.default === id ? ' (default)' : ''}`);
        if (p) printProfile(p, next);
        return 0;
      }
      if (sub === 'use') {
        await api(o, 'PATCH', '/api/providers', { default: id });
        console.log(`default provider: ${id}`);
        return 0;
      }
      if (sub === 'test' || sub === 'models') return printProbe(await api<ProbeProviderResponse>(o, 'POST', `/api/providers/${sub}`, { id }));
      if (sub === 'rm') {
        const next = await api<ProvidersResponse>(o, 'DELETE', `/api/providers/${enc(id)}`);
        console.log(`removed ${id}; default is now ${next.default ?? 'none'}`);
        return 0;
      }
      return null;
    }
  }
  return null;
}
