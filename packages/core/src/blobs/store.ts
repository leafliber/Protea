import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/database.js';
import type { Clock } from '../util/time.js';

const HANDLE_RE = /^blob:([a-f0-9]{64})$/;

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export function isBlobHandle(v: unknown): v is string {
  return typeof v === 'string' && HANDLE_RE.test(v);
}

/** The image type by its magic bytes; null for anything else (SVG included: it can carry scripts). */
export function sniffImageMime(b: Uint8Array): ImageMime | null {
  const at = (i: number, ...bytes: number[]): boolean => bytes.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

export interface BlobInfo {
  handle: string;
  mime: string;
  size: number;
  createdAt: string;
}

export type PutResult = { ok: true; blob: BlobInfo } | { ok: false; reason: string };

export interface BlobStoreOptions {
  dir: string;
  db: Db;
  clock: Clock;
  maxImageBytes: () => number;
}

interface Row {
  handle: string;
  mime: string;
  size: number;
  created_at: string;
}

/**
 * Content-addressed images under <data>/blobs (ADR-0014). The handle is the digest, so
 * knowing one is as good as having the image: plugins can read back what they were given and
 * nothing else. Storing the same image again restarts its retention.
 */
export class BlobStore {
  constructor(private readonly o: BlobStoreOptions) {}

  private file(digest: string): string {
    return path.join(this.o.dir, digest.slice(0, 2), digest);
  }

  /** Store an image. The type comes from the bytes; a file that is not an image is refused. */
  putImage(bytes: Buffer, source?: string): PutResult {
    const mime = sniffImageMime(bytes);
    if (!mime) return { ok: false, reason: `not a supported image (${IMAGE_MIMES.join(', ')})` };
    const max = this.o.maxImageBytes();
    if (bytes.length > max) return { ok: false, reason: `${Math.ceil(bytes.length / 1024)} KB is over the limit of ${Math.floor(max / 1024)} KB` };
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = this.file(digest);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = path.join(path.dirname(file), `.tmp-${digest}-${process.pid}`);
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    const now = this.o.clock.now();
    const handle = `blob:${digest}`;
    const createdAt = new Date(now).toISOString();
    this.o.db
      .prepare(
        `INSERT INTO blobs (handle, mime, size, source, created_at, created_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET created_at = excluded.created_at, created_ms = excluded.created_ms`,
      )
      .run(handle, mime, bytes.length, source ?? null, createdAt, now);
    return { ok: true, blob: { handle, mime, size: bytes.length, createdAt } };
  }

  info(handle: string): BlobInfo | null {
    if (!isBlobHandle(handle)) return null;
    const r = this.o.db.prepare('SELECT handle, mime, size, created_at FROM blobs WHERE handle = ?').get(handle) as Row | undefined;
    return r ? { handle: r.handle, mime: r.mime, size: r.size, createdAt: r.created_at } : null;
  }

  /** The image's bytes, or null when it was never stored or has expired. */
  get(handle: string): { bytes: Buffer; mime: string; size: number } | null {
    const info = this.info(handle);
    if (!info) return null;
    try {
      const bytes = fs.readFileSync(this.file(handle.slice('blob:'.length)));
      return { bytes, mime: info.mime, size: bytes.length };
    } catch {
      return null;
    }
  }

  /** Remove images older than `maxAgeMs`. Returns how many went. */
  sweep(maxAgeMs: number): number {
    const before = this.o.clock.now() - maxAgeMs;
    const rows = this.o.db.prepare('SELECT handle FROM blobs WHERE created_ms < ?').all(before) as Array<{ handle: string }>;
    const del = this.o.db.prepare('DELETE FROM blobs WHERE handle = ?');
    for (const { handle } of rows) {
      fs.rmSync(this.file(handle.slice('blob:'.length)), { force: true });
      del.run(handle);
    }
    return rows.length;
  }
}
