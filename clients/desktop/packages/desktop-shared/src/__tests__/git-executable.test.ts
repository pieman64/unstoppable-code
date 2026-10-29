import {
  getGitExecutableCommand,
  getLinuxGitCandidates,
  parseGitVersion,
} from '../lib/git-executable';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

it('uses CANOPY_GIT_EXECUTABLE when set', () => {
  process.env.CANOPY_GIT_EXECUTABLE = 'C:\\Program Files\\Git\\cmd\\git.exe';
  expect(getGitExecutableCommand(process.env)).toBe(
    'C:\\Program Files\\Git\\cmd\\git.exe',
  );
});

it('falls back to git when no override is set', () => {
  delete process.env.CANOPY_GIT_EXECUTABLE;
  expect(getGitExecutableCommand(process.env)).toBe('git');
});

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.43.0\n', 'git version 2.43.0'],
    [
      'warning: noise\nGit Version 2.50.1.windows.1',
      'Git Version 2.50.1.windows.1',
    ],
    ['git version 2.39.5 (Apple Git-154)', 'git version 2.39.5'],
  ])('extracts the reported version from %j', (output, expected) => {
    expect(parseGitVersion(output)).toBe(expected);
  });

  it.each(['', 'not git\n', 'git: command not found', 'digit version 1'])(
    'rejects output that does not report a Git version: %j',
    (output) => {
      expect(parseGitVersion(output)).toBeNull();
    },
  );
});

describe('parseGitVersion strict mode', () => {
  it('keeps the legacy parser permissive unless numeric versions are required', () => {
    expect(parseGitVersion('git version banana')).toBe('git version banana');
    expect(parseGitVersion('git version banana', { numeric: true })).toBeNull();
  });

  it.each([
    ['git version 2.43.0\n', 'git version 2.43.0'],
    ['git version 2.39.5 (Apple Git-154)', 'git version 2.39.5'],
    ['noise\ngit version 2.40.0-rc1', 'git version 2.40.0-rc1'],
  ])('accepts numeric versions in %j', (output, expected) => {
    expect(parseGitVersion(output, { numeric: true })).toBe(expected);
  });

  it.each(['git version', 'git version v2', 'git version 2', 'git version .5'])(
    'rejects %j when numeric versions are required',
    (output) => {
      expect(parseGitVersion(output, { numeric: true })).toBeNull();
    },
  );
});

describe('getLinuxGitCandidates', () => {
  it('tries the refreshed login PATH first and the system location last', () => {
    expect(getLinuxGitCandidates('/opt/git/bin:/usr/local/bin')).toEqual([
      { path: '/opt/git/bin/git', source: 'login-path' },
      { path: '/usr/local/bin/git', source: 'login-path' },
      { path: '/usr/bin/git', source: 'system' },
    ]);
  });

  it('keeps PATH order, drops relative and empty entries, and dedupes', () => {
    expect(
      getLinuxGitCandidates(
        '/home/u/.local/bin::relative/bin:.:/usr/local/bin/:/usr/bin:/home/u/.local/bin://usr//bin',
      ),
    ).toEqual([
      { path: '/home/u/.local/bin/git', source: 'login-path' },
      { path: '/usr/local/bin/git', source: 'login-path' },
      { path: '/usr/bin/git', source: 'login-path' },
    ]);
  });

  it('handles the root directory', () => {
    expect(getLinuxGitCandidates('/')).toEqual([
      { path: '/git', source: 'login-path' },
      { path: '/usr/bin/git', source: 'system' },
    ]);
  });

  it('reports a system location already on the login PATH as login-path once', () => {
    expect(getLinuxGitCandidates('/usr/bin:/bin')).toEqual([
      { path: '/usr/bin/git', source: 'login-path' },
      { path: '/bin/git', source: 'login-path' },
    ]);
  });

  it('still offers the system location when the login PATH is empty', () => {
    expect(getLinuxGitCandidates('')).toEqual([
      { path: '/usr/bin/git', source: 'system' },
    ]);
  });
});
