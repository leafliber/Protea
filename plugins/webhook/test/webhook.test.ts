import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { createWebhookPlugin } from '../src/plugin.js';

const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function setup(hooks: unknown[]) {
  const h = new FakeHost(createWebhookPlugin(), { id: 'webhook', levelCap: 2, config: { hooks } });
  hosts.push(h);
  await h.start();
  return h;
}

const sign = (secret: string, body: string) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

describe('webhook source', () => {
  it('serves only verified hooks and refuses unsigned ones unless allowed', async () => {
    const h = await setup([
      { name: 'github', verify: 'github', secret: 'gh-secret' },
      { name: 'open', verify: 'none' },
      { name: 'lab', verify: 'none', allowUnsigned: true, level: 4 },
    ]);
    expect(h.capabilities.hooks).toEqual(['github', 'lab']);
    expect((await h.http({ hook: 'open', body: '{}' })).status).toBe(404);
  });

  it('verifies GitHub signatures and describes the event', async () => {
    const h = await setup([{ name: 'github', verify: 'github', secret: 'gh-secret' }]);
    const body = JSON.stringify({
      action: 'completed',
      repository: { full_name: 'leafliber/protea' },
      workflow_run: { name: 'CI', head_branch: 'main', conclusion: 'failure', html_url: 'https://github.com/x' },
    });
    const headers = { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign('gh-secret', body) };
    const ok = await h.http({ hook: 'github', headers, body });
    expect(ok.status).toBe(202);
    expect(JSON.parse(ok.body ?? '{}')).toMatchObject({ cursor: 1, deduped: false });
    expect(h.events[0]).toMatchObject({ type: 'webhook.github', level: 2, trigger: 'flush', dedupeKey: 'delivery:d-1' });
    expect(h.events[0]?.text).toMatch(/^GitHub workflow "CI" completed in leafliber\/protea on main: failure/);
    // A redelivery is deduplicated; a forged signature is refused and stores nothing.
    expect(JSON.parse((await h.http({ hook: 'github', headers, body })).body ?? '{}').deduped).toBe(true);
    const forged = await h.http({ hook: 'github', headers: { ...headers, 'x-hub-signature-256': sign('wrong', body) }, body });
    expect(forged.status).toBe(401);
    expect(h.events).toHaveLength(1);
    expect(h.violations).toEqual([]);
  });

  it('supports generic HMAC and token hooks', async () => {
    const h = await setup([
      { name: 'alerts', verify: 'hmac-sha256', secret: 'k1', header: 'X-Sig', level: 2 },
      { name: 'notes', verify: 'token', secret: 't0k3n', level: 3 },
    ]);
    const body = 'disk almost full';
    expect((await h.http({ hook: 'alerts', headers: { 'x-sig': sign('k1', body).slice(7) }, body })).status).toBe(202);
    expect((await h.http({ hook: 'notes', headers: { 'x-webhook-token': 'nope' }, body })).status).toBe(401);
    expect((await h.http({ hook: 'notes', headers: { 'x-webhook-token': 't0k3n', 'content-type': 'text/plain' }, body: 'buy milk' })).status).toBe(202);
    expect(h.events.map((e) => [e.type, e.level, e.trigger])).toEqual([
      ['webhook.alerts', 2, 'flush'],
      ['webhook.notes', 3, 'debounce'],
    ]);
    expect(h.events[1]?.text).toBe('Webhook notes received text/plain, 8 bytes:\nbuy milk');
    expect((await h.http({ hook: 'alerts', method: 'GET', body })).status).toBe(405);
  });
});
