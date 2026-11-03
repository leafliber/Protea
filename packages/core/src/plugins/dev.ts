import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The tsx loader URL for running plugin sources in development mode, or null when tsx
 * is not installed (production images ship built plugins).
 */
export function resolveDevLoader(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
    return pathToFileURL(path.join(path.dirname(pkg), 'dist', 'loader.mjs')).href;
  } catch {
    return null;
  }
}
