import {
  gitHubPreviewTargetKey,
  type GitHubPreviewTarget,
} from '@canopy/protocol/reference-previews';
import {
  extractCreateFromReferences,
  scanReferenceOccurrences,
} from '../create-from-reference';
import {
  gitHubReferenceFromHref,
  gitHubReferenceLabel,
  isGeneratedGitHubLabel,
  scanGitHubReferenceOccurrences,
  type GitHubReferenceOccurrence,
} from '../github-reference-occurrences';

/** Matched source text plus a compact identity for table assertions. */
function describeOccurrence(
  text: string,
  occurrence: GitHubReferenceOccurrence,
): string {
  const source = text.slice(occurrence.start, occurrence.end);
  if (occurrence.form === 'bare')
    return `bare ${source} -> ${occurrence.number}`;
  return `${occurrence.form} ${source} -> ${gitHubPreviewTargetKey(occurrence.target)}`;
}

function scan(text: string): string[] {
  const { occurrences } = scanGitHubReferenceOccurrences(text);
  return occurrences.map((occurrence) => describeOccurrence(text, occurrence));
}

const item = (
  owner: string,
  repository: string,
  number: number,
): GitHubPreviewTarget => ({ kind: 'item', owner, repository, number });
const repo = (owner: string, repository: string): GitHubPreviewTarget => ({
  kind: 'repository',
  owner,
  repository,
});

describe('scanGitHubReferenceOccurrences: URLs', () => {
  it.each([
    ['https://github.com/Acme/API/pull/42', item('acme', 'api', 42)],
    ['https://github.com/acme/api/pull/42/', item('acme', 'api', 42)],
    ['https://github.com/acme/api/pull/42/files', item('acme', 'api', 42)],
    ['https://github.com/acme/api/pull/42/commits/', item('acme', 'api', 42)],
    ['https://github.com/acme/api/pull/42/checks', item('acme', 'api', 42)],
    ['https://github.com/acme/api/pull/42?w=1', item('acme', 'api', 42)],
    [
      'https://github.com/acme/api/pull/42/files#diff-abc',
      item('acme', 'api', 42),
    ],
    ['http://github.com/acme/api/pull/42', item('acme', 'api', 42)],
    ['HTTPS://GitHub.com/acme/api/pull/42', item('acme', 'api', 42)],
    ['https://github.com/acme/api/issues/7', item('acme', 'api', 7)],
    ['https://github.com/acme/api/issues/7/', item('acme', 'api', 7)],
    [
      'https://github.com/acme/api/issues/7#issuecomment-1',
      item('acme', 'api', 7),
    ],
    [
      'https://github.com/acme/my_repo.js/issues/2147483647',
      item('acme', 'my_repo.js', 2147483647),
    ],
    ['https://github.com/acme/api', repo('acme', 'api')],
    ['https://github.com/Acme/API/', repo('acme', 'api')],
    ['https://github.com/acme/api.git', repo('acme', 'api')],
    ['https://github.com/acme/api?tab=readme', repo('acme', 'api')],
    ['https://github.com/acme/api#readme', repo('acme', 'api')],
  ])('recognizes %s', (url, target) => {
    const text = `See ${url} now`;
    const { occurrences, complete } = scanGitHubReferenceOccurrences(text);
    expect(complete).toBe(true);
    expect(occurrences).toEqual([
      { start: 4, end: 4 + url.length, form: 'url', target, originalUrl: url },
    ]);
  });

  it.each([
    [
      '(https://github.com/acme/api/pull/42)',
      'https://github.com/acme/api/pull/42',
    ],
    [
      'https://github.com/acme/api/pull/42.',
      'https://github.com/acme/api/pull/42',
    ],
    [
      'https://github.com/acme/api/pull/42),',
      'https://github.com/acme/api/pull/42',
    ],
    [
      'https://github.com/acme/api/issues/7!',
      'https://github.com/acme/api/issues/7',
    ],
    ['https://github.com/acme/api;', 'https://github.com/acme/api'],
    [
      '[https://github.com/acme/api/pull/42]',
      'https://github.com/acme/api/pull/42',
    ],
    [
      'https://github.com/acme/api/pull/42#discussion_r1:',
      'https://github.com/acme/api/pull/42#discussion_r1',
    ],
  ])('trims trailing punctuation from %s', (text, url) => {
    const { occurrences } = scanGitHubReferenceOccurrences(text);
    expect(occurrences).toHaveLength(1);
    const [occurrence] = occurrences;
    expect(text.slice(occurrence.start, occurrence.end)).toBe(url);
    expect(occurrence).toMatchObject({ form: 'url', originalUrl: url });
  });

  it.each([
    'https://github.com.evil.io/acme/api/pull/42',
    'https://evilgithub.com/acme/api/pull/42',
    'https://www.github.com/acme/api/pull/42',
    'https://gist.github.com/acme/api',
    'https://api.github.com/repos/acme/api/pulls/42',
    'https://github.com./acme/api/pull/42',
    'https://user@github.com/acme/api/pull/42',
    'https://user:pass@github.com/acme/api/pull/42',
    'https://github.com:443/acme/api/pull/42',
    'ftp://github.com/acme/api/pull/42',
    'github.com/acme/api/pull/42',
    'https://github.com',
    'https://github.com/',
    'https://github.com/acme',
    'https://github.com/acme/',
    'https://github.com/acme/api/blob/main/README.md',
    'https://github.com/acme/api/tree/main',
    'https://github.com/acme/api/actions',
    'https://github.com/acme/api/actions/runs/123',
    'https://github.com/acme/api/commit/abc123',
    'https://github.com/acme/api/pulls',
    'https://github.com/acme/api/issues',
    'https://github.com/acme/api/wiki',
    'https://github.com/acme/api/pull/42/files/x',
    'https://github.com/acme/api/pull/42/commits/abc123',
    'https://github.com/acme/api/issues/7/files',
    'https://github.com/acme/api/pull/0',
    'https://github.com/acme/api/pull/012',
    'https://github.com/acme/api/pull/2147483648',
    'https://github.com/acme/api/pull/abc',
    'https://github.com/-acme/api/pull/42',
    'https://github.com/acme-/api',
    'https://github.com/acme/../api/pull/42',
    'https://github.com/acme/%2E%2E/pull/42',
    'https://github.com/acme/..',
    'https://github.com/a_b/api',
    'https://github.com/orgs/acme',
    'https://github.com/settings/tokens',
    'https://github.com/marketplace/actions',
    'https://github.com/apps/canopy',
    'https://github.com/site/privacy',
    'https://github.com/security/advanced-security',
    'https://github.com/account/billing',
    'https://github.com/contact/report',
    'https://github.com/copilot/c',
    'https://github.com/readme/guides',
    'https://github.com/solutions/ci-cd',
    'https://github.com/team/pricing',
  ])('does not recognize %s', (url) => {
    expect(scanGitHubReferenceOccurrences(`See ${url} now`)).toEqual({
      occurrences: [],
      complete: true,
    });
  });

  it('rejects a URL longer than 2048 characters', () => {
    const base = 'https://github.com/acme/api/pull/42?q=';
    const atLimit = `${base}${'x'.repeat(2048 - base.length)}`;
    expect(scan(atLimit)).toEqual([`url ${atLimit} -> github.com/acme/api#42`]);
    expect(scan(`${atLimit}x`)).toEqual([]);
  });

  it.each([
    'https://example.com/#12',
    'https://example.com/foo/bar#12',
    'https://example.com/?q=#12',
    'https://github.com/acme/api/blob/main/x.md#12',
    'https://github.com/acme/api/pull/42#12',
    'https://github.com/acme/api/compare/foo/bar#12',
    'https://github.com.evil.io/acme/api#12',
    'xhttps://github.com/acme/api/pull/42',
    'https://github.com/acme/api/blob/main?x=foo/bar#12',
  ])('masks every URL so nothing inside %s matches', (url) => {
    const occurrences = scan(`see ${url} and`);
    expect(
      occurrences.filter((occurrence) => !occurrence.startsWith('url ')),
    ).toEqual([]);
  });
});

describe('scanGitHubReferenceOccurrences: qualified references', () => {
  it.each([
    ['see foo/bar#12.', ['qualified foo/bar#12 -> github.com/foo/bar#12']],
    [
      'Acme/My.Repo_x-1#3',
      ['qualified Acme/My.Repo_x-1#3 -> github.com/acme/my.repo_x-1#3'],
    ],
    ['(foo/bar#12)', ['qualified foo/bar#12 -> github.com/foo/bar#12']],
    ['foo/bar#12, then', ['qualified foo/bar#12 -> github.com/foo/bar#12']],
    ['"foo/bar#12"', ['qualified foo/bar#12 -> github.com/foo/bar#12']],
    [
      'foo/bar#2147483647',
      ['qualified foo/bar#2147483647 -> github.com/foo/bar#2147483647'],
    ],
  ])('recognizes %s', (text, expected) => {
    expect(scan(text)).toEqual(expected);
  });

  it.each([
    'github.com/foo/bar#12',
    'a/b/c#12',
    './foo/bar#12',
    'x.foo/bar#12',
    '@foo/bar#12',
    '#foo/bar#12',
    '-foo/bar#12',
    '_foo/bar#12',
    'foo/bar#12abc',
    'foo/bar#12_',
    'foo/bar#12#3',
    'foo/bar#12/x',
    'foo/bar#12-13',
    'foo/bar#12.5',
    'foo/bar#0',
    'foo/bar#012',
    'foo/bar#2147483648',
    'foo/bar#',
    '-foo/bar#1',
    'foo-/bar#1',
    'foo_x/bar#1',
    'foo/..#1',
    'orgs/acme#1',
    `${'a'.repeat(40)}/bar#1`,
    `foo/${'b'.repeat(101)}#1`,
  ])('does not recognize %s', (text) => {
    expect(scan(`see ${text} now`)).toEqual([]);
  });

  it('keeps identical numbers in different repositories distinct', () => {
    const { occurrences } = scanGitHubReferenceOccurrences(
      'foo/bar#1234 and baz/qux#1234',
    );
    const keys = occurrences.map((occurrence) =>
      occurrence.form === 'bare'
        ? null
        : gitHubPreviewTargetKey(occurrence.target),
    );
    expect(keys).toEqual([
      'github.com/foo/bar#1234',
      'github.com/baz/qux#1234',
    ]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('scanGitHubReferenceOccurrences: bare references', () => {
  it.each([
    ['see #12', ['bare #12 -> 12']],
    ['(#12)', ['bare #12 -> 12']],
    ['#12, #13.', ['bare #12 -> 12', 'bare #13 -> 13']],
    ['fixes #12: done', ['bare #12 -> 12']],
    ['#2147483647', ['bare #2147483647 -> 2147483647']],
    ['[#7]', ['bare #7 -> 7']],
  ])('recognizes %s', (text, expected) => {
    expect(scan(text)).toEqual(expected);
  });

  it.each([
    'C#1',
    '&#123;',
    'issue#1',
    '##1',
    '/#1',
    '.#1',
    '-#1',
    '_#1',
    '#0',
    '#012',
    '#12abc',
    '#12_',
    '#1-2',
    '#1.5',
    '#2147483648',
    '#12345678901',
    'CAN-12#3',
    '#',
    '# 12',
  ])('does not recognize %s', (text) => {
    expect(scan(`see ${text} now`)).toEqual([]);
  });

  it('matches a bare and a qualified reference once each', () => {
    const text = 'Both #1234 and foo/bar#1234 apply.';
    expect(scanGitHubReferenceOccurrences(text)).toEqual({
      complete: true,
      occurrences: [
        { start: 5, end: 10, form: 'bare', number: 1234 },
        {
          start: 15,
          end: 27,
          form: 'qualified',
          target: item('foo', 'bar', 1234),
        },
      ],
    });
  });
});

describe('scanGitHubReferenceOccurrences: ordering and bounds', () => {
  it('returns non-overlapping occurrences sorted by start', () => {
    const text =
      '#1 https://github.com/a/b/pull/2 c/d#3 https://example.com/#4 #5 https://github.com/e/f';
    expect(scan(text)).toEqual([
      'bare #1 -> 1',
      'url https://github.com/a/b/pull/2 -> github.com/a/b#2',
      'qualified c/d#3 -> github.com/c/d#3',
      'bare #5 -> 5',
      'url https://github.com/e/f -> github.com/e/f',
    ]);
    const { occurrences } = scanGitHubReferenceOccurrences(text);
    for (let index = 1; index < occurrences.length; index += 1) {
      expect(occurrences[index].start).toBeGreaterThanOrEqual(
        occurrences[index - 1].end,
      );
    }
  });

  it('returns nothing and complete false above 100,000 characters', () => {
    const text = `#1 ${' '.repeat(99_997)}`;
    expect(text).toHaveLength(100_000);
    expect(scanGitHubReferenceOccurrences(text).occurrences).toHaveLength(1);
    expect(scanGitHubReferenceOccurrences(`${text} `)).toEqual({
      occurrences: [],
      complete: false,
    });
  });

  it('keeps the first 100 occurrences and reports complete false', () => {
    const exactly = Array.from({ length: 100 }, (_, i) => `#${i + 1}`).join(
      ' ',
    );
    expect(scanGitHubReferenceOccurrences(exactly).complete).toBe(true);
    const over = `${exactly} foo/bar#101`;
    const { occurrences, complete } = scanGitHubReferenceOccurrences(over);
    expect(complete).toBe(false);
    expect(occurrences).toHaveLength(100);
    expect(occurrences[99]).toMatchObject({ form: 'bare', number: 100 });
  });

  it('scans pathological 100,000-character input in linear time', () => {
    for (const text of [
      'a.'.repeat(50_000),
      'a'.repeat(100_000),
      '#1'.repeat(50_000),
      'a/'.repeat(50_000),
      ':/'.repeat(50_000),
      'x://'.repeat(25_000),
      '_://'.repeat(25_000),
      `${'1.'.repeat(49_998)}://x`,
      `${'a.'.repeat(49_998)}://x`,
      `#${'1'.repeat(99_999)}`,
    ]) {
      const startedAt = performance.now();
      scanGitHubReferenceOccurrences(text);
      expect(performance.now() - startedAt).toBeLessThan(500);
    }
  });
});

describe('URL masking matches the shared URL_IN_TEXT_RE spans', () => {
  // The scanner finds URLs without this regex (it is quadratic on input such
  // as `a.a.a…`); masking must still cover exactly the same spans.
  const URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
  const BARE_RE = /(?<![A-Za-z0-9_&/#.-])#[1-9]\d{0,9}(?![A-Za-z0-9_-]|\.\d)/g;
  const alphabet = [
    'a',
    'Z',
    '1',
    '_',
    '.',
    '+',
    '-',
    ':',
    '/',
    ' ',
    '"',
    '<',
    'h',
    '#9',
    '#9',
    '://',
    'x://y',
    'https://',
  ];

  function pseudoRandomTexts(count: number): string[] {
    let seed = 3979;
    const next = (): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed;
    };
    return Array.from({ length: count }, () =>
      Array.from(
        { length: 1 + (next() % 24) },
        () => alphabet[next() % alphabet.length],
      ).join(''),
    );
  }

  it('finds bare numbers exactly where regex masking leaves them', () => {
    for (const text of pseudoRandomTexts(5_000)) {
      const masked = text.replace(URL_IN_TEXT_RE, (url) =>
        ' '.repeat(url.length),
      );
      const expected = Array.from(masked.matchAll(BARE_RE), (match) => [
        match.index,
        match.index + match[0].length,
      ]);
      const actual = scanGitHubReferenceOccurrences(text)
        .occurrences.filter((occurrence) => occurrence.form === 'bare')
        .map((occurrence) => [occurrence.start, occurrence.end]);
      expect({ text, spans: actual }).toEqual({ text, spans: expected });
    }
  });
});

describe('gitHubReferenceFromHref', () => {
  it.each([
    ['https://github.com/acme/api/pull/42', item('acme', 'api', 42)],
    [
      'https://github.com/acme/api/issues/7#issuecomment-1',
      item('acme', 'api', 7),
    ],
    ['https://github.com/Acme/API', repo('acme', 'api')],
  ])('resolves %s', (href, target) => {
    expect(gitHubReferenceFromHref(href)).toEqual({
      target,
      originalUrl: href,
    });
  });

  it.each([
    'https://github.com/acme/api/pull/42)',
    'https://github.com/acme/api/pull/42.',
    ' https://github.com/acme/api/pull/42',
    'https://github.com/acme/api/pull/42 x',
    'acme/api#42',
    '#42',
    'https://github.com/acme/api/blob/main/x',
    'https://example.com/acme/api/pull/42',
    'mailto:someone@example.com',
    '',
  ])('rejects %j', (href) => {
    expect(gitHubReferenceFromHref(href)).toBeNull();
  });
});

describe('gitHubReferenceLabel', () => {
  it.each([
    [repo('acme', 'api'), null, 'acme/api'],
    [repo('acme', 'api'), { owner: 'acme', repository: 'api' }, 'acme/api'],
    [item('acme', 'api', 42), null, 'acme/api#42'],
    [item('acme', 'api', 42), { owner: 'acme', repository: 'api' }, '#42'],
    [item('acme', 'api', 42), { owner: 'Acme', repository: 'API' }, '#42'],
    [
      item('acme', 'api', 42),
      { owner: 'acme', repository: 'web' },
      'acme/api#42',
    ],
    [
      item('acme', 'api', 42),
      { owner: 'other', repository: 'api' },
      'acme/api#42',
    ],
  ])('labels %j with short repository %j as %s', (target, short, label) => {
    expect(gitHubReferenceLabel(target, short)).toBe(label);
  });
});

describe('isGeneratedGitHubLabel', () => {
  const href = 'https://github.com/acme/api/pull/42';
  it.each([
    [href, href, item('acme', 'api', 42), true],
    [` ${href} `, href, item('acme', 'api', 42), true],
    ['acme/api#42', href, item('acme', 'api', 42), true],
    ['Acme/API#42', href, item('acme', 'api', 42), true],
    ['#42', href, item('acme', 'api', 42), true],
    ['acme/api', href, item('acme', 'api', 42), false],
    ['#43', href, item('acme', 'api', 42), false],
    ['my explanation', href, item('acme', 'api', 42), false],
    ['the fix in #42', href, item('acme', 'api', 42), false],
    ['acme/api', 'https://github.com/acme/api', repo('acme', 'api'), true],
    ['ACME/api', 'https://github.com/acme/api', repo('acme', 'api'), true],
    ['#42', 'https://github.com/acme/api', repo('acme', 'api'), false],
    ['the API repo', 'https://github.com/acme/api', repo('acme', 'api'), false],
  ])('%j for %s is generated: %s', (label, linkHref, target, expected) => {
    expect(isGeneratedGitHubLabel(label, linkHref, target)).toBe(expected);
  });
});

describe('New Task create-from semantics are unchanged', () => {
  it('still yields no create-from reference for an issues URL', () => {
    const text = 'https://github.com/acme/api/issues/7';
    expect(extractCreateFromReferences(text)).toEqual({
      references: [],
      complete: true,
    });
    expect(scanReferenceOccurrences(text)).toEqual({
      occurrences: [],
      complete: true,
    });
    expect(scanGitHubReferenceOccurrences(text).occurrences).toHaveLength(1);
  });

  it('does not treat qualified or bare GitHub references as create-from references', () => {
    expect(
      extractCreateFromReferences('foo/bar#12 and #13').references,
    ).toEqual([]);
  });
});
