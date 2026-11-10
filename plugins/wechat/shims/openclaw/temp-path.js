import os from 'node:os';

/** Where the official package's logger would write; the connector turns that logger off. */
export function resolvePreferredOpenClawTmpDir() {
  return os.tmpdir();
}
