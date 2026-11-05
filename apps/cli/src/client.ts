import fs from 'node:fs';
import path from 'node:path';

export interface ClientOptions {
  url: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['PROTEA_DATA_DIR']) return path.resolve(env['PROTEA_DATA_DIR']);
  return fs.existsSync('/data') ? '/data' : path.resolve('protea-data');
}

/** Token from --token, PROTEA_ADMIN_TOKEN, or the data directory's secrets file. */
export function resolveClient(flags: { url?: string; token?: string; dataDir?: string }, env = process.env): ClientOptions {
  const url = (flags.url ?? env['PROTEA_URL'] ?? 'http://127.0.0.1:7788').replace(/\/$/, '');
  let token = flags.token ?? env['PROTEA_ADMIN_TOKEN'];
  if (!token) {
    const file = path.join(flags.dataDir ?? defaultDataDir(env), 'secrets', 'PROTEA_ADMIN_TOKEN');
    if (fs.existsSync(file)) token = fs.readFileSync(file, 'utf8').trim();
  }
  if (!token) throw new Error('no admin token: pass --token, set PROTEA_ADMIN_TOKEN, or point --data-dir at the daemon data directory');
  return { url, token };
}

/** JSON request; a string body with `text: true` is sent as plain text (secrets, memory and persona files). */
export async function api<T>(o: ClientOptions, method: string, p: string, body?: unknown, opts: { text?: boolean } = {}): Promise<T> {
  let res: Response;
  const plain = opts.text === true && typeof body === 'string';
  try {
    res = await fetch(`${o.url}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        ...(body !== undefined ? { 'content-type': plain ? 'text/plain; charset=utf-8' : 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: plain ? (body as string) : JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(`cannot reach the daemon at ${o.url}: ${(err as Error).message}`);
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } } | undefined)?.error?.message ?? res.statusText;
    throw new ApiError(res.status, `${method} ${p}: ${res.status} ${msg}`);
  }
  return json as T;
}

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Parse a Server-Sent Events byte stream into messages. */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const msg: SseMessage = { event: 'message', data: '' };
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') msg.event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') msg.id = value;
      }
      msg.data = data.join('\n');
      if (data.length > 0 || msg.event !== 'message') yield msg;
    }
  }
}

export async function* stream(o: ClientOptions, p: string, signal: AbortSignal): AsyncGenerator<SseMessage> {
  const res = await fetch(`${o.url}${p}`, { headers: { authorization: `Bearer ${o.token}`, accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body) throw new ApiError(res.status, `GET ${p}: ${res.status} ${res.statusText}`);
  yield* parseSse(res.body as unknown as AsyncIterable<Uint8Array>);
}

/** Read all of stdin (secret values, file contents). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A password or key: typed without echo on a terminal, or the first line of piped stdin
 * (`echo … | protea …`, `docker exec -i`).
 */
export async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return (await readStdin()).split(/\r?\n/)[0] ?? '';
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          cleanup();
          resolve(buf);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** A new password: asked twice on a terminal. */
export async function readNewPassword(what: string): Promise<string> {
  const pw = await readHidden(`${what}: `);
  if (process.stdin.isTTY) {
    const again = await readHidden('again: ');
    if (again !== pw) throw new Error('the two passwords differ');
  }
  if (!pw) throw new Error('empty password');
  return pw;
}
