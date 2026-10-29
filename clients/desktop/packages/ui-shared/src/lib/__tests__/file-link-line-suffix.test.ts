import {
  matchLeadingLineSuffix,
  parseFileLinkLineSuffix,
  type FileLinkLineLocation,
} from '../file-link-line-suffix';

describe('parseFileLinkLineSuffix (CAN-4275)', () => {
  it.each<[string, string, FileLinkLineLocation]>([
    ['src/a.ts:12', 'src/a.ts', { line: 12 }],
    ['src/a.ts#L12', 'src/a.ts', { line: 12 }],
    ['src/a.ts:12-20', 'src/a.ts', { line: 12, lineEnd: 20 }],
    ['src/a.ts#L12-L20', 'src/a.ts', { line: 12, lineEnd: 20 }],
    ['src/a.ts#L12-20', 'src/a.ts', { line: 12, lineEnd: 20 }],
    ['src/a.ts:12:4', 'src/a.ts', { line: 12 }],
    ['src/a.ts#L12C4', 'src/a.ts', { line: 12 }],
    ['src/a.ts:12:4-20:9', 'src/a.ts', { line: 12, lineEnd: 20 }],
    ['README.md:3', 'README.md', { line: 3 }],
    ['/vercel/sandbox/src/a.ts:7', '/vercel/sandbox/src/a.ts', { line: 7 }],
    ['file:///x/a.ts#L3-L5', 'file:///x/a.ts', { line: 3, lineEnd: 5 }],
    ['C:/repo/a.ts:4', 'C:/repo/a.ts', { line: 4 }],
    ['C:\\repo\\a.ts:4-6', 'C:\\repo\\a.ts', { line: 4, lineEnd: 6 }],
    ['src/my%20file.ts:9', 'src/my%20file.ts', { line: 9 }],
  ])('parses %s', (href, path, location) => {
    expect(parseFileLinkLineSuffix(href)).toEqual({ href: path, location });
  });

  it.each<[string, FileLinkLineLocation]>([
    ['a.ts:007', { line: 7 }],
    ['a.ts:0012-0020', { line: 12, lineEnd: 20 }],
    ['a.ts#L08-L09', { line: 8, lineEnd: 9 }],
  ])('normalizes leading zeros in %s', (href, location) => {
    expect(parseFileLinkLineSuffix(href).location).toEqual(location);
  });

  it.each<[string, FileLinkLineLocation]>([
    ['a.ts:20-12', { line: 20 }],
    ['a.ts#L20-L12', { line: 20 }],
    ['a.ts:20:1-12:1', { line: 20 }],
    ['a.ts:12-12', { line: 12 }],
    ['a.ts#L12-L12', { line: 12 }],
    ['a.ts:12:3-12:9', { line: 12 }],
  ])('drops a reversed or equal end in %s', (href, location) => {
    const parsed = parseFileLinkLineSuffix(href);
    expect(parsed.location).toEqual(location);
    expect(parsed.location).not.toHaveProperty('lineEnd');
  });

  it.each([
    // Malformed continuations never recover a shorter valid prefix.
    'src/a.ts:12-',
    'src/a.ts:12:',
    'src/a.ts:12abc',
    'src/a.ts#L12-',
    'src/a.ts#L12C',
    'src/a.ts#L',
    'src/a.ts#12',
    'src/a.ts#l12',
    'src/a.ts:',
    'src/a.ts:12:4-20',
    'src/a.ts:12-20:9',
    // Zero and overflow components invalidate the whole suffix.
    'src/a.ts:0',
    'src/a.ts:12-0',
    'src/a.ts:12:0',
    'src/a.ts#L0',
    'src/a.ts#L12C0',
    'src/a.ts:12:4-20:0',
    'src/a.ts:99999999999999999999',
    'src/a.ts:1-99999999999999999999',
    // Whitespace anywhere in the suffix.
    'src/a.ts: 12',
    'src/a.ts:12 ',
    'src/a.ts:12 -20',
    'src/a.ts#L 12',
    // Non-ASCII digits.
    'src/a.ts:١٢',
    // Encoded delimiters are literal filename characters.
    'src/a.ts%3A12',
    'src/a.ts%23L12',
    // A suffix needs a nonempty path.
    ':12',
    '#L12',
    // Plain paths and URLs carry no location.
    'src/a.ts',
    'C:/repo/a.ts',
    'file:///x/a.ts',
    '',
  ])('leaves %p unchanged with no location', (href) => {
    expect(parseFileLinkLineSuffix(href)).toEqual({ href, location: null });
  });

  it('interprets recognized suffix syntax on an ambiguous literal filename as a location', () => {
    expect(parseFileLinkLineSuffix('log:2024:12')).toEqual({
      href: 'log',
      location: { line: 2024 },
    });
    expect(parseFileLinkLineSuffix('2024-01-05:12')).toEqual({
      href: '2024-01-05',
      location: { line: 12 },
    });
    expect(parseFileLinkLineSuffix('my-file-2:12')).toEqual({
      href: 'my-file-2',
      location: { line: 12 },
    });
  });

  it('rejects an overlong suffix run as a whole instead of taking its tail', () => {
    expect(parseFileLinkLineSuffix('notes:1:2:3')).toEqual({
      href: 'notes:1:2:3',
      location: null,
    });
    expect(parseFileLinkLineSuffix('a.ts:5#L12')).toEqual({
      href: 'a.ts:5#L12',
      location: null,
    });
  });

  it('keeps the earliest complete suffix rather than a shorter trailing one', () => {
    expect(parseFileLinkLineSuffix('a.ts:12:3')).toEqual({
      href: 'a.ts',
      location: { line: 12 },
    });
  });
});

describe('matchLeadingLineSuffix (CAN-4275)', () => {
  it.each<[string, number, FileLinkLineLocation]>([
    [':12', 3, { line: 12 }],
    ['#L12', 4, { line: 12 }],
    [':12-20', 6, { line: 12, lineEnd: 20 }],
    ['#L12-L20', 8, { line: 12, lineEnd: 20 }],
    ['#L12-20', 7, { line: 12, lineEnd: 20 }],
    [':12:4', 5, { line: 12 }],
    ['#L12C4', 6, { line: 12 }],
    [':12:4-20:9', 10, { line: 12, lineEnd: 20 }],
    [':20-12', 6, { line: 20 }],
    [':007', 4, { line: 7 }],
  ])('matches %p at end of text', (text, length, location) => {
    expect(matchLeadingLineSuffix(text)).toEqual({ length, location });
  });

  it.each([
    ':12 and more',
    ':12\nnext',
    ':12\tnext',
    ':12)',
    ':12]',
    ':12}',
    ':12>',
    ':12`',
    ":12'",
    ':12"',
    ':12, then',
    ':12,',
    ':12.',
    ':12. Next sentence',
    ':12.)',
    ':12;',
    ':12!',
    ':12?',
  ])('accepts a prose boundary after the suffix in %p', (text) => {
    expect(matchLeadingLineSuffix(text)).toEqual({
      length: 3,
      location: { line: 12 },
    });
  });

  it.each([
    // Letters, digits, and underscore continue a token.
    ':12abc',
    ':12_',
    '#L12x',
    // Path separators continue a path.
    ':12/more',
    ':12\\more',
    // Additional or incomplete suffix syntax.
    ':12:',
    ':12-',
    ':12:4-',
    ':12:4-20',
    ':12-20:9',
    ':12#L3',
    '#L12-',
    '#L12C',
    // A period that does not end the sentence.
    ':12.5',
    ':12.ts',
    ':12,5',
    // Invalid numbers.
    ':0',
    ':12-0',
    ':99999999999999999999',
    // Not a suffix at all.
    ' :12',
    ':',
    '',
    'abc',
    ':١٢',
  ])('rejects %p', (text) => {
    expect(matchLeadingLineSuffix(text)).toBeNull();
  });
});
