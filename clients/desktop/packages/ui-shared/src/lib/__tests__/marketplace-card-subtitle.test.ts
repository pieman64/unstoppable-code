import { marketplaceCardSubtitle } from '../marketplace-card-subtitle';

describe('marketplaceCardSubtitle', () => {
  it('uses edited copy for known products', () => {
    expect(marketplaceCardSubtitle('Slack', 'anything')).toBe(
      'Read and manage Slack',
    );
  });

  it('keeps a plain description whole for CSS to truncate', () => {
    expect(
      marketplaceCardSubtitle(
        'Other',
        'one two three four five six seven eight',
      ),
    ).toBe('one two three four five six seven eight');
  });

  it('drops markdown syntax before taking the first words', () => {
    expect(
      marketplaceCardSubtitle(
        'Other',
        '## **Triage** helper\n\n1. Reads [issues](https://example.com)\n2. Labels them',
      ),
    ).toBe('Triage helper. Reads issues. Labels them');
  });

  it('does not apply a JavaScript character limit', () => {
    const description = `Opening words for the card ${'filler '.repeat(100)}`;
    expect(marketplaceCardSubtitle('Other', description)).toBe(
      description.trim(),
    );
  });
});
