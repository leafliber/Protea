import YAML from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MAX_SUMMARY_CHARS = 200;

export interface NoteParts {
  /** The frontmatter `summary`, or the first line of text. */
  summary: string;
  keywords: string[];
  /** The text after the frontmatter. */
  body: string;
}

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.replace(/^#+\s*/, '').trim().slice(0, MAX_SUMMARY_CHARS);
}

function keywordList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((k): k is string | number => typeof k === 'string' || typeof k === 'number').map(String);
  if (typeof value === 'string') return value.split(/[,，、\s]+/).filter(Boolean);
  return [];
}

/** Split a memory file into its optional YAML frontmatter fields and text. Broken frontmatter counts as text. */
export function parseNote(text: string): NoteParts {
  const m = FRONTMATTER.exec(text);
  if (m) {
    try {
      const doc = YAML.parse(m[1] as string) as unknown;
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        const data = doc as Record<string, unknown>;
        const body = text.slice(m[0].length);
        const summary = typeof data['summary'] === 'string' && data['summary'].trim() ? data['summary'].trim().slice(0, MAX_SUMMARY_CHARS) : firstLine(body);
        return { summary, keywords: keywordList(data['keywords']), body };
      }
    } catch {
      // Not YAML: the whole file is text.
    }
  }
  return { summary: firstLine(text), keywords: [], body: text };
}
