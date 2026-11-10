import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The memory directory as the model sees it (the memory tool's convention). */
export const MEMORY_ROOT = '/memories';
/** Largest file the memory tool writes or indexes. */
export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;
const MAX_VIEW_CHARS = 100_000;
/** Lines of a file shown when no range is asked for: memory is read a piece at a time. */
const MAX_VIEW_LINES = 200;
const LINE_NUMBER_WIDTH = 6;
/** Written by the runtime as a record of what happened; the memory tool may read them only. */
const READ_ONLY_DIRS = ['raw', 'handoff'] as const;

/** Create the memory directory on first start from a template (INDEX.md); never overwrite afterwards. */
export function ensureMemoryDir(memoryDir: string, templateDir: string): { created: boolean } {
  if (fs.existsSync(memoryDir)) return { created: false };
  fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(templateDir)) fs.cpSync(templateDir, memoryDir, { recursive: true });
  return { created: true };
}

export class MemoryError extends Error {
  override readonly name = 'MemoryError';
}

export interface MemoryCommand {
  command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename';
  path?: string;
  view_range?: number[];
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  old_path?: string;
  new_path?: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0B';
  const units = ['B', 'K', 'M', 'G'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = bytes / 1024 ** i;
  return (size % 1 === 0 ? String(size) : size.toFixed(1)) + units[i];
}

function numbered(lines: readonly string[], start: number): string {
  return lines.map((l, i) => `${String(i + start).padStart(LINE_NUMBER_WIDTH, ' ')}\t${l}`).join('\n');
}

/**
 * `/data/memory` behind the memory tool's command surface (view / create / str_replace /
 * insert / delete / rename, paths under /memories). Messages follow the reference
 * implementation the models are trained on. Writes are atomic; nothing escapes the root,
 * symlinks included. `onChange` receives the relative paths that changed.
 */
export class MemoryStore {
  constructor(
    readonly dir: string,
    private readonly onChange?: (paths: string[]) => void,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** `/memories/a/b.md` → `a/b.md` (`''` for the root). Throws MemoryError on anything outside. */
  relative(memPath: string): string {
    if (typeof memPath !== 'string' || memPath.length === 0) throw new MemoryError('A path is required.');
    if (memPath.includes('\0')) throw new MemoryError(`Invalid path ${JSON.stringify(memPath)}`);
    if (memPath !== MEMORY_ROOT && !memPath.startsWith(`${MEMORY_ROOT}/`)) {
      throw new MemoryError(`Path must start with ${MEMORY_ROOT}, got: ${memPath}`);
    }
    const rest = memPath.slice(MEMORY_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
    if (rest === '') return '';
    const parts = rest.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new MemoryError(`Path ${memPath} would escape ${MEMORY_ROOT} directory`);
    return parts.join('/');
  }

  /** Absolute file path for a relative memory path, refusing symlink escapes. */
  full(rel: string): string {
    const root = fs.realpathSync(this.dir);
    const target = rel === '' ? root : path.join(root, ...rel.split('/'));
    let probe = target;
    for (;;) {
      try {
        const real = fs.realpathSync(probe);
        if (real !== root && !real.startsWith(root + path.sep)) throw new MemoryError(`Path ${MEMORY_ROOT}/${rel} would escape ${MEMORY_ROOT} directory via symlink`);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const parent = path.dirname(probe);
        if (parent === probe || probe === root) break;
        probe = parent;
      }
    }
    return target;
  }

  run(cmd: MemoryCommand): string {
    if (cmd.command !== 'view') {
      for (const p of [cmd.path, cmd.old_path, cmd.new_path]) if (p !== undefined) this.assertWritable(p);
    }
    switch (cmd.command) {
      case 'view':
        return this.view(this.need(cmd.path, 'path'), cmd.view_range);
      case 'create':
        return this.create(this.need(cmd.path, 'path'), this.need(cmd.file_text, 'file_text'));
      case 'str_replace':
        return this.strReplace(this.need(cmd.path, 'path'), this.need(cmd.old_str, 'old_str'), cmd.new_str ?? '');
      case 'insert':
        if (typeof cmd.insert_line !== 'number') throw new MemoryError('Missing required parameter `insert_line`.');
        return this.insert(this.need(cmd.path, 'path'), cmd.insert_line, this.need(cmd.insert_text, 'insert_text'));
      case 'delete':
        return this.delete(this.need(cmd.path, 'path'));
      case 'rename':
        return this.rename(this.need(cmd.old_path, 'old_path'), this.need(cmd.new_path, 'new_path'));
      default:
        throw new MemoryError(`Unknown command ${JSON.stringify((cmd as { command: unknown }).command)}.`);
    }
  }

  private assertWritable(memPath: string): void {
    const rel = this.relative(memPath);
    if (READ_ONLY_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) {
      throw new MemoryError(`${memPath} is read-only: the runtime keeps it as a record of what happened.`);
    }
  }

  private need(v: string | undefined, name: string): string {
    if (typeof v !== 'string') throw new MemoryError(`Missing required parameter \`${name}\`.`);
    return v;
  }

  view(memPath: string, range?: number[]): string {
    const rel = this.relative(memPath);
    const full = this.full(rel);
    const st = this.statOrNull(full);
    if (!st) throw new MemoryError(`The path ${memPath} does not exist. Please provide a valid path.`);
    if (st.isDirectory()) {
      const lines = [`${formatSize(st.size)}\t${memPath}`];
      const walk = (dir: string, prefix: string, depth: number): void => {
        for (const name of fs.readdirSync(dir).sort()) {
          if (name.startsWith('.') || name === 'node_modules') continue;
          const p = path.join(dir, name);
          const s = this.statOrNull(p);
          if (!s) continue;
          const shown = `${memPath.replace(/\/$/, '')}/${prefix}${name}`;
          if (s.isDirectory()) {
            lines.push(`${formatSize(s.size)}\t${shown}/`);
            if (depth < 2) walk(p, `${prefix}${name}/`, depth + 1);
          } else if (s.isFile()) {
            lines.push(`${formatSize(s.size)}\t${shown}`);
          }
        }
      };
      walk(full, '', 1);
      return `Here're the files and directories up to 2 levels deep in ${memPath}, excluding hidden items and node_modules:\n${lines.join('\n')}`;
    }
    if (!st.isFile()) throw new MemoryError(`Unsupported file type for ${memPath}`);
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    let start = 1;
    let shown = lines;
    if (range && range.length === 2) {
      const [from, to] = range as [number, number];
      const s = Math.max(1, from) - 1;
      shown = lines.slice(s, to === -1 ? lines.length : to);
      start = s + 1;
    } else if (lines.length > MAX_VIEW_LINES) {
      shown = lines.slice(0, MAX_VIEW_LINES);
      return `Here's the content of ${memPath} with line numbers:\n${numbered(shown, start).slice(0, MAX_VIEW_CHARS)}\n… [truncated: ${lines.length} lines in all; pass view_range to see the rest]`;
    }
    let body = numbered(shown, start);
    if (body.length > MAX_VIEW_CHARS) {
      body = `${body.slice(0, MAX_VIEW_CHARS)}\n… [truncated: ${lines.length} lines in all; pass view_range to see the rest]`;
    }
    return `Here's the content of ${memPath} with line numbers:\n${body}`;
  }

  create(memPath: string, text: string): string {
    const rel = this.relative(memPath);
    if (rel === '') throw new MemoryError(`Cannot create ${MEMORY_ROOT} itself`);
    const full = this.full(rel);
    if (fs.existsSync(full)) throw new MemoryError(`Error: File ${memPath} already exists`);
    this.checkSize(text, memPath);
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    this.atomicWrite(full, text);
    this.changed([rel]);
    return `File created successfully at: ${memPath}`;
  }

  strReplace(memPath: string, oldStr: string, newStr: string): string {
    const rel = this.relative(memPath);
    const full = this.full(rel);
    const content = this.readFile(full, memPath, 'The path {path} does not exist. Please provide a valid path.');
    const lines = content.split('\n');
    const hits: number[] = [];
    lines.forEach((l, i) => {
      if (l.includes(oldStr)) hits.push(i + 1);
    });
    // A multi-line old_str never matches a single line; count real occurrences instead.
    const occurrences = oldStr.length === 0 ? 0 : content.split(oldStr).length - 1;
    if (occurrences === 0) throw new MemoryError(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${memPath}.`);
    if (occurrences > 1) {
      throw new MemoryError(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${hits.join(', ')}. Please ensure it is unique`);
    }
    const next = content.replace(oldStr, () => newStr);
    this.checkSize(next, memPath);
    this.atomicWrite(full, next);
    this.changed([rel]);
    const at = content.slice(0, content.indexOf(oldStr)).split('\n').length - 1;
    const nextLines = next.split('\n');
    const from = Math.max(0, at - 2);
    const to = Math.min(nextLines.length, at + 3 + newStr.split('\n').length - 1);
    return `The memory file has been edited. Here is the snippet showing the change (with line numbers):\n${numbered(nextLines.slice(from, to), from + 1)}`;
  }

  insert(memPath: string, line: number, text: string): string {
    const rel = this.relative(memPath);
    const full = this.full(rel);
    const content = this.readFile(full, memPath, 'Error: The path {path} does not exist');
    const lines = content.split('\n');
    if (!Number.isInteger(line) || line < 0 || line > lines.length) {
      throw new MemoryError(`Error: Invalid \`insert_line\` parameter: ${line}. It should be within the range of lines of the file: [0, ${lines.length}]`);
    }
    lines.splice(line, 0, text.replace(/\n$/, ''));
    const next = lines.join('\n');
    this.checkSize(next, memPath);
    this.atomicWrite(full, next);
    this.changed([rel]);
    return `The file ${memPath} has been edited.`;
  }

  delete(memPath: string): string {
    const rel = this.relative(memPath);
    if (rel === '') throw new MemoryError(`Cannot delete the ${MEMORY_ROOT} directory itself`);
    const full = this.full(rel);
    if (!fs.existsSync(full)) throw new MemoryError(`Error: The path ${memPath} does not exist`);
    const gone = this.filesUnder(full, rel);
    fs.rmSync(full, { recursive: true, force: false });
    this.changed(gone);
    return `Successfully deleted ${memPath}`;
  }

  rename(oldPath: string, newPath: string): string {
    const from = this.relative(oldPath);
    const to = this.relative(newPath);
    if (from === '' || to === '') throw new MemoryError(`Cannot rename the ${MEMORY_ROOT} directory itself`);
    const src = this.full(from);
    const dst = this.full(to);
    if (!fs.existsSync(src)) throw new MemoryError(`Error: The path ${oldPath} does not exist`);
    if (fs.existsSync(dst)) throw new MemoryError(`Error: The destination ${newPath} already exists`);
    const before = this.filesUnder(src, from);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dst);
    this.changed([...before, ...before.map((p) => to + p.slice(from.length))]);
    return `Successfully renamed ${oldPath} to ${newPath}`;
  }

  /** Text of a memory file by relative path, or undefined. Used by the index segment and search. */
  readText(rel: string): string | undefined {
    try {
      const full = this.full(rel);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_MEMORY_FILE_BYTES) return undefined;
      return fs.readFileSync(full, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Write a file on Core's behalf (handoff notes, the index's handoff list). */
  writeText(rel: string, text: string): void {
    this.checkSize(text, `${MEMORY_ROOT}/${rel}`);
    const full = this.full(this.relative(`${MEMORY_ROOT}/${rel}`));
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    this.atomicWrite(full, text);
    this.changed([rel]);
  }

  /** Every visible file (relative paths) with size and mtime. */
  listFiles(): Array<{ path: string; size: number; mtimeMs: number }> {
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const root = this.dir;
    const walk = (dir: string, prefix: string): void => {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const p = path.join(dir, name);
        const st = this.statOrNull(p, true);
        if (!st) continue;
        if (st.isDirectory()) walk(p, `${prefix}${name}/`);
        else if (st.isFile()) out.push({ path: `${prefix}${name}`, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      }
    };
    walk(root, '');
    return out;
  }

  private filesUnder(full: string, rel: string): string[] {
    const st = this.statOrNull(full, true);
    if (!st) return [];
    if (!st.isDirectory()) return [rel];
    return this.listFiles()
      .map((f) => f.path)
      .filter((p) => p.startsWith(`${rel}/`));
  }

  private readFile(full: string, memPath: string, missing: string): string {
    const st = this.statOrNull(full);
    if (!st) throw new MemoryError(missing.replace('{path}', memPath));
    if (!st.isFile()) throw new MemoryError(`The path ${memPath} is not a file.`);
    if (st.size > MAX_MEMORY_FILE_BYTES) throw new MemoryError(`File ${memPath} is larger than ${formatSize(MAX_MEMORY_FILE_BYTES)}; it cannot be edited here.`);
    return fs.readFileSync(full, 'utf8');
  }

  private checkSize(text: string, memPath: string): void {
    if (Buffer.byteLength(text, 'utf8') > MAX_MEMORY_FILE_BYTES) {
      throw new MemoryError(`File ${memPath} would exceed ${formatSize(MAX_MEMORY_FILE_BYTES)}; split it into smaller files.`);
    }
  }

  private statOrNull(p: string, noFollow = false): fs.Stats | null {
    try {
      return noFollow ? fs.lstatSync(p) : fs.statSync(p);
    } catch {
      return null;
    }
  }

  private atomicWrite(full: string, text: string): void {
    const tmp = path.join(path.dirname(full), `.tmp-${process.pid}-${crypto.randomUUID()}`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, full);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  private changed(paths: string[]): void {
    if (paths.length > 0) this.onChange?.(paths);
  }
}
