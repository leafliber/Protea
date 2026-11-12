import { parseNote } from './frontmatter.js';

/** A piece of a memory file that search returns on its own. Lines are 1-based and inclusive. */
export interface Chunk {
  start: number;
  end: number;
  /** The heading the piece sits under (a message header in an archive), or ''. */
  heading: string;
  text: string;
}

/** Past this size a piece ends at the next blank line or list item. */
const TARGET_CHARS = 1_200;
/** Past this size a piece ends at the next line, whatever it is. */
const MAX_CHARS = 3_000;

const HEADING = /^#{1,6}\s+(.*)$/;
/** A message header in a conversation archive (raw/): `--- assistant ---`. */
const MESSAGE = /^--- (.+) ---$/;
const SOFT = /^(\s*$|[-*+] |\d+\. )/;

/**
 * Split a memory file into pieces for search: at headings and archived messages, and where
 * a piece grows long, at blank lines and list items (a journal entry each). The frontmatter
 * is not part of any piece; its summary and keywords belong to the file.
 */
export function chunkText(text: string): Chunk[] {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const skip = parseNote(text).headerLines;
  const out: Chunk[] = [];
  let start = skip + 1;
  let buf: string[] = [];
  let size = 0;
  let heading = '';
  let bufHeading = '';
  const flush = (end: number): void => {
    if (buf.some((l) => l.trim() !== '')) out.push({ start, end, heading: bufHeading, text: buf.join('\n') });
    buf = [];
    size = 0;
  };
  for (let i = skip; i < lines.length; i++) {
    const line = lines[i] as string;
    const h = HEADING.exec(line) ?? MESSAGE.exec(line);
    const boundary = h !== null || (size >= TARGET_CHARS && SOFT.test(line)) || size >= MAX_CHARS;
    if (boundary && buf.length > 0) {
      flush(i);
      start = i + 1;
    }
    if (h) heading = (h[1] ?? '').trim();
    if (buf.length === 0) {
      start = i + 1;
      bufHeading = heading;
    }
    buf.push(line);
    size += line.length + 1;
  }
  flush(lines.length);
  return out;
}
