import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';
import { cx } from './ui';

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
/** Raster pictures are not blown up past this when they open (a diagram scales freely). */
const RASTER_FIT_MAX = 2;
/** A press that travels less than this is a click, not a drag. */
const DRAG_PX = 4;

export interface View {
  /** Scale of the picture: 1 is its own size. */
  s: number;
  /** Offset of the picture's centre from the stage's centre, in CSS pixels. */
  x: number;
  y: number;
}

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The scale at which a `w`×`h` picture fills the stage without leaving it. */
export function fitScale(w: number, h: number, stageW: number, stageH: number, vector: boolean): number {
  if (!(w > 0 && h > 0 && stageW > 0 && stageH > 0)) return 1;
  // A diagram sits on a panel with a margin of its own, so it gets a little less of the stage.
  const share = vector ? 0.9 : 0.96;
  const fill = Math.min((stageW * share) / w, (stageH * share) / h);
  // A big picture shrinks to fit; a small one grows, but a photo not so far that it turns to mush.
  return clampScale(vector ? fill : Math.min(fill, Math.max(1, Math.min(RASTER_FIT_MAX, fill))));
}

/** Zoom by `factor` keeping the point (`px`, `py`), measured from the stage's centre, where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const s = clampScale(v.s * factor);
  const k = s / v.s;
  return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** The drawing's own size, from its viewBox (Mermaid always writes one). */
export function svgSize(svg: string): { w: number; h: number } {
  const box = /viewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']/.exec(svg);
  const w = box ? Number(box[1]) : NaN;
  const h = box ? Number(box[2]) : NaN;
  return w > 0 && h > 0 ? { w, h } : { w: 960, h: 640 };
}

/**
 * A picture or a diagram over the whole window: it opens as large as fits, the wheel or a pinch
 * zooms around the pointer, a drag moves it, a double click switches between fitting and full
 * size. Rendered into <body>, so the styles of wherever it was opened from do not reach it.
 * `svg` must already be safe to insert (Diagram defangs Mermaid's output).
 */
export function Lightbox({ label, src, svg, onClose }: { label: string; src?: string; svg?: string; onClose: () => void }) {
  const vector = svg !== undefined;
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => (svg !== undefined ? svgSize(svg) : null));
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [fitted, setFitted] = useState(true);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;

  const fitNow = useCallback((): number => {
    const el = stage.current;
    if (!el || !size) return 1;
    return fitScale(size.w, size.h, el.clientWidth, el.clientHeight, vector);
  }, [size, vector]);

  const fit = useCallback(() => {
    setView({ s: fitNow(), x: 0, y: 0 });
    setFitted(true);
  }, [fitNow]);

  const actual = useCallback(() => {
    setView({ s: 1, x: 0, y: 0 });
    setFitted(false);
  }, []);

  const zoom = useCallback((factor: number, px = 0, py = 0) => {
    setView((v) => zoomAt(v, factor, px, py));
    setFitted(false);
  }, []);

  useLayoutEffect(() => {
    if (size) fit();
  }, [size, fit]);

  useEffect(() => {
    if (!fitted) return;
    const on = () => setView({ s: fitNow(), x: 0, y: 0 });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [fitted, fitNow]);

  useEffect(() => {
    // Capture: a drawer or dialog underneath must not close on the same Esc.
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      else if (e.key === '+' || e.key === '=') zoom(1.25);
      else if (e.key === '-' || e.key === '_') zoom(0.8);
      else if (e.key === '0') fit();
      else if (e.key === '1') actual();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', on, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', on, true);
      document.body.style.overflow = overflow;
    };
  }, [zoom, fit, actual]);

  /** A point of the window, measured from the stage's centre. */
  const fromCentre = (clientX: number, clientY: number): [number, number] => {
    const r = stage.current?.getBoundingClientRect();
    return r ? [clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2)] : [0, 0];
  };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    // Not passive: the page behind must not scroll or zoom instead.
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const [px, py] = fromCentre(e.clientX, e.clientY);
      // A trackpad pinch arrives as ctrl+wheel with small deltas.
      zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), px, py);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [zoom]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<{ onBackdrop: boolean; travelled: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) press.current = { onBackdrop: e.target === e.currentTarget, travelled: 0 };
    else if (press.current) press.current.travelled = Infinity;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const was = pointers.current.get(e.pointerId);
    if (!was) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, now);
    if (pointers.current.size === 1) {
      const dx = now.x - was.x;
      const dy = now.y - was.y;
      if (press.current) press.current.travelled += Math.abs(dx) + Math.abs(dy);
      if ((press.current?.travelled ?? 0) < DRAG_PX) return;
      setDragging(true);
      setFitted(false);
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      return;
    }
    const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
    if (!other) return;
    const before = Math.hypot(was.x - other.x, was.y - other.y);
    const after = Math.hypot(now.x - other.x, now.y - other.y);
    if (before > 0 && after > 0) {
      const [px, py] = fromCentre((now.x + other.x) / 2, (now.y + other.y) / 2);
      zoom(after / before, px, py);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size > 0) return;
    const p = press.current;
    press.current = null;
    setDragging(false);
    if (e.type === 'pointerup' && p && p.onBackdrop && p.travelled < DRAG_PX) onClose();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) return;
    if (fitted && Math.abs(view.s - 1) > 0.01) {
      const [px, py] = fromCentre(e.clientX, e.clientY);
      setView((v) => zoomAt(v, 1 / v.s, px, py));
      setFitted(false);
    } else fit();
  };

  const style = size ? { width: size.w, height: size.h, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.s})` } : undefined;
  const content = failed ? (
    <div className="lightbox-gone">图片已不再保存</div>
  ) : svg !== undefined ? (
    <div className="lightbox-content lightbox-vector" style={style} dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <div className={cx('lightbox-content', !size && 'lightbox-loading')} style={style}>
      <img src={src} alt={label} draggable={false} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
    </div>
  );

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={label}>
      <div className="lightbox-bar">
        <button type="button" className="lightbox-btn" onClick={() => zoom(0.8)} aria-label="缩小" title="缩小（-）">
          −
        </button>
        <span className="lightbox-pct" aria-live="polite">
          {Math.round(view.s * 100)}%
        </span>
        <button type="button" className="lightbox-btn" onClick={() => zoom(1.25)} aria-label="放大" title="放大（+）">
          +
        </button>
        <button type="button" className={cx('lightbox-btn', fitted && 'lightbox-on')} onClick={fit} title="适应窗口（0）">
          适应
        </button>
        <button type="button" className="lightbox-btn" onClick={actual} title="原始大小（1）">
          1:1
        </button>
        {src !== undefined && (
          <a className="lightbox-btn" href={src} target="_blank" rel="noreferrer" title="在新标签页打开">
            新标签打开
          </a>
        )}
        <button type="button" className="lightbox-btn lightbox-close" onClick={onClose} aria-label="关闭" title="关闭（Esc）">
          <IconClose size={18} />
        </button>
      </div>
      <div
        ref={stage}
        className={cx('lightbox-stage', dragging && 'lightbox-dragging')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {content}
      </div>
    </div>,
    document.body,
  );
}
