import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock, CopyText } from './CodeBlock';
import { Diagram } from './Diagram';
import { lazy, useLazy } from './lazy';
import { fencesClosed, settle, splitBlocks } from './stream';

/** A node of the tree between Markdown and React (hast), as far as this file looks at it. */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

/** Whether the block being rendered is the unfinished end of a reply that is still being written. */
const Live = createContext(false);

const math = lazy(async () => {
  const [remark, rehype] = await Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css')]);
  return { remark: remark.default, rehype: rehype.default };
});

const ALERTS: Record<string, string> = { NOTE: '说明', TIP: '提示', IMPORTANT: '重要', WARNING: '注意', CAUTION: '警告' };
const ALERT_MARK = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/;

/** `> [!NOTE]` quotes become callouts: the marker leaves the text and the quote is tagged. */
function rehypeAlerts() {
  const walk = (node: HNode): void => {
    for (const child of node.children ?? []) walk(child);
    if (node.type !== 'element' || node.tagName !== 'blockquote') return;
    const p = node.children?.find((c) => c.type === 'element');
    const first = p?.tagName === 'p' ? p.children?.[0] : undefined;
    const m = first?.type === 'text' ? ALERT_MARK.exec(first.value ?? '') : null;
    if (!m || !first) return;
    first.value = (first.value ?? '').slice(m[0].length);
    node.properties = { ...node.properties, dataAlert: (m[1] as string).toLowerCase() };
  };
  return (tree: HNode): void => walk(tree);
}

const textOf = (n: HNode | undefined): string => (n ? (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join('')) : '');

/** Only links that open a page or a mail window; anything else is shown as text. */
function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url.trim()) ? url : '';
}

const FOLD_ROWS = 12;

/** A table that scrolls sideways inside the column, folds when long and copies as tab-separated text. */
function Table({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const [rows, setRows] = useState(0);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    setRows(ref.current?.tBodies[0]?.rows.length ?? 0);
  });
  const tsv = (): string =>
    [...(ref.current?.rows ?? [])].map((r) => [...r.cells].map((c) => (c.textContent ?? '').replace(/[\t\n]+/g, ' ')).join('\t')).join('\n');
  const long = rows > FOLD_ROWS;
  return (
    <div className="rich-block rich-tableblock">
      <div className="rich-bar">
        <span className="rich-lang">表格</span>
        <CopyText text={tsv} />
      </div>
      <div className="rich-table-scroll">
        <table ref={ref} className={long && !open ? 'rich-table rich-table-fold' : 'rich-table'}>
          {children}
        </table>
      </div>
      {long && (
        <button type="button" className="rich-more" onClick={() => setOpen(!open)}>
          {open ? '收起' : `展开全部 ${rows} 行`}
        </button>
      )}
    </div>
  );
}

function Pre({ node, children }: { node?: unknown; children?: ReactNode }) {
  const live = useContext(Live);
  const code = (node as HNode | undefined)?.children?.find((c) => c.tagName === 'code');
  if (!code) return <pre className="rich-code">{children}</pre>;
  const cls = (code.properties?.['className'] as string[] | undefined) ?? [];
  const lang = (cls.find((c) => c.startsWith('language-')) ?? '').slice(9).toLowerCase();
  const text = textOf(code).replace(/\n$/, '');
  if (lang === 'mermaid') return <Diagram source={text} live={live} />;
  return <CodeBlock lang={lang} text={text} live={live} />;
}

const COMPONENTS: Components = {
  // A reply is part of a conversation: its headings are smaller than the page's.
  h1: ({ children }) => <h3 className="rich-h1">{children}</h3>,
  h2: ({ children }) => <h3 className="rich-h1">{children}</h3>,
  h3: ({ children }) => <h4 className="rich-h2">{children}</h4>,
  h4: ({ children }) => <h5 className="rich-h3">{children}</h5>,
  h5: ({ children }) => <h5 className="rich-h3">{children}</h5>,
  h6: ({ children }) => <h5 className="rich-h3">{children}</h5>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Nothing is loaded from other sites; an image in the text is a link to it. The assistant's own pictures come as attachments.
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? safeUrl(src) : '';
    const label = `图片${alt ? `：${alt}` : ''}`;
    return url.startsWith('http') ? (
      <a href={url} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    ) : (
      <span className="muted">[{label}]</span>
    );
  },
  pre: Pre,
  table: ({ children }) => <Table>{children}</Table>,
  blockquote: ({ node, children }) => {
    const kind = (node as HNode | undefined)?.properties?.['dataAlert'] as string | undefined;
    if (!kind) return <blockquote>{children}</blockquote>;
    return (
      <div className={`rich-alert rich-alert-${kind}`} role="note">
        <div className="rich-alert-title">{ALERTS[kind.toUpperCase()]}</div>
        {children}
      </div>
    );
  },
  input: ({ checked }) => <input type="checkbox" checked={checked === true} readOnly disabled />,
};

const HAS_MATH = /\$\$/;

/** One top-level block. Finished blocks never render again while the reply grows. */
const Block = memo(function Block({ src, live }: { src: string; live: boolean }) {
  const m = useLazy(math, HAS_MATH.test(src));
  const shown = live ? settle(src) : src;
  const remark = useMemo(() => (m && HAS_MATH.test(src) ? [remarkGfm, [m.remark, { singleDollarTextMath: false }]] : [remarkGfm]), [m, src]);
  const rehype = useMemo(() => (m && HAS_MATH.test(src) ? [rehypeAlerts, m.rehype] : [rehypeAlerts]), [m, src]);
  if (shown.trim() === '') return null;
  return (
    <Live.Provider value={live && !fencesClosed(src)}>
      {/* Raw HTML in the text is shown as text: no plugin that would render it is ever added here. */}
      <ReactMarkdown remarkPlugins={remark as never} rehypePlugins={rehype as never} components={COMPONENTS} urlTransform={safeUrl}>
        {shown}
      </ReactMarkdown>
    </Live.Provider>
  );
});

/**
 * A chat reply: GitHub-flavoured Markdown with tables, task lists, callouts, code, mermaid
 * diagrams and `$$` formulas, built as React elements and never from an HTML string
 * (docs/10-architecture/13-control-plane.md §5). `streaming` marks a reply that is still being written.
 */
export function Rich({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="rich">
      {blocks.map((b, i) => (
        <Block key={i} src={b} live={streaming === true && i === blocks.length - 1} />
      ))}
    </div>
  );
}
