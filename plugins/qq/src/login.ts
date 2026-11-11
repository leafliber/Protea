import crypto from 'node:crypto';
import type { PluginLoginStatus } from '@protea/protocol';

/** `status` of poll_bind_result. A fresh task already reads PENDING, so neither 0 nor 1 means "scanned". */
const BindStatus = { NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 } as const;
const REQUEST_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 480_000;
const MAX_QR_CODES = 3;

interface BindTask {
  taskId: string;
  /** Ours, made per task: the service seals the AppSecret to it. */
  key: string;
}

interface BindPoll {
  status?: number;
  bot_appid?: string | number;
  bot_encrypt_secret?: string;
  user_openid?: string;
}

export interface BindResult {
  appId: string;
  appSecret: string;
  /** Who scanned the code: their openid for this bot. */
  userOpenid?: string;
}

export interface QrBindOptions {
  bindBase: string;
  pollMs: number;
  /** State when no attempt is under way. */
  resting: () => PluginLoginStatus;
  /** Hands the credentials over; returns who is signed in, for display. */
  onConfirmed: (r: BindResult) => Promise<string>;
}

/** AES-256-GCM, base64 of IV (12 bytes) + ciphertext + tag (16 bytes), as poll_bind_result returns it. */
export function decryptSecret(encryptedBase64: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const raw = Buffer.from(encryptedBase64, 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('the sealed secret is too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}

async function post<T>(base: string, endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}`);
  const json = (await res.json()) as { retcode?: number; msg?: string; data?: T };
  if (json.retcode !== 0) throw new Error(json.msg || `${endpoint} answered retcode ${json.retcode}`);
  return (json.data ?? {}) as T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The QR sign-in of q.qq.com that creates a QQ bot: create a bind task with our own key, show the
 * connect page as a QR code, poll until the scanner confirmed, then open the AppSecret the service
 * sealed to the key. The same requests and states as Tencent's `@tencent-connect/qqbot-connector`
 * (which prints to stdout, the plugin channel here). Each attempt runs in the background;
 * `status()` answers from memory.
 */
export class QrBind {
  private current: PluginLoginStatus | null = null;
  /** A new attempt or a cancel leaves the running loop behind. */
  private attempt = 0;

  constructor(private readonly o: QrBindOptions) {}

  status(): PluginLoginStatus {
    return this.current ?? this.o.resting();
  }

  async start(): Promise<PluginLoginStatus> {
    const attempt = ++this.attempt;
    try {
      const task = await this.createTask();
      if (attempt !== this.attempt) return this.status();
      this.show(task);
      void this.run(attempt, task);
    } catch (err) {
      if (attempt === this.attempt) this.fail(`Could not get a QR code: ${(err as Error).message}`);
    }
    return this.status();
  }

  /** QQ asks for no number. */
  submit(): PluginLoginStatus {
    return this.status();
  }

  cancel(): PluginLoginStatus {
    this.attempt++;
    this.current = null;
    return this.status();
  }

  private fail(message: string): void {
    this.current = { state: 'failed', message };
  }

  private show(task: BindTask, message = 'Scan this code with QQ on your phone and confirm: that creates the bot and connects it.'): void {
    // An empty source shows Protea as a "third-party bot" on the confirmation page.
    this.current = { state: 'waiting', qr: `${this.o.bindBase}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(task.taskId)}&source=&_wv=2`, message };
  }

  private async createTask(): Promise<BindTask> {
    const key = crypto.randomBytes(32).toString('base64');
    const data = await post<{ task_id?: string }>(this.o.bindBase, '/lite/create_bind_task', { key });
    if (!data.task_id) throw new Error('the service returned no task');
    return { taskId: data.task_id, key };
  }

  private async run(attempt: number, first: BindTask): Promise<void> {
    let task = first;
    let shown = 1;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    const live = (): boolean => attempt === this.attempt;
    try {
      while (live() && Date.now() < deadline) {
        let r: BindPoll | null;
        try {
          r = await post<BindPoll>(this.o.bindBase, '/lite/poll_bind_result', { task_id: task.taskId });
        } catch {
          r = null; // as in the official client: a failed poll is retried
        }
        if (!live()) return;
        if (r?.status === BindStatus.COMPLETED) {
          const appId = String(r.bot_appid ?? '');
          if (appId === '' || appId === '0' || !r.bot_encrypt_secret) {
            this.fail('The service confirmed the sign-in but gave no credentials.');
            return;
          }
          let appSecret: string;
          try {
            appSecret = decryptSecret(r.bot_encrypt_secret, task.key);
          } catch {
            this.fail('Could not open the credentials the service returned.');
            return;
          }
          const account = await this.o.onConfirmed({ appId, appSecret, ...(r.user_openid ? { userOpenid: r.user_openid } : {}) });
          if (live()) this.current = { state: 'connected', account };
          return;
        }
        if (r?.status === BindStatus.EXPIRED) {
          if (++shown > MAX_QR_CODES) {
            this.fail('The QR code expired too many times. Try again later.');
            return;
          }
          task = await this.createTask();
          if (!live()) return;
          this.show(task, 'The QR code expired; here is a new one.');
          continue;
        }
        await sleep(this.o.pollMs);
      }
      if (live()) this.fail('Timed out waiting for the scan.');
    } catch (err) {
      if (live()) this.fail(`Sign-in failed: ${(err as Error).message}`);
    }
  }
}
