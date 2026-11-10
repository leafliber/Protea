import { BOARD_SECTIONS, type BoardCommand, type BoardItem, type BoardSection } from '@protea/protocol';
import type { Db } from '../db/database.js';
import type { KvNamespace } from '../db/repos.js';
import { escapeStructural } from '../util/escape.js';
import type { BoardSettings } from './settings.js';

const META_KEY = 'board';
const MAX_ITEM_CHARS = 500;
const ID_PREFIX: Record<BoardSection, string> = { goals: 'g', todo: 't', notes: 'n' };

export class BoardError extends Error {
  override readonly name = 'BoardError';
}

/** Who changed the whiteboard: the main session knows what it did itself, anything else has to be shown to it. */
export type BoardActor = 'main' | 'external';

interface BoardMeta {
  rev: number;
  externalRev: number;
  seq: number;
}

interface BoardRow {
  id: string;
  section: BoardSection;
  text: string;
  due: string | null;
  state: BoardItem['state'];
  outcome: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function toItem(r: BoardRow): BoardItem {
  return {
    id: r.id,
    section: r.section,
    text: r.text,
    ...(r.due !== null ? { due: r.due } : {}),
    state: r.state,
    ...(r.outcome !== null ? { outcome: r.outcome } : {}),
    ...(r.source !== null ? { source: r.source } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.closed_at !== null ? { closedAt: r.closed_at } : {}),
  };
}

function cleanText(text: unknown): string {
  if (typeof text !== 'string' || text.trim() === '') throw new BoardError('Missing required parameter `text`.');
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length > MAX_ITEM_CHARS) throw new BoardError(`An item is limited to ${MAX_ITEM_CHARS} characters; put the details in a note and keep a short line here.`);
  return clean;
}

function cleanDue(due: unknown): string {
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ]\S+)?$/.test(due.trim())) throw new BoardError('`due` must be a date (YYYY-MM-DD) or an ISO time.');
  return due.trim();
}

function cleanSection(section: unknown): BoardSection {
  if (!BOARD_SECTIONS.includes(section as BoardSection)) throw new BoardError(`\`section\` must be one of ${BOARD_SECTIONS.join(', ')}.`);
  return section as BoardSection;
}

/**
 * The whiteboard (docs/10-architecture/11-memory-and-persona.md): goals, todo and notes the
 * assistant keeps current. It is state, not a document: one row per item, closed items kept
 * for review. It never enters the system prefix; the model sees it through transcript
 * messages, so editing it does not touch the cached part of a request.
 */
export class Board {
  constructor(
    private readonly db: Db,
    private readonly kv: KvNamespace,
    private readonly settings: () => BoardSettings,
    private readonly now: () => string,
  ) {}

  private meta(): BoardMeta {
    return this.kv.get<BoardMeta>(META_KEY) ?? { rev: 0, externalRev: 0, seq: 0 };
  }

  get rev(): number {
    return this.meta().rev;
  }

  /** The revision of the latest change the main session did not make itself. */
  get externalRev(): number {
    return this.meta().externalRev;
  }

  open(): BoardItem[] {
    const rows = this.db
      .prepare("SELECT * FROM board_items WHERE state = 'open' ORDER BY due IS NULL, due, seq")
      .all() as BoardRow[];
    return rows.map(toItem);
  }

  closed(limit = 50): BoardItem[] {
    const rows = this.db
      .prepare("SELECT * FROM board_items WHERE state != 'open' ORDER BY closed_at DESC, seq DESC LIMIT ?")
      .all(limit) as BoardRow[];
    return rows.map(toItem);
  }

  /** The whole board as one block; an empty board is rendered too, so clearing it is visible. */
  render(): string {
    const items = this.open();
    const rev = this.rev;
    if (items.length === 0) return `<board rev="${rev}" empty="true"/>`;
    const lines = [`<board rev="${rev}">`];
    for (const section of BOARD_SECTIONS) {
      const inSection = items.filter((i) => i.section === section);
      if (inSection.length === 0) continue;
      lines.push(`## ${section}`);
      for (const i of inSection) lines.push(`- ${i.id} ${escapeStructural(i.text)}${i.due ? ` (due ${i.due})` : ''}`);
    }
    lines.push('</board>');
    return lines.join('\n');
  }

  /** Apply a change and return a one-line receipt. Throws BoardError on anything invalid; nothing is changed then. */
  apply(cmd: BoardCommand, actor: BoardActor, source?: string): string {
    return this.db.transaction(() => {
      const verb = this.change(cmd, source);
      const limits = this.settings();
      const open = this.open();
      if (open.length > limits.maxItems) throw new BoardError(`The board is full (${limits.maxItems} items): close or merge some first.`);
      const meta = this.meta();
      meta.rev += 1;
      if (actor === 'external') meta.externalRev = meta.rev;
      this.kv.set(META_KEY, meta);
      if (this.render().length > limits.maxChars) throw new BoardError(`The board would exceed ${limits.maxChars} characters: close or shorten some items first.`);
      const counts = BOARD_SECTIONS.map((s) => `${s} ${open.filter((i) => i.section === s).length}`).join(', ');
      return `${verb} (board rev ${meta.rev}: ${counts})`;
    })();
  }

  private change(cmd: BoardCommand, source?: string): string {
    const now = this.now();
    switch (cmd.command) {
      case 'add': {
        const section = cleanSection(cmd.section);
        const text = cleanText(cmd.text);
        const due = cmd.due === undefined || cmd.due === '' ? null : cleanDue(cmd.due);
        const meta = this.meta();
        meta.seq += 1;
        this.kv.set(META_KEY, meta);
        const id = `${ID_PREFIX[section]}${meta.seq}`;
        this.db
          .prepare('INSERT INTO board_items (id, section, text, due, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, section, text, due, source ?? null, now, now);
        return `added ${id} to ${section}`;
      }
      case 'update': {
        const item = this.openItem(cmd.id);
        const section = cmd.section === undefined ? item.section : cleanSection(cmd.section);
        const text = cmd.text === undefined ? item.text : cleanText(cmd.text);
        const due = cmd.due === undefined ? (item.due ?? null) : cmd.due === '' ? null : cleanDue(cmd.due);
        this.db.prepare('UPDATE board_items SET section = ?, text = ?, due = ?, updated_at = ? WHERE id = ?').run(section, text, due, now, item.id);
        return `updated ${item.id}`;
      }
      case 'done':
      case 'drop': {
        const item = this.openItem(cmd.id);
        const state = cmd.command === 'done' ? 'done' : 'dropped';
        const outcome = typeof cmd.outcome === 'string' && cmd.outcome.trim() ? cmd.outcome.trim() : null;
        this.db.prepare('UPDATE board_items SET state = ?, outcome = ?, updated_at = ?, closed_at = ? WHERE id = ?').run(state, outcome, now, now, item.id);
        return `${state} ${item.id}`;
      }
      default:
        throw new BoardError(`Unknown command ${JSON.stringify((cmd as { command: unknown }).command)}.`);
    }
  }

  private openItem(id: unknown): BoardItem {
    if (typeof id !== 'string' || id === '') throw new BoardError('Missing required parameter `id`.');
    const row = this.db.prepare("SELECT * FROM board_items WHERE id = ? AND state = 'open'").get(id) as BoardRow | undefined;
    if (!row) throw new BoardError(`There is no open item ${id}.`);
    return toItem(row);
  }
}

/** True for the text of a block `Board.render` produced. */
export function isBoardText(text: string): boolean {
  return /^<board[\s>/]/.test(text);
}
