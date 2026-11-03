import crypto from 'node:crypto';
import { definePlugin, type PluginDefinition } from '@protea/plugin-sdk';
import type { HttpResponse, Level, Trigger } from '@protea/protocol';

export interface HookConfig {
  name: string;
  verify: 'github' | 'hmac-sha256' | 'token' | 'none';
  secret?: string;
  header?: string;
  allowUnsigned?: boolean;
  level?: 2 | 3 | 4;
  trigger?: Extract<Trigger, 'debounce' | 'flush' | 'piggyback' | 'store'>;
  maxTextChars?: number;
}

export interface WebhookConfig {
  hooks?: HookConfig[];
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hmacHex(secret: string, body: Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Whether the request carries a valid signature or token for this hook. */
export function verify(hook: HookConfig, headers: Record<string, string>, body: Buffer): boolean {
  const secret = hook.secret ?? '';
  switch (hook.verify) {
    case 'github': {
      const sig = headers['x-hub-signature-256'] ?? '';
      return secret !== '' && safeEqual(sig, `sha256=${hmacHex(secret, body)}`);
    }
    case 'hmac-sha256': {
      const raw = headers[(hook.header ?? 'x-signature-256').toLowerCase()] ?? '';
      const sig = raw.startsWith('sha256=') ? raw.slice(7) : raw;
      return secret !== '' && safeEqual(sig.toLowerCase(), hmacHex(secret, body));
    }
    case 'token':
      return secret !== '' && safeEqual(headers[(hook.header ?? 'x-webhook-token').toLowerCase()] ?? '', secret);
    case 'none':
      return hook.allowUnsigned === true;
  }
}

type Json = Record<string, any>;

/** A one-line, factual description of common GitHub events; null for others. */
export function describeGithub(event: string, p: Json): string | null {
  const repo = p['repository']?.['full_name'] ?? 'unknown repository';
  const who = p['sender']?.['login'] ? ` by ${p['sender']['login']}` : '';
  switch (event) {
    case 'ping':
      return `GitHub ping for ${repo}: ${p['zen'] ?? ''}`.trim();
    case 'push': {
      const commits = Array.isArray(p['commits']) ? p['commits'].length : 0;
      const head = p['head_commit']?.['message']?.split('\n')[0];
      return `GitHub push to ${p['ref'] ?? '?'} in ${repo}${who}: ${commits} commit(s)${head ? `, latest "${head}"` : ''}`;
    }
    case 'pull_request':
      return `GitHub pull request #${p['number']} ${p['action']} in ${repo}${who}: "${p['pull_request']?.['title'] ?? ''}" ${p['pull_request']?.['html_url'] ?? ''}`.trim();
    case 'issues':
      return `GitHub issue #${p['issue']?.['number']} ${p['action']} in ${repo}${who}: "${p['issue']?.['title'] ?? ''}" ${p['issue']?.['html_url'] ?? ''}`.trim();
    case 'issue_comment':
      return `GitHub comment on #${p['issue']?.['number']} in ${repo}${who}: ${String(p['comment']?.['body'] ?? '').slice(0, 500)}`;
    case 'workflow_run': {
      const r = p['workflow_run'] ?? {};
      return `GitHub workflow "${r['name'] ?? '?'}" ${p['action']} in ${repo} on ${r['head_branch'] ?? '?'}: ${r['conclusion'] ?? r['status'] ?? ''} ${r['html_url'] ?? ''}`.trim();
    }
    case 'release':
      return `GitHub release ${p['release']?.['tag_name'] ?? ''} ${p['action']} in ${repo}${who}`;
    default:
      return null;
  }
}

/**
 * Inbound webhooks (docs/10-architecture/08-event-source-plugins.md §6). The daemon forwards
 * `/hooks/<name>` here; unsigned hooks are refused unless explicitly allowed.
 */
export function createWebhookPlugin(): PluginDefinition<WebhookConfig> {
  const served = (config: WebhookConfig): HookConfig[] =>
    (config.hooks ?? []).filter((h) => h.verify !== 'none' || h.allowUnsigned === true);

  return definePlugin<WebhookConfig>({
    displayName: 'Webhooks',
    hooks: (config) => served(config).map((h) => h.name),
    start(host) {
      for (const h of host.config.hooks ?? []) {
        if (h.verify === 'none' && !h.allowUnsigned) host.log.warn(`hook ${h.name} has no verification and allowUnsigned is not set; it is disabled`);
        if (h.verify !== 'none' && !h.secret) host.log.warn(`hook ${h.name} has no secret; every request will be refused`);
      }
    },
    envPromptVars: (host) => ({ hooks: served(host.config).map((h) => `webhook.${h.name}`).join(', ') }),
    async onHttpRequest(host, req) {
      const hook = served(host.config).find((h) => h.name === req.hook);
      if (!hook) return json(404, { error: 'unknown hook' });
      if (req.method !== 'POST') return json(405, { error: 'use POST' });
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const body = Buffer.from(req.bodyBase64, 'base64');
      if (!verify(hook, headers, body)) {
        host.log.warn('webhook signature check failed', { hook: hook.name });
        return json(401, { error: 'signature check failed' });
      }
      const max = hook.maxTextChars ?? 2000;
      const contentType = headers['content-type'] ?? 'application/octet-stream';
      let payload: Json | null = null;
      if (/json/.test(contentType)) {
        try {
          payload = JSON.parse(body.toString('utf8')) as Json;
        } catch {
          return json(400, { error: 'invalid JSON' });
        }
      }
      const event = headers['x-github-event'];
      const delivery = headers['x-github-delivery'] ?? headers['x-request-id'] ?? headers['idempotency-key'];
      const described = hook.verify === 'github' && event && payload ? describeGithub(event, payload) : null;
      const raw = payload ? JSON.stringify(payload, null, 2) : body.toString('utf8');
      const preview = raw.length > max ? `${raw.slice(0, max)}\n[… ${raw.length - max} more characters]` : raw;
      const text = described
        ? `${described}\n\nPayload (truncated):\n${preview.slice(0, Math.min(max, 1000))}`
        : `Webhook ${hook.name} received ${contentType}, ${body.length} bytes${req.path ? ` at ${req.path}` : ''}:\n${preview}`;
      const level = (hook.level ?? 2) as Level;
      const r = await host.events.push({
        type: `webhook.${hook.name}`,
        ts: new Date().toISOString(),
        level,
        trigger: hook.trigger ?? (level >= 4 ? 'piggyback' : level === 3 ? 'debounce' : 'flush'),
        text,
        dedupeKey: delivery ? `delivery:${delivery}` : `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`,
        meta: { hook: hook.name, ...(event ? { event } : {}), ...(delivery ? { delivery } : {}) },
      });
      return json(202, { cursor: r.cursor, deduped: r.deduped });
    },
  });
}
