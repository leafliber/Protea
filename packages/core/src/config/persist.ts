import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig } from './load.js';
import type { ProteaConfig } from './types.js';

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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** RFC 7386: members set to null inside a new object are simply absent. */
function withoutNulls(v: unknown): unknown {
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, withoutNulls(x)]));
}

/**
 * Apply a JSON Merge Patch (RFC 7386) to `<data>/config.yaml`: objects merge, `null` deletes,
 * anything else replaces. The result is validated as a whole (with the environment layer)
 * before the file is written, comments kept. Returns the changed key paths and the new
 * effective configuration; throws without writing when the result is invalid.
 */
export function patchConfigFile(
  dataDir: string,
  patch: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { changed: string[]; config: ProteaConfig } {
  if (!isPlainObject(patch)) throw new Error('a config patch must be an object');
  const file = path.join(dataDir, 'config.yaml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]?.message ?? 'invalid YAML'}`);
  const changed: string[] = [];
  // JSON keys are strings; reuse the document's own key when it is the number "2" (scheduler.levels.2).
  const keyIn = (parent: unknown[], k: string): unknown => {
    const map = parent.length === 0 ? doc.contents : doc.getIn(parent, true);
    if (YAML.isMap(map)) {
      for (const pair of map.items) {
        const key = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
        if (key !== k && String(key) === k) return key;
      }
    }
    return k;
  };
  const apply = (node: Record<string, unknown>, keys: unknown[]): void => {
    for (const [k, v] of Object.entries(node)) {
      const at = [...keys, keyIn(keys, k)];
      if (v === null) {
        if (doc.hasIn(at)) {
          doc.deleteIn(at);
          changed.push(at.map(String).join('.'));
        }
      } else if (isPlainObject(v) && YAML.isMap(doc.getIn(at, true))) {
        apply(v, at);
      } else if (isPlainObject(v) && Object.keys(withoutNulls(v) as object).length === 0) {
        // Nothing to set: an empty object does not create a key.
      } else {
        doc.setIn(at, withoutNulls(v));
        changed.push(at.map(String).join('.'));
      }
    }
  };
  apply(patch, []);
  const { config } = loadConfig(dataDir, env, { fileDoc: doc.toJS() as unknown });
  if (changed.length > 0) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, doc.toString());
    fs.renameSync(tmp, file);
  }
  return { changed, config };
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
