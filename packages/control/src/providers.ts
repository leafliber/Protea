import type { Context, Hono } from 'hono';
import type { ModelRole, ProbeProviderRequest, ProbeProviderResponse, ProvidersResponse, PutProviderRequest } from '@protea/protocol';

/** What the daemon does for the provider routes (docs/30-specs/05-control-api.md §Providers). */
export interface ProviderOps {
  view(): ProvidersResponse;
  /** Validate, write providers.profiles.<id> to config.yaml, store or remove the key, apply. */
  put(id: string, req: PutProviderRequest): Promise<ProvidersResponse>;
  remove(id: string): Promise<ProvidersResponse>;
  /** Change providers.default and/or providers.roles (null clears a role). */
  select(req: { default?: string | null; roles?: Partial<Record<ModelRole, string | null>> }): Promise<ProvidersResponse>;
  probe(req: ProbeProviderRequest, what: 'test' | 'models'): Promise<ProbeProviderResponse>;
}

function bad(c: Context, err: unknown) {
  return c.json({ error: { code: 'invalid', message: err instanceof Error ? err.message : String(err) } }, 400);
}

async function body(c: Context): Promise<Record<string, unknown> | null> {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** /api/providers: list, save, remove, choose the default and per-role profiles, test, list models. */
export function registerProviderRoutes(app: Hono, ops: ProviderOps | undefined): void {
  const missing = (c: Context) => c.json({ error: { code: 'not_found', message: 'providers are not available' } }, 404);
  app.get('/api/providers', (c) => (ops ? c.json(ops.view()) : missing(c)));

  app.put('/api/providers/:id', async (c) => {
    if (!ops) return missing(c);
    const b = await body(c);
    if (!b || typeof b['profile'] !== 'object' || b['profile'] === null) return bad(c, new Error('body must be { profile, apiKey?, makeDefault? }'));
    const apiKey = b['apiKey'];
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') return bad(c, new Error('apiKey must be text or null'));
    try {
      return c.json(
        await ops.put(c.req.param('id'), {
          profile: b['profile'] as Record<string, unknown>,
          ...(apiKey !== undefined ? { apiKey: apiKey as string | null } : {}),
          ...(b['makeDefault'] === true ? { makeDefault: true } : {}),
        }),
      );
    } catch (err) {
      return bad(c, err);
    }
  });

  app.delete('/api/providers/:id', async (c) => {
    if (!ops) return missing(c);
    try {
      return c.json(await ops.remove(c.req.param('id')));
    } catch (err) {
      return bad(c, err);
    }
  });

  app.patch('/api/providers', async (c) => {
    if (!ops) return missing(c);
    const b = await body(c);
    if (!b) return bad(c, new Error('body must be { default?, roles? }'));
    try {
      return c.json(
        await ops.select({
          ...(b['default'] !== undefined ? { default: b['default'] as string | null } : {}),
          ...(b['roles'] !== undefined ? { roles: b['roles'] as Partial<Record<ModelRole, string | null>> } : {}),
        }),
      );
    } catch (err) {
      return bad(c, err);
    }
  });

  for (const what of ['test', 'models'] as const) {
    app.post(`/api/providers/${what}`, async (c) => {
      if (!ops) return missing(c);
      const b = await body(c);
      if (!b || typeof b['id'] !== 'string') return bad(c, new Error('body must be { id, profile?, apiKey?, role? }'));
      try {
        return c.json(
          await ops.probe(
            {
              id: b['id'],
              ...(typeof b['profile'] === 'object' && b['profile'] !== null ? { profile: b['profile'] as Record<string, unknown> } : {}),
              ...(typeof b['apiKey'] === 'string' && b['apiKey'] !== '' ? { apiKey: b['apiKey'] } : {}),
              ...(typeof b['role'] === 'string' ? { role: b['role'] as ModelRole } : {}),
            },
            what,
          ),
        );
      } catch (err) {
        return bad(c, err);
      }
    });
  }
}
