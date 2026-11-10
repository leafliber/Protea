import type { PluginLoginStatus } from '@protea/protocol';
import { apiGetFetch, apiPostFetch } from './ilink.js';

const BOT_TYPE = '3';
const QR_TTL_MS = 5 * 60_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const QR_FETCH_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 480_000;
const MAX_QR_REFRESH = 3;

interface QrCode {
  qrcode?: string;
  qrcode_img_content?: string;
}

interface QrStatus {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export interface LoginResult {
  token: string;
  botId: string;
  baseUrl: string;
  /** Who scanned the code. */
  userId?: string;
}

export interface QrLoginOptions {
  apiBase: string;
  pollMs: number;
  currentToken: () => string | null;
  /** State when no attempt is under way. */
  resting: () => PluginLoginStatus;
  /** Hands the credentials over; returns who is signed in, for display. */
  onConfirmed: (r: LoginResult) => Promise<string>;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * The QR sign-in of the iLink bot channel, driven from the console instead of a terminal: the
 * same requests and states as the official `waitForWeixinLogin`, which asks for the verification
 * number on stdin. Each attempt runs in the background; `status()` answers from memory.
 */
export class QrLogin {
  private current: PluginLoginStatus | null = null;
  /** A new attempt or a cancel leaves the running loop behind. */
  private attempt = 0;
  private codeWaiter: ((code: string | null) => void) | null = null;

  constructor(private readonly o: QrLoginOptions) {}

  status(): PluginLoginStatus {
    return this.current ?? this.o.resting();
  }

  async start(): Promise<PluginLoginStatus> {
    const attempt = this.begin();
    try {
      const qr = await this.fetchQr();
      if (attempt !== this.attempt) return this.status();
      this.showQr(qr);
      void this.run(attempt, qr.qrcode as string);
    } catch (err) {
      if (attempt === this.attempt) this.fail(`Could not get a QR code: ${(err as Error).message}`);
    }
    return this.status();
  }

  submit(code: string): PluginLoginStatus {
    const clean = typeof code === 'string' ? code.trim() : '';
    if (this.codeWaiter && clean !== '') {
      const waiter = this.codeWaiter;
      this.codeWaiter = null;
      this.current = { state: 'scanned', message: 'Checking the number…' };
      waiter(clean);
    }
    return this.status();
  }

  cancel(): PluginLoginStatus {
    this.begin();
    this.current = null;
    return this.status();
  }

  private begin(): number {
    this.codeWaiter?.(null);
    this.codeWaiter = null;
    return ++this.attempt;
  }

  private fail(message: string): void {
    this.current = { state: 'failed', message };
  }

  private showQr(qr: QrCode, message = 'Scan this code with WeChat on your phone.'): void {
    this.current = { state: 'waiting', qr: qr.qrcode_img_content as string, expiresAt: iso(Date.now() + QR_TTL_MS), message };
  }

  private async fetchQr(): Promise<QrCode> {
    const token = this.o.currentToken();
    const raw = await apiPostFetch({
      baseUrl: this.o.apiBase,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      body: JSON.stringify({ local_token_list: token ? [token] : [] }),
      timeoutMs: QR_FETCH_TIMEOUT_MS,
      label: 'fetchQRCode',
    });
    const qr = JSON.parse(raw) as QrCode;
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('the service returned no QR code');
    return qr;
  }

  /** A timeout or a gateway error just means "still waiting", as in the official client. */
  private async poll(baseUrl: string, qrcode: string, verifyCode: string | undefined): Promise<QrStatus> {
    try {
      const raw = await apiGetFetch({
        baseUrl,
        endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`,
        timeoutMs: QR_POLL_TIMEOUT_MS,
        label: 'pollQRStatus',
      });
      return JSON.parse(raw) as QrStatus;
    } catch {
      return { status: 'wait' };
    }
  }

  private waitForCode(deadline: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.codeWaiter = null;
        resolve(null);
      }, Math.max(deadline - Date.now(), 0));
      this.codeWaiter = (code) => {
        clearTimeout(timer);
        resolve(code);
      };
    });
  }

  private redirected(host: string | undefined, current: string): string {
    if (!host || !HOST_RE.test(host)) return current;
    return `${new URL(this.o.apiBase).protocol}//${host}`;
  }

  private async run(attempt: number, firstCode: string): Promise<void> {
    let qrcode = firstCode;
    let baseUrl = this.o.apiBase;
    let verifyCode: string | undefined;
    let shown = 1;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    const live = (): boolean => attempt === this.attempt;
    const refresh = async (giveUp: string, message: string): Promise<boolean> => {
      if (++shown > MAX_QR_REFRESH) {
        this.fail(giveUp);
        return false;
      }
      const qr = await this.fetchQr();
      if (!live()) return false;
      qrcode = qr.qrcode as string;
      this.showQr(qr, message);
      return true;
    };
    try {
      while (live() && Date.now() < deadline) {
        const r = await this.poll(baseUrl, qrcode, verifyCode);
        if (!live()) return;
        switch (r.status) {
          case 'scaned':
            verifyCode = undefined;
            if (this.current?.state === 'waiting') this.current = { ...this.current, state: 'scanned', message: 'Scanned. Confirm on your phone.' };
            break;
          case 'need_verifycode': {
            this.current = { state: 'need_code', message: verifyCode ? 'That number did not match. Enter the number shown on your phone.' : 'Enter the number shown on your phone.' };
            const code = await this.waitForCode(deadline);
            if (!live()) return;
            if (code === null) {
              this.fail('Timed out waiting for the number.');
              return;
            }
            verifyCode = code;
            continue; // at once, as the official client does
          }
          case 'expired':
            verifyCode = undefined;
            if (!(await refresh('The QR code expired too many times. Try again later.', 'The QR code expired; here is a new one.'))) return;
            break;
          case 'verify_code_blocked':
            verifyCode = undefined;
            if (!(await refresh('Too many wrong numbers. Try again later.', 'Too many wrong numbers; scan this new code.'))) return;
            break;
          case 'binded_redirect':
            this.current = { ...this.o.resting(), state: 'already_bound', message: 'This WeChat account is already linked to this bot; no new sign-in was issued.' };
            return;
          case 'scaned_but_redirect':
            baseUrl = this.redirected(r.redirect_host, baseUrl);
            break;
          case 'confirmed': {
            if (!r.bot_token || !r.ilink_bot_id) {
              this.fail('The service confirmed the sign-in but gave no credentials.');
              return;
            }
            const account = await this.o.onConfirmed({ token: r.bot_token, botId: r.ilink_bot_id, baseUrl: r.baseurl || this.o.apiBase, ...(r.ilink_user_id ? { userId: r.ilink_user_id } : {}) });
            if (live()) this.current = { state: 'connected', account };
            return;
          }
          default: // "wait"
            break;
        }
        await new Promise((done) => setTimeout(done, this.o.pollMs));
      }
      if (live()) this.fail('Timed out waiting for the scan.');
    } catch (err) {
      if (live()) this.fail(`Sign-in failed: ${(err as Error).message}`);
    }
  }
}
