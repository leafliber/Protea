import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

export interface FileOAuthOptions {
  /** `<data>/secrets/mcp-oauth/<server>.json` (mode 0600). */
  file: string;
  redirectUrl: string;
  scopes?: string[];
  /** A pre-registered client; otherwise the provider registers one dynamically. */
  clientId?: string;
  clientSecret?: string;
  /** The SDK wants the owner to open this URL. */
  onAuthorize: (url: URL) => void;
}

/**
 * OAuth for one remote MCP server (authorization code + PKCE). Client registration,
 * tokens and the PKCE verifier persist in the secrets directory; the authorization
 * itself is done by the owner in a browser and ends at /api/mcp/oauth/callback.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(private readonly o: FileOAuthOptions) {}

  get redirectUrl(): string {
    return this.o.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Protea',
      redirect_uris: [this.o.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.o.clientSecret ? 'client_secret_post' : 'none',
      ...(this.o.scopes?.length ? { scope: this.o.scopes.join(' ') } : {}),
    };
  }

  state(): string {
    const state = crypto.randomBytes(16).toString('hex');
    this.write({ ...this.read(), state });
    return state;
  }

  /** The state of the authorization in progress, to route the callback. */
  pendingState(): string | undefined {
    return this.read().state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.o.clientId) return { client_id: this.o.clientId, ...(this.o.clientSecret ? { client_secret: this.o.clientSecret } : {}) };
    return this.read().client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.write({ ...this.read(), client: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const s = this.read();
    delete s.state;
    this.write({ ...s, tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.o.onAuthorize(url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.write({ ...this.read(), codeVerifier });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error('no PKCE code verifier is stored; start the authorization again');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const s = this.read();
    if (scope === 'all') return this.write({});
    if (scope === 'client') delete s.client;
    if (scope === 'tokens') delete s.tokens;
    if (scope === 'verifier') delete s.codeVerifier;
    this.write(s);
  }

  hasTokens(): boolean {
    return !!this.read().tokens;
  }

  /** Every stored secret value (for log redaction). */
  secretValues(): string[] {
    const s = this.read();
    const out: string[] = [];
    if (s.tokens?.access_token) out.push(s.tokens.access_token);
    if (s.tokens?.refresh_token) out.push(s.tokens.refresh_token);
    const secret = (s.client as { client_secret?: string } | undefined)?.client_secret;
    if (secret) out.push(secret);
    return out;
  }

  private read(): Stored {
    try {
      return JSON.parse(fs.readFileSync(this.o.file, 'utf8')) as Stored;
    } catch {
      return {};
    }
  }

  private write(s: Stored): void {
    fs.mkdirSync(path.dirname(this.o.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.o.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.o.file);
  }
}
