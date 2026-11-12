import { describe, expect, it } from 'vitest';
import { diffLines, diffStat, foldDiff } from '../src/diff';
import { MAX_SCALE, MIN_SCALE, fitScale, svgSize, zoomAt } from '../src/components/Lightbox';
import { chatActivity, visiblePlugins } from '../src/view-logic';

describe('line diff', () => {
  it('finds what was removed and added and keeps the rest', () => {
    const d = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'add', text: 'e' },
    ]);
    expect(diffStat(d)).toEqual({ added: 2, removed: 1 });
  });

  it('treats a missing side as everything added or removed', () => {
    expect(diffLines(null, 'x\ny')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
    expect(diffLines('x\n', null)).toEqual([{ kind: 'del', text: 'x' }]);
    expect(diffLines('same\n', 'same\n')).toEqual([{ kind: 'same', text: 'same' }]);
    expect(diffLines(null, null)).toEqual([]);
  });

  it('folds long unchanged stretches, keeping a few lines around each change', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[15] = 'changed';
    const rows = foldDiff(diffLines(before.join('\n'), after.join('\n')), 2);
    expect(rows.map((r) => (r.kind === 'skip' ? `skip ${r.count}` : `${r.kind} ${r.text}`))).toEqual([
      'skip 13',
      'same line 13',
      'same line 14',
      'del line 15',
      'add changed',
      'same line 16',
      'same line 17',
      'skip 12',
    ]);
  });

  it('still answers when the two texts are too different to align', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join('\n');
    expect(diffStat(diffLines(a, b))).toEqual({ added: 1500, removed: 1500 });
  });
});

describe('the enlarged picture', () => {
  it('opens a large picture as big as fits, and does not shrink a small one', () => {
    // 4000×2000 in a 1000×800 stage: limited by the width.
    expect(fitScale(4000, 2000, 1000, 800, false)).toBeCloseTo(0.24);
    // A screenshot smaller than the stage grows to fill it, but not past twice its size.
    expect(fitScale(640, 360, 1600, 1000, false)).toBe(2);
    expect(fitScale(1200, 700, 1600, 1000, false)).toBeCloseTo(1.28);
    // A diagram has no pixels to blur: it fills the stage.
    expect(fitScale(200, 100, 1600, 1000, true)).toBeCloseTo(7.2);
    expect(fitScale(0, 0, 1600, 1000, false)).toBe(1);
  });

  it('zooms around the pointer and stays within its limits', () => {
    // The point under the pointer (100, 50 from the centre) stays where it is.
    const v = zoomAt({ s: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(v).toEqual({ s: 2, x: -100, y: -50 });
    const back = zoomAt(v, 0.5, 100, 50);
    expect(back.s).toBe(1);
    expect(back.x).toBeCloseTo(0);
    expect(back.y).toBeCloseTo(0);
    expect(zoomAt({ s: 4, x: 0, y: 0 }, 100, 0, 0).s).toBe(MAX_SCALE);
    expect(zoomAt({ s: 1, x: 0, y: 0 }, 0.0001, 0, 0).s).toBe(MIN_SCALE);
  });

  it('reads a diagram’s size from its viewBox', () => {
    expect(svgSize('<svg viewBox="0 0 812.5 344" style="max-width: 812px">')).toEqual({ w: 812.5, h: 344 });
    expect(svgSize("<svg viewBox='-8 -8 100,60'>")).toEqual({ w: 100, h: 60 });
    expect(svgSize('<svg>')).toEqual({ w: 960, h: 640 });
  });
});

describe('what the console lists and the chat shows', () => {
  it('leaves disabled plugins out unless asked', () => {
    const plugins = [
      { id: 'cron', enabled: true },
      { id: 'wechat', enabled: false },
    ];
    expect(visiblePlugins(plugins, false).map((p) => p.id)).toEqual(['cron']);
    expect(visiblePlugins(plugins, true).map((p) => p.id)).toEqual(['cron', 'wechat']);
  });

  it('does not show "thinking" for the model round that follows a delivered reply', () => {
    const base = { active: true, drafts: 0, replied: false } as const;
    expect(chatActivity({ ...base, phase: 'model' })).toBe('typing');
    expect(chatActivity({ ...base, phase: 'tools' })).toBe('typing');
    // The reply is on screen; the model is only deciding whether anything is left.
    expect(chatActivity({ ...base, phase: 'model', replied: true })).toBe('wrapping');
    // It went on to real work after replying: that is shown.
    expect(chatActivity({ ...base, phase: 'tools', replied: true })).toBe('typing');
    // A reply being written shows itself.
    expect(chatActivity({ ...base, phase: 'model', drafts: 1 })).toBe('none');
    expect(chatActivity({ ...base, phase: 'model', drafts: 1, replied: true })).toBe('none');
    expect(chatActivity({ ...base, active: false, phase: 'model' })).toBe('none');
  });
});
