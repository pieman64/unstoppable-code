import type * as MarkdownPlainText from '../markdown-plain-text';
import { markdownToPlainText } from '../markdown-plain-text';
import { marketplaceCardSubtitle } from '../marketplace-card-subtitle';

jest.mock('../markdown-plain-text', () => {
  const actual = jest.requireActual<typeof MarkdownPlainText>(
    '../markdown-plain-text',
  );
  return {
    ...actual,
    markdownToPlainText: jest.fn(actual.markdownToPlainText),
  };
});

describe('marketplaceCardSubtitle', () => {
  it('uses edited copy for known products', () => {
    expect(marketplaceCardSubtitle('Slack', 'anything')).toBe(
      'Read and manage Slack',
    );
  });

  it('caps a plain description at seven words and marks the cut', () => {
    expect(
      marketplaceCardSubtitle(
        'Other',
        'one two three four five six seven eight',
      ),
    ).toBe('one two three four five six seven…');
  });

  it('drops trailing punctuation before the ellipsis', () => {
    expect(
      marketplaceCardSubtitle(
        'Other',
        'Use when asked to read, write, validate, or lint config files',
      ),
    ).toBe('Use when asked to read, write, validate…');
  });

  it('keeps a description of seven words or fewer whole', () => {
    expect(
      marketplaceCardSubtitle(
        'Other',
        'Checks UI copy against the writing guide',
      ),
    ).toBe('Checks UI copy against the writing guide');
  });

  it('keeps a description of seven words or fewer whole', () => {
    expect(
      marketplaceCardSubtitle('Other', 'one two three four five six seven'),
    ).toBe('one two three four five six seven');
    expect(marketplaceCardSubtitle('Other', 'Old review rubric.')).toBe(
      'Old review rubric.',
    );
  });

  it('drops a dangling comma or stop before the ellipsis', () => {
    expect(
      marketplaceCardSubtitle(
        'Other',
        'Turn merged PR titles into short, user-facing release notes.',
      ),
    ).toBe('Turn merged PR titles into short, user-facing…');
    expect(
      marketplaceCardSubtitle(
        'Other',
        'Label new issues, find duplicates, and route them.',
      ),
    ).toBe('Label new issues, find duplicates, and route…');
    expect(
      marketplaceCardSubtitle(
        'Other',
        'Check changes for injection, secrets, and unsafe defaults.',
      ),
    ).toBe('Check changes for injection, secrets, and unsafe…');
    expect(
      marketplaceCardSubtitle(
        'Other',
        'one two three four five six seven, eight',
      ),
    ).toBe('one two three four five six seven…');
  });

  it('drops markdown syntax before taking the first words', () => {
    expect(
      marketplaceCardSubtitle(
        'Other',
        '## **Triage** helper\n\n1. Reads [issues](https://example.com)\n2. Labels them',
      ),
    ).toBe('Triage helper. Reads issues. Labels them');
  });

  it('parses only a bounded prefix of a long catalog description', () => {
    const description = `Opening words for the card ${'filler '.repeat(5000)}`;
    expect(marketplaceCardSubtitle('Other', description)).toBe(
      'Opening words for the card filler filler…',
    );
    const parsed = jest.mocked(markdownToPlainText).mock.calls.at(-1)?.[0];
    expect(parsed?.length).toBeLessThanOrEqual(400);
  });

  it('cuts the parsed prefix at a word boundary', () => {
    // 395 characters of space-separated words, then a long link that the
    // 400-character limit would otherwise split into raw `[` / `](` text.
    const description = `${'abcd '.repeat(79)}[linked](https://example.com/a/long/path)`;
    marketplaceCardSubtitle('Other', description);
    const parsed = jest.mocked(markdownToPlainText).mock.calls.at(-1)?.[0];
    expect(parsed).toBe('abcd '.repeat(79).trimEnd());
  });
});
