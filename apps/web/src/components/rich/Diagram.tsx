import { useEffect, useState } from 'react';
import { CodeBlock, CopyText } from './CodeBlock';
import { lazy, useLazy } from './lazy';

const MAX_SOURCE = 8000;
const RENDER_MS = 3000;

const mermaidLib = lazy(async () => (await import('mermaid')).default);
let seq = 0;

const dark = (): boolean => window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;

/**
 * Mermaid's SVG with everything that could act taken out: links are unwrapped, and scripts,
 * embedded HTML and event attributes are removed. `strict` mode should leave none of these; this
 * does not rely on it.
 */
function defang(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('svg');
  for (const a of [...doc.querySelectorAll('a')]) a.replaceWith(...a.childNodes);
  for (const el of [...doc.querySelectorAll('script, foreignObject, iframe, object, embed, use[href^="http"], image[href^="http"]')]) el.remove();
  for (const el of [...doc.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || (/href$/i.test(attr.name) && /^\s*(javascript|data|https?):/i.test(attr.value))) el.removeAttribute(attr.name);
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}

type State = { kind: 'wait' } | { kind: 'svg'; svg: string } | { kind: 'bad'; why: string };

/**
 * A ```mermaid block as a picture. The one place where markup that React did not build enters
 * the page: Mermaid's own SVG, made in `strict` mode (no click handlers, sanitized, labels as SVG
 * text). The page's CSP stays as it is, so a script or a request from outside would not run
 * even if something slipped through. A diagram that does not parse shows its source instead.
 */
export function Diagram({ source, live }: { source: string; live?: boolean }) {
  const lib = useLazy(mermaidLib, !live);
  const [state, setState] = useState<State>({ kind: 'wait' });
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    if (live || !lib) return;
    if (source.length > MAX_SOURCE) {
      setState({ kind: 'bad', why: '图太大，没有渲染' });
      return;
    }
    let gone = false;
    const timer = setTimeout(() => {
      if (!gone) setState({ kind: 'bad', why: '渲染超时' });
      gone = true;
    }, RENDER_MS);
    void (async () => {
      try {
        lib.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark() ? 'dark' : 'neutral', htmlLabels: false, flowchart: { htmlLabels: false }, suppressErrorRendering: true });
        const ok = await lib.parse(source, { suppressErrors: true });
        if (!ok) throw new Error('syntax');
        const { svg } = await lib.render(`mmd-${++seq}`, source);
        if (!gone) setState({ kind: 'svg', svg: defang(svg) });
      } catch {
        if (!gone) setState({ kind: 'bad', why: '图表语法有误' });
      } finally {
        gone = true;
        clearTimeout(timer);
      }
    })();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [lib, source, live]);

  useEffect(() => {
    if (!zoom) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(false);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [zoom]);

  if (live || state.kind === 'wait') {
    return (
      <div className="rich-block rich-diagram rich-pending" aria-busy="true">
        正在画图…
      </div>
    );
  }
  if (state.kind === 'bad') {
    return (
      <div className="rich-diagram-bad">
        <div className="rich-note">{state.why}，下面是源码。</div>
        <CodeBlock lang="mermaid" text={source} />
      </div>
    );
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const picture = <div className="rich-svg" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  return (
    <div className="rich-block rich-diagram">
      <div className="rich-bar">
        <span className="rich-lang">图</span>
        <button type="button" className="rich-tool" onClick={() => setZoom(true)}>
          放大
        </button>
        <button type="button" className="rich-tool" onClick={() => setShowSource(!showSource)}>
          {showSource ? '看图' : '源码'}
        </button>
        <CopyText text={() => source} label="复制源码" />
        <button type="button" className="rich-tool" onClick={download}>
          下载 SVG
        </button>
      </div>
      {showSource ? <pre className="rich-code">{source}</pre> : picture}
      {zoom && (
        <div className="lightbox" role="dialog" aria-label="放大的图" onClick={() => setZoom(false)}>
          <div className="lightbox-svg" dangerouslySetInnerHTML={{ __html: state.svg }} />
        </div>
      )}
    </div>
  );
}
