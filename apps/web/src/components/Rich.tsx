import type { ReactNode } from 'react';

/**
 * A small, safe Markdown subset for chat replies: fenced code, paragraphs, lists, headings,
 * quotes, `code`, **bold** and http(s) links. Everything is rendered as React text, never HTML.
 */
export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) out.push(...blocks(text.slice(last, m.index), `b${n++}`));
    out.push(
      <pre key={`c${n++}`} className="rich-code">
        {(m[1] ?? '').replace(/\n$/, '')}
      </pre>,
    );
    last = fence.lastIndex;
  }
  if (last < text.length) out.push(...blocks(text.slice(last), `b${n++}`));
  return <div className="rich">{out}</div>;
}

function blocks(src: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  src
    .split(/\n\s*\n/)
    .map((b) => b.replace(/^\n+|\n+$/g, ''))
    .filter((b) => b.trim() !== '')
    .forEach((b, i) => {
      const k = `${key}.${i}`;
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        out.push(
          <ul key={k}>
            {lines.map((l, j) => (
              <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>
            ))}
          </ul>,
        );
      } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        out.push(
          <ol key={k} start={Number(/\d+/.exec(lines[0] ?? '1')?.[0] ?? 1)}>
            {lines.map((l, j) => (
              <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>
            ))}
          </ol>,
        );
      } else if (lines.every((l) => /^>\s?/.test(l))) {
        out.push(<blockquote key={k}>{inline(lines.map((l) => l.replace(/^>\s?/, '')).join('\n'))}</blockquote>);
      } else if (lines.length === 1 && /^#{1,6}\s+/.test(b)) {
        out.push(
          <p key={k} className="rich-h">
            {inline(b.replace(/^#{1,6}\s+/, ''))}
          </p>,
        );
      } else {
        out.push(<p key={k}>{inline(b)}</p>);
      }
    });
  return out;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？'"])/g;

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out.push(<code key={n++}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={n++}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) {
      const label = tok.slice(1, tok.indexOf(']('));
      const href = tok.slice(tok.indexOf('](') + 2, -1);
      out.push(
        <a key={n++} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    } else
      out.push(
        <a key={n++} href={tok} target="_blank" rel="noreferrer noopener">
          {tok}
        </a>,
      );
    last = INLINE.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
