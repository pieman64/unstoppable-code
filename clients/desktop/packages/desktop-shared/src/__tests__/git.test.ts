import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({
    CUSTOM_ENV: 'from-enhanced-env',
    PATH: '/enhanced/bin:/usr/bin',
  })),
}));

import {
  commitWithMessage,
  getCurrentBranchDisplayName,
  hasBranchBeenPushedToRemote,
  readBranchPublication,
  getRemoteDefaultBranch,
  setGitExecutableResolver,
  setLocalRemoteHeadBranch,
} from '../lib/git';
import { getEnhancedEnv } from '../pipelines/config-paths';

const mockedGetEnhancedEnv = jest.mocked(getEnhancedEnv);

describe('shared git helpers', () => {
  let tempDir: string;
  let originalGitExecutable: string | undefined;

  beforeEach(() => {
    originalGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    mockedGetEnhancedEnv.mockClear();
    mockedGetEnhancedEnv.mockReturnValue({
      CUSTOM_ENV: 'from-enhanced-env',
      PATH: '/enhanced/bin:/usr/bin',
    });
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-git-test-'));
  });

  afterEach(() => {
    setGitExecutableResolver(null);
    if (originalGitExecutable === undefined) {
      delete process.env.CANOPY_GIT_EXECUTABLE;
    } else {
      process.env.CANOPY_GIT_EXECUTABLE = originalGitExecutable;
    }
    jest.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses an injected executable resolver for each shared Git launch', async () => {
    const executable = join(tempDir, 'resolved-git');
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" injected-branch\n');
    chmodSync(executable, 0o755);
    process.env.CANOPY_GIT_EXECUTABLE = join(tempDir, 'stale-git');
    const resolver = jest.fn(() => Promise.resolve(executable));
    setGitExecutableResolver(resolver);

    await expect(getCurrentBranchDisplayName(tempDir)).resolves.toBe(
      'injected-branch',
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it.each(['present', 'missing', 'unavailable'])(
    'distinguishes publication from probe failure (%s ref)',
    async (state) => {
      if (state !== 'unavailable') {
        execFileSync('git', ['init', '-b', 'feature'], {
          cwd: tempDir,
          stdio: 'ignore',
        });
        execFileSync(
          'git',
          [
            '-c',
            'core.hooksPath=',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--allow-empty',
            '-m',
            'Seed',
          ],
          { cwd: tempDir, stdio: 'ignore' },
        );
      }
      if (state === 'present') {
        const refs = join(tempDir, '.git', 'refs', 'remotes', 'origin');
        mkdirSync(refs, { recursive: true });
        const value = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tempDir,
          encoding: 'utf8',
        });
        writeFileSync(join(refs, 'feature'), value);
      }
      mockedGetEnhancedEnv.mockReturnValue({ ...process.env });
      setGitExecutableResolver(() => Promise.resolve('git'));
      await expect(readBranchPublication(tempDir)).resolves.toBe(
        state === 'present' ? true : state === 'missing' ? false : null,
      );
      await expect(hasBranchBeenPushedToRemote(tempDir)).resolves.toBe(
        state === 'present',
      );
    },
  );

  it('keeps a spawn failure unknown while the boolean API stays fail-closed', async () => {
    setGitExecutableResolver(() =>
      Promise.resolve(join(tempDir, 'missing-git')),
    );
    await expect(readBranchPublication(tempDir)).resolves.toBeNull();
    await expect(hasBranchBeenPushedToRemote(tempDir)).resolves.toBe(false);
  });

  function installDefaultBranchGit(options?: {
    localBranch?: string;
    remoteBranch?: string;
    remoteDelaySeconds?: number;
  }): string {
    const executable = join(tempDir, 'fake-git');
    const logPath = join(tempDir, 'git.log');
    const commonDir = join(tempDir, 'common.git');
    const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
if [ "$1 $2" = "rev-parse --path-format=absolute" ]; then
  printf '%s\\n' '${commonDir}'
  exit 0
fi
if [ "$1" = "symbolic-ref" ]; then
  ${options?.localBranch ? `printf '%s\\n' 'refs/remotes/origin/${options.localBranch}'; exit 0` : 'exit 1'}
fi
if [ "$1" = "ls-remote" ]; then
  ${options?.remoteDelaySeconds ? `sleep ${options.remoteDelaySeconds}` : ''}
  ${options?.remoteBranch ? `printf '%s\\n' 'ref: refs/heads/${options.remoteBranch} HEAD'; exit 0` : 'exit 1'}
fi
if [ "$1 $2 $3" = "remote set-head origin" ]; then
  exit 0
fi
exit 1
`;
    writeFileSync(executable, script);
    chmodSync(executable, 0o755);
    process.env.CANOPY_GIT_EXECUTABLE = executable;
    return logPath;
  }

  function readGitCalls(logPath: string): string[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  }

  it('runs git commits with the enhanced environment so hooks can resolve PATH tools', async () => {
    const repoPath = join(tempDir, 'repo');
    const binPath = join(tempDir, 'bin');
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(binPath, { recursive: true });

    const fakeNpmPath = join(binPath, 'npm');
    writeFileSync(fakeNpmPath, '#!/bin/sh\necho fake-npm\n');
    chmodSync(fakeNpmPath, 0o755);

    mockedGetEnhancedEnv.mockReturnValue({
      ...process.env,
      PATH: `${binPath}${delimiter}${process.env.PATH ?? ''}`,
    });

    execFileSync('git', ['init'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Canopy Test'], {
      cwd: repoPath,
    });
    execFileSync('git', ['config', 'user.email', 'canopy@example.com'], {
      cwd: repoPath,
    });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repoPath,
    });

    writeFileSync(
      join(repoPath, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\ncommand -v npm > .git/hook-npm-path\nnpm > .git/hook-npm-output\n',
    );
    chmodSync(join(repoPath, '.git', 'hooks', 'pre-commit'), 0o755);

    writeFileSync(join(repoPath, 'file.txt'), 'content\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repoPath });

    await expect(commitWithMessage(repoPath, 'Test commit')).resolves.toMatch(
      /^[a-f0-9]+$/,
    );
    expect(
      execFileSync('cat', [join(repoPath, '.git', 'hook-npm-path')], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(fakeNpmPath);
    expect(
      execFileSync('cat', [join(repoPath, '.git', 'hook-npm-output')], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('fake-npm');
  });

  it('uses the original branch name as the display name during an interrupted rebase', async () => {
    const repoPath = join(tempDir, 'repo');
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
    };
    mkdirSync(repoPath, { recursive: true });

    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Canopy Test']);
    git(['config', 'user.email', 'canopy@example.com']);
    git(['config', 'commit.gpgsign', 'false']);

    writeFileSync(join(repoPath, 'file.txt'), 'base\n');
    git(['add', 'file.txt']);
    git(['commit', '-m', 'base']);

    git(['checkout', '-b', 'feature/rebase']);
    writeFileSync(join(repoPath, 'file.txt'), 'feature\n');
    git(['commit', '-am', 'feature']);

    git(['checkout', 'main']);
    writeFileSync(join(repoPath, 'file.txt'), 'main\n');
    git(['commit', '-am', 'main']);

    git(['checkout', 'feature/rebase']);
    expect(() => git(['rebase', 'main'])).toThrow();

    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim(),
    ).toBe('HEAD');
    await expect(getCurrentBranchDisplayName(repoPath)).resolves.toBe(
      'feature/rebase',
    );
  });

  it('propagates cancellation during remote default-branch discovery', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      getRemoteDefaultBranch(tempDir, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses local origin/HEAD without querying the remote', async () => {
    const logPath = installDefaultBranchGit({ localBranch: 'trunk' });

    await expect(getRemoteDefaultBranch(tempDir)).resolves.toBe('trunk');
    expect(readGitCalls(logPath)).not.toContain(
      'ls-remote --symref origin HEAD',
    );
  });

  it('prefers verified remote HEAD over a stale local origin/HEAD when requested', async () => {
    const logPath = installDefaultBranchGit({
      localBranch: 'main',
      remoteBranch: 'develop',
    });

    await expect(
      getRemoteDefaultBranch(tempDir, { preferRemote: true }),
    ).resolves.toBe('develop');
    expect(readGitCalls(logPath)).toContain('ls-remote --symref origin HEAD');
    expect(readGitCalls(logPath)).not.toContain(
      'symbolic-ref refs/remotes/origin/HEAD',
    );
  });

  it('updates the local origin HEAD symbolic ref to a verified branch', async () => {
    const logPath = installDefaultBranchGit();

    await setLocalRemoteHeadBranch(tempDir, 'develop');

    expect(readGitCalls(logPath)).toContain('remote set-head origin develop');
  });

  it('falls back to local origin/HEAD when remote-first discovery fails', async () => {
    const logPath = installDefaultBranchGit({ localBranch: 'main' });

    await expect(
      getRemoteDefaultBranch(tempDir, { preferRemote: true }),
    ).resolves.toBe('main');
    expect(readGitCalls(logPath)).toEqual(
      expect.arrayContaining([
        'ls-remote --symref origin HEAD',
        'symbolic-ref refs/remotes/origin/HEAD',
      ]),
    );
  });

  it('falls back to ls-remote when local origin/HEAD is absent', async () => {
    const logPath = installDefaultBranchGit({ remoteBranch: 'main' });

    await expect(getRemoteDefaultBranch(tempDir)).resolves.toBe('main');
    expect(readGitCalls(logPath)).toContain('ls-remote --symref origin HEAD');
  });

  it('never invokes ls-remote when network discovery is disabled', async () => {
    const logPath = installDefaultBranchGit();

    await expect(
      getRemoteDefaultBranch(tempDir, { allowNetwork: false }),
    ).resolves.toBeNull();
    expect(readGitCalls(logPath)).not.toContain(
      'ls-remote --symref origin HEAD',
    );
  });

  it('caches remote resolution for one minute and refreshes after the TTL', async () => {
    const logPath = installDefaultBranchGit({ remoteBranch: 'main' });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    await getRemoteDefaultBranch(tempDir);
    await getRemoteDefaultBranch(tempDir);
    now.mockReturnValue(61_001);
    await getRemoteDefaultBranch(tempDir);

    expect(
      readGitCalls(logPath).filter((call) => call.startsWith('ls-remote')),
    ).toHaveLength(2);
  });

  it('deduplicates concurrent remote resolution', async () => {
    const logPath = installDefaultBranchGit({
      remoteBranch: 'main',
      remoteDelaySeconds: 0.1,
    });

    await expect(
      Promise.all([
        getRemoteDefaultBranch(tempDir),
        getRemoteDefaultBranch(tempDir),
      ]),
    ).resolves.toEqual(['main', 'main']);
    expect(
      readGitCalls(logPath).filter((call) => call.startsWith('ls-remote')),
    ).toHaveLength(1);
  });

  it('detaches an aborted caller without cancelling shared resolution', async () => {
    const logPath = installDefaultBranchGit({
      remoteBranch: 'main',
      remoteDelaySeconds: 0.1,
    });
    const shared = getRemoteDefaultBranch(tempDir);
    const controller = new AbortController();
    const cancelled = getRemoteDefaultBranch(tempDir, {
      signal: controller.signal,
    });

    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(shared).resolves.toBe('main');
    expect(
      readGitCalls(logPath).filter((call) => call.startsWith('ls-remote')),
    ).toHaveLength(1);
  });

  it('rejects an already-aborted caller without cancelling shared resolution', async () => {
    const logPath = installDefaultBranchGit({
      remoteBranch: 'main',
      remoteDelaySeconds: 0.1,
    });
    const shared = getRemoteDefaultBranch(tempDir);
    const controller = new AbortController();
    controller.abort();

    await expect(
      getRemoteDefaultBranch(tempDir, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(shared).resolves.toBe('main');
    expect(
      readGitCalls(logPath).filter((call) => call.startsWith('ls-remote')),
    ).toHaveLength(1);
  });
});
