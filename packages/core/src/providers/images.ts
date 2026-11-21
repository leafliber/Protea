import { isImageBlock, isToolResultBlock, type ContentBlock, type ImageBlock, type ModelRole, type TranscriptMessage } from '@protea/protocol';
import type { BlobInfo, BlobStore } from '../blobs/store.js';
import type { GenerateOptions, Provider, ProviderHealth, ProviderRequest, ProviderResponse } from './types.js';

function placeholder(b: ImageBlock, note: string): ContentBlock {
  const handle = b.source.type === 'blob' ? `, ${b.source.handle}` : '';
  return { type: 'text', text: `[image ${b.source.media_type}${handle}: ${note}]` };
}

function fileReference(info: BlobInfo, downloadUrl?: (handle: string) => string | undefined): ContentBlock {
  const url = downloadUrl?.(info.handle);
  const download = url ? `\nShort-lived download URL for image-processing tools\n${url}` : '';
  return {
    type: 'text',
    text: `Cached image file ${info.handle} (${info.mime}, ${info.size} bytes). Use the handle as sh_run.stdinImage if available.${download}`,
  };
}

type ImageStore = Pick<BlobStore, 'get' | 'info' | 'putBase64Image'>;

/** Send image bytes to visual models and file references to text-only models. */
export function resolveImageBlocks(
  messages: readonly TranscriptMessage[],
  blobs: ImageStore,
  vision: boolean,
  downloadUrl?: (handle: string) => string | undefined,
): TranscriptMessage[] {
  const resolve = (b: ContentBlock): ContentBlock => {
    if (isImageBlock(b)) {
      if (!vision) {
        if (b.source.type === 'blob') {
          const info = blobs.info(b.source.handle);
          return info ? fileReference(info, downloadUrl) : placeholder(b, 'no longer stored');
        }
        if (b.source.type !== 'base64' || typeof b.source.data !== 'string') return placeholder(b, 'no supported image data');
        const stored = blobs.putBase64Image(b.source.data, 'provider');
        return stored.ok ? fileReference(stored.blob, downloadUrl) : placeholder(b, stored.reason);
      }
      if (b.source.type !== 'blob') return b;
      const found = blobs.get(b.source.handle);
      if (!found) return placeholder(b, 'no longer stored');
      return { type: 'image', source: { type: 'base64', media_type: found.mime, data: found.bytes.toString('base64') } };
    }
    if (isToolResultBlock(b) && Array.isArray(b.content) && b.content.some(isImageBlock)) return { ...b, content: b.content.map(resolve) };
    return b;
  };
  return messages.map((m) => {
    const hasImage = m.content.some((b) => isImageBlock(b) || (isToolResultBlock(b) && Array.isArray(b.content) && b.content.some(isImageBlock)));
    return hasImage ? { role: m.role, content: m.content.map(resolve) } : m;
  });
}

/**
 * The last step before a request leaves: everything outside this wrapper (redaction, recording,
 * the transcript) sees only references (ADR-0014).
 */
export class ImageResolvingProvider implements Provider {
  constructor(
    private readonly inner: Provider,
    private readonly blobs: ImageStore,
    private readonly vision: (role: ModelRole) => boolean,
    private readonly downloadUrl?: (handle: string) => string | undefined,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  modelFor(role: ModelRole): string {
    return this.inner.modelFor(role);
  }

  health(): ProviderHealth {
    return this.inner.health();
  }

  supportsToolSearch(role: ModelRole): boolean {
    return this.inner.supportsToolSearch?.(role) ?? false;
  }

  contextWindow(role: ModelRole): number | undefined {
    return this.inner.contextWindow?.(role);
  }

  cacheHorizonMs(role: ModelRole): number | undefined {
    return this.inner.cacheHorizonMs?.(role);
  }

  private resolved(req: ProviderRequest): ProviderRequest {
    return { ...req, messages: resolveImageBlocks(req.messages, this.blobs, this.vision(req.role), this.downloadUrl) };
  }

  countTokens(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<number | undefined> {
    return this.inner.countTokens ? this.inner.countTokens(this.resolved(req), opts) : Promise.resolve(undefined);
  }

  generate(req: ProviderRequest, opts: GenerateOptions): Promise<ProviderResponse> {
    return this.inner.generate(this.resolved(req), opts);
  }
}
