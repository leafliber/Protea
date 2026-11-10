import fs from 'node:fs';
import path from 'node:path';
import type { ToolSpec } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import { isBlobHandle, sniffImageMime, type BlobStore } from './store.js';

/** Where the shared workspace appears inside the sandbox container. */
const SANDBOX_WORKSPACE = '/workspace';

/**
 * A regular image file inside the workspace. The workspace is writable from the sandbox, so
 * nothing in it is trusted: a symlink must not lead out of it, and a FIFO must not hang the call.
 */
export function readWorkspaceFile(workspace: string, requested: string, maxBytes: number): Buffer {
  const root = fs.realpathSync(workspace);
  let rel = requested;
  if (rel === SANDBOX_WORKSPACE || rel.startsWith(`${SANDBOX_WORKSPACE}/`)) rel = rel.slice(SANDBOX_WORKSPACE.length + 1);
  const target = path.resolve(root, rel);
  if (!fs.existsSync(target)) throw new Error(`${requested} does not exist in the workspace`);
  const real = fs.realpathSync(target);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`${requested} is outside the workspace`);
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${requested} is not a regular file`);
    if (st.size > maxBytes) throw new Error(`${requested} is ${Math.ceil(st.size / 1024)} KB, over the limit of ${Math.floor(maxBytes / 1024)} KB`);
    const buf = Buffer.alloc(st.size);
    const read = fs.readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** `view_image`: show the model an image file from the workspace, or a stored image by handle. */
export function viewImageTool(deps: { blobs: BlobStore; workspace: string; maxBytes: () => number }): ToolSpec<never> {
  const spec: ToolSpec<{ path: string }> = {
    name: 'view_image',
    description:
      'Look at an image: a file in the workspace (a path relative to it, or under /workspace as the sandbox shell sees it) or a stored image by its handle (blob:…). PNG, JPEG, WebP and GIF.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Workspace path or blob handle.' } },
    },
    flags: { readOnly: true },
    handler: (input) => {
      if (isBlobHandle(input.path)) {
        const info = deps.blobs.info(input.path);
        if (!info) return { text: `${input.path} is no longer stored`, failed: true };
        return { text: `${input.path} (${info.mime}, ${Math.ceil(info.size / 1024)} KB)`, images: [{ handle: info.handle, mime: info.mime }] };
      }
      let bytes: Buffer;
      try {
        bytes = readWorkspaceFile(deps.workspace, input.path, deps.maxBytes());
      } catch (err) {
        return { text: errorMessage(err), failed: true };
      }
      if (!sniffImageMime(bytes)) return { text: `${input.path} is not a PNG, JPEG, WebP or GIF image`, failed: true };
      const put = deps.blobs.putImage(bytes, 'view_image');
      if (!put.ok) return { text: `${input.path}: ${put.reason}`, failed: true };
      return { text: `${input.path} (${put.blob.mime}, ${Math.ceil(put.blob.size / 1024)} KB)`, images: [{ handle: put.blob.handle, mime: put.blob.mime }] };
    },
  };
  return spec as unknown as ToolSpec<never>;
}
