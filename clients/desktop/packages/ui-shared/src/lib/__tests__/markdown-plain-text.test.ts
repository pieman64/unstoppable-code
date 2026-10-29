import { fromMarkdown } from 'mdast-util-from-markdown';
import type * as MdastFromMarkdown from 'mdast-util-from-markdown';
import {
  hasMarkdownDescriptionText,
  markdownDescriptionToPlainText,
  markdownToPlainText,
} from '../markdown-plain-text';

jest.mock('mdast-util-from-markdown', () => {
  const actual = jest.requireActual<typeof MdastFromMarkdown>(
    'mdast-util-from-markdown',
  );
  return { ...actual, fromMarkdown: jest.fn(actual.fromMarkdown) };
});

describe('markdownToPlainText', () => {
  it('flattens paragraphs and numbered lists into one line', () => {
    expect(
      markdownToPlainText(
        'Keeps the backlog tidy.\n\n1. Reads new issues\n2. Labels them\n\nThen posts a digest.',
      ),
    ).toBe(
      'Keeps the backlog tidy. Reads new issues. Labels them. Then posts a digest.',
    );
  });

  it('keeps link text and drops the URL', () => {
    expect(
      markdownToPlainText('See [the docs](https://example.com/docs).'),
    ).toBe('See the docs.');
  });

  it('drops heading markers and emphasis syntax', () => {
    expect(markdownToPlainText('# Weekly **triage** _run_\n\nBody')).toBe(
      'Weekly triage run. Body',
    );
  });

  it('keeps inline code and fenced code text', () => {
    expect(
      markdownToPlainText('Run `npm test`\n\n```\nnpm run build\n```'),
    ).toBe('Run npm test. npm run build');
  });

  it('keeps image alt text and drops the source', () => {
    expect(
      markdownToPlainText('![Build status](https://example.com/p.png) ok'),
    ).toBe('Build status ok');
  });

  it('flattens GFM tables, strikethrough, and bullet lists', () => {
    expect(
      markdownToPlainText(
        '- ~~old~~ new\n- next\n\n| a | b |\n| - | - |\n| 1 | 2 |',
      ),
    ).toBe('old new. next. a b 1 2');
  });

  it('keeps existing sentence punctuation between blocks', () => {
    expect(markdownToPlainText('Steps:\n\n- Build!\n- Ship?\n- Done.')).toBe(
      'Steps: Build! Ship? Done.',
    );
  });

  it('joins the typed lines of one paragraph with a space', () => {
    expect(markdownToPlainText('  First line\nSecond line  \n')).toBe(
      'First line Second line',
    );
    expect(markdownToPlainText('Works with\nGitHub and Slack')).toBe(
      'Works with GitHub and Slack',
    );
    expect(markdownToPlainText('I built this so\nI could ship')).toBe(
      'I built this so I could ship',
    );
  });

  it('does not add a period after a block ending in a comma or dash', () => {
    expect(markdownToPlainText('- Step one,\n- Step two')).toBe(
      'Step one, Step two',
    );
    expect(markdownToPlainText('Intro —\n\nDetails follow')).toBe(
      'Intro — Details follow',
    );
  });

  it('drops raw HTML tags and comments but keeps their text', () => {
    expect(markdownToPlainText('<!-- hidden --> Visible')).toBe('Visible');
    expect(markdownToPlainText('<div>Block text</div>')).toBe('Block text');
    expect(markdownToPlainText('Bold text <b>is</b> here')).toBe(
      'Bold text is here',
    );
  });

  it('parses only a bounded prefix of a long description', () => {
    jest.mocked(fromMarkdown).mockClear();
    const nested = `${'> '.repeat(200_000)}deep`;
    markdownToPlainText(nested);
    const parsed = jest.mocked(fromMarkdown).mock.calls.at(-1)?.[0];
    expect(
      typeof parsed === 'string' ? parsed.length : Infinity,
    ).toBeLessThanOrEqual(1000);
  });

  it('keeps the words of a long description up to a word boundary', () => {
    const long = `${'**word** '.repeat(200)}tail`;
    const text = markdownToPlainText(long);
    expect(text.startsWith('word word')).toBe(true);
    expect(text).not.toContain('*');
    expect(text).not.toContain('tail');
  });

  it('joins a hard-wrapped sentence with a space', () => {
    expect(
      markdownToPlainText(
        'Reviews every open pull request and posts\nfindings to the channel.',
      ),
    ).toBe(
      'Reviews every open pull request and posts findings to the channel.',
    );
  });

  it('collapses runs of whitespace inside a line', () => {
    expect(markdownToPlainText('  spaced    out   words  ')).toBe(
      'spaced out words',
    );
  });

  it('skips the parser for prose with no Markdown syntax', () => {
    jest.mocked(fromMarkdown).mockClear();
    expect(markdownToPlainText('Plain catalog prose, no syntax at all')).toBe(
      'Plain catalog prose, no syntax at all',
    );
    expect(fromMarkdown).not.toHaveBeenCalled();
  });

  it('keeps recently used entries cached', () => {
    // Start from a full cache of unrelated entries.
    for (let index = 0; index < 500; index += 1) {
      markdownToPlainText(`**warm** ${index}`);
    }
    const hot = '**hot** entry';
    markdownToPlainText(hot);
    // 499 fresh entries, re-reading `hot` just before the cache turns over.
    for (let index = 0; index < 499; index += 1) {
      markdownToPlainText(`**fresh** ${index}`);
    }
    markdownToPlainText(hot);
    markdownToPlainText('**one more** entry');
    jest.mocked(fromMarkdown).mockClear();
    expect(markdownToPlainText(hot)).toBe('hot entry');
    expect(fromMarkdown).not.toHaveBeenCalled();
  });

  it('returns an empty string for empty input', () => {
    expect(markdownToPlainText('')).toBe('');
    expect(markdownToPlainText('   \n\n ')).toBe('');
  });

  it('falls back to whitespace-collapsed input when parsing throws', () => {
    jest.mocked(fromMarkdown).mockImplementationOnce(() => {
      throw new Error('parser failure');
    });
    expect(markdownToPlainText('  **raw**\n\n1. text  ')).toBe(
      '**raw** 1. text',
    );
  });
});

describe('hasMarkdownDescriptionText', () => {
  it('is true only when the description has visible text', () => {
    expect(hasMarkdownDescriptionText('**Bold**')).toBe(true);
    expect(hasMarkdownDescriptionText('---')).toBe(false);
    expect(hasMarkdownDescriptionText('[ref]: https://example.com')).toBe(
      false,
    );
    expect(hasMarkdownDescriptionText('')).toBe(false);
    expect(hasMarkdownDescriptionText(undefined)).toBe(false);
    expect(hasMarkdownDescriptionText(null)).toBe(false);
  });

  it('assumes visible text lies beyond a syntax-only bounded prefix', () => {
    expect(
      hasMarkdownDescriptionText(`${'---\n\n'.repeat(400)}Real text`),
    ).toBe(true);
  });
});

describe('markdownDescriptionToPlainText', () => {
  it('returns undefined for missing or markdown-only-empty descriptions', () => {
    expect(markdownDescriptionToPlainText(undefined)).toBeUndefined();
    expect(markdownDescriptionToPlainText(null)).toBeUndefined();
    expect(markdownDescriptionToPlainText('')).toBeUndefined();
    expect(markdownDescriptionToPlainText('---')).toBeUndefined();
  });

  it('returns plain text for a markdown description', () => {
    expect(markdownDescriptionToPlainText('**Bold** start')).toBe('Bold start');
  });
});
