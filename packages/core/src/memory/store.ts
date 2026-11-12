import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseNote } from './frontmatter.js';

/** The memory directory as the model sees it. */
export const MEMORY_ROOT = '/memories';
/** Largest file the memory tool writes or indexes. */
export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;
const MAX_READ_CHARS = 100_000;
/** Lines of a file shown when no range is asked for: memory is read a piece at a time. */
const MAX_READ_LINES = 200;
const LINE_NUMBER_WIDTH = 6;
/** Written by the runtime as a record of what happened; the memory tool may read them only. */
const READ_ONLY_DIRS = ['raw', 'handoff'] as const;

/**
 * The resident files: always in the system prefix, so each has a hard limit in characters.
 * Nothing else may live under `core/`.
 */
export const CORE_FILES: Readonly<Record<string, number>> = { 'core/owner.md': 2_000, 'core/rules.md': 4_000 };
/** Earlier versions of the resident files, newest last (hidden, so neither listed nor indexed). */
const HISTORY_DIR = 'core/.history';
const HISTORY_KEEP = 20;

export function isCorePath(rel: string): boolean {
  return rel in CORE_FILES;
}

/** Notes are what the index lists: every one needs a one-line summary. */
export function isNotePath(rel: string): boolean {
  return rel.startsWith('notes/') && rel.endsWith('.md');
}

/** Create the memory directory on first start; never touch it afterwards. */
export function ensureMemoryDir(memoryDir: string): { created: boolean } {
  if (fs.existsSync(memoryDir)) return { created: false };
  fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  return { created: true };
}

export class MemoryError extends Error {
  override readonly name = 'MemoryError';
}

export const MEMORY_COMMANDS = ['read', 'write', 'append', 'edit', 'move', 'delete'] as const;

/** One call of the memory tool. Which fields matter depends on the command. */
export interface MemoryCommand {
  command: (typeof MEMORY_COMMANDS)[number];
  path?: string;
  /** read: [first, last] line, 1-based; last -1 = end of file. */
  range?: number[];
  /** write, append */
  text?: string;
  /** edit */
  old?: string;
  new?: string;
  /** move */
  from?: string;
  to?: string;
}

/** A file that changed, for whoever keeps track (the search index, the access log). */
export type MemoryChange = string[];

export interface MemoryVersion {
  /** File name under core/.history. */
  name: string;
  at: string;
  text: string;
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

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

const SUMMARY_HINT = 'Start it with a header like:\n---\nsummary: one line saying what this file holds\nkeywords: [names, synonyms, Chinese and English terms]\n---';

/**
 * `/data/memory` behind the memory tool (read / write / append / edit / move / delete, paths
 * under /memories). Writes are atomic; nothing escapes the root, symlinks included. The
 * resident files under `core/` have hard limits and keep their earlier versions; notes need
 * a summary. `onChange` receives the relative paths that changed.
 */
export class MemoryStore {
  private readonly now: () => number;

  constructor(
    readonly dir: string,
    private readonly onChange?: (paths: MemoryChange) => void,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * A path as the model may write it (`/memories/a/b.md`, `memories/a/b.md` or `a/b.md`) →
   * `a/b.md` (`''` for the root). Throws MemoryError on anything outside.
   */
  relative(memPath: string): string {
    if (typeof memPath !== 'string') throw new MemoryError('A path is required.');
    let p = memPath.trim();
    if (p.includes('\0')) throw new MemoryError(`Invalid path ${JSON.stringify(memPath)}`);
    const root = MEMORY_ROOT.slice(1);
    if (p.startsWith('/')) {
      if (p !== MEMORY_ROOT && !p.startsWith(`${MEMORY_ROOT}/`)) throw new MemoryError(`Paths are inside ${MEMORY_ROOT}, got: ${memPath}`);
      p = p.slice(MEMORY_ROOT.length);
    } else if (p === root || p.startsWith(`${root}/`)) {
      p = p.slice(root.length);
    }
    const rest = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (rest === '') return '';
    const parts = rest.split('/');
    if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new MemoryError(`Path ${memPath} would leave ${MEMORY_ROOT}`);
    return parts.join('/');
  }

  /** How the model sees a relative path. */
  shown(rel: string): string {
    return rel === '' ? MEMORY_ROOT : `${MEMORY_ROOT}/${rel}`;
  }

  /** Absolute file path for a relative memory path, refusing symlink escapes. */
  full(rel: string): string {
    const root = fs.realpathSync(this.dir);
    const target = rel === '' ? root : path.join(root, ...rel.split('/'));
    let probe = target;
    for (;;) {
      try {
        const real = fs.realpathSync(probe);
        if (real !== root && !real.startsWith(root + path.sep)) throw new MemoryError(`Path ${this.shown(rel)} would leave ${MEMORY_ROOT} through a symlink`);
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

  /** The relative paths a command writes, after normalisation (empty for `read`). */
  targets(cmd: MemoryCommand): string[] {
    if (cmd.command === 'read') return [];
    if (cmd.command === 'move') return [cmd.from, cmd.to].filter((p): p is string => typeof p === 'string').map((p) => this.relative(p));
    return typeof cmd.path === 'string' ? [this.relative(cmd.path)] : [];
  }

  /** Run a command of the memory tool, with every rule the model is held to. */
  run(cmd: MemoryCommand): string {
    switch (cmd.command) {
      case 'read':
        return this.read(this.need(cmd.path, 'path'), cmd.range);
      case 'write':
        return this.write(this.need(cmd.path, 'path'), this.need(cmd.text, 'text'));
      case 'append':
        return this.append(this.need(cmd.path, 'path'), this.need(cmd.text, 'text'));
      case 'edit':
        return this.edit(this.need(cmd.path, 'path'), this.need(cmd.old, 'old'), cmd.new ?? '');
      case 'move':
        return this.move(this.need(cmd.from, 'from'), this.need(cmd.to, 'to'));
      case 'delete':
        return this.delete(this.need(cmd.path, 'path'));
      default:
        throw new MemoryError(`Unknown command ${JSON.stringify((cmd as { command: unknown }).command)}; use one of ${MEMORY_COMMANDS.join(', ')}.`);
    }
  }

  private need(v: string | undefined, name: string): string {
    if (typeof v !== 'string') throw new MemoryError(`Missing required parameter \`${name}\`.`);
    return v;
  }

  /** What the model may not write: the record, hidden files, and anything under core/ but its two files. */
  private assertWritable(rel: string): void {
    const shown = this.shown(rel);
    if (rel === '') throw new MemoryError(`${MEMORY_ROOT} itself cannot be changed.`);
    if (READ_ONLY_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) throw new MemoryError(`${shown} is read-only: the runtime keeps it as a record of what happened.`);
    if (rel.split('/').some((s) => s.startsWith('.'))) throw new MemoryError(`${shown} is hidden and kept by the runtime.`);
    if ((rel === 'core' || rel.startsWith('core/')) && !isCorePath(rel)) {
      throw new MemoryError(`${MEMORY_ROOT}/core holds only ${Object.keys(CORE_FILES).map((p) => this.shown(p)).join(' and ')}.`);
    }
  }

  /** Rules on the content a write would leave behind. `model`: the notes rule applies too. */
  private checkContent(rel: string, text: string, model: boolean): void {
    if (Buffer.byteLength(text, 'utf8') > MAX_MEMORY_FILE_BYTES) {
      throw new MemoryError(`${this.shown(rel)} would exceed ${formatSize(MAX_MEMORY_FILE_BYTES)}; split it into smaller files.`);
    }
    const limit = CORE_FILES[rel];
    if (limit !== undefined && text.length > limit) {
      throw new MemoryError(`${this.shown(rel)} would be ${text.length} characters; its limit is ${limit}. Nothing was written. Rewrite it shorter: merge entries and drop what no longer holds.`);
    }
    if (model && isNotePath(rel) && !parseNote(text).hasSummary) {
      throw new MemoryError(`${this.shown(rel)} has no summary, so it cannot be listed in the index. Nothing was written. ${SUMMARY_HINT}`);
    }
  }

  private usage(rel: string, text: string): string {
    const limit = CORE_FILES[rel];
    return limit !== undefined ? `${text.length}/${limit} characters` : `${lineCount(text)} lines`;
  }

  read(memPath: string, range?: number[]): string {
    const rel = this.relative(memPath);
    const shown = this.shown(rel);
    const full = this.full(rel);
    const st = this.statOrNull(full);
    if (!st) throw new MemoryError(`${shown} does not exist.${rel.endsWith('.md') ? ' append or write creates it.' : ''}`);
    if (st.isDirectory()) {
      const lines: string[] = [];
      const walk = (dir: string, prefix: string, depth: number): void => {
        for (const name of fs.readdirSync(dir).sort()) {
          if (name.startsWith('.')) continue;
          const p = path.join(dir, name);
          const s = this.statOrNull(p);
          if (!s) continue;
          const at = `${shown}/${prefix}${name}`.replace(/^\/\//, '/');
          if (s.isDirectory()) {
            lines.push(`${at}/`);
            if (depth < 2) walk(p, `${prefix}${name}/`, depth + 1);
          } else if (s.isFile()) {
            lines.push(`${formatSize(s.size)}\t${at}`);
          }
        }
      };
      walk(full, '', 1);
      return lines.length === 0 ? `${shown}/ is empty.` : `${shown}/ (two levels):\n${lines.join('\n')}`;
    }
    if (!st.isFile()) throw new MemoryError(`${shown} is not a file.`);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    const total = lines.length;
    if (total === 0) return `${shown} is empty.`;
    let from = 1;
    let to = Math.min(total, MAX_READ_LINES);
    if (range && range.length === 2) {
      const [a, b] = range as [number, number];
      from = Math.min(Math.max(1, a), total);
      to = b === -1 ? total : Math.min(Math.max(from, b), total);
    }
    let body = numbered(lines.slice(from - 1, to), from);
    let cut = false;
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS);
      cut = true;
    }
    const whole = from === 1 && to === total && !cut;
    const head = whole ? `${shown} (${this.usage(rel, text)}):` : `${shown}, lines ${from}-${to} of ${total}:`;
    const more = to < total ? `\n… ${total - to} more line(s); read with range [${to + 1}, ${total}]` : cut ? '\n… cut at the size limit of a read; use a smaller range' : '';
    return `${head}\n${body}${more}`;
  }

  write(memPath: string, text: string): string {
    const rel = this.relative(memPath);
    this.assertWritable(rel);
    const full = this.full(rel);
    const st = this.statOrNull(full);
    if (st?.isDirectory()) throw new MemoryError(`${this.shown(rel)} is a directory.`);
    this.checkContent(rel, text, true);
    this.put(rel, full, text);
    return `${st ? 'Wrote' : 'Created'} ${this.shown(rel)} (${this.usage(rel, text)}).`;
  }

  append(memPath: string, text: string): string {
    const rel = this.relative(memPath);
    this.assertWritable(rel);
    const full = this.full(rel);
    const before = this.statOrNull(full) ? this.readFile(full, rel) : '';
    const sep = before === '' || before.endsWith('\n') ? '' : '\n';
    const added = text.endsWith('\n') ? text : `${text}\n`;
    const next = `${before}${sep}${added}`;
    this.checkContent(rel, next, true);
    this.put(rel, full, next);
    return `Appended ${lineCount(added)} line(s) to ${this.shown(rel)}${before === '' ? ', a new file' : ''} (${this.usage(rel, next)}).`;
  }

  edit(memPath: string, oldStr: string, newStr: string): string {
    const rel = this.relative(memPath);
    this.assertWritable(rel);
    const full = this.full(rel);
    if (!this.statOrNull(full)) throw new MemoryError(`${this.shown(rel)} does not exist.`);
    const content = this.readFile(full, rel);
    if (oldStr.length === 0) throw new MemoryError('`old` is empty; give the exact text to replace.');
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) throw new MemoryError(`\`old\` does not appear in ${this.shown(rel)}. Read the file and copy the text exactly, including spaces and line breaks.`);
    if (occurrences > 1) {
      const lines: number[] = [];
      let at = content.indexOf(oldStr);
      while (at >= 0) {
        lines.push(content.slice(0, at).split('\n').length);
        at = content.indexOf(oldStr, at + 1);
      }
      throw new MemoryError(`\`old\` appears ${occurrences} times in ${this.shown(rel)} (lines ${[...new Set(lines)].join(', ')}). Include more of the surrounding text so it is unique.`);
    }
    const next = content.replace(oldStr, () => newStr);
    this.checkContent(rel, next, true);
    this.put(rel, full, next);
    const at = content.slice(0, content.indexOf(oldStr)).split('\n').length - 1;
    const nextLines = next.split('\n');
    const from = Math.max(0, at - 2);
    const to = Math.min(nextLines.length, at + 3 + newStr.split('\n').length - 1);
    return `Edited ${this.shown(rel)} (${this.usage(rel, next)}):\n${numbered(nextLines.slice(from, to), from + 1)}`;
  }

  delete(memPath: string): string {
    const rel = this.relative(memPath);
    this.assertWritable(rel);
    if (isCorePath(rel)) throw new MemoryError(`${this.shown(rel)} cannot be deleted; write a shorter version instead.`);
    const full = this.full(rel);
    if (!this.statOrNull(full, true)) throw new MemoryError(`${this.shown(rel)} does not exist.`);
    const gone = this.filesUnder(full, rel);
    fs.rmSync(full, { recursive: true, force: false });
    this.changed(gone);
    return `Deleted ${this.shown(rel)}${gone.length > 1 ? ` (${gone.length} files)` : ''}.`;
  }

  move(fromPath: string, toPath: string): string {
    const from = this.relative(fromPath);
    const to = this.relative(toPath);
    this.assertWritable(from);
    this.assertWritable(to);
    if (isCorePath(from) || isCorePath(to)) throw new MemoryError(`The files under ${MEMORY_ROOT}/core cannot be moved; write them instead.`);
    const src = this.full(from);
    const dst = this.full(to);
    const st = this.statOrNull(src, true);
    if (!st) throw new MemoryError(`${this.shown(from)} does not exist.`);
    if (fs.existsSync(dst)) throw new MemoryError(`${this.shown(to)} already exists.`);
    if (st.isFile() && isNotePath(to)) this.checkContent(to, this.readFile(src, from), true);
    const before = this.filesUnder(src, from);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dst);
    this.changed([...before, ...before.map((p) => to + p.slice(from.length))]);
    return `Moved ${this.shown(from)} to ${this.shown(to)}.`;
  }

  /** Whether a relative path is a file, a directory, or nothing. */
  kind(rel: string): 'file' | 'dir' | null {
    try {
      const st = this.statOrNull(this.full(rel));
      return st?.isFile() ? 'file' : st?.isDirectory() ? 'dir' : null;
    } catch {
      return null;
    }
  }

  /** Text of a memory file by relative path, or undefined. */
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

  /**
   * Write a file on behalf of the runtime (handoff notes, archives) or the owner (console).
   * The size limits of the resident files hold here too; the record stays writable.
   */
  writeText(rel: string, text: string): void {
    const clean = this.relative(rel);
    if (clean === '') throw new MemoryError('A file path is required.');
    if ((clean === 'core' || clean.startsWith('core/')) && !isCorePath(clean)) this.assertWritable(clean);
    this.checkContent(clean, text, false);
    this.put(clean, this.full(clean), text);
  }

  /** Earlier versions of a resident file, newest first. */
  history(rel: string): MemoryVersion[] {
    if (!isCorePath(rel)) return [];
    const dir = this.full(HISTORY_DIR);
    const prefix = `${path.basename(rel, '.md')}-`;
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.md'));
    } catch {
      return [];
    }
    return names
      .sort()
      .reverse()
      .map((name) => ({ name, at: this.stampTime(name.slice(prefix.length, -3)), text: fs.readFileSync(path.join(dir, name), 'utf8') }));
  }

  /** Every visible file (relative paths) with size and mtime. */
  listFiles(): Array<{ path: string; size: number; mtimeMs: number }> {
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
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
    walk(this.dir, '');
    return out;
  }

  /** Write, keeping the version a resident file had before. */
  private put(rel: string, full: string, text: string): void {
    if (isCorePath(rel)) {
      const before = this.statOrNull(full) ? fs.readFileSync(full, 'utf8') : undefined;
      if (before !== undefined && before !== text && before.trim() !== '') this.keepVersion(rel, before);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    this.atomicWrite(full, text);
    this.changed([rel]);
  }

  private keepVersion(rel: string, text: string): void {
    const dir = this.full(HISTORY_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = path.basename(rel, '.md');
    const stamp = new Date(this.now()).toISOString().replace(/:/g, '-');
    let name = `${base}-${stamp}.md`;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${stamp}-${n}.md`;
    this.atomicWrite(path.join(dir, name), text);
    const mine = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${base}-`) && n.endsWith('.md'))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - HISTORY_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
  }

  /** `2026-11-12T05-23-35.123Z` → ISO time. */
  private stampTime(stamp: string): string {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z/.exec(stamp);
    return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] ?? ''}Z` : stamp;
  }

  private filesUnder(full: string, rel: string): string[] {
    const st = this.statOrNull(full, true);
    if (!st) return [];
    if (!st.isDirectory()) return [rel];
    return this.listFiles()
      .map((f) => f.path)
      .filter((p) => p.startsWith(`${rel}/`));
  }

  private readFile(full: string, rel: string): string {
    const st = this.statOrNull(full);
    if (!st) throw new MemoryError(`${this.shown(rel)} does not exist.`);
    if (!st.isFile()) throw new MemoryError(`${this.shown(rel)} is not a file.`);
    if (st.size > MAX_MEMORY_FILE_BYTES) throw new MemoryError(`${this.shown(rel)} is larger than ${formatSize(MAX_MEMORY_FILE_BYTES)}; it cannot be changed here.`);
    return fs.readFileSync(full, 'utf8');
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
