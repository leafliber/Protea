import { useEffect, useState } from 'react';
import type { BlobImageRef } from '@protea/protocol';
import { enc, post } from './api';

const MAX_EDGE = 1568;
/** The largest file sent as it is; anything bigger is re-encoded (the server's limit is 1.5 MB by default). */
const MAX_ORIGINAL_BYTES = 1024 * 1024;
const SENDABLE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const blobUrl = (handle: string): string => `/api/blobs/${enc(handle)}`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Shrink in the browser: the server stores what it gets and has no image library. */
async function shrink(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const fits = Math.max(bmp.width, bmp.height) <= MAX_EDGE;
  if (fits && file.size <= MAX_ORIGINAL_BYTES && SENDABLE.includes(file.type)) {
    bmp.close();
    return file;
  }
  const scale = fits ? 1 : MAX_EDGE / Math.max(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('无法处理这张图片'))), 'image/jpeg', 0.85));
}

/** Store an image for a message. */
export async function uploadImage(file: Blob): Promise<BlobImageRef> {
  const small = await shrink(file);
  return post<BlobImageRef>('/api/blobs', { dataBase64: toBase64(await small.arrayBuffer()) });
}

/** The images of a message as thumbnails; one opens enlarged on the page. An expired image says so. */
export function BlobImages({ images }: { images: BlobImageRef[] | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  const [gone, setGone] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);
  if (!images || images.length === 0) return null;
  return (
    <div className="blob-images">
      {images.map((i) =>
        gone.includes(i.handle) ? (
          <span key={i.handle} className="blob-gone">
            图片已不再保存
          </span>
        ) : (
          <button key={i.handle} type="button" className="blob-thumb" title="放大" onClick={() => setOpen(i.handle)}>
            <img src={blobUrl(i.handle)} alt="图片" loading="lazy" onError={() => setGone((old) => [...old, i.handle])} />
          </button>
        ),
      )}
      {open && (
        <div className="lightbox" role="dialog" aria-label="放大的图片" onClick={() => setOpen(null)}>
          <img src={blobUrl(open)} alt="图片" />
        </div>
      )}
    </div>
  );
}
