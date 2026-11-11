import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Rich } from '../src/components/rich/Markdown';
import { fencesClosed, settle, splitBlocks } from '../src/components/rich/stream';

const html = (text: string, streaming = false): string => renderToStaticMarkup(createElement(Rich, { text, streaming }));

const REPLY = [
  '## Plan',
  '',
  'Three ways to get there, **fast** or *cheap*, ~~not both~~:',
  '',
  '| Way | Time | Cost |',
  '|:----|-----:|-----:|',
  '| Train | 4.5 h | 553 |',
  '| Plane | 2 h | 1200 |',
  '',
  '- [x] pick a date',
  '- [ ] book',
  '  - seat by the window',
  '',
  '> [!WARNING]',
  '> Prices change on Friday.',
  '',
  '```ts',
  'const total: number = 553 + 1200;',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  a[Pick] --> b[Book]',
  '```',
  '',
  'See [the site](https://example.com/a?b=1) or https://example.org.',
].join('\n');

describe('splitting a reply into blocks', () => {
  it('cuts at blank lines, but not inside a fence, a list or an indented continuation', () => {
    expect(splitBlocks('one\n\ntwo')).toEqual(['one\n', 'two']);
    expect(splitBlocks('```\na\n\nb\n```\n\nafter')).toEqual(['```\na\n\nb\n```\n', 'after']);
    expect(splitBlocks('~~~\na\n```\n\nstill code')).toEqual(['~~~\na\n```\n\nstill code']);
    expect(splitBlocks('- a\n\n- b\n\n  more of b\n\ntext')).toEqual(['- a\n\n- b\n\n  more of b\n', 'text']);
    expect(splitBlocks('1. a\n\n2. b')).toEqual(['1. a\n\n2. b']);
    expect(splitBlocks('')).toEqual([]);
  });

  it('keeps a text with footnotes or link references whole', () => {
    const text = 'See [docs][1] and a note.[^n]\n\n[1]: https://example.com\n\n[^n]: The note.';
    expect(splitBlocks(text)).toEqual([text]);
  });

  it('gives the text back unchanged when the blocks are joined', () => {
    expect(splitBlocks(REPLY).join('\n')).toBe(REPLY);
  });

  it('knows an open fence from a closed one', () => {
    expect(fencesClosed('```js\nlet a')).toBe(false);
    expect(fencesClosed('```js\nlet a\n```')).toBe(true);
    expect(fencesClosed('````\n```\n````')).toBe(true);
    expect(fencesClosed('no fence')).toBe(true);
  });
});

describe('the unfinished end of a reply', () => {
  it('holds a table back until its rule row is complete', () => {
    expect(settle('| Way | Time |')).toBe('');
    expect(settle('| Way | Time |\n|---')).toBe('');
    expect(settle('| Way | Time |\n|---|---|')).toContain('| Way | Time |');
    expect(settle('| Way | Time |\n|---|---|\n| Train | 4')).toContain('| Train | 4');
  });

  it('closes emphasis and code that are still open, and leaves a fence alone', () => {
    expect(settle('this is **bol')).toBe('this is **bol**');
    expect(settle('call `fo')).toBe('call `fo`');
    expect(settle('```js\nconst a = "**x')).toBe('```js\nconst a = "**x');
  });
});

describe('rendering a reply', () => {
  it('shows tables, task lists, callouts, code and links as elements', () => {
    const out = html(REPLY);
    expect(out).toContain('<h3 class="rich-h1">Plan</h3>');
    expect(out).toContain('<strong>fast</strong>');
    expect(out).toContain('<em>cheap</em>');
    expect(out).toContain('<del>not both</del>');
    expect(out).toMatch(/<table[^>]*class="rich-table"/);
    expect(out).toMatch(/<td style="text-align:right">553<\/td>/);
    expect(out).toContain('<input type="checkbox" readOnly="" disabled="" checked=""/>');
    expect(out).toMatch(/<li>seat by the window<\/li>/);
    expect(out).toContain('class="rich-alert rich-alert-warning"');
    expect(out).toContain('Prices change on Friday.');
    expect(out).not.toContain('[!WARNING]');
    expect(out).toContain('<span class="rich-lang">ts</span>');
    expect(out).toContain('const total: number = 553 + 1200;');
    // The diagram is drawn in the browser, after its library is fetched.
    expect(out).toContain('正在画图…');
    expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noreferrer noopener">the site</a>');
    expect(out).toContain('<a href="https://example.org" target="_blank" rel="noreferrer noopener">https://example.org</a>');
  });

  it('never turns the text into markup, a script or a request to another site', () => {
    const out = html(
      [
        '<img src=x onerror="alert(1)"> <script>alert(2)</script>',
        '',
        '<iframe src="https://evil.example"></iframe>',
        '',
        '[click](javascript:alert(3)) [data](data:text/html,<script>alert(4)</script>) [ok](mailto:a@example.com)',
        '',
        '![tracker](https://evil.example/pixel.png) ![local](/api/secrets)',
      ].join('\n'),
    );
    expect(out).not.toMatch(/<img|<script|<iframe/);
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(out).not.toMatch(/href="(javascript|data):/i);
    expect(out).toContain('<span>click</span>');
    expect(out).toContain('href="mailto:a@example.com"');
    // An image in the text is a link to it, never a load.
    expect(out).toContain('<a href="https://evil.example/pixel.png" target="_blank" rel="noreferrer noopener">图片：tracker</a>');
    expect(out).toContain('[图片：local]');
  });

  it('renders every prefix of a reply that is being written', () => {
    for (let n = 0; n <= REPLY.length; n++) {
      expect(() => html(REPLY.slice(0, n), true), `cut at ${n}`).not.toThrow();
    }
    // A table that has only its header does not flash as a line of pipes.
    const cut = REPLY.indexOf('|:----');
    expect(html(REPLY.slice(0, cut), true)).not.toContain('| Way');
    expect(html(REPLY.slice(0, cut))).toContain('| Way');
    // Once written, the stream shows what the finished reply shows.
    expect(html(REPLY, true)).toBe(html(REPLY));
  });
});
