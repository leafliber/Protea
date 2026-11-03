import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Change one value in `<data>/config.yaml`, keeping the operator's comments and layout
 * (the yaml Document API). `undefined` deletes the key. Written atomically.
 */
export function setConfigValue(dataDir: string, keyPath: Array<string | number>, value: unknown): void {
  const file = path.join(dataDir, 'config.yaml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]?.message ?? 'invalid YAML'}`);
  if (value === undefined) doc.deleteIn(keyPath);
  else doc.setIn(keyPath, value);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, doc.toString());
  fs.renameSync(tmp, file);
}

/**
 * Call `onChange` (debounced) whenever a watched file or directory changes. Returns a
 * function that stops watching. Missing paths are skipped; errors go to `onError`.
 */
export function watchPaths(
  targets: Array<{ path: string; recursive?: boolean; filter?: (name: string | null) => boolean }>,
  onChange: () => void,
  opts: { debounceMs?: number; onError?: (err: Error) => void } = {},
): () => void {
  const watchers: fs.FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, opts.debounceMs ?? 300);
  };
  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue;
    try {
      const w = fs.watch(t.path, { recursive: !!t.recursive, persistent: false }, (_event, name) => {
        if (!t.filter || t.filter(name === null ? null : String(name))) fire();
      });
      w.on('error', (err) => opts.onError?.(err));
      watchers.push(w);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
