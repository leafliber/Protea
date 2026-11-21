import crypto from 'node:crypto';
import { isLoopback } from '../util/cidr.js';
import type { Clock } from '../util/time.js';
import { parseDownloadBaseUrl } from './settings.js';
import { isBlobHandle, type BlobStore } from './store.js';

export const IMAGE_DOWNLOAD_PATH = '/api/blob-downloads';
const LINK_WINDOW_MS = 5 * 60_000;

/** Short-lived read access to one cached image, signed with a key that lives only in this process. */
export class BlobDownloads {
  private readonly key = crypto.randomBytes(32);

  constructor(private readonly o: { blobs: BlobStore; clock: Clock; localUrl: () => string; publicUrl: () => string | null }) {}

  url(handle: string): string | undefined {
    const base = this.baseUrl();
    if (!base || !isBlobHandle(handle)) return undefined;
    // Rotate on a fixed boundary so repeated prompts keep the same prefix within this window.
    const expires = String((Math.floor(this.o.clock.now() / LINK_WINDOW_MS) + 2) * LINK_WINDOW_MS);
    const signature = this.sign(base, handle, expires).toString('hex');
    base.pathname = `${base.pathname.replace(/\/+$/, '')}${IMAGE_DOWNLOAD_PATH}/${encodeURIComponent(handle)}`;
    base.search = new URLSearchParams({ expires, signature }).toString();
    return base.href;
  }

  read(handle: string, expires: string | undefined, signature: string | undefined, address: string): ReturnType<BlobStore['get']> {
    if (!isBlobHandle(handle) || !expires || !/^\d{1,15}$/.test(expires) || !signature || !/^[a-f0-9]{64}$/.test(signature)) return null;
    const remaining = Number(expires) - this.o.clock.now();
    if (remaining <= 0 || remaining > 2 * LINK_WINDOW_MS) return null;
    const base = this.baseUrl();
    if (!base || (base.protocol === 'http:' && !isLoopback(address))) return null;
    if (!crypto.timingSafeEqual(this.sign(base, handle, expires), Buffer.from(signature, 'hex'))) return null;
    return this.o.blobs.get(handle);
  }

  private baseUrl(): URL | null {
    const publicUrl = parseDownloadBaseUrl(this.o.publicUrl());
    if (publicUrl) return publicUrl;
    const local = URL.parse(this.o.localUrl());
    return local?.protocol === 'http:' && (local.hostname === 'localhost' || isLoopback(local.hostname)) ? local : null;
  }

  private sign(base: URL, handle: string, expires: string): Buffer {
    return crypto.createHmac('sha256', this.key).update(`${base.href}\n${handle}\n${expires}`).digest();
  }
}
