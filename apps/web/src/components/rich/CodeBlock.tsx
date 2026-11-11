import { useState, type ReactNode } from 'react';
import { IconCheck, IconCopy } from '../icons';
import { lazy, useLazy } from './lazy';

/** A node of the tree lowlight returns (hast). */
interface HNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HNode[];
}

const highlighter = lazy(async () => {
  const { common, createLowlight } = await import('lowlight');
  return createLowlight(common);
});

/** The tree as React elements: text and spans with classes, never HTML. */
function toReact(nodes: HNode[], key = 'h'): ReactNode[] {
  return nodes.map((n, i) =>
    n.type === 'text' ? (
      n.value
    ) : (
      <span key={`${key}.${i}`} className={(n.properties?.className ?? []).join(' ')}>
        {toReact(n.children ?? [], `${key}.${i}`)}
      </span>
    ),
  );
}

const FOLD_LINES = 24;

export function CopyText({ text, label = '复制' }: { text: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rich-tool"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text()).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
      <span>{done ? '已复制' : label}</span>
    </button>
  );
}

/** A fenced block: its language, a copy button, colours once the highlighter is there, folded when long. */
export function CodeBlock({ lang, text, live }: { lang: string; text: string; live?: boolean }) {
  const hl = useLazy(highlighter, lang !== '' && !live);
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').length;
  const long = !live && lines > FOLD_LINES;
  let body: ReactNode = text;
  if (hl && lang !== '' && hl.registered(lang)) {
    try {
      body = toReact((hl.highlight(lang, text) as unknown as HNode).children ?? []);
    } catch {
      body = text;
    }
  }
  return (
    <div className="rich-block rich-codeblock">
      <div className="rich-bar">
        <span className="rich-lang">{lang || '文本'}</span>
        <CopyText text={() => text} />
      </div>
      <pre className={long && !open ? 'rich-code rich-fold' : 'rich-code'}>
        <code>{body}</code>
      </pre>
      {long && (
        <button type="button" className="rich-more" onClick={() => setOpen(!open)}>
          {open ? '收起' : `展开全部 ${lines} 行`}
        </button>
      )}
    </div>
  );
}
