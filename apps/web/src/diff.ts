export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Past this many cell comparisons the middle is shown as "all removed, all added" instead of aligned. */
const MAX_CELLS = 2_000_000;

function split(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line diff of two texts (longest common subsequence). `null` is "no such thing": everything
 * of the other side is added or removed.
 */
export function diffLines(before: string | null, after: string | null): DiffLine[] {
  const a = split(before);
  const b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (x.length * y.length > MAX_CELLS) {
    for (const text of x) out.push({ kind: 'del', text });
    for (const text of y) out.push({ kind: 'add', text });
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? (lcs[(i + 1) * w + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        out.push({ kind: 'same', text: x[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) out.push({ kind: 'del', text: x[i++] as string });
      else out.push({ kind: 'add', text: y[j++] as string });
    }
    while (i < x.length) out.push({ kind: 'del', text: x[i++] as string });
    while (j < y.length) out.push({ kind: 'add', text: y[j++] as string });
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text });
  return out;
}

export type DiffRow = DiffLine | { kind: 'skip'; count: number };

/** Keep `context` unchanged lines around each change; longer unchanged runs become one `skip` row. */
export function foldDiff(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ kind: 'skip', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped > 0) out.push({ kind: 'skip', count: skipped });
  return out;
}

export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length };
}
