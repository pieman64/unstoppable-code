import {
  normalizeRepositoryCloneUrl,
  repositoryCloneErrorMessage,
  portalRepositoryCloneErrorMessage,
  PORTAL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE,
  REPOSITORY_CLONE_FAILURE_MESSAGE,
} from '../index';

describe('repositoryCloneErrorMessage', () => {
  it.each([
    'This change was saved but did not finish and needs recovery.',
    'This request was saved but did not finish and needs recovery.',
    'An earlier attempt of this request was interrupted and needs recovery.',
  ])('preserves exact controlled recovery copy: %s', (message) => {
    expect(repositoryCloneErrorMessage(message)).toBe(message);
    expect(repositoryCloneErrorMessage(new Error(message))).toBe(message);
  });

  it.each([
    null,
    undefined,
    {},
    new Error('fatal: private credentials'),
    Object.assign(new Error('malformed'), { message: null }),
    'This change was saved but did not finish and needs recovery. private diagnostics',
    ' This change was saved but did not finish and needs recovery.',
  ])('sanitizes unknown and misleading local failures: %p', (input) => {
    expect(repositoryCloneErrorMessage(input)).toBe(
      REPOSITORY_CLONE_FAILURE_MESSAGE,
    );
  });
});

describe('normalizeRepositoryCloneUrl', () => {
  const recognized = [
    [
      'https://github.com/cursor/plugins/tree/main/pstack',
      'https://github.com/cursor/plugins',
    ],
    [
      ' https://github.com/Owner/Repo.git/blob/main/a.md/ ',
      'https://github.com/Owner/Repo.git',
    ],
    [
      'HTTP://WWW.GITHUB.COM/Owner/Repo/tree/feature/with/slashes?x=1#readme',
      'http://github.com/Owner/Repo',
    ],
    ['https://GiThUb.CoM/a-b/a_b.c/tree/main/', 'https://github.com/a-b/a_b.c'],
    ['https://github.com/o/r/tree/main', 'https://github.com/o/r'],
    [
      'https://github.com/o/r/blob/main/file?raw=true',
      'https://github.com/o/r',
    ],
    [
      'https://github.com/o/r/tree/a%20b/f%C3%B6o/%252f/%252e%252e',
      'https://github.com/o/r',
    ],
    ['https://github.com/-/r/tree/main', 'https://github.com/-/r'],
  ];
  const unchanged = [
    '',
    '   ',
    ' https://github.com/o/r ',
    'https://github.com/o/r/',
    'https://github.com/o/r?x=1#readme',
    'https://github.com/o/r/#readme',
    'https://www.github.com/o/r.git',
    'git@github.com:o/r.git',
    'ssh://git@github.com/o/r/tree/main/f',
    '/tmp/repo/tree/main',
    'C:\\repos\\thing',
    'file:///tmp/repo/tree/main',
    'https://gitlab.com/o/r/tree/main/f',
    'git://github.com/o/r/tree/main',
    'https://github.com.evil.test/o/r/tree/main',
    'https://github.com./o/r/tree/main',
    'https://github.example.com/o/r/tree/main',
    'https://github.com:443/o/r/tree/main',
    'http://github.com:80/o/r/tree/main',
    'https://www.github.com:443/o/r/tree/main',
    'https://user:secret@github.com/o/r/tree/main',
    'https://github.com@evil.test/o/r/tree/main',
    'https://github.com/o/./tree/main',
    'https://github.com/o/../r/tree/main',
    'https://github.com/o/r/tree/../main',
    'https://github.com/o/r/tree/%2E%2e/main',
    'https://github.com/o/r/tree/.%2e/main',
    'https://github.com/o/r/tree/%2e/main',
    'https://github.com/o/r/tree/a%2Fb/f',
    'https://github.com/o/r/tree/a%5Cb/f',
    'https://github.com/o/r/tree/a\\b/f',
    'https://github.com/o/r/tree/a b/f',
    'https://github.com/o/r/tree/a\nb/f',
    'https://github.com/o/r/tree/a\u0000b/f',
    'https://github.com/o/r/tree/a\u0085b/f',
    'https://github.com/o/r/tree/a%2',
    'https://github.com/o/r/tree/a%zz',
    'https://github.com/o/r/tree/main?x=%zz',
    'https://github.com/o/r/tree/main//f',
    'https://github.com//r/tree/main',
    'https://github.com/o//tree/main',
    'https://github.com/o/r/tree/main//',
    'https://github.com/o/r/TREE/main',
    'https://github.com/o/r/BLOB/main/f',
    'https://github.com/o/r/tree',
    'https://github.com/o/r/tree/?ref=main',
    'https://github.com/o/r/blob/main',
    'https://github.com/o/r/blob/main/#file',
    'https://github.com/o/r/blob?main/file',
    'https://github.com/o/r/issues/123',
    'https://github.com/o/r/commit/123',
    'https://github.com/o/.git/tree/main',
    'https://github.com/o_/r/tree/main',
    'https://github.com/%6f/r/tree/main',
    'https://github.com/o/r%65po/tree/main',
  ];
  it.each(recognized)('normalizes %s', (input, expected) => {
    expect(normalizeRepositoryCloneUrl(input)).toBe(expected);
  });
  it.each(unchanged)('preserves unrecognized remote %s', (input) => {
    expect(normalizeRepositoryCloneUrl(input)).toBe(input.trim());
  });
  it.each([...recognized.map(([input]) => input), ...unchanged])(
    'is idempotent for %s',
    (input) => {
      const once = normalizeRepositoryCloneUrl(input);
      expect(normalizeRepositoryCloneUrl(once)).toBe(once);
    },
  );
});

describe('portalRepositoryCloneErrorMessage', () => {
  const prefix = 'Portal command portal.workspace.create failed: ';
  const safe = [
    REPOSITORY_CLONE_FAILURE_MESSAGE,
    PORTAL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE,
    'Could not confirm the clone request on the desktop. Check Projects before trying again.',
    'Could not confirm the clone result on the desktop. Check Projects before trying again.',
    'The desktop restarted before the clone result was confirmed. Check Projects before trying again.',
    'The clone request expired before the desktop confirmed it. Check Projects before trying again.',
  ];
  it.each(safe)('preserves only exact safe message %s', (message) => {
    for (const input of [
      message,
      new Error(message),
      prefix + message,
      new Error(prefix + message),
    ]) {
      expect(portalRepositoryCloneErrorMessage(input)).toBe(message);
      expect(
        portalRepositoryCloneErrorMessage(
          portalRepositoryCloneErrorMessage(input),
        ),
      ).toBe(message);
    }
  });
  it.each([
    null,
    undefined,
    42,
    {},
    { message: REPOSITORY_CLONE_FAILURE_MESSAGE },
    Object.assign(new Error('malformed'), { message: 42 }),
    Object.assign(new Error('malformed'), { message: null }),
    {
      toString: (): never => {
        throw new Error('must not stringify');
      },
    },
    'fatal: clone https://user:secret@host/r into /private/path failed',
    new Error('disconnected'),
    '',
    'Check Projects',
    `diagnostic ${REPOSITORY_CLONE_FAILURE_MESSAGE}`,
    `${REPOSITORY_CLONE_FAILURE_MESSAGE} fatal: secret`,
    ` ${REPOSITORY_CLONE_FAILURE_MESSAGE}`,
    `${prefix}${prefix}${REPOSITORY_CLONE_FAILURE_MESSAGE}`,
    `Portal command other failed: ${REPOSITORY_CLONE_FAILURE_MESSAGE}`,
  ])('keeps unknown completion uncertain (%p)', (input) => {
    expect(portalRepositoryCloneErrorMessage(input)).toBe(
      PORTAL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE,
    );
  });
});
