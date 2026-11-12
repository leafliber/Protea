/** A request the plugin made, as the fake Open API saw it. */
export interface Call {
  method: string;
  /** Path below `/open/v1`. */
  path: string;
  query: Record<string, string>;
  body: unknown;
  auth: string | null;
}

type Reply = (call: Call) => unknown;

/**
 * The Dida365 Open API in memory: routes answer with JSON (or a `Response` for anything else),
 * and every request is recorded. Unknown routes answer 404, like the real service.
 */
export class FakeDida {
  readonly calls: Call[] = [];
  private readonly routes: Array<{ method: string; path: string | RegExp; reply: Reply }> = [];

  on(method: 'GET' | 'POST' | 'DELETE', path: string | RegExp, reply?: Reply | object): this {
    this.routes.unshift({ method, path, reply: typeof reply === 'function' ? (reply as Reply) : () => reply });
    return this;
  }

  /** The requests to one route, oldest first. */
  to(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/open\/v1/, ''),
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    };
    this.calls.push(call);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const route = this.routes.find((r) => r.method === call.method && (typeof r.path === 'string' ? r.path === call.path : r.path.test(call.path)));
    if (!route) return new Response('', { status: 404 });
    const out = await route.reply(call);
    if (out instanceof Response) return out;
    return out === undefined ? new Response('', { status: 200 }) : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

export const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 't1', projectId: 'p1', title: 'Write the report', status: 0, priority: 0, ...over });
