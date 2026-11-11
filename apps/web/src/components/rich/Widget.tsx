import { useEffect, useRef, useState } from 'react';
import type { WidgetResponse } from '@protea/protocol';
import { enc, get } from '../../api';

/** The static sandbox page (packages/control/src/static.ts gives it its own headers). */
const FRAME = './widget-frame.html';
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 640;
const RENDER_MS = 5000;
const MAX_PROMPT = 2000;
const MAX_ERROR = 300;
/** Widgets that run at once; one further from view goes back to a placeholder. */
const MAX_ACTIVE = 4;

/** A widget that never finished loading leaves this behind: after a reload it is not started again on its own. */
const marker = (id: string): string => `protea.widget.loading.${id}`;
const store = {
  has: (id: string): boolean => {
    try {
      return localStorage.getItem(marker(id)) !== null;
    } catch {
      return false;
    }
  },
  set: (id: string): void => {
    try {
      localStorage.setItem(marker(id), '1');
    } catch {
      /* private mode: the timeout still applies */
    }
  },
  clear: (id: string): void => {
    try {
      localStorage.removeItem(marker(id));
    } catch {
      /* nothing to clear */
    }
  },
};

interface Active {
  el: HTMLElement;
  unload: () => void;
}
const active = new Set<Active>();

/** Make room for one more running widget by putting the one furthest from view back to its placeholder. */
function makeRoom(): void {
  if (active.size < MAX_ACTIVE) return;
  const mid = window.innerHeight / 2;
  let far: Active | null = null;
  let most = -1;
  for (const a of active) {
    const r = a.el.getBoundingClientRect();
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d > most) {
      most = d;
      far = a;
    }
  }
  far?.unload();
}

/** `idle`: starts when it scrolls into view. `parked`: put aside to make room, starts on a click. */
type Phase = 'idle' | 'parked' | 'loading' | 'shown' | 'error' | 'stalled' | 'off';

/** Text from the sandbox, made safe to show or to put in the input box: a plain, bounded string. */
function plain(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

/**
 * An inline widget: model-written HTML that runs only inside the sandbox frame
 * (docs/10-architecture/14-security-and-permissions.md §8). This page fetches the code with its
 * own session and hands it to the frame; the frame has an opaque origin and no network. The
 * title bar is drawn here, outside the frame, where the widget cannot change it. Everything the
 * frame posts back is untrusted: a height is clamped, text is only ever text, and `prompt` fills
 * the input box without sending.
 */
export function Widget({ id, title, enabled, tall, onPrompt }: { id: string; title: string; enabled: boolean; tall?: boolean; onPrompt?: (text: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<Phase>(() => (!enabled ? 'off' : store.has(id) ? 'stalled' : 'idle'));
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState(title);
  const [height, setHeight] = useState(120);
  const [problem, setProblem] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [run, setRun] = useState(0);
  const prompt = useRef(onPrompt);
  prompt.current = onPrompt;

  useEffect(() => {
    setPhase((p) => (!enabled ? 'off' : p === 'off' ? 'idle' : p));
  }, [enabled]);

  // Start when it scrolls into view.
  useEffect(() => {
    const el = box.current;
    if (!el || phase !== 'idle') return;
    if (typeof IntersectionObserver === 'undefined') {
      setPhase('loading');
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setPhase('loading'), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [phase]);

  // Fetch the code, then run it in a fresh frame.
  useEffect(() => {
    if (phase !== 'loading') return;
    let gone = false;
    const fail = (why: string) => {
      if (gone) return;
      setProblem(why);
      setPhase('error');
    };
    store.set(id);
    get<WidgetResponse>(`/api/widgets/${enc(id)}`).then(
      (w) => {
        if (gone) return;
        setCode(w.code);
        setName(w.title);
      },
      (e: unknown) => {
        store.clear(id);
        fail(e instanceof Error ? e.message : String(e));
      },
    );
    const timer = setTimeout(() => {
      // It stays marked: a page that hung on it must not start it again by itself.
      fail('5 秒内没有显示出来');
    }, RENDER_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [phase, id, run]);

  // While it runs it counts against the number of live widgets.
  const live = phase === 'loading' || phase === 'shown';
  useEffect(() => {
    if (!live || !box.current) return;
    makeRoom();
    // One that is put aside stays aside until the owner asks for it: it must not start again by itself and push another out.
    const me: Active = { el: box.current, unload: () => setPhase('parked') };
    active.add(me);
    return () => {
      active.delete(me);
    };
  }, [live]);

  // The bridge: only messages from this frame's window, and only these kinds.
  useEffect(() => {
    if (code === null || (phase !== 'loading' && phase !== 'shown')) return;
    let sent = false;
    let lastPrompt = 0;
    const on = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const d = e.data as { type?: unknown; height?: unknown; text?: unknown; message?: unknown } | null;
      if (typeof d !== 'object' || d === null) return;
      switch (d.type) {
        case 'ready':
          if (sent) return;
          sent = true;
          // An opaque origin cannot be named as a target; the frame holds nothing but this code.
          win.postMessage({ type: 'render', code }, '*');
          break;
        case 'rendered':
          store.clear(id);
          setPhase((p) => (p === 'loading' ? 'shown' : p));
          break;
        case 'size': {
          const h = Number(d.height);
          if (Number.isFinite(h)) setHeight(Math.round(Math.min(Math.max(h, MIN_HEIGHT), tall ? 4000 : MAX_HEIGHT)));
          break;
        }
        case 'prompt': {
          // Only right after the owner clicked, with the focus in this widget (so not while they are
          // typing a message), and one at a time.
          const acted = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === true;
          const now = Date.now();
          if (!acted || document.activeElement !== frame.current || now - lastPrompt < 1000) return;
          const text = plain(d.text, MAX_PROMPT).trim();
          if (!text) return;
          lastPrompt = now;
          prompt.current?.(text);
          break;
        }
        case 'error':
          setProblem(plain(d.message, MAX_ERROR));
          break;
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [code, phase, id, tall]);

  const loads = useRef(0);
  useEffect(() => {
    loads.current = 0;
  }, [code, run]);

  const reload = () => {
    store.clear(id);
    setProblem('');
    setCode(null);
    setRun((n) => n + 1);
    setPhase('loading');
  };

  const running = code !== null && (phase === 'loading' || phase === 'shown');
  return (
    <div className="widget" ref={box}>
      <div className="widget-bar">
        <span className="widget-tag">小组件</span>
        <span className="widget-title" title={name}>
          {name}
        </span>
        <span className="spacer" />
        {phase !== 'off' && (
          <>
            <button type="button" className="rich-tool" onClick={reload} title="重新加载">
              重新加载
            </button>
            {!tall && (
              <a className="rich-tool" href={`#/widget/${enc(id)}`} target="_blank" rel="noreferrer noopener" title="在单独的页面打开">
                单独打开
              </a>
            )}
            <button type="button" className="rich-tool" disabled={code === null} onClick={() => setShowSource(!showSource)}>
              {showSource ? '收起源码' : '源码'}
            </button>
          </>
        )}
      </div>
      {phase === 'off' && <div className="widget-note">小组件已停用（配置项 chat.widgets）。</div>}
      {phase === 'idle' && <div className="widget-note">滚动到这里时显示。</div>}
      {phase === 'parked' && (
        <button type="button" className="widget-note widget-start" onClick={() => setPhase('loading')}>
          点击显示
        </button>
      )}
      {phase === 'stalled' && (
        <div className="widget-note">
          上次没有加载完。
          <button type="button" className="cm-link" onClick={reload}>
            点击重试
          </button>
        </div>
      )}
      {phase === 'error' && (
        <div className="widget-note widget-bad">
          小组件没有正常运行{problem ? `：${problem}` : ''}。
          <button type="button" className="cm-link" onClick={reload}>
            重试
          </button>
        </div>
      )}
      {phase === 'loading' && !running && <div className="widget-note">正在加载…</div>}
      {running && (
        <>
          <iframe
            key={run}
            ref={frame}
            className="widget-frame"
            title={`小组件：${name}`}
            src={FRAME}
            sandbox="allow-scripts"
            allow=""
            referrerPolicy="no-referrer"
            style={{ height, visibility: phase === 'shown' ? 'visible' : 'hidden' }}
            onLoad={() => {
              // The frame loads once. A second load means it navigated: take it away.
              if (++loads.current > 1) {
                setProblem('它试图离开自己的框');
                setPhase('error');
              }
            }}
          />
          {phase === 'shown' && problem && <div className="widget-note widget-bad">脚本出错：{problem}</div>}
        </>
      )}
      {showSource && code !== null && <pre className="rich-code widget-source">{code}</pre>}
    </div>
  );
}
