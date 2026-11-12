import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_CODE, makeHostHarness, writeFixture } from './plugin-fixtures.js';
import { tmpDir, waitFor } from './helpers.js';

type H = ReturnType<typeof makeHostHarness>;
const open: H[] = [];
function harness(opts: Parameters<typeof makeHostHarness>[0] = {}): H {
  const h = makeHostHarness(opts);
  open.push(h);
  return h;
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function started(h: H, id = 'fx'): Promise<void> {
  await h.rescan();
  await h.host.start(id);
  expect(h.host.get(id)?.state, h.host.get(id)?.error).toBe('running');
}

describe('plugin host: sign-in', () => {
  const signInHarness = async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir, { manifest: { optionalSecrets: ['FX_TOKEN'], login: { method: 'qr' } } });
    await started(h);
    return h;
  };

  it('stores what the plugin hands over, names the owner and restarts it with the secret', async () => {
    const h = await signInHarness();
    const firstPid = h.host.get('fx')?.pid;
    expect(await h.host.loginStatus('fx')).toEqual({ state: 'idle' });
    expect(await h.host.loginStart('fx')).toEqual({ state: 'waiting', qr: 'https://example.test/qr' });
    expect(await h.host.loginSubmit('fx', '42')).toMatchObject({ message: 'got 42' });
    expect((await h.call('fx_login', { secrets: { FX_TOKEN: 'fresh-token' }, ownerSenderKey: 'fx:scanner' })).content).toBe('completed');
    await waitFor(() => h.host.get('fx')?.state === 'running' && h.host.get('fx')?.pid !== firstPid);
    expect(h.secrets.get('FX_TOKEN')).toBe('fresh-token');
    expect(h.signIns).toEqual([['fx', 'fx:scanner']]);
    expect((await h.call('fx_secret')).content).toBe('11');
    expect(await h.host.loginStatus('fx')).toEqual({ state: 'connected', account: 'fx-account' });
  });

  it('accepts login/complete only during a sign-in the host started, and only once', async () => {
    const h = await signInHarness();
    const unasked = await h.call('fx_login', { secrets: { FX_TOKEN: 'sneaky' }, ownerSenderKey: 'fx:attacker' });
    expect(unasked.is_error).toBe(true);
    expect(unasked.content).toContain('no sign-in is in progress');
    expect(h.secrets.get('FX_TOKEN')).toBeUndefined();
    expect(h.signIns).toEqual([]);
    await h.host.loginStart('fx');
    await h.host.loginCancel('fx');
    expect((await h.call('fx_login', { secrets: { FX_TOKEN: 'late' } })).content).toContain('no sign-in is in progress');
  });

  it('refuses a secret the manifest does not declare, and an empty hand-over', async () => {
    const h = await signInHarness();
    await h.host.loginStart('fx');
    expect((await h.call('fx_login', { secrets: { ADMIN_TOKEN: 'x' } })).content).toContain('secret ADMIN_TOKEN is not declared');
    expect((await h.call('fx_login', { secrets: {} })).content).toContain('at least one secret');
    expect((await h.call('fx_login', { secrets: { FX_TOKEN: 'x' }, ownerSenderKey: '*' })).content).toContain('must name one sender');
    expect(h.signIns).toEqual([]);
    expect(h.secrets.get('ADMIN_TOKEN')).toBeUndefined();
  });

  it('signs out: forgets the secret and the owner, and restarts without them', async () => {
    const h = await signInHarness();
    h.secrets.set('FX_TOKEN', 'stored-token');
    await h.host.restart('fx');
    expect((await h.call('fx_secret')).content).toBe('12');
    await h.host.logout('fx');
    expect(h.secrets.get('FX_TOKEN')).toBeUndefined();
    expect(h.signIns).toEqual([['fx', null]]);
    expect(h.host.get('fx')?.state).toBe('running');
    expect((await h.call('fx_secret')).content).toBe('0');
  });

  it('says why a sign-in cannot start', async () => {
    const h = harness();
    writeFixture(h.pluginsDir);
    writeFixture(h.pluginsDir, { id: 'fy', manifest: { login: { method: 'qr' } } });
    await h.rescan();
    expect(h.host.supportsLogin('fx')).toBe(false);
    expect(h.host.supportsLogin('fy')).toBe(true);
    await expect(h.host.loginStart('fx')).rejects.toThrow('has no sign-in');
    await expect(h.host.loginStart('fy')).rejects.toThrow('is not running');
  });
});

describe('plugin host: out-of-process plugins', () => {
  it('starts a plugin, registers its tools and answers calls over the protocol', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: { greeting: 'hi', pushOnStart: true } } } });
    writeFixture(h.pluginsDir);
    await h.rescan();
    await h.host.startAll();
    const s = h.host.get('fx');
    expect(s).toMatchObject({ state: 'running', enabled: true, origin: 'data', version: '1.0.0' });
    expect(s?.pid).toBeGreaterThan(0);
    expect(h.tools.namesOf('fx')).toEqual(['fx_config', 'fx_crash', 'fx_echo', 'fx_env', 'fx_kv', 'fx_login', 'fx_push', 'fx_secret', 'fx_slow', 'fx_version']);

    expect((await h.call('fx_echo', { text: 'ping' })).content).toBe('echo: ping');
    // The start event went through the gate and the store like any other source's.
    const ev = h.store.query({ type: 'fx.started' })[0];
    expect(ev).toMatchObject({ source: 'fx', origin: 'external', effLevel: 3, text: 'fixture v1 started' });
    // Environment prompt variables come from env/prompt.
    expect(h.host.envSources().map((e) => [e.id, e.envPromptVars()])).toEqual([['fx', { greeting: 'hi' }]]);
  });

  it('gates plugin events: owner identity is bound to the plugin, L1 needs the owner', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir);
    await started(h);
    const owner = JSON.parse((await h.call('fx_push', { text: 'from owner', senderKey: 'fx:owner' })).content) as { effectiveLevel: number };
    const stranger = JSON.parse((await h.call('fx_push', { text: 'from stranger', senderKey: 'fx:999' })).content) as { effectiveLevel: number };
    expect(owner.effectiveLevel).toBe(1);
    expect(stranger.effectiveLevel).toBe(2);
    expect(h.store.query({ type: 'fx.note', order: 'asc' }).map((e) => e.senderRole)).toEqual(['owner', 'unknown']);
  });

  it('injects only declared secrets and a minimal environment', async () => {
    const h = harness({
      env: { PROTEA_SECRET_FX_TOKEN: 'tok-123456', ANTHROPIC_API_KEY: 'sk-not-for-plugins' },
      settings: { fx: { enabled: true, config: {} } },
    });
    writeFixture(h.pluginsDir, { manifest: { secrets: ['FX_TOKEN'] } });
    await started(h);
    expect((await h.call('fx_secret')).content).toBe('10');
    const env = (await h.call('fx_env')).content.split(',');
    expect(env).toContain('FX_TOKEN');
    expect(env).toContain('PROTEA_PLUGIN_ID');
    expect(env).not.toContain('ANTHROPIC_API_KEY');
    expect(env).not.toContain('PROTEA_SECRET_FX_TOKEN');
  });

  it('refuses to start without a declared secret and keeps the operator intent', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir, { manifest: { secrets: ['FX_TOKEN'] } });
    await h.rescan();
    await h.host.startAll();
    expect(h.host.get('fx')).toMatchObject({ state: 'failed', enabled: true, error: 'secret FX_TOKEN is not set' });
  });

  it('starts without an optional secret and injects it when set', async () => {
    const without = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(without.pluginsDir, { manifest: { optionalSecrets: ['FX_TOKEN'] } });
    await started(without);
    expect((await without.call('fx_secret')).content).toBe('0');
    const withIt = harness({ env: { PROTEA_SECRET_FX_TOKEN: 'tok-123456' }, settings: { fx: { enabled: true, config: {} } } });
    writeFixture(withIt.pluginsDir, { manifest: { optionalSecrets: ['FX_TOKEN'] } });
    await started(withIt);
    expect((await withIt.call('fx_secret')).content).toBe('10');
  });

  it('rejects malformed sign-in and optional-secret declarations', async () => {
    const h = harness();
    writeFixture(h.pluginsDir, { id: 'badlogin', manifest: { login: { method: 'password' } as never, optionalSecrets: ['lower'] } });
    await h.rescan();
    expect(h.host.get('badlogin')).toMatchObject({ state: 'invalid', error: expect.stringContaining('login.method must be one of qr') });
    expect(h.host.get('badlogin')?.error).toContain('optionalSecrets must be a list of UPPER_CASE names');
  });

  it('marks invalid manifests with the reasons', async () => {
    const h = harness();
    writeFixture(h.pluginsDir, { id: 'bad', manifest: { level: 0 as never, tools: ['ab_one', 'cd_two'], runtime: { exec: 'node', inproc: true } } });
    await h.rescan();
    const s = h.host.get('bad');
    expect(s?.state).toBe('invalid');
    expect(s?.error).toContain('level must be 1-4');
    expect(s?.error).toContain('tool names must share one prefix');
    expect(s?.error).toContain('runtime.inproc is reserved');
  });

  it('disables gracefully: tools disappear at once, a running call finishes, late calls say why', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir);
    await started(h);
    const slow = h.call('fx_slow', { ms: 300 });
    await new Promise((r) => setTimeout(r, 50));
    const disabling = h.host.disable('fx');
    await waitFor(() => h.host.get('fx')?.state === 'draining');
    expect(h.tools.namesOf('fx')).toEqual([]);
    expect((await h.call('fx_echo', { text: 'late' })).content).toBe('tool fx_echo is not available (plugin fx is disabled)');
    expect((await slow).content).toBe('slept');
    await disabling;
    expect(h.host.get('fx')).toMatchObject({ state: 'stopped', enabled: false });
    expect(h.persisted).toEqual([['fx', false]]);
  });

  it('restarts a crashed plugin with backoff and replays settle notifications it missed', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir);
    await started(h);
    const pid = h.host.get('fx')?.pid;
    const pushed = JSON.parse((await h.call('fx_push', { text: 'x', level: 3, trigger: 'flush' })).content) as { cursor: number };
    process.kill(pid as number, 'SIGKILL');
    await waitFor(() => h.host.get('fx')?.state === 'crashed', 3000, 'crashed');
    expect(h.tools.namesOf('fx')).toEqual([]);
    h.store.settle([pushed.cursor], 'delivered'); // while the plugin is down
    await waitFor(() => h.host.get('fx')?.state === 'running', 10_000, 'restarted');
    expect(h.host.get('fx')?.pid).not.toBe(pid);
    expect(h.host.get('fx')?.restarts).toBe(1);
    let settled = '';
    await waitFor(() => {
      void h.call('fx_kv', { key: 'settled' }).then((r) => (settled = r.content));
      return settled.includes(`${pushed.cursor}:delivered`);
    }, 5000, 'settled replay');
    expect(h.store.query({ type: 'plugin.crashed' })[0]?.state).toBe('archived');
  });

  it('gives up after 5 crashes in a row and reports it to the main session', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: { crashAfterMs: 20 } } } });
    writeFixture(h.pluginsDir);
    await h.rescan();
    await h.host.startAll();
    await waitFor(() => h.host.get('fx')?.state === 'failed', 20_000, 'failed');
    const s = h.host.get('fx');
    expect(s?.error).toMatch(/^crashed 5 times in a row/);
    expect(s?.restarts).toBe(4);
    expect(s?.enabled).toBe(true);
    const report = h.store.query({ type: 'plugin.failed' })[0];
    expect(report).toMatchObject({ source: 'core', effLevel: 2, effTrigger: 'flush' });
    // An operator restart clears the count.
    await h.host.updateConfig('fx', {});
    await h.host.restart('fx');
    expect(h.host.get('fx')?.state).toBe('running');
  }, 30_000);

  it('treats three missed health checks as a crash', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: { hangHealth: true } } } });
    writeFixture(h.pluginsDir, { manifest: { healthcheck: { intervalMs: 60, timeoutMs: 40 } } });
    await started(h);
    await waitFor(() => h.host.get('fx')?.state === 'crashed' || (h.host.get('fx')?.restarts ?? 0) > 0, 5000, 'health crash');
  });

  it('applies hot config changes in place and reloads for x-hot:false keys', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: { greeting: 'hi' } } } });
    writeFixture(h.pluginsDir);
    await started(h);
    const pid = h.host.get('fx')?.pid;
    await h.host.updateConfig('fx', { greeting: 'hello there' });
    expect(h.host.get('fx')?.pid).toBe(pid);
    expect(JSON.parse((await h.call('fx_kv', { key: 'lastPatch' })).content)).toEqual({ greeting: 'hello there' });
    expect(h.host.envSources()[0]?.envPromptVars()).toEqual({ greeting: 'hello there' });
    await h.host.updateConfig('fx', { greeting: 'hello there', mode: 'strict' });
    expect(h.host.get('fx')?.state).toBe('running');
    expect(h.host.get('fx')?.pid).not.toBe(pid);
    expect(JSON.parse((await h.call('fx_config')).content)).toEqual({ greeting: 'hello there', mode: 'strict' });
    await expect(h.host.updateConfig('fx', { greeting: 42 })).rejects.toThrow(/invalid config for fx/);
  });

  it('lets a tool plugin load on demand, keeps a connector loaded, and switches either without a restart', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir, { manifest: { kind: 'tool' } });
    await started(h);
    const pid = h.host.get('fx')?.pid;
    expect(h.host.get('fx')?.alwaysLoad).toBe(false);
    expect(h.tools.get('fx_echo')?.deferrable).toBe(true);
    // Always load: the tools stay registered, the process keeps running.
    const rev = h.tools.revision;
    expect(h.host.setAlwaysLoad('fx', true)).toMatchObject({ alwaysLoad: true, state: 'running', pid });
    expect(h.tools.get('fx_echo')?.deferrable).toBeUndefined();
    expect(h.tools.revision).toBeGreaterThan(rev);
    expect((await h.call('fx_echo', { text: 'still here' })).content).toBe('echo: still here');
    // Back to the kind's default through the config file (hot reload).
    await h.host.applySettings('fx', { enabled: true, config: {} });
    expect(h.host.get('fx')?.alwaysLoad).toBe(false);
    expect(h.tools.get('fx_echo')?.deferrable).toBe(true);
    // A restart registers the tools again with the same choice.
    h.host.setAlwaysLoad('fx', true);
    await h.host.reload('fx');
    expect(h.tools.get('fx_echo')?.deferrable).toBeUndefined();
  });

  it('keeps a connector’s tools loaded unless it is set to load on demand', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir);
    await started(h);
    expect(h.host.get('fx')?.alwaysLoad).toBe(true);
    expect(h.tools.get('fx_echo')?.deferrable).toBeUndefined();
    await h.host.applySettings('fx', { enabled: true, config: {}, alwaysLoad: false });
    expect(h.host.get('fx')?.alwaysLoad).toBe(false);
    expect(h.tools.get('fx_echo')?.deferrable).toBe(true);
  });

  it('resolves ${secret:NAME} references in plugin config', async () => {
    const h = harness({ env: { PROTEA_SECRET_HOOK_KEY: 's3cret' }, settings: { fx: { enabled: true, config: { token: '${secret:HOOK_KEY}' } } } });
    writeFixture(h.pluginsDir);
    await started(h);
    expect(JSON.parse((await h.call('fx_config')).content)).toEqual({ token: 's3cret' });
  });

  it('reloads new code without restarting the daemon', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } } });
    const dir = writeFixture(h.pluginsDir);
    await started(h);
    expect((await h.call('fx_version')).content).toBe('v1');
    fs.writeFileSync(path.join(dir, 'main.mjs'), FIXTURE_CODE('v2'));
    await h.host.reload('fx');
    expect((await h.call('fx_version')).content).toBe('v2');
  });

  it('installs, discovers and uninstalls data-volume plugins', async () => {
    const h = harness();
    await h.rescan();
    const src = writeFixture(tmpDir('protea-src-'), { id: 'fx' });
    const s = await h.host.install(src);
    expect(s).toMatchObject({ id: 'fx', state: 'running', enabled: true, origin: 'data' });
    expect(fs.existsSync(path.join(h.pluginsDir, 'fx', 'protea.plugin.json'))).toBe(true);
    await expect(h.host.install(src)).rejects.toThrow(/already installed/);
    await expect(h.host.uninstall('fx')).rejects.toThrow(/must be disabled/);
    await h.host.disable('fx');
    await h.host.uninstall('fx');
    expect(h.host.get('fx')).toBeUndefined();
    expect(fs.existsSync(path.join(h.pluginsDir, 'fx'))).toBe(false);

    // A directory dropped into the volume is discovered (loaded, not started without config).
    writeFixture(h.pluginsDir, { id: 'fy', manifest: { tools: ['fy_echo'] } });
    await h.rescan();
    expect(h.host.get('fy')).toMatchObject({ state: 'loaded', enabled: false });
    fs.rmSync(path.join(h.pluginsDir, 'fy'), { recursive: true });
    await h.rescan();
    expect(h.host.get('fy')).toBeUndefined();
  });

  it('escalates to SIGTERM when a plugin ignores stop', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} } }, host: { stopTimeoutMs: 200 } });
    writeFixture(h.pluginsDir, { manifest: { runtime: { exec: 'node', args: ['main.mjs'], env: { FX_HANG_STOP: '1' } } } });
    await started(h);
    const t0 = Date.now();
    await h.host.stop('fx');
    expect(h.host.get('fx')?.state).toBe('stopped');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('I-6: a plugin crash mid-call becomes a failed receipt and leaves other plugins running', async () => {
    const h = harness({ settings: { fx: { enabled: true, config: {} }, fy: { enabled: true, config: {} } } });
    writeFixture(h.pluginsDir, { id: 'fx' });
    writeFixture(h.pluginsDir, {
      id: 'fy',
      manifest: { tools: ['fy_echo'] },
    });
    // fy reuses the fixture code, whose tools are fx_*; give it its own prefix by rewriting the names.
    const fyMain = path.join(h.pluginsDir, 'fy', 'main.mjs');
    fs.writeFileSync(fyMain, fs.readFileSync(fyMain, 'utf8').replaceAll("name: 'fx_", "name: 'fy_"));
    await h.rescan();
    await h.host.startAll();
    expect(h.host.get('fy')?.state).toBe('running');
    const slow = h.call('fx_slow', { ms: 2000 });
    await new Promise((r) => setTimeout(r, 100));
    process.kill(h.host.get('fx')?.pid as number, 'SIGKILL');
    const r = await slow;
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/^plugin fx: plugin fx exited \(SIGKILL\)/);
    expect((await h.call('fy_echo', { text: 'still here' })).content).toBe('echo: still here');
    await waitFor(() => h.host.get('fx')?.state === 'running', 10_000, 'fx restarted');
    expect((await h.call('fx_echo', { text: 'back' })).content).toBe('echo: back');
  });
});
