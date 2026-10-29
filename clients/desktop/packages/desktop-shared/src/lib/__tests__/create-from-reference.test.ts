import {
  detectCreateFromReference,
  extractCreateFromReferences,
  parseGitHubRepositoryReference,
  parseLinearIdentifier,
  parsePullRequestReference,
  scanReferenceOccurrences,
} from '../create-from-reference';

describe('parsePullRequestReference', () => {
  it('parses a full GitHub PR URL', () => {
    expect(
      parsePullRequestReference(
        'https://github.com/example-org/example-repo/pull/1825',
      ),
    ).toEqual({ owner: 'example-org', repo: 'example-repo', number: 1825 });
  });

  it('parses a PR URL with a trailing path or query', () => {
    expect(
      parsePullRequestReference(
        'https://github.com/o/r/pull/7/files?diff=split',
      ),
    ).toEqual({ owner: 'o', repo: 'r', number: 7 });
  });

  it('parses "#123" and bare numbers without owner/repo', () => {
    expect(parsePullRequestReference('#123')).toEqual({ number: 123 });
    expect(parsePullRequestReference(' 42 ')).toEqual({ number: 42 });
  });

  it('preserves scheme-less URLs accepted by the existing branch picker', () => {
    expect(parsePullRequestReference('github.com/o/r/pull/7')).toEqual({
      owner: 'o',
      repo: 'r',
      number: 7,
    });
  });

  it('rejects zero, negatives, and non-PR text', () => {
    expect(parsePullRequestReference('#0')).toBeNull();
    expect(parsePullRequestReference('feature/foo')).toBeNull();
    expect(parsePullRequestReference('')).toBeNull();
    expect(
      parsePullRequestReference('https://github.com/o/r/issues/12'),
    ).toBeNull();
  });
});

describe('parseLinearIdentifier', () => {
  it('accepts bare identifiers like ECW-8121', () => {
    expect(parseLinearIdentifier('ECW-8121')).toBe('ECW-8121');
    expect(parseLinearIdentifier('  CAN-1 ')).toBe('CAN-1');
  });

  it('preserves scheme-less issue URLs', () => {
    expect(parseLinearIdentifier('linear.app/acme/issue/CAN-7')).toBe('CAN-7');
  });

  it('extracts the identifier from a Linear issue URL (case-normalized)', () => {
    expect(
      parseLinearIdentifier(
        'https://linear.app/unstoppable-domains/issue/ECW-8121/create-worktree',
      ),
    ).toBe('ECW-8121');
    expect(parseLinearIdentifier('https://linear.app/acme/issue/abc-77')).toBe(
      'ABC-77',
    );
  });

  it('rejects lowercase bare ids, branch names, and PR URLs', () => {
    expect(parseLinearIdentifier('ecw-8121')).toBeNull();
    expect(parseLinearIdentifier('feature/ECW-8121-foo')).toBeNull();
    expect(parseLinearIdentifier('https://github.com/o/r/pull/12')).toBeNull();
  });
});

describe('detectCreateFromReference', () => {
  it('detects Linear identifiers and URLs', () => {
    expect(detectCreateFromReference('ECW-8121')).toEqual({
      mode: 'linear',
      value: 'ECW-8121',
    });
    expect(
      detectCreateFromReference('https://linear.app/acme/issue/ECW-8121/x'),
    ).toEqual({ mode: 'linear', value: 'ECW-8121' });
  });

  it('detects PR URLs and numbers', () => {
    expect(detectCreateFromReference('https://github.com/o/r/pull/9')).toEqual({
      mode: 'pr',
      value: 'https://github.com/o/r/pull/9',
    });
    expect(detectCreateFromReference('#1825')).toEqual({
      mode: 'pr',
      value: '#1825',
    });
    expect(detectCreateFromReference('1825')).toEqual({
      mode: 'pr',
      value: '1825',
    });
  });

  it('falls back to branch for everything else', () => {
    expect(detectCreateFromReference('feature/checkout-flow')).toEqual({
      mode: 'branch',
      value: 'feature/checkout-flow',
    });
    expect(detectCreateFromReference('ryan/ecw-8121-create')).toEqual({
      mode: 'branch',
      value: 'ryan/ecw-8121-create',
    });
  });

  it('returns null for empty/whitespace input', () => {
    expect(detectCreateFromReference('')).toBeNull();
    expect(detectCreateFromReference('   ')).toBeNull();
  });
});

describe('reference host validation', () => {
  it('does not resolve lookalike or embedded GitHub hosts', () => {
    expect(
      parsePullRequestReference('https://evilgithub.com/o/r/pull/7'),
    ).toBeNull();
    expect(
      parsePullRequestReference('https://example.com/github.com/o/r/pull/7'),
    ).toBeNull();
  });

  it('does not resolve lookalike Linear hosts', () => {
    expect(
      parseLinearIdentifier('https://evillinear.app/acme/issue/CAN-7'),
    ).toBeNull();
  });
});

describe('parseGitHubRepositoryReference', () => {
  it.each([
    'https://github.com/Owner/Repo',
    'https://github.com/owner/repo.git/',
    'https://github.com/OWNER/REPO?tab=readme#readme',
    'https://github.com/owner/repo/tree/feature/nested',
  ])('normalizes repository identity from %s', (url) => {
    expect(parseGitHubRepositoryReference(url)).toEqual({
      owner: 'owner',
      repo: 'repo',
      repositoryKey: 'github.com/owner/repo',
      url: 'https://github.com/owner/repo',
    });
  });

  it.each([
    'https://github.com/o/r/issues/7',
    'https://github.com/o/r/pull/7',
    'https://github.com/o/r/blob/main/file',
    'https://github.com/o/r/tree/',
    'https://github.com/o/r/actions',
    'https://github.com/o/',
    'https://github.com/o/.git',
    'https://github.com:444/o/r',
    'https://user@github.com/o/r',
    'https://evilgithub.com/o/r',
    'https://github.com.example/o/r',
    'https://github.com/o/r%2Fother',
    'ftp://github.com/o/r',
    'not a URL',
  ])('rejects unsupported or malformed repository URL %s', (url) => {
    expect(parseGitHubRepositoryReference(url)).toBeNull();
  });
});

describe('extractCreateFromReferences', () => {
  it('rejects unsupported pull-request routes', () => {
    expect(
      extractCreateFromReferences(
        'https://github.com/acme/app/pull/7/arbitrary',
      ).references,
    ).toEqual([]);
  });
  it.each([
    "'https://github.com/o/r'",
    '"https://github.com/o/r"',
    '<https://github.com/o/r>',
    '`https://github.com/o/r`',
  ])('finds a repository in quoted or delimited prose %s', (text) => {
    expect(
      extractCreateFromReferences(text).references.map(
        (reference) => reference.key,
      ),
    ).toEqual(['github.com/o/r']);
  });

  it('finds supported references in prose and Markdown', () => {
    expect(
      extractCreateFromReferences(
        'Use [PR](https://github.com/O/R/pull/007/files?diff=split#x), (https://github.com/other/repo/tree/dev). See https://linear.app/acme/issue/can-3606/title and CAN-3606.',
      ),
    ).toEqual({
      complete: true,
      references: [
        {
          kind: 'pr',
          owner: 'o',
          repo: 'r',
          repositoryKey: 'github.com/o/r',
          url: 'https://github.com/o/r/pull/7',
          number: 7,
          key: 'github.com/o/r/pull/7',
        },
        {
          kind: 'repository',
          owner: 'other',
          repo: 'repo',
          repositoryKey: 'github.com/other/repo',
          url: 'https://github.com/other/repo',
          key: 'github.com/other/repo',
        },
        { kind: 'linear', identifier: 'CAN-3606', key: 'linear:CAN-3606' },
      ],
    });
  });

  it('deduplicates URL variants and lets a PR subsume only its own repository', () => {
    const { references, complete } = extractCreateFromReferences(
      'https://github.com/O/R.git/ https://github.com/o/r/tree/main https://github.com/o/r/pull/7 https://github.com/O/R/pull/007?x=1 https://github.com/other/repo',
    );
    expect(complete).toBe(true);
    expect(references.map((reference) => reference.key)).toEqual([
      'github.com/o/r/pull/7',
      'github.com/other/repo',
    ]);
  });

  it('preserves distinct PRs, issues and repositories for caller selection', () => {
    const { references } = extractCreateFromReferences(
      'https://github.com/o/r/pull/7 https://github.com/o/r/pull/8 https://github.com/o/other CAN-1 can-2',
    );
    expect(references.map((reference) => reference.key)).toEqual([
      'github.com/o/r/pull/7',
      'github.com/o/r/pull/8',
      'github.com/o/other',
      'linear:CAN-1',
      'linear:CAN-2',
    ]);
  });

  it.each([
    '123 #123',
    'prefixCAN-7suffix CAN-7-branch feature/CAN-7 @CAN-7 user_CAN-7 CAN-7@example.com CAN-7.ts',
    'https://evilgithub.com/o/r/pull/7 https://github.com/o/r/pull/0 https://github.com/o/r/pull/7x',
    'https://evillinear.app/acme/issue/CAN-7 https://example.com/?issue=CAN-7',
    'https://linear.app/acme/issue/CAN-7evil https://linear.app/acme/project/CAN-7',
    'https://github.com/o/r/pull/9007199254740993',
    'https://github.com/o/r/issues/7',
  ])('ignores unsupported references in %s', (text) => {
    expect(extractCreateFromReferences(text)).toEqual({
      references: [],
      complete: true,
    });
  });

  it('normalizes standalone identifier case with punctuation boundaries', () => {
    expect(
      extractCreateFromReferences('(can-7), CAN-7; [ABC9-12].').references.map(
        (reference) => reference.key,
      ),
    ).toEqual(['linear:CAN-7', 'linear:ABC9-12']);
  });

  it.each([
    'https://github.com/acme/app',
    'https://github.com/acme/app/pull/7',
    'https://linear.app/acme/issue/CAN-1',
  ])('recognizes long benign query and fragment decoration on %s', (url) => {
    for (const suffix of ['?utm=', '#anchor=']) {
      expect(
        extractCreateFromReferences(`${url}${suffix}${'x'.repeat(3000)}`),
      ).toEqual(extractCreateFromReferences(url));
    }
  });

  it('reports limits without claiming a unique target', () => {
    expect(extractCreateFromReferences('x'.repeat(100_001))).toEqual({
      references: [],
      complete: false,
    });
    const result = extractCreateFromReferences(
      Array.from({ length: 101 }, (_, index) => `CAN-${index + 1}`).join(' '),
    );
    expect(result.complete).toBe(false);
    expect(result.references).toHaveLength(100);
  });
});

describe('scanReferenceOccurrences', () => {
  const spans = (text: string): string[] =>
    scanReferenceOccurrences(text).occurrences.map(({ start, end }) =>
      text.slice(start, end),
    );

  it('keeps every occurrence with exclusive offsets in text order', () => {
    const text =
      'CAN-1 then https://github.com/o/r and https://github.com/o/r/pull/7 then can-1 (CAN-1).';
    expect(spans(text)).toEqual([
      'CAN-1',
      'https://github.com/o/r',
      'https://github.com/o/r/pull/7',
      'can-1',
      'CAN-1',
    ]);
    expect(
      scanReferenceOccurrences(text).occurrences.map(
        ({ reference }) => reference.key,
      ),
    ).toEqual([
      'linear:CAN-1',
      'github.com/o/r',
      'github.com/o/r/pull/7',
      'linear:CAN-1',
      'linear:CAN-1',
    ]);
  });

  it('keeps a Linear URL workspace and the original destination', () => {
    const text =
      'See https://linear.app/Acme/issue/can-7/title?x=1#c), then go.';
    expect(scanReferenceOccurrences(text)).toEqual({
      complete: true,
      occurrences: [
        {
          start: 4,
          end: 51,
          reference: {
            kind: 'linear',
            identifier: 'CAN-7',
            key: 'linear:CAN-7',
          },
          originalUrl: 'https://linear.app/Acme/issue/can-7/title?x=1#c',
          linearWorkspaceSlug: 'acme',
        },
      ],
    });
  });

  it('ignores identifiers inside unrelated URLs and identifier lookalikes', () => {
    expect(
      spans(
        'https://example.com/?issue=CAN-7 feature/CAN-7 CAN-7.ts @CAN-7 CAN-7-x',
      ),
    ).toEqual([]);
  });

  it('bounds the text and occurrence count', () => {
    expect(scanReferenceOccurrences('x'.repeat(100_001))).toEqual({
      occurrences: [],
      complete: false,
    });
    const result = scanReferenceOccurrences(
      Array.from({ length: 101 }, () => 'CAN-1').join(' '),
    );
    expect(result.complete).toBe(false);
    expect(result.occurrences).toHaveLength(100);
  });

  it('leaves the create-worktree aggregate deduplicated', () => {
    expect(
      extractCreateFromReferences(
        Array.from({ length: 150 }, () => 'CAN-1').join(' '),
      ),
    ).toEqual({
      complete: true,
      references: [
        { kind: 'linear', identifier: 'CAN-1', key: 'linear:CAN-1' },
      ],
    });
  });
});
