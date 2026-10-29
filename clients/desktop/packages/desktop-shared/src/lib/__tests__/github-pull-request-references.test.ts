import {
  isGitHubPullRequestUrl,
  normalizeGitHubPullRequestNumber,
  normalizeGitHubPullRequestTargets,
  parseGitHubPullRequestReference,
} from '../github-pull-request-references';

describe('parseGitHubPullRequestReference', () => {
  it.each([
    'https://github.com/Acme/API/pull/42',
    'https://github.com/acme/api/pull/42/',
    'https://github.com/acme/api/pull/42/files',
    'https://github.com/acme/api/pull/42/commits/abc123',
    'https://github.com/acme/api/pull/42?w=1',
    'https://github.com/acme/api/pull/42#discussion_r1',
    'https://www.github.com/acme/api/pull/42/checks?check_run_id=9#step:1',
    'acme/api#42',
    'Acme/API#42',
  ])('parses %s', (reference) => {
    expect(parseGitHubPullRequestReference(reference)).toEqual({
      ok: true,
      value: { repository: 'acme/api', number: 42 },
    });
  });

  it.each([
    'https://gitlab.com/acme/api/pull/42',
    'https://github.example.com/acme/api/pull/42',
    'http://github.com/acme/api/pull/42',
    'https://api.github.com/repos/acme/api/pulls/42',
    'https://user@github.com/acme/api/pull/42',
    'https://github.com:8443/acme/api/pull/42',
  ])('rejects non-GitHub.com URL %s', (reference) => {
    expect(parseGitHubPullRequestReference(reference)).toMatchObject({
      ok: false,
      code: 'invalid_reference',
      message: 'Only GitHub.com pull request references are supported.',
    });
  });

  it.each([
    'https://github.com/acme/api/actions/runs/123',
    'https://github.com/acme/api/actions/runs/123/job/456',
    'https://github.com/acme/api/issues/42',
    'https://github.com/acme/api/pulls',
    'https://github.com/acme/api/pull/0',
    'https://github.com/acme/api/pull/-1',
    'https://github.com/acme/api/pull/4x2',
    'https://github.com/acme/api/pull/99999999999',
    'https://github.com/acme//api/pull/42',
    'https://github.com/ac%2Fme/api/pull/42',
    'https://github.com/acme/../pull/42',
    'acme/api#0',
    'acme/api#',
    'acme#42',
    'acme/api/x#42',
    'ac me/api#42',
    'acme/api#42/1',
    ' acme/api#42',
    '42',
    '',
  ])('rejects malformed reference %s', (reference) => {
    expect(parseGitHubPullRequestReference(reference)).toMatchObject({
      ok: false,
      code: 'invalid_reference',
    });
  });

  // The URL parser silently strips tab, CR and LF anywhere in the input.
  it.each([
    'https://git\thub.com/acme/api/pull/42',
    'https://github.com/acme/api/pull/4\t2',
    'https://github.com/acme/api/pull/4\r2',
    'https://github.com/ac\nme/api/pull/42',
    'https://github.com/acme/api/pull/42\u0000',
    'acme/api#4\t2',
    'ac\tme/api#42',
  ])('rejects embedded control characters in %j', (reference) => {
    expect(parseGitHubPullRequestReference(reference)).toMatchObject({
      ok: false,
      code: 'invalid_reference',
    });
    expect(isGitHubPullRequestUrl(reference)).toBe(false);
  });

  // The URL parser drops a default port and resolves backslashes and dot
  // segments, which would turn these into a valid canonical path.
  it.each([
    'https://github.com/acme\\api/pull/42',
    'https://github.com/acme/x/../api/pull/42',
    'https://github.com/acme/./api/pull/42',
    'https://github.com/acme/x/%2e%2e/api/pull/42',
    'https://github.com/acme/x/.%2E/api/pull/42',
    'https://github.com/acme/api/pull/42/../43',
    'https://github.com/acme/api/pull/42/%2e%2e/43',
    'https://github.com:443/acme/api/pull/42',
    'https://github.com:/acme/api/pull/42',
  ])('rejects URL syntax the parser would canonicalize: %j', (reference) => {
    expect(parseGitHubPullRequestReference(reference)).toMatchObject({
      ok: false,
      code: 'invalid_reference',
    });
    expect(isGitHubPullRequestUrl(reference)).toBe(false);
  });

  it('rejects non-string references', () => {
    expect(parseGitHubPullRequestReference(42)).toMatchObject({
      ok: false,
      code: 'invalid_reference',
    });
  });
});

describe('isGitHubPullRequestUrl', () => {
  it('detects only GitHub.com pull request URLs', () => {
    expect(isGitHubPullRequestUrl('https://github.com/acme/api/pull/1')).toBe(
      true,
    );
    expect(isGitHubPullRequestUrl('acme/api#1')).toBe(false);
    expect(
      isGitHubPullRequestUrl('https://github.com/acme/api/actions/runs/1'),
    ).toBe(false);
    expect(isGitHubPullRequestUrl(1)).toBe(false);
  });
});

describe('normalizeGitHubPullRequestNumber', () => {
  it.each([
    [7, 7],
    ['7', 7],
    ['007', 7],
    [0, null],
    [-3, null],
    [1.5, null],
    ['1.5', null],
    ['', null],
    [Number.MAX_SAFE_INTEGER + 1, null],
    ['12345678901', null],
    [12345678901, null],
    [9999999999, 9999999999],
    ['9999999999', 9999999999],
    [null, null],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeGitHubPullRequestNumber(input)).toBe(expected);
  });
});

describe('normalizeGitHubPullRequestTargets', () => {
  it('uses the item repository before the default repository', () => {
    expect(
      normalizeGitHubPullRequestTargets({
        items: [
          { kind: 'pull_request', repository: 'acme/web', number: 1 },
          { kind: 'pull_request', number: '2' },
        ],
        repository: 'https://github.com/acme/api',
      }),
    ).toEqual({
      ok: true,
      targets: [
        { kind: 'pull_request', repository: 'acme/web', number: 1 },
        { kind: 'pull_request', repository: 'acme/api', number: 2 },
      ],
    });
  });

  it('reports the failing item and field', () => {
    expect(
      normalizeGitHubPullRequestTargets({
        items: [
          { kind: 'pull_request', target: 'acme/api#1' },
          { kind: 'pull_request', repository: 'not a repo', number: 2 },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: 'invalid_reference',
      itemIndex: 1,
      field: 'items',
    });
    expect(
      normalizeGitHubPullRequestTargets({
        items: [{ kind: 'pull_request', number: 2 }],
        repository: 'acme',
      }),
    ).toMatchObject({
      ok: false,
      code: 'invalid_reference',
      field: 'repository',
    });
  });

  it('rejects control characters in repository fields', () => {
    expect(
      normalizeGitHubPullRequestTargets({
        items: [
          {
            kind: 'pull_request',
            repository: 'https://git\thub.com/acme/api',
            number: 2,
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: 'invalid_reference', itemIndex: 0 });
    expect(
      normalizeGitHubPullRequestTargets({
        items: [{ kind: 'pull_request', number: 2 }],
        repository: 'https://github.com/ac\nme/api',
      }),
    ).toMatchObject({
      ok: false,
      code: 'invalid_reference',
      field: 'repository',
    });
    expect(
      normalizeGitHubPullRequestTargets({
        items: [{ kind: 'pull_request', number: 2 }],
        repositoryCandidates: ['https://github.com/ac\tme/api'],
      }),
    ).toMatchObject({ ok: false, code: 'repository_required' });
  });

  it('rejects repository URLs the parser would canonicalize', () => {
    for (const repository of [
      'https://github.com/acme/x/../api',
      'https://github.com/acme/api/../web',
      'https://github.com:443/acme/api',
      'https://github.com/acme\\api',
    ]) {
      expect(
        normalizeGitHubPullRequestTargets({
          items: [{ kind: 'pull_request', repository, number: 2 }],
        }),
      ).toMatchObject({ ok: false, code: 'invalid_reference', itemIndex: 0 });
    }
  });

  it('rejects bare numbers and unknown item shapes', () => {
    for (const item of [
      { kind: 'pull_request', target: 42 },
      { kind: 'pull_request', target: '42' },
      { kind: 'pull_request' },
      { kind: 'pull_request', number: 1, url: 'x' },
      'acme/api#1',
    ]) {
      expect(
        normalizeGitHubPullRequestTargets({
          items: [item],
          repository: 'acme/api',
        }),
      ).toMatchObject({ ok: false, itemIndex: 0 });
    }
  });
});
