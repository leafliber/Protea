import remend from 'remend';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;
/** Definitions that other blocks refer to: footnotes and link references. With these, the text stays whole. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/**
 * Cut Markdown into top-level blocks at blank lines, so a reply that is still being written
 * re-parses only its last block. Never cuts inside a fenced block, before an indented line
 * (a continuation of what is above) or between the items of one list.
 */
export function splitBlocks(text: string): string[] {
  if (DEFINITION.test(text)) return [text];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  let blank = false;
  for (const line of lines) {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      cur.push(line);
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
      continue;
    }
    if (line.trim() === '') {
      blank = true;
      cur.push(line);
      continue;
    }
    if (blank && cur.some((l) => l.trim() !== '')) {
      const first = cur.find((l) => l.trim() !== '') as string;
      const continues = /^[ \t]/.test(line) || (LIST_ITEM.test(first) && LIST_ITEM.test(line));
      if (!continues) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
    }
    blank = false;
    cur.push(line);
    if (f) fence = f;
  }
  if (cur.some((l) => l.trim() !== '')) blocks.push(cur.join('\n'));
  return blocks;
}

/** Whether every fence in this block is closed. */
export function fencesClosed(block: string): boolean {
  let fence: string | null = null;
  for (const line of block.split('\n')) {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
    } else if (f) fence = f;
  }
  return fence === null;
}

const TABLE_ROW = /^\s*\|/;
const cells = (row: string): number => row.trim().replace(/^\||\|$/g, '').split('|').length;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * The last block of a reply that is still being written, made fit to show: a table waits for its
 * rule row (it would flash as lines of pipes), and unclosed emphasis, code and links are closed.
 * Only what is shown changes; the stored text is the model's.
 */
export function settle(tail: string): string {
  if (!fencesClosed(tail)) return tail;
  const lines = tail.split('\n').filter((l) => l.trim() !== '');
  if (lines.length > 0 && lines.every((l) => TABLE_ROW.test(l))) {
    const rule = lines[1];
    const ready = rule !== undefined && TABLE_RULE.test(rule) && cells(rule) >= cells(lines[0] as string);
    if (!ready) return '';
  }
  try {
    return remend(tail);
  } catch {
    return tail;
  }
}
