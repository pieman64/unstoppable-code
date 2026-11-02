import {
  LINEAR_ISSUE_SEARCH_QUERY_MAX_LENGTH,
  parseLinearIssueSearchQuery,
} from '../reference-previews';

describe('parseLinearIssueSearchQuery', () => {
  it('returns the trimmed query', () => {
    expect(parseLinearIssueSearchQuery('  CAN-123 ')).toBe('CAN-123');
    expect(parseLinearIssueSearchQuery('fix "quotes" { } #tag')).toBe(
      'fix "quotes" { } #tag',
    );
  });

  it('rejects values that are not strings', () => {
    for (const value of [undefined, null, 42, {}, ['CAN-1'], true]) {
      expect(parseLinearIssueSearchQuery(value)).toBeNull();
    }
  });

  it('rejects an empty or whitespace-only query', () => {
    expect(parseLinearIssueSearchQuery('')).toBeNull();
    expect(parseLinearIssueSearchQuery('   ')).toBeNull();
  });

  it('rejects control characters, including newlines inside the query', () => {
    expect(parseLinearIssueSearchQuery('a\nb')).toBeNull();
    expect(parseLinearIssueSearchQuery('a\u0000b')).toBeNull();
    expect(parseLinearIssueSearchQuery('a\u007fb')).toBeNull();
    expect(parseLinearIssueSearchQuery('a\u009fb')).toBeNull();
  });

  it('caps the trimmed length', () => {
    const atLimit = 'a'.repeat(LINEAR_ISSUE_SEARCH_QUERY_MAX_LENGTH);
    expect(parseLinearIssueSearchQuery(`  ${atLimit}  `)).toBe(atLimit);
    expect(parseLinearIssueSearchQuery(`${atLimit}a`)).toBeNull();
  });

  it('rejects an oversized raw value before trimming it', () => {
    const padding = ' '.repeat(LINEAR_ISSUE_SEARCH_QUERY_MAX_LENGTH * 4);
    expect(parseLinearIssueSearchQuery(`${padding}CAN-1`)).toBeNull();
    expect(parseLinearIssueSearchQuery(`${padding.slice(5)}CAN-1`)).toBe(
      'CAN-1',
    );
  });
});
