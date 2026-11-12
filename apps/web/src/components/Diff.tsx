import { useMemo, useState } from 'react';
import { diffLines, diffStat, foldDiff } from '../diff';
import { cx } from './ui';

const SIGN = { same: ' ', add: '+', del: '-' } as const;

/**
 * Two versions of a text, line by line: removed lines, added lines, and a little of what
 * stayed around them. With only one side it is simply everything added or everything removed.
 */
export function Diff({ before, after }: { before: string | null; after: string | null }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const [all, setAll] = useState(false);
  const stat = diffStat(lines);
  const changed = stat.added + stat.removed > 0;
  const rows = all || !changed ? lines : foldDiff(lines);
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-add">+{stat.added}</span> <span className="diff-del">−{stat.removed}</span>
        {!changed && <span className="muted">内容没有变化</span>}
        {changed && lines.length > stat.added + stat.removed && (
          <button type="button" className="link-btn" onClick={() => setAll(!all)}>
            {all ? '只看改动' : '显示全文'}
          </button>
        )}
      </div>
      <pre className="diff-body">
        {rows.map((r, i) =>
          r.kind === 'skip' ? (
            <div key={i} className="diff-skip">
              ⋯ {r.count} 行没有变化
            </div>
          ) : (
            <div key={i} className={cx('diff-line', r.kind === 'add' && 'diff-line-add', r.kind === 'del' && 'diff-line-del')}>
              <span className="diff-sign">{SIGN[r.kind]}</span>
              {r.text || ' '}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}
