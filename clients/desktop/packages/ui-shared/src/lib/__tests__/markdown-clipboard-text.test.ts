import { fromMarkdown } from 'mdast-util-from-markdown';
import type * as MdastFromMarkdown from 'mdast-util-from-markdown';
import { markdownToClipboardText } from '../markdown-clipboard-text';

jest.mock('mdast-util-from-markdown', () => {
  const actual = jest.requireActual<typeof MdastFromMarkdown>(
    'mdast-util-from-markdown',
  );
  return { ...actual, fromMarkdown: jest.fn(actual.fromMarkdown) };
});

const mockFromMarkdown = fromMarkdown as jest.MockedFunction<
  typeof fromMarkdown
>;

describe('markdownToClipboardText', () => {
  it('returns an empty string for empty input', () => {
    expect(markdownToClipboardText('')).toBe('');
  });

  it('returns an empty string for markup-only input', () => {
    expect(markdownToClipboardText('---')).toBe('');
    expect(markdownToClipboardText('![](https://example.com/a.png)')).toBe('');
    expect(markdownToClipboardText('[ref]: https://example.com')).toBe('');
    expect(markdownToClipboardText('<!-- note -->')).toBe('');
  });

  it('separates adjacent top-level blocks with one blank line', () => {
    expect(
      markdownToClipboardText(
        '# Title\n\nFirst paragraph.\n\n> Quoted\n\nLast',
      ),
    ).toBe('Title\n\nFirst paragraph.\n\nQuoted\n\nLast');
  });

  it('keeps soft and hard line breaks inside a paragraph', () => {
    expect(markdownToClipboardText('one\ntwo  \nthree\\\nfour')).toBe(
      'one\ntwo\nthree\nfour',
    );
  });

  it('removes inline delimiters but keeps their text', () => {
    expect(
      markdownToClipboardText('Use **bold**, _em_, ~~gone~~ and `code()`.'),
    ).toBe('Use bold, em, gone and code().');
  });

  it('keeps list order, nesting, starting numbers and task states', () => {
    expect(
      markdownToClipboardText(
        [
          '3. Third',
          '4. Fourth',
          '   - nested a',
          '   - nested b',
          '     continued line',
          '',
          'Then:',
          '',
          '- [x] done',
          '- [ ] todo',
        ].join('\n'),
      ),
    ).toBe(
      [
        '3. Third',
        '4. Fourth',
        '   - nested a',
        '   - nested b',
        '     continued line',
        '',
        'Then:',
        '',
        '- [x] done',
        '- [ ] todo',
      ].join('\n'),
    );
  });

  it('keeps blank lines between items of a loose list', () => {
    expect(markdownToClipboardText('- one\n\n- two')).toBe('- one\n\n- two');
  });

  it('keeps multi-paragraph list items indented under their marker', () => {
    expect(
      markdownToClipboardText('1. First\n\n   More detail\n2. Second'),
    ).toBe('1. First\n\n   More detail\n2. Second');
  });

  it('removes blockquote markers but keeps block boundaries', () => {
    expect(markdownToClipboardText('> one\n>\n> two\n\nafter')).toBe(
      'one\n\ntwo\n\nafter',
    );
  });

  it('keeps fenced and indented code exactly, without fences', () => {
    expect(
      markdownToClipboardText(
        '```ts\nconst a = 1;\n\n  const b = 2;\n```\n\n    indented()\n      more()',
      ),
    ).toBe('const a = 1;\n\n  const b = 2;\n\nindented()\n  more()');
  });

  it('renders links as text and URL without duplicating autolinks', () => {
    expect(
      markdownToClipboardText(
        'See [docs](https://example.com/docs), <https://a.dev>, https://b.dev and www.c.dev.',
      ),
    ).toBe(
      'See docs (https://example.com/docs), https://a.dev, https://b.dev and www.c.dev.',
    );
  });

  it('resolves reference links and omits their definitions', () => {
    expect(
      markdownToClipboardText(
        'Read [the guide][g] and [g].\n\n[g]: https://example.com/guide',
      ),
    ).toBe(
      'Read the guide (https://example.com/guide) and g (https://example.com/guide).',
    );
  });

  it('uses the first reference definition, matching rendered Markdown', () => {
    expect(
      markdownToClipboardText(
        '[guide][g]\n\n[g]: https://first.test\n[g]: https://second.test',
      ),
    ).toBe('guide (https://first.test)');
  });

  it('renders images as alt text', () => {
    expect(
      markdownToClipboardText('Look: ![A diagram](https://example.com/d.png)'),
    ).toBe('Look: A diagram');
  });

  it('renders raw HTML image alt text without loading its source', () => {
    expect(
      markdownToClipboardText(
        '<div><img src="https://example.com/a.png" alt="A &amp; B"></div>',
      ),
    ).toBe('A & B');
    expect(
      markdownToClipboardText("Inline <img data-alt='wrong' alt='kept'> end"),
    ).toBe('Inline kept end');
    expect(
      markdownToClipboardText('<img title=" alt=wrong " alt="kept">'),
    ).toBe('kept');
  });

  it('renders tables as rows with two spaces between cells', () => {
    expect(
      markdownToClipboardText('| A | B |\n| - | - |\n| 1 | **2** |\n| x | |'),
    ).toBe('A  B\n1  2\nx  ');
  });

  it('omits thematic breaks between blocks', () => {
    expect(markdownToClipboardText('above\n\n---\n\nbelow')).toBe(
      'above\n\nbelow',
    );
  });

  it('reduces raw HTML to its visible text without script or style contents', () => {
    expect(
      markdownToClipboardText(
        '<div>\n  <p>Hello &amp; <b>welcome</b></p>\n  <script>alert(1)</script>\n  <style>p{}</style>\n</div>\n\nInline <span>kept</span><br>next <script>x()</script>done',
      ),
    ).toBe('Hello & welcome\n\nInline kept\nnext done');
  });

  it('drops malformed trailing tags and keeps a lone angle bracket', () => {
    expect(markdownToClipboardText('<div class="x"\n\na < b')).toBe('a < b');
    expect(markdownToClipboardText('<p>open only')).toBe('open only');
  });

  it('keeps quoted tag attributes out of visible HTML text', () => {
    expect(markdownToClipboardText('<div title="a > b">Visible</div>')).toBe(
      'Visible',
    );
    expect(markdownToClipboardText("<p title='a > b'>Visible</p>")).toBe(
      'Visible',
    );
  });

  it('decodes named HTML entities as visible Unicode text', () => {
    expect(
      markdownToClipboardText(
        '<div>&copy; &frac12; &NotEqualTilde; &nbsp;</div>',
      ),
    ).toBe('© ½ ≂̸ \u00a0');
  });

  it('preserves repeated explicit HTML line breaks and preformatted whitespace', () => {
    expect(markdownToClipboardText('<div>one<br><br>two</div>')).toBe(
      'one\n\ntwo',
    );
    expect(markdownToClipboardText('<pre>  one\n\n  two  </pre>')).toBe(
      '  one\n\n  two  ',
    );
  });

  it('preserves Unicode and content past the compact-row limit', () => {
    const long = `${'é'.repeat(1500)} 🌲 終わり`;
    expect(markdownToClipboardText(long)).toBe(long);
  });

  it('does not collapse whitespace inside text', () => {
    expect(markdownToClipboardText('a   b\twide')).toBe('a   b\twide');
  });

  it('returns the original input when the parser throws', () => {
    mockFromMarkdown.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(markdownToClipboardText('**kept as is**')).toBe('**kept as is**');
  });
});
