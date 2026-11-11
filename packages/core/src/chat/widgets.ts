import crypto from 'node:crypto';
import vm from 'node:vm';
import type { WidgetResponse } from '@protea/protocol';
import type { Db } from '../db/database.js';

/** Markup that reaches outside the widget. The sandbox blocks all of it; naming it lets the model fix the widget at once. */
const EXTERNAL: Array<[RegExp, string]> = [
  [/<script\b[^>]*\bsrc\s*=/i, '<script src>'],
  [/<link\b/i, '<link>'],
  [/<i?frame\b/i, '<iframe>'],
  [/<object\b/i, '<object>'],
  [/<embed\b/i, '<embed>'],
  [/<base\b/i, '<base>'],
  [/<meta\b[^>]*\bhttp-equiv\b/i, '<meta http-equiv>'],
];

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_TYPE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
const CLASSIC = new Set(['', 'text/javascript', 'application/javascript']);

/**
 * Why this widget would not work, in words the model can act on; null when nothing stands out.
 * A hint for the model, not a defence: the sandbox frame is what contains a widget
 * (docs/10-architecture/14-security-and-permissions.md §8).
 */
export function checkWidget(code: string, maxBytes: number): string | null {
  const size = Buffer.byteLength(code, 'utf8');
  if (size > maxBytes) return `the widget is ${Math.ceil(size / 1024)} KB, over the limit of ${Math.floor(maxBytes / 1024)} KB`;
  if (code.trim() === '') return 'the widget is empty';
  for (const [re, name] of EXTERNAL) {
    if (re.test(code)) return `a widget has no network and no external resources: remove ${name} and put scripts, styles and images inline`;
  }
  let n = 0;
  for (const m of code.matchAll(SCRIPT)) {
    n++;
    const type = (SCRIPT_TYPE.exec(m[1] ?? '')?.[1] ?? '').toLowerCase();
    if (!CLASSIC.has(type)) continue;
    try {
      // Compiled, never run.
      new vm.Script(m[2] ?? '', { filename: 'widget' });
    } catch (err) {
      const line = /widget:(\d+)/.exec(err instanceof Error ? (err.stack ?? '') : '')?.[1];
      return `script ${n} of the widget does not parse${line ? ` (line ${line} of that script)` : ''}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}

/**
 * Inline widgets that `chat_send` sent. Content-addressed, so the same widget is stored once.
 * The code leaves only as a string inside a JSON response, never as a page.
 */
export class WidgetStore {
  constructor(private readonly db: Db) {}

  put(w: { title: string; code: string; sessionId?: string; batchId?: string }, at: string): { id: string; title: string } {
    const id = `w${crypto.createHash('sha256').update(w.title).update('\n').update(w.code).digest('hex').slice(0, 32)}`;
    this.db
      .prepare('INSERT OR IGNORE INTO widgets (id, title, code, session_id, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, w.title, w.code, w.sessionId ?? null, w.batchId ?? null, at);
    return { id, title: w.title };
  }

  get(id: string): WidgetResponse | null {
    if (!/^w[a-f0-9]{32}$/.test(id)) return null;
    const r = this.db.prepare('SELECT id, title, code FROM widgets WHERE id = ?').get(id) as WidgetResponse | undefined;
    return r ?? null;
  }
}
