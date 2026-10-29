import { PassThrough } from 'node:stream';
import type * as ChildProcessModule from 'node:child_process';
import type * as FsPromisesModule from 'node:fs/promises';

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  execFile: jest.fn(),
}));
jest.mock('node:fs/promises');
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));
jest.mock('../lib/git-fetch-freshness', () => ({
  invalidateGitFetchFreshness: jest.fn(),
  readGitFetchFreshness: jest.fn(),
  recordGitFetchFailure: jest.fn(),
  recordGitFetchSuccess: jest.fn(),
}));
jest.mock('../lib/worktree-process-cleanup', () => ({
  terminateProcessesReferencingPath: jest.fn(() => Promise.resolve(0)),
}));

import {
  ChildProcess,
  execFile,
  type ExecFileOptions,
} from 'node:child_process';
import { Dirent, statSync, type Stats } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invalidateGitFetchFreshness,
  readGitFetchFreshness,
  recordGitFetchFailure,
  recordGitFetchSuccess,
} from '../lib/git-fetch-freshness';
import { terminateProcessesReferencingPath } from '../lib/worktree-process-cleanup';
import {
  addRemoteAndSync,
  applyIndexPatch,
  checkoutDetachedRef,
  checkoutBranch,
  createBranchAndCheckout,
  createWorktree,
  createWorktreeFromStartPoint,
  checkIgnoredPaths,
  cloneRepo,
  cloneRepoAtCommit,
  doesOriginBranchExist,
  fetchOrigin,
  getChangedFilesList,
  getCommittedFilesList,
  getComparisonDiff,
  getDiffStats,
  getFileDiffCombined,
  getFileDiffCommitted,
  getGitHeadWatchState,
  getLiveOriginBranchSha,
  pushBranchToOriginNonInteractive,
  getLocalDefaultBranch,
  getPushRemoteUrlStrict,
  getRemoteUrlStrict,
  initLocalRepo,
  isAncestor,
  listBranches,
  listIgnoredPathEntries,
  listTrackedFiles,
  moveWorktree,
  removeWindowsWorktreeReparsePoints,
  removeWorktree,
  resetRemoteDefaultBranchCacheForTests,
  withWorktreeRemovalLock,
} from '../lib/git';

const mockedExecFile = jest.mocked(execFile);
const mockedLstat = jest.mocked(lstat);
const mockedOpen = jest.mocked(open);
const mockedReaddir = jest.mocked(readdir);
const mockedReadFile = jest.mocked(readFile);
const mockedRealpath = jest.mocked(realpath);
const mockedRename = jest.mocked(rename);
const mockedRm = jest.mocked(rm);
const mockedStat = jest.mocked(stat);
const mockedWriteFile = jest.mocked(writeFile);
const mockedInvalidateGitFetchFreshness = jest.mocked(
  invalidateGitFetchFreshness,
);
const mockedReadGitFetchFreshness = jest.mocked(readGitFetchFreshness);
const mockedRecordGitFetchFailure = jest.mocked(recordGitFetchFailure);
const mockedRecordGitFetchSuccess = jest.mocked(recordGitFetchSuccess);
const mockedTerminateProcessesReferencingPath = jest.mocked(
  terminateProcessesReferencingPath,
);

type ExecFileCallback = (
  error: Error | null,
  result: { stdout: string; stderr: string },
) => void;

type ExecFileMockImplementation = (
  file: string,
  args: string[],
  options: ExecFileOptions | undefined,
  callback?: ExecFileCallback,
) => ExecFileMockResult | void;

interface ExecFileMockResult {
  stdinEnd?: (input: string) => void;
}

function mockExecFile(implementation: ExecFileMockImplementation): void {
  mockedExecFile.mockImplementation(
    (
      file: string,
      args: readonly string[] | null | undefined,
      options: ExecFileOptions | null | undefined,
      callback?: unknown,
    ): ChildProcess => {
      const child = new ChildProcess();
      let stdinEnd: ((input: string) => void) | undefined;
      Object.defineProperty(child, 'stdin', {
        value: {
          on: jest.fn(),
          end: (input: string): void => {
            stdinEnd?.(input);
          },
        },
      });
      const result = implementation(
        file,
        args ? [...args] : [],
        options ?? undefined,
        typeof callback === 'function'
          ? (error, result): void => {
              Reflect.apply(callback, undefined, [error, result]);
            }
          : undefined,
      );

      if (result?.stdinEnd) {
        stdinEnd = result.stdinEnd;
      }
      return child;
    },
  );
}

function handleLoginShellPathMock(
  args: string[],
  callback?: ExecFileCallback,
): boolean {
  if (args.join(' ') !== '-lic exec /usr/bin/printf \'%s\\n\' "$PATH"') {
    return false;
  }
  const stdout = process.env.PATH ?? '';
  const result: { stdout: string; stderr: string } = Object.assign(
    new String(stdout),
    {
      stdout,
      stderr: '',
    },
  );
  callback?.(null, result);
  return true;
}

function mockStats(options: {
  file?: boolean;
  directory?: boolean;
  symbolicLink?: boolean;
}): Stats {
  const stats = statSync(__filename);
  stats.isFile = (): boolean => options.file === true;
  stats.isDirectory = (): boolean => options.directory === true;
  stats.isSymbolicLink = (): boolean => options.symbolicLink === true;
  return stats;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRemoteDefaultBranchCacheForTests();
  mockedRealpath.mockImplementation((targetPath) =>
    Promise.resolve(String(targetPath)),
  );
  mockedInvalidateGitFetchFreshness.mockResolvedValue(undefined);
  mockedReadGitFetchFreshness.mockResolvedValue(null);
  mockedRecordGitFetchFailure.mockImplementation(({ identity, failedAt }) =>
    Promise.resolve({
      ...identity,
      lastAttemptAt: new Date(failedAt).toISOString(),
      lastFailureAt: new Date(failedAt).toISOString(),
      retryAfterAt: new Date(failedAt + 30_000).toISOString(),
      consecutiveFailures: 1,
    }),
  );
  mockedRecordGitFetchSuccess.mockResolvedValue(undefined);
});

describe('getGitHeadWatchState', () => {
  it('resolves an ordinary attached HEAD without launching Git', async () => {
    mockedStat.mockResolvedValue(mockStats({ directory: true }));
    mockedReadFile.mockResolvedValue('ref: refs/heads/feature/rename\n');
    const gitCommands: string[] = [];
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      const key = args.join(' ');
      gitCommands.push(key);
      cb?.(new Error(`Unexpected Git command: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(getGitHeadWatchState('/repo')).resolves.toEqual({
      headPath: '/repo/.git/HEAD',
      branchName: 'feature/rename',
    });
    expect(gitCommands).toEqual([]);
  });

  it('resolves a linked-worktree gitdir and attached HEAD without launching Git', async () => {
    mockedStat.mockResolvedValue(mockStats({ file: true }));
    mockedReadFile
      .mockResolvedValueOnce('gitdir: ../.git/worktrees/demo\n')
      .mockResolvedValueOnce('ref: refs/heads/feature/linked\n');

    await expect(getGitHeadWatchState('/repo/worktree')).resolves.toEqual({
      headPath: '/repo/.git/worktrees/demo/HEAD',
      branchName: 'feature/linked',
    });
    expect(mockedReadFile).toHaveBeenNthCalledWith(
      1,
      '/repo/worktree/.git',
      'utf8',
    );
    expect(mockedReadFile).toHaveBeenNthCalledWith(
      2,
      '/repo/.git/worktrees/demo/HEAD',
      'utf8',
    );
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('rejects incomplete combined output instead of watching an unknown path', async () => {
    mockedStat.mockRejectedValue(new Error('unsupported metadata layout'));
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      cb?.(null, { stdout: '.git/HEAD\n', stderr: '' });
    });

    await expect(getGitHeadWatchState('/repo')).rejects.toThrow(
      'Git did not return HEAD path and branch state',
    );
  });

  it('keeps the resolved watcher path when detached display lookup fails', async () => {
    mockedStat.mockRejectedValue(new Error('unsupported metadata layout'));
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      const key = args.join(' ');
      if (key === 'rev-parse --git-path HEAD --abbrev-ref HEAD') {
        cb?.(null, { stdout: '.git/HEAD\nHEAD\n', stderr: '' });
        return;
      }
      expect(key).toBe('rev-parse --abbrev-ref HEAD');
      cb?.(new Error('detached lookup failed'), {
        stdout: '',
        stderr: 'detached lookup failed',
      });
    });

    await expect(getGitHeadWatchState('/repo')).resolves.toEqual({
      headPath: '/repo/.git/HEAD',
      branchName: null,
    });
  });
});

describe('getRemoteUrlStrict', () => {
  it('returns null only when the origin remote is absent', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      const key = args.join(' ');
      if (key === 'remote get-url origin') {
        cb?.(new Error('No such remote'), {
          stdout: '',
          stderr: "error: No such remote 'origin'",
        });
        return;
      }
      expect(key).toBe('remote');
      cb?.(null, { stdout: 'upstream\n', stderr: '' });
    });

    await expect(getRemoteUrlStrict('/repo')).resolves.toBeNull();
  });

  it('returns the origin URL when origin is configured', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, {
          stdout: 'git@example.com:org/repo.git\n',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`unexpected git command: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(getRemoteUrlStrict('/repo')).resolves.toBe(
      'git@example.com:org/repo.git',
    );
  });

  it('propagates operational origin lookup failures', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(new Error('git remote lookup failed'), {
          stdout: '',
          stderr: 'transient git failure',
        });
        return;
      }
      if (key === 'remote') {
        cb?.(null, { stdout: 'origin\n', stderr: '' });
        return;
      }
      cb?.(new Error(`unexpected git command: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(getRemoteUrlStrict('/repo')).rejects.toThrow(
      'git remote lookup failed',
    );
  });
});

describe('getPushRemoteUrlStrict', () => {
  it('asks Git for the push URL, which may differ from the fetch URL', async () => {
    const calls: string[] = [];
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      const key = args.join(' ');
      calls.push(key);
      if (key === 'remote get-url --push origin') {
        cb?.(null, {
          stdout: 'git@github.com:acme/push-target.git\n',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`unexpected git command: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(getPushRemoteUrlStrict('/repo')).resolves.toBe(
      'git@github.com:acme/push-target.git',
    );
    expect(calls).toContain('remote get-url --push origin');
  });

  it('returns null only when the origin remote is absent', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      const key = args.join(' ');
      if (key === 'remote get-url --push origin') {
        cb?.(new Error('No such remote'), {
          stdout: '',
          stderr: "error: No such remote 'origin'",
        });
        return;
      }
      expect(key).toBe('remote');
      cb?.(null, { stdout: 'upstream\n', stderr: '' });
    });

    await expect(getPushRemoteUrlStrict('/repo')).resolves.toBeNull();
  });

  it('propagates operational push-URL lookup failures', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) {
        return;
      }
      const key = args.join(' ');
      if (key === 'remote get-url --push origin') {
        cb?.(new Error('git remote lookup failed'), {
          stdout: '',
          stderr: 'transient git failure',
        });
        return;
      }
      if (key === 'remote') {
        cb?.(null, { stdout: 'origin\n', stderr: '' });
        return;
      }
      cb?.(new Error(`unexpected git command: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(getPushRemoteUrlStrict('/repo')).rejects.toThrow(
      'git remote lookup failed',
    );
  });
});

function withPlatform(
  platform: NodeJS.Platform,
  callback: () => Promise<void>,
): Promise<void> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    });
}

function worktreeAddKey(args: string): string {
  return `-c core.hooksPath=${devNull} worktree add ${args}`;
}

function isWorktreeAddCommand(key: string): boolean {
  return key.startsWith(`-c core.hooksPath=${devNull} worktree add`);
}

function mockOpenAsText(): void {
  mockedOpen.mockResolvedValue({
    read: jest
      .fn()
      .mockImplementation((buf: Buffer): Promise<{ bytesRead: number }> => {
        const count = Math.min(8, buf.length);
        for (let i = 0; i < count; i += 1) {
          buf[i] = 0x41;
        }
        return Promise.resolve({ bytesRead: count });
      }),
    close: jest.fn().mockResolvedValue(undefined),
  } as never);
}

describe('fetchOrigin', () => {
  it('single-flights concurrent cold origin identity lookups', async () => {
    const originCallbacks: ExecFileCallback[] = [];
    let fetchCount = 0;
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        if (cb) originCallbacks.push(cb);
        return;
      }
      if (key === 'fetch --prune origin') {
        fetchCount += 1;
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    const first = fetchOrigin('/singleflight-origin-repo', { prune: true });
    const second = fetchOrigin('/singleflight-origin-repo', { prune: true });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(originCallbacks).toHaveLength(1);
    originCallbacks[0]?.(null, {
      stdout: 'https://example.test/singleflight.git',
      stderr: '',
    });
    await Promise.all([first, second]);

    expect(fetchCount).toBe(1);
  });

  it('shares durable freshness across equivalent common-dir spellings', async () => {
    const canonicalCommonDir = '/private/var/tmp/canonical-fetch-repo/.git';
    const originUrl = 'https://example.test/canonical-fetch-repo.git';
    const now = Date.now();
    mockedRealpath.mockResolvedValue(canonicalCommonDir);
    mockedReadGitFetchFreshness.mockResolvedValue({
      commonDir: canonicalCommonDir,
      originUrl,
      prune: true,
      lastAttemptAt: new Date(now - 1_000).toISOString(),
      lastSuccessAt: new Date(now - 1_000).toISOString(),
      consecutiveFailures: 0,
    });
    const calls: string[] = [];
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, { stdout: originUrl, stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await fetchOrigin('/var/tmp/canonical-fetch-repo', {
      prune: true,
      ttlMs: 60_000,
    });
    await fetchOrigin('/private/var/tmp/canonical-fetch-repo', {
      prune: true,
      ttlMs: 60_000,
    });

    expect(calls).toEqual([
      'rev-parse --git-common-dir',
      'remote get-url origin',
      'rev-parse --git-common-dir',
    ]);
    expect(mockedReadGitFetchFreshness).toHaveBeenCalledTimes(1);
    expect(mockedReadGitFetchFreshness).toHaveBeenCalledWith({
      commonDir: canonicalCommonDir,
      originUrl,
      prune: true,
    });
  });

  it('shares origin-aware freshness between user and automatic fetches', async () => {
    const calls: string[] = [];
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, {
          stdout: 'https://example.test/dedup-repo.git',
          stderr: '',
        });
        return;
      }
      if (key === 'fetch --prune origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await fetchOrigin('/dedup-repo', { prune: true });
    await fetchOrigin('/dedup-repo', { prune: true, ttlMs: 60_000 });

    expect(calls).toEqual([
      'rev-parse --git-common-dir',
      'remote get-url origin',
      'fetch --prune origin',
      'rev-parse --git-common-dir',
    ]);
    expect(mockedReadGitFetchFreshness).not.toHaveBeenCalled();
  });

  it('does not reuse process-local freshness after the origin changes', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let originUrl = 'https://example.test/first.git';
    let fetchCount = 0;
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, { stdout: originUrl, stderr: '' });
        return;
      }
      if (key === 'fetch --prune origin') {
        fetchCount += 1;
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    try {
      await fetchOrigin('/origin-change-repo', {
        prune: true,
        ttlMs: 60_000,
      });
      now += 6_000;
      originUrl = 'https://example.test/second.git';
      await fetchOrigin('/origin-change-repo', {
        prune: true,
        ttlMs: 60_000,
      });

      expect(fetchCount).toBe(2);
      expect(mockedReadGitFetchFreshness).toHaveBeenLastCalledWith({
        commonDir: '/origin-change-repo/.git',
        originUrl: 'https://example.test/second.git',
        prune: true,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reuses durable automatic fetch freshness for the same common dir and origin', async () => {
    const now = Date.now();
    mockedReadGitFetchFreshness.mockResolvedValue({
      commonDir: '/repo/.git',
      originUrl: 'https://example.test/repo.git',
      prune: true,
      lastAttemptAt: new Date(now - 1_000).toISOString(),
      lastSuccessAt: new Date(now - 1_000).toISOString(),
      consecutiveFailures: 0,
    });
    const calls: string[] = [];
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, {
          stdout: 'https://example.test/repo.git',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(
      fetchOrigin('/repo', { prune: true, ttlMs: 60_000 }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      'rev-parse --git-common-dir',
      'remote get-url origin',
    ]);
    expect(mockedReadGitFetchFreshness).toHaveBeenCalledWith({
      commonDir: '/repo/.git',
      originUrl: 'https://example.test/repo.git',
      prune: true,
    });
  });

  it('uses a short retry window after a failed automatic fetch', async () => {
    let fetchCount = 0;
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, { stdout: 'https://example.test/offline.git', stderr: '' });
        return;
      }
      if (key === 'fetch --prune origin') {
        fetchCount += 1;
        cb?.(new Error('offline'), { stdout: '', stderr: 'offline' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await fetchOrigin('/offline-repo', { prune: true, ttlMs: 300_000 });
    await fetchOrigin('/offline-repo', { prune: true, ttlMs: 300_000 });

    expect(fetchCount).toBe(1);
    expect(mockedRecordGitFetchFailure).toHaveBeenCalledTimes(1);
  });

  it('invalidates earlier freshness when a forced fetch fails', async () => {
    let fetchCount = 0;
    let durableFreshnessIsValid = false;
    const originUrl = 'https://example.test/repo.git';
    mockedReadGitFetchFreshness.mockImplementation((identity) =>
      Promise.resolve(
        durableFreshnessIsValid
          ? {
              ...identity,
              lastAttemptAt: new Date(Date.now() - 1_000).toISOString(),
              lastSuccessAt: new Date(Date.now() - 1_000).toISOString(),
              consecutiveFailures: 0,
            }
          : null,
      ),
    );
    mockedInvalidateGitFetchFreshness.mockImplementation(() => {
      durableFreshnessIsValid = false;
      return Promise.resolve();
    });
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, { stdout: originUrl, stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        fetchCount += 1;
        if (fetchCount === 2) {
          cb?.(new Error('authentication failed'), {
            stdout: '',
            stderr: '',
          });
        } else {
          cb?.(null, { stdout: '', stderr: '' });
        }
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await fetchOrigin('/repo', { ttlMs: 60_000 });
    durableFreshnessIsValid = true;
    await expect(
      fetchOrigin('/repo', { signal: new AbortController().signal }),
    ).rejects.toThrow('authentication failed');
    await fetchOrigin('/repo', { ttlMs: 60_000 });

    expect(fetchCount).toBe(3);
    expect(mockedInvalidateGitFetchFreshness).toHaveBeenCalledWith({
      commonDir: '/repo/.git',
      originUrl,
      prune: false,
    });
  });

  it('invalidates pruning freshness when a forced non-pruning fetch fails', async () => {
    let pruningFetchCount = 0;
    const originUrl = 'https://example.test/repo.git';
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, { stdout: originUrl, stderr: '' });
        return;
      }
      if (key === 'fetch --prune origin') {
        pruningFetchCount += 1;
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        cb?.(new Error('authentication failed'), {
          stdout: '',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await fetchOrigin('/repo', { prune: true, ttlMs: 60_000 });
    await expect(
      fetchOrigin('/repo', { signal: new AbortController().signal }),
    ).rejects.toThrow('authentication failed');
    await fetchOrigin('/repo', { prune: true, ttlMs: 60_000 });

    expect(pruningFetchCount).toBe(2);
    expect(mockedInvalidateGitFetchFreshness).toHaveBeenCalledWith({
      commonDir: '/repo/.git',
      originUrl,
      prune: false,
    });
    expect(mockedInvalidateGitFetchFreshness).toHaveBeenCalledWith({
      commonDir: '/repo/.git',
      originUrl,
      prune: true,
    });
  });

  it('propagates a joined automatic fetch failure to a forced waiter', async () => {
    let fetchCount = 0;
    let activeFetchCallback: ExecFileCallback | undefined;
    const originUrl = 'https://example.test/repo.git';
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, { stdout: originUrl, stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        fetchCount += 1;
        if (fetchCount === 1) {
          activeFetchCallback = cb;
        } else {
          cb?.(null, { stdout: '', stderr: '' });
        }
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    const automaticFetch = fetchOrigin('/repo', { ttlMs: 60_000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const forcedFetch = fetchOrigin('/repo', {
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeFetchCallback?.(new Error('offline'), {
      stdout: '',
      stderr: 'offline',
    });

    await expect(automaticFetch).resolves.toBeUndefined();
    await expect(forcedFetch).rejects.toThrow('offline');
    await expect(
      fetchOrigin('/repo', { signal: new AbortController().signal }),
    ).resolves.toBeUndefined();

    expect(fetchCount).toBe(2);
    expect(mockedInvalidateGitFetchFreshness).toHaveBeenCalledWith({
      commonDir: '/repo/.git',
      originUrl,
      prune: false,
    });
  });

  it('bounds waiting for an active fetch with the caller signal', async () => {
    let activeFetchCallback: ExecFileCallback | undefined;
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git', stderr: '' });
        return;
      }
      if (key === 'remote get-url origin') {
        cb?.(null, { stdout: 'https://example.test/repo.git', stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        activeFetchCallback = cb;
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    const activeFetch = fetchOrigin('/repo');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const controller = new AbortController();
    const boundedWait = fetchOrigin('/repo', { signal: controller.signal });
    controller.abort(new Error('fetch wait timed out'));

    await expect(boundedWait).rejects.toThrow('fetch wait timed out');
    activeFetchCallback?.(null, { stdout: '', stderr: '' });
    await activeFetch;
  });
});

describe('createWorktree', () => {
  it('fetches origin, detects default branch via remote HEAD, and creates worktree from origin/main', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree('/repo', '/worktrees/my-branch', 'my-branch');

    expect(calls).toContain('fetch origin');
    expect(calls).toContain('ls-remote --symref origin HEAD');
    expect(calls).toContain(
      worktreeAddKey('-b my-branch /worktrees/my-branch origin/main'),
    );
  });

  it('creates from remote HEAD when local origin HEAD is stale', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        cb?.(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree('/repo', '/worktrees/my-branch', 'my-branch');

    expect(calls).toContain('ls-remote --symref origin HEAD');
    expect(calls).not.toContain('symbolic-ref refs/remotes/origin/HEAD');
    expect(calls).toContain(
      worktreeAddKey('-b my-branch /worktrees/my-branch origin/develop'),
    );
  });

  it('falls back to probing main/master when remote HEAD lookup fails', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(new Error('not available'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        cb?.(new Error('not set'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'rev-parse --verify refs/remotes/origin/main') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'rev-parse --verify refs/remotes/origin/master') {
        cb?.(null, { stdout: 'abc123\n', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree('/repo', '/worktrees/my-branch', 'my-branch');

    expect(calls).toContain(
      worktreeAddKey('-b my-branch /worktrees/my-branch origin/master'),
    );
  });

  it('uses local remote refs even when fetch fails', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(new Error('no network'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(new Error('offline'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        cb?.(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree('/repo', '/worktrees/my-branch', 'my-branch');

    expect(calls).toContain(
      worktreeAddKey('-b my-branch /worktrees/my-branch origin/main'),
    );
  });

  it('falls back to HEAD when no remote refs exist', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(new Error('no remote'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(new Error('offline'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        cb?.(new Error('not set'), { stdout: '', stderr: '' });
        return;
      }
      if (key.startsWith('rev-parse --verify refs/remotes/origin/')) {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree('/repo', '/worktrees/my-branch', 'my-branch');

    // Should fall back to creating from HEAD (no start-point)
    expect(calls).toContain(
      worktreeAddKey('-b my-branch /worktrees/my-branch'),
    );
  });

  it('attaches existing branch as-is without overriding start-point', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/existing-branch') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (
        key === 'for-each-ref --format=%(refname) refs/heads/existing-branch/'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree(
      '/repo',
      '/worktrees/existing-branch',
      'existing-branch',
    );

    // Should attach the existing branch, no -b flag, no start-point
    expect(calls).toContain(
      worktreeAddKey('/worktrees/existing-branch existing-branch'),
    );
    // Should NOT have a worktree add -b variant
    expect(
      calls.filter((c) =>
        c.startsWith(`-c core.hooksPath=${devNull} worktree add -b`),
      ),
    ).toHaveLength(0);
  });

  it('resolves ref hierarchy conflict by appending a suffix', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/robin') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      // Simulate existing robin/api-382/logger-test branch
      if (key === 'for-each-ref --format=%(refname) refs/heads/robin/') {
        cb?.(null, {
          stdout: 'refs/heads/robin/api-382/logger-test\n',
          stderr: '',
        });
        return;
      }
      // robin-2 doesn't exist and has no conflict
      if (key === 'show-ref --verify --quiet refs/heads/robin-2') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'for-each-ref --format=%(refname) refs/heads/robin-2/') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree('/repo', '/worktrees/robin', 'robin');

    expect(calls).toContain(
      worktreeAddKey('-b robin-2 /worktrees/robin origin/main'),
    );
  });

  it('attaches existing branch even when fetch fails', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'fetch origin') {
        cb?.(new Error('offline'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(new Error('offline'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        cb?.(new Error('not set'), { stdout: '', stderr: '' });
        return;
      }
      if (key.startsWith('rev-parse --verify refs/remotes/origin/')) {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/existing-branch') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (
        key === 'for-each-ref --format=%(refname) refs/heads/existing-branch/'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktree(
      '/repo',
      '/worktrees/existing-branch',
      'existing-branch',
    );

    expect(calls).toContain(
      worktreeAddKey('/worktrees/existing-branch existing-branch'),
    );
  });
});

describe('getLocalDefaultBranch', () => {
  it('falls back to nonstandard local branch names when the repo root is on the feature branch', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');

      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, { stdout: '.git\n', stderr: '' });
        return;
      }
      if (key === 'rev-parse --abbrev-ref HEAD') {
        cb?.(null, { stdout: 'feature/local-only\n', stderr: '' });
        return;
      }
      if (key === 'config --get init.defaultBranch') {
        cb?.(new Error('missing config'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'for-each-ref --format=%(refname:short) refs/heads/') {
        cb?.(null, {
          stdout: 'feature/local-only\ntrunk\nrelease/2026.04\n',
          stderr: '',
        });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(
      getLocalDefaultBranch(
        '/repo/worktrees/feature-local-only',
        'feature/local-only',
      ),
    ).resolves.toBe('trunk');
  });
});

describe('createWorktreeFromStartPoint', () => {
  it('launches automatic worktree checkout with inherited macOS background policy', async () => {
    const launches: Array<{ command: string; args: string[] }> = [];

    mockExecFile((command, args, _opts, cb) => {
      launches.push({ command, args });
      const key = args.join(' ');
      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'for-each-ref --format=%(refname) refs/heads/my-branch/') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (
        command === '/usr/sbin/taskpolicy' &&
        args.slice(3).join(' ') ===
          worktreeAddKey('-b my-branch /worktrees/my-branch release/1.2')
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${command} ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await withPlatform('darwin', async () => {
      await createWorktreeFromStartPoint(
        '/repo',
        '/worktrees/my-branch',
        'my-branch',
        'release/1.2',
        { backgroundPriority: true },
      );
    });

    const backgroundLaunch = launches.find(
      (launch) => launch.command === '/usr/sbin/taskpolicy',
    );
    expect(backgroundLaunch?.args).toEqual(
      expect.arrayContaining(['-c', 'utility']),
    );
  });

  it('creates a new worktree branch from the explicit start point', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'for-each-ref --format=%(refname) refs/heads/my-branch/') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktreeFromStartPoint(
      '/repo',
      '/worktrees/my-branch',
      'my-branch',
      'release/1.2',
    );

    expect(calls).toContain(
      worktreeAddKey('-b my-branch /worktrees/my-branch release/1.2'),
    );
  });

  it('suffixes colliding branch names and still uses the explicit start point', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/heads/my-branch') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/my-branch-2') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'for-each-ref --format=%(refname) refs/heads/my-branch-2/') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (isWorktreeAddCommand(key)) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await createWorktreeFromStartPoint(
      '/repo',
      '/worktrees/my-branch',
      'my-branch',
      'release/1.2',
    );

    expect(calls).toContain(
      worktreeAddKey('-b my-branch-2 /worktrees/my-branch release/1.2'),
    );
    expect(calls).not.toContain(
      worktreeAddKey('/worktrees/my-branch my-branch'),
    );
  });
});

describe('checkoutDetachedRef', () => {
  it('disables checkout hooks while detaching to a ref', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (
        key === `-c core.hooksPath=${devNull} checkout --detach origin/main`
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await checkoutDetachedRef('/repo-shadow', 'origin/main');

    expect(calls).toEqual([
      `-c core.hooksPath=${devNull} checkout --detach origin/main`,
    ]);
  });

  it('sets the LFS skip-smudge environment when requested', async () => {
    let environment: NodeJS.ProcessEnv | undefined;
    mockExecFile((_cmd, _args, opts, cb) => {
      environment = (opts as ExecFileOptions).env;
      cb?.(null, { stdout: '', stderr: '' });
    });

    await checkoutDetachedRef('/repo-shadow', 'origin/main', {
      skipLfsSmudge: true,
    });

    expect(environment?.GIT_LFS_SKIP_SMUDGE).toBe('1');
  });
});

describe('listBranches', () => {
  it('returns deduped local and remote branches with worktree occupancy', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');

      if (
        key ===
        'for-each-ref --format=%(refname:short)%(HEAD) refs/heads/ refs/remotes/origin/'
      ) {
        cb?.(null, {
          stdout:
            'main\nfeature/foo*\norigin/main\norigin/feature/foo\norigin/remote-only\norigin/HEAD\n',
          stderr: '',
        });
        return;
      }

      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, {
          stdout: '/repo/.git/worktrees/feature-foo\n',
          stderr: '',
        });
        return;
      }

      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/foo\n',
          stderr: '',
        });
        return;
      }

      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(listBranches('/repo-feature')).resolves.toEqual({
      defaultBranch: 'main',
      branches: [
        {
          name: 'feature/foo',
          isRemote: false,
          isCurrent: true,
          isUsedByWorktree: false,
          hasLocalRef: true,
          hasRemoteRef: true,
        },
        {
          name: 'main',
          isRemote: false,
          isCurrent: false,
          isUsedByWorktree: true,
          hasLocalRef: true,
          hasRemoteRef: true,
        },
        {
          name: 'remote-only',
          isRemote: true,
          isCurrent: false,
          isUsedByWorktree: false,
          hasLocalRef: false,
          hasRemoteRef: true,
        },
      ],
    });
  });

  it('still lists branches when occupied-worktree lookup fails', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');

      if (
        key ===
        'for-each-ref --format=%(refname:short)%(HEAD) refs/heads/ refs/remotes/origin/'
      ) {
        cb?.(null, {
          stdout: 'main*\norigin/main\norigin/release\n',
          stderr: '',
        });
        return;
      }

      if (key === 'rev-parse --git-common-dir') {
        cb?.(new Error('broken git common dir'), { stdout: '', stderr: '' });
        return;
      }

      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(listBranches('/repo-feature')).resolves.toEqual({
      defaultBranch: 'main',
      branches: [
        {
          name: 'main',
          isRemote: false,
          isCurrent: true,
          isUsedByWorktree: false,
          hasLocalRef: true,
          hasRemoteRef: true,
        },
        {
          name: 'release',
          isRemote: true,
          isCurrent: false,
          isUsedByWorktree: false,
          hasLocalRef: false,
          hasRemoteRef: true,
        },
      ],
    });
  });
});

describe('checkoutBranch', () => {
  it('checks out an existing local branch', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'status --porcelain --untracked-files=normal') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, {
          stdout: '/repo/.git/worktrees/current\n',
          stderr: '',
        });
        return;
      }

      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo-current\nHEAD abc123\nbranch refs/heads/current\n',
          stderr: '',
        });
        return;
      }

      if (key === 'show-ref --verify --quiet refs/heads/release') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'checkout release') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(checkoutBranch('/repo-current', 'release')).resolves.toBe(
      undefined,
    );
    expect(calls).toContain('checkout release');
  });

  it('creates a local branch when only the remote branch exists', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'status --porcelain --untracked-files=normal') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, {
          stdout: '/repo/.git/worktrees/current\n',
          stderr: '',
        });
        return;
      }

      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo-current\nHEAD abc123\nbranch refs/heads/current\n',
          stderr: '',
        });
        return;
      }

      if (key === 'show-ref --verify --quiet refs/heads/release') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }

      if (key === 'show-ref --verify --quiet refs/remotes/origin/release') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'checkout -b release origin/release') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(checkoutBranch('/repo-current', 'release')).resolves.toBe(
      undefined,
    );
    expect(calls).toContain('checkout -b release origin/release');
  });

  it.each([
    ['checks out an origin branch fetched on demand', true],
    ['reports a branch missing from origin after fetching it', false],
  ])('%s', async (_name, onOrigin) => {
    const calls: string[] = [];
    let fetched = false;
    const fetchKey =
      'fetch --no-tags origin refs/heads/pr-head:refs/remotes/origin/pr-head';

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'status --porcelain --untracked-files=normal') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, {
          stdout: '/repo/.git/worktrees/current\n',
          stderr: '',
        });
        return;
      }

      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo-current\nHEAD abc123\nbranch refs/heads/current\n',
          stderr: '',
        });
        return;
      }

      if (key === 'show-ref --verify --quiet refs/heads/pr-head') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }

      if (key === 'show-ref --verify --quiet refs/remotes/origin/pr-head') {
        cb?.(fetched ? null : new Error('not found'), {
          stdout: '',
          stderr: '',
        });
        return;
      }

      if (key === fetchKey) {
        fetched = onOrigin;
        cb?.(onOrigin ? null : new Error("couldn't find remote ref"), {
          stdout: '',
          stderr: '',
        });
        return;
      }

      if (key === 'checkout -b pr-head origin/pr-head') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    const checkout = checkoutBranch('/repo-current', 'pr-head');
    if (onOrigin) {
      await expect(checkout).resolves.toBe(undefined);
      expect(calls).toContain('checkout -b pr-head origin/pr-head');
    } else {
      await expect(checkout).rejects.toThrow('Branch "pr-head" was not found');
    }
    expect(calls).toContain(fetchKey);
  });

  it('rejects branches already occupied by another worktree', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');

      if (key === 'status --porcelain --untracked-files=normal') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'rev-parse --git-common-dir') {
        cb?.(null, {
          stdout: '/repo/.git/worktrees/current\n',
          stderr: '',
        });
        return;
      }

      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo-current\nHEAD abc123\nbranch refs/heads/current\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/release\n',
          stderr: '',
        });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(checkoutBranch('/repo-current', 'release')).rejects.toThrow(
      'Branch "release" is already checked out in another worktree',
    );
  });
});

describe('removeWorktree', () => {
  function mockDirent(name: string): Dirent {
    return new Dirent(name, 1);
  }

  it('serializes removals for the same repository and uses the delete timeout', async () => {
    const callbacks: ExecFileCallback[] = [];
    const commands: string[][] = [];
    let resolveFirstStarted: () => void = () => {};
    let resolveSecondStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolvePromise) => {
      resolveFirstStarted = resolvePromise;
    });
    const secondStarted = new Promise<void>((resolvePromise) => {
      resolveSecondStarted = resolvePromise;
    });
    mockExecFile((_cmd, args, options, callback) => {
      commands.push(args);
      expect(options?.timeout).toBe(300_000);
      if (callback) callbacks.push(callback);
      if (commands.length === 1) {
        resolveFirstStarted();
      } else if (commands.length === 2) {
        resolveSecondStarted();
      }
    });

    const firstRemoval = removeWorktree('/repo', '/repo/first');
    const secondRemoval = removeWorktree('/repo', '/repo/second');
    await firstStarted;

    expect(mockedTerminateProcessesReferencingPath).toHaveBeenCalledWith(
      '/repo/first',
    );
    expect(commands).toEqual([
      ['worktree', 'remove', '--force', '/repo/first'],
    ]);
    callbacks[0]?.(null, { stdout: '', stderr: '' });
    await firstRemoval;
    await secondStarted;

    expect(commands).toEqual([
      ['worktree', 'remove', '--force', '/repo/first'],
      ['worktree', 'remove', '--force', '/repo/second'],
    ]);
    callbacks[1]?.(null, { stdout: '', stderr: '' });
    await secondRemoval;
  });

  it('holds the repository lock until the full removal lifecycle settles', async () => {
    const callbacks: ExecFileCallback[] = [];
    const commands: string[][] = [];
    let releaseRecovery: () => void = () => {};
    let markInitialRemovalComplete: () => void = () => {};
    let markFirstCommandStarted: () => void = () => {};
    let markSecondCommandStarted: () => void = () => {};
    const recoveryReleased = new Promise<void>((resolvePromise) => {
      releaseRecovery = resolvePromise;
    });
    const initialRemovalComplete = new Promise<void>((resolvePromise) => {
      markInitialRemovalComplete = resolvePromise;
    });
    const firstCommandStarted = new Promise<void>((resolvePromise) => {
      markFirstCommandStarted = resolvePromise;
    });
    const secondCommandStarted = new Promise<void>((resolvePromise) => {
      markSecondCommandStarted = resolvePromise;
    });
    mockExecFile((_cmd, args, _options, callback) => {
      commands.push(args);
      if (callback) callbacks.push(callback);
      if (commands.length === 1) {
        markFirstCommandStarted();
      } else if (commands.length === 2) {
        markSecondCommandStarted();
      }
    });

    const firstLifecycle = withWorktreeRemovalLock(
      '/repo',
      async (removeLockedWorktree) => {
        await removeLockedWorktree('/repo/first');
        markInitialRemovalComplete();
        await recoveryReleased;
      },
    );
    const secondRemoval = removeWorktree('/repo', '/repo/second');

    await firstCommandStarted;
    expect(commands).toEqual([
      ['worktree', 'remove', '--force', '/repo/first'],
    ]);
    callbacks[0]?.(null, { stdout: '', stderr: '' });
    await initialRemovalComplete;

    expect(commands).toEqual([
      ['worktree', 'remove', '--force', '/repo/first'],
    ]);
    releaseRecovery();
    await firstLifecycle;
    await secondCommandStarted;

    expect(commands).toEqual([
      ['worktree', 'remove', '--force', '/repo/first'],
      ['worktree', 'remove', '--force', '/repo/second'],
    ]);
    callbacks[1]?.(null, { stdout: '', stderr: '' });
    await secondRemoval;
  });

  it('removes Windows reparse-point entries before asking Git to remove the worktree', async () =>
    withPlatform('win32', async () => {
      const worktreePath = join('/repo', 'worktree');
      const claudeLinkPath = join(worktreePath, '.claude');
      const srcPath = join(worktreePath, 'src');
      const filePath = join(srcPath, 'index.ts');
      const events: string[] = [];

      mockedReaddir.mockImplementation((targetPath) => {
        const normalizedTarget = String(targetPath);
        if (normalizedTarget === worktreePath) {
          return Promise.resolve([mockDirent('.claude'), mockDirent('src')]);
        }
        if (normalizedTarget === srcPath) {
          return Promise.resolve([mockDirent('index.ts')]);
        }
        throw new Error(`Unexpected readdir: ${normalizedTarget}`);
      });
      mockedLstat.mockImplementation((targetPath) => {
        const normalizedTarget = String(targetPath);
        if (normalizedTarget === claudeLinkPath) {
          return Promise.resolve(
            mockStats({ directory: true, symbolicLink: true }),
          );
        }
        if (normalizedTarget === srcPath) {
          return Promise.resolve(mockStats({ directory: true }));
        }
        if (normalizedTarget === filePath) {
          return Promise.resolve(mockStats({}));
        }
        throw new Error(`Unexpected lstat: ${normalizedTarget}`);
      });
      mockedRm.mockImplementation((targetPath) => {
        events.push(`rm ${String(targetPath)}`);
        return Promise.resolve();
      });
      let removeOptions: ExecFileOptions | undefined;
      mockExecFile((_cmd, args, options, cb) => {
        events.push(`git ${(args ?? []).join(' ')}`);
        removeOptions = options;
        cb?.(null, { stdout: '', stderr: '' });
      });

      await expect(
        removeWorktree('/repo', worktreePath),
      ).resolves.toBeUndefined();

      expect(mockedRm).toHaveBeenCalledWith(claudeLinkPath, {
        recursive: true,
        force: true,
      });
      expect(events).toEqual([
        `rm ${claudeLinkPath}`,
        `git worktree remove --force ${worktreePath}`,
      ]);
      expect(removeOptions?.env?.PATH).toEqual(expect.any(String));
    }));

  it('does not invoke Git on Windows when the reparse-point scan fails', async () =>
    withPlatform('win32', async () => {
      const scanError = Object.assign(new Error('access denied'), {
        code: 'EACCES',
      });
      mockedReaddir.mockRejectedValue(scanError);

      await expect(removeWorktree('/repo', '/repo/worktree')).rejects.toThrow(
        'access denied',
      );

      expect(mockedExecFile).not.toHaveBeenCalled();
    }));

  it('walks Windows reparse-point entries sequentially', async () =>
    withPlatform('win32', async () => {
      const worktreePath = join('/repo', 'worktree');
      const firstLinkPath = join(worktreePath, 'first');
      const secondLinkPath = join(worktreePath, 'second');
      const events: string[] = [];

      mockedReaddir.mockResolvedValue([
        mockDirent('first'),
        mockDirent('second'),
      ]);
      mockedLstat.mockImplementation((targetPath) => {
        events.push(`lstat ${String(targetPath)}`);
        return Promise.resolve(mockStats({ symbolicLink: true }));
      });
      mockedRm.mockImplementation((targetPath) => {
        events.push(`rm ${String(targetPath)}`);
        return Promise.resolve();
      });

      await expect(
        removeWindowsWorktreeReparsePoints(worktreePath),
      ).resolves.toBeUndefined();

      expect(events).toEqual([
        `lstat ${firstLinkPath}`,
        `rm ${firstLinkPath}`,
        `lstat ${secondLinkPath}`,
        `rm ${secondLinkPath}`,
      ]);
    }));
});

describe('moveWorktree', () => {
  beforeEach(() => {
    mockedRealpath.mockImplementation((targetPath) =>
      Promise.resolve(String(targetPath)),
    );
    mockedRename.mockResolvedValue(undefined);
  });

  it('does not use filesystem rename fallback when Git still recognizes the old worktree path', async () => {
    mockExecFile((_cmd, args, opts, cb) => {
      const key = (args ?? []).join(' ');
      if (key === 'worktree move /repo-old /repo-new') {
        cb?.(new Error('git move failed'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-old\nHEAD def456\nbranch refs/heads/feature\n',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`Unexpected ${String(opts?.cwd ?? '')}: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(
      moveWorktree('/repo', '/repo-old', '/repo-new'),
    ).rejects.toThrow('git move failed');
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it('uses filesystem rename fallback only when Git no longer recognizes a self-rooted old worktree path', async () => {
    mockExecFile((_cmd, args, opts, cb) => {
      const key = (args ?? []).join(' ');
      if (key === 'worktree move /repo-old /repo-new') {
        cb?.(new Error('is not a working tree'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/feature\n',
          stderr: '',
        });
        return;
      }
      if (key === 'rev-parse --show-toplevel' && opts?.cwd === '/repo-old') {
        cb?.(null, {
          stdout: '/repo-old\n',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`Unexpected ${String(opts?.cwd ?? '')}: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(
      moveWorktree('/repo', '/repo-old', '/repo-new'),
    ).resolves.toBeUndefined();
    expect(mockedRename).toHaveBeenCalledWith('/repo-old', '/repo-new');
  });

  it('does not use filesystem rename fallback when the old path is inside another worktree top level', async () => {
    mockExecFile((_cmd, args, opts, cb) => {
      const key = (args ?? []).join(' ');
      if (key === 'worktree move /repo-old/nested /repo-new') {
        cb?.(new Error('is not a working tree'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'worktree list --porcelain') {
        cb?.(null, {
          stdout:
            'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/feature\n',
          stderr: '',
        });
        return;
      }
      if (
        key === 'rev-parse --show-toplevel' &&
        opts?.cwd === '/repo-old/nested'
      ) {
        cb?.(null, {
          stdout: '/repo-old\n',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`Unexpected ${String(opts?.cwd ?? '')}: ${key}`), {
        stdout: '',
        stderr: '',
      });
    });

    await expect(
      moveWorktree('/repo', '/repo-old/nested', '/repo-new'),
    ).rejects.toThrow('is not a working tree');
    expect(mockedRename).not.toHaveBeenCalled();
  });
});

describe('configured base-branch git helpers', () => {
  it('keeps tracked stats when an oversized untracked artifact is present', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      const outputs: Record<string, string> = {
        'show-ref --verify --quiet refs/remotes/origin/develop': '',
        'merge-base origin/develop HEAD': 'abc123\n',
        'diff abc123 --shortstat':
          ' 1 file changed, 4 insertions(+), 2 deletions(-)\n',
        'ls-files --others --exclude-standard': 'artifact.bin\n',
      };
      const stdout = outputs[key];
      if (stdout !== undefined) cb?.(null, { stdout, stderr: '' });
      else cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });
    mockedLstat.mockResolvedValue({
      ...mockStats({ file: true }),
      size: 50_000_000,
    });

    await expect(getDiffStats('/repo', 'develop')).resolves.toEqual({
      insertions: 4,
      deletions: 2,
    });
    expect(mockedLstat).toHaveBeenCalledWith('/repo/artifact.bin');
  });

  it('uses the remote configured base branch for diff stats when it exists', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/remotes/origin/release/1.2') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'merge-base origin/release/1.2 HEAD') {
        cb?.(null, { stdout: 'abc123\n', stderr: '' });
        return;
      }
      if (key === 'diff abc123 --shortstat') {
        cb?.(null, {
          stdout: ' 1 file changed, 4 insertions(+), 2 deletions(-)\n',
          stderr: '',
        });
        return;
      }
      if (
        key === '-c core.quotePath=false ls-files --others --exclude-standard'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(getDiffStats('/repo', 'release/1.2')).resolves.toEqual({
      insertions: 4,
      deletions: 2,
    });
    expect(calls).toContain(
      'show-ref --verify --quiet refs/remotes/origin/release/1.2',
    );
    expect(calls).toContain('merge-base origin/release/1.2 HEAD');
  });

  it('falls back to the local configured base branch for diff stats when the remote ref is missing', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/remotes/origin/release/1.2') {
        cb?.(new Error('missing remote ref'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/release/1.2') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'merge-base release/1.2 HEAD') {
        cb?.(null, { stdout: 'def456\n', stderr: '' });
        return;
      }
      if (key === 'diff def456 --shortstat') {
        cb?.(null, {
          stdout: ' 2 files changed, 7 insertions(+), 1 deletion(-)\n',
          stderr: '',
        });
        return;
      }
      if (
        key === '-c core.quotePath=false ls-files --others --exclude-standard'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(getDiffStats('/repo', 'release/1.2')).resolves.toEqual({
      insertions: 7,
      deletions: 1,
    });
    expect(calls).toContain('show-ref --verify --quiet refs/heads/release/1.2');
    expect(calls).toContain('merge-base release/1.2 HEAD');
  });

  it('prefers the remote configured base branch for diff stats when both refs exist', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/remotes/origin/release/1.2') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'merge-base origin/release/1.2 HEAD') {
        cb?.(null, { stdout: 'ghi789\n', stderr: '' });
        return;
      }
      if (key === 'diff ghi789 --shortstat') {
        cb?.(null, {
          stdout: ' 3 files changed, 8 insertions(+), 2 deletions(-)\n',
          stderr: '',
        });
        return;
      }
      if (
        key === '-c core.quotePath=false ls-files --others --exclude-standard'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(getDiffStats('/repo', 'release/1.2')).resolves.toEqual({
      insertions: 8,
      deletions: 2,
    });
    expect(calls).toContain(
      'show-ref --verify --quiet refs/remotes/origin/release/1.2',
    );
    expect(calls).toContain('merge-base origin/release/1.2 HEAD');
    expect(calls).not.toContain(
      'show-ref --verify --quiet refs/heads/release/1.2',
    );
    expect(calls).not.toContain('merge-base release/1.2 HEAD');
  });

  it('diffs committed files against the configured base branch merge base', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/develop') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'merge-base origin/develop HEAD') {
        cb?.(null, { stdout: 'merge123\n', stderr: '' });
        return;
      }
      if (
        key ===
        '-c core.quotePath=false diff merge123..HEAD --name-status --find-renames --find-copies'
      ) {
        cb?.(null, { stdout: 'M\tsrc/app.ts\n', stderr: '' });
        return;
      }
      if (
        key ===
        '-c core.quotePath=false diff merge123..HEAD --numstat --find-renames --find-copies'
      ) {
        cb?.(null, { stdout: '9\t3\tsrc/app.ts\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(getCommittedFilesList('/repo', 'develop')).resolves.toEqual([
      {
        path: 'src/app.ts',
        status: 'modified',
        insertions: 9,
        deletions: 3,
      },
    ]);
  });

  it('uses the configured local-only base branch for committed file diffs', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/develop') {
        cb?.(new Error('missing remote ref'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/develop') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'merge-base develop HEAD') {
        cb?.(null, { stdout: 'merge789\n', stderr: '' });
        return;
      }
      if (key === 'diff merge789 HEAD --numstat -- src/app.ts') {
        cb?.(null, { stdout: '5\t1\tsrc/app.ts\n', stderr: '' });
        return;
      }
      if (key === 'show merge789:src/app.ts') {
        cb?.(null, { stdout: 'old content\n', stderr: '' });
        return;
      }
      if (key === 'show HEAD:src/app.ts') {
        cb?.(null, { stdout: 'new content\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });
    mockOpenAsText();

    await expect(
      getFileDiffCommitted('/repo', 'src/app.ts', 'develop'),
    ).resolves.toEqual({
      oldValue: 'old content\n',
      newValue: 'new content\n',
      truncated: false,
      binary: false,
    });
  });

  it('uses the configured local-only base branch for combined file diffs', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/develop') {
        cb?.(new Error('missing remote ref'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'show-ref --verify --quiet refs/heads/develop') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'merge-base develop HEAD') {
        cb?.(null, { stdout: 'merge321\n', stderr: '' });
        return;
      }
      if (key === 'diff merge321 --numstat -- src/app.ts') {
        cb?.(null, { stdout: '4\t0\tsrc/app.ts\n', stderr: '' });
        return;
      }
      if (key === 'show merge321:src/app.ts') {
        cb?.(null, { stdout: 'base content\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });
    mockOpenAsText();
    mockedReadFile.mockResolvedValue(
      'working tree content\n' as Awaited<ReturnType<typeof readFile>>,
    );

    await expect(
      getFileDiffCombined('/repo', 'src/app.ts', 'develop'),
    ).resolves.toEqual({
      oldValue: 'base content\n',
      newValue: 'working tree content\n',
      truncated: false,
      binary: false,
    });
  });
});

describe('createBranchAndCheckout', () => {
  it('creates a suffixed branch name when the preferred name already exists', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'status --porcelain --untracked-files=normal') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'check-ref-format --branch feature') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'show-ref --verify --quiet refs/heads/feature') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'show-ref --verify --quiet refs/heads/feature-2') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }

      if (key === 'for-each-ref --format=%(refname) refs/heads/feature-2/') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'checkout -b feature-2 origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(
      createBranchAndCheckout('/repo-current', 'feature', 'origin/main'),
    ).resolves.toBe('feature-2');
    expect(calls).toContain('checkout -b feature-2 origin/main');
  });
});

describe('getLiveOriginBranchSha', () => {
  it('fetches and returns the exact SHA reported by the live origin branch', async () => {
    const calls: string[] = [];
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) return;
      const key = args.join(' ');
      calls.push(key);
      if (key === 'ls-remote --heads origin refs/heads/feature/live-check') {
        cb?.(null, {
          stdout:
            '0123456789abcdef0123456789abcdef01234567\trefs/heads/feature/live-check\n',
          stderr: '',
        });
        return;
      }
      if (key === 'fetch --no-tags origin refs/heads/feature/live-check') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (
        key === 'cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(
      getLiveOriginBranchSha('/repo', 'feature/live-check'),
    ).resolves.toBe('0123456789abcdef0123456789abcdef01234567');
    expect(calls).toEqual([
      'ls-remote --heads origin refs/heads/feature/live-check',
      'fetch --no-tags origin refs/heads/feature/live-check',
      'cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}',
    ]);
  });

  it('returns null only when the live origin branch is absent', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) return;
      cb?.(null, { stdout: '', stderr: '' });
    });

    await expect(
      getLiveOriginBranchSha('/repo', 'deleted-branch'),
    ).resolves.toBeNull();
  });

  it('propagates live remote probe failures', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) return;
      cb?.(new Error('network unavailable'), {
        stdout: '',
        stderr: 'network unavailable',
      });
    });

    await expect(
      getLiveOriginBranchSha('/repo', 'feature/live-check'),
    ).rejects.toThrow('network unavailable');
  });
});

describe('pushBranchToOriginNonInteractive', () => {
  it('pushes the branch to a same-named origin branch without forcing', async () => {
    const calls: string[] = [];
    let seenEnv: NodeJS.ProcessEnv | undefined;
    let seenTimeout: number | undefined;
    mockExecFile((_cmd, args, opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) return;
      calls.push((args ?? []).join(' '));
      const options: ExecFileOptions = opts as ExecFileOptions;
      seenEnv = options?.env;
      seenTimeout = options?.timeout;
      cb?.(null, { stdout: '', stderr: '' });
    });

    await expect(
      pushBranchToOriginNonInteractive('/repo', 'feature/test'),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(['push origin feature/test:feature/test']);
    // Never force, never rewrite, never touch the working tree.
    expect(calls[0]).not.toMatch(/--force|\+/);
    // Never sets upstream: `-u` would rewrite `branch.<name>.remote` and
    // `branch.<name>.merge` in the user's local config, silently changing what
    // a later `git pull` outside Canopy does. The readiness check resolves the
    // same-named branch against the live remote, so upstream config buys this
    // flow nothing.
    expect(calls[0]).not.toMatch(/(^| )(-u|--set-upstream)( |$)/);
    // Non-interactive: a missing credential must fail fast instead of
    // blocking the main process on a hidden prompt.
    expect(seenEnv?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(seenEnv?.GCM_INTERACTIVE).toBe('never');
    // Bounded, but on a push budget rather than the 10s probe budget. A push
    // transfers objects; sharing the `ls-remote` timeout killed the recovery
    // for large repositories and slow uplinks on every retry.
    expect(seenTimeout).toBeGreaterThan(10_000);
    expect(seenTimeout).toBe(120_000);
  });

  it('propagates a rejected push so callers can report a bounded failure', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      if (handleLoginShellPathMock(args, cb)) return;
      cb?.(new Error('failed to push some refs'), {
        stdout: '',
        stderr: 'remote: Permission denied',
      });
    });

    await expect(
      pushBranchToOriginNonInteractive('/repo', 'feature/test'),
    ).rejects.toThrow('failed to push some refs');
  });
});

describe('doesOriginBranchExist', () => {
  it('checks the live origin when no remote-tracking ref exists locally', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/remotes/origin/feature') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }

      if (key === 'remote get-url origin') {
        cb?.(null, {
          stdout: 'https://github.com/acme/example-repo.git\n',
          stderr: '',
        });
        return;
      }

      if (key === 'ls-remote --heads origin feature feature/*') {
        cb?.(null, { stdout: 'abc123\trefs/heads/feature\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(doesOriginBranchExist('/repo', 'feature')).resolves.toBe(true);
    expect(calls).toContain('ls-remote --heads origin feature feature/*');
  });

  it('detects live origin parent branch namespace conflicts', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/remotes/origin/feature/api') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }

      if (key === 'remote get-url origin') {
        cb?.(null, {
          stdout: 'https://github.com/acme/example-repo.git\n',
          stderr: '',
        });
        return;
      }

      if (
        key === 'ls-remote --heads origin feature/api feature/api/* feature'
      ) {
        cb?.(null, { stdout: 'abc123\trefs/heads/feature\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(doesOriginBranchExist('/repo', 'feature/api')).resolves.toBe(
      true,
    );
    expect(calls).toContain(
      'ls-remote --heads origin feature/api feature/api/* feature',
    );
  });

  it('detects live origin descendant branch namespace conflicts', async () => {
    const calls: string[] = [];

    mockExecFile((_cmd, args, _opts, cb) => {
      const key = (args ?? []).join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/remotes/origin/feature') {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }

      if (key === 'remote get-url origin') {
        cb?.(null, {
          stdout: 'https://github.com/acme/example-repo.git\n',
          stderr: '',
        });
        return;
      }

      if (key === 'ls-remote --heads origin feature feature/*') {
        cb?.(null, { stdout: 'abc123\trefs/heads/feature/api\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    });

    await expect(doesOriginBranchExist('/repo', 'feature')).resolves.toBe(true);
    expect(calls).toContain('ls-remote --heads origin feature feature/*');
  });
});

describe('getChangedFilesList', () => {
  // CAN-2551: git's default `core.quotePath` C-quotes and octal-escapes any
  // non-ASCII path (`"caf\303\251.md"`), and `ls-files` does it too. Both
  // changed-file helpers feed user-visible surfaces — the activity panel and
  // the shared-container share preview — so every git call that lists paths
  // has to opt out of it.
  it.each([
    ['getChangedFilesList', getChangedFilesList],
    ['getCommittedFilesList', getCommittedFilesList],
  ])('disables path quoting in every %s git call', async (_name, listFiles) => {
    const invocations: string[][] = [];
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      invocations.push(args);
      const key = args.join(' ');
      if (key.includes('merge-base')) {
        cb?.(null, { stdout: 'merge123\n', stderr: '' });
        return;
      }
      cb?.(null, { stdout: '', stderr: '' });
    }) as typeof execFile);

    await listFiles('/repo');

    const pathListingCalls = invocations.filter((args) =>
      args.some(
        (arg) =>
          arg === '--name-status' || arg === '--numstat' || arg === 'ls-files',
      ),
    );
    expect(pathListingCalls.length).toBeGreaterThan(0);
    for (const args of pathListingCalls) {
      expect(args.slice(0, 2)).toEqual(['-c', 'core.quotePath=false']);
    }
  });

  it('parses tracked and untracked files with counts', async () => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (
        key ===
        '-c core.quotePath=false diff HEAD --name-status --find-renames --find-copies'
      ) {
        cb?.(null, {
          stdout: 'M\tsrc/app.ts\nR100\tsrc/old.ts\tsrc/new.ts\n',
          stderr: '',
        });
        return;
      }

      if (
        key ===
        '-c core.quotePath=false diff HEAD --numstat --find-renames --find-copies'
      ) {
        cb?.(null, {
          stdout: '3\t1\tsrc/app.ts\n7\t0\tsrc/old.ts\tsrc/new.ts\n',
          stderr: '',
        });
        return;
      }

      if (
        key === '-c core.quotePath=false ls-files --others --exclude-standard'
      ) {
        cb?.(null, { stdout: 'notes/todo.md\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    const untrackedContent = Buffer.from('hello\nworld\n');
    mockedLstat.mockResolvedValue({
      ...mockStats({ file: true }),
      size: untrackedContent.length,
    });
    const actualFs =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const tempDir = await actualFs.mkdtemp(join(tmpdir(), 'canopy-git-test-'));
    const tempPath = join(tempDir, 'todo.md');
    await actualFs.writeFile(tempPath, untrackedContent);
    mockedOpen.mockImplementation(() => actualFs.open(tempPath, 'r'));

    const files = await getChangedFilesList('/repo').finally(() =>
      actualFs.rm(tempDir, { recursive: true, force: true }),
    );

    expect(files).toEqual([
      {
        deletions: 0,
        insertions: 2,
        path: 'notes/todo.md',
        status: 'untracked',
      },
      {
        deletions: 1,
        insertions: 3,
        path: 'src/app.ts',
        status: 'modified',
      },
      {
        deletions: 0,
        insertions: 7,
        path: 'src/new.ts',
        previousPath: 'src/old.ts',
        status: 'renamed',
      },
    ]);
  });
});

describe('getComparisonDiff', () => {
  it('diffs the merge-base against HEAD instead of the working tree', async () => {
    const calls: string[] = [];

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'show-ref --verify --quiet refs/remotes/origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      if (key === 'merge-base origin/main HEAD') {
        cb?.(null, { stdout: 'abc123\n', stderr: '' });
        return;
      }

      if (key === 'diff abc123 HEAD') {
        cb?.(null, { stdout: 'diff output\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    await expect(getComparisonDiff('/repo', 'main')).resolves.toBe(
      'diff output\n',
    );
    expect(calls).toEqual([
      'show-ref --verify --quiet refs/remotes/origin/main',
      'merge-base origin/main HEAD',
      'diff abc123 HEAD',
    ]);
  });
});

describe('listTrackedFiles', () => {
  it('returns tracked and untracked paths from git ls-files output', async () => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      expect(args).toEqual([
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
      ]);
      cb?.(null, {
        stdout: 'src/main.ts\nREADME.md\n',
        stderr: '',
      });
    }) as typeof execFile);

    await expect(listTrackedFiles('/repo')).resolves.toEqual([
      'src/main.ts',
      'README.md',
    ]);
  });

  it('lists only index entries when asked for cached paths', async () => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      expect(args).toEqual([
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        'ls-files',
        '--cached',
        '-z',
        '--',
        '.cursorrules',
      ]);
      cb?.(null, { stdout: '.cursorrules\0', stderr: '' });
    }) as typeof execFile);

    await expect(
      listTrackedFiles('/repo', {
        pathspecs: ['.cursorrules'],
        maxBuffer: 1024,
        timeoutMs: 1000,
        cachedOnly: true,
      }),
    ).resolves.toEqual(['.cursorrules']);
  });
});

describe('checkIgnoredPaths', () => {
  it('treats git check-ignore exit code 1 as an empty match set', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['check-ignore', '-z', '--stdin']);
      const error = new Error('no matches');
      Object.defineProperty(error, 'code', { value: 1 });
      cb?.(error, { stdout: '', stderr: '' });
      return {
        stdinEnd: jest.fn(),
      };
    });

    await expect(checkIgnoredPaths('/repo', ['src/main.ts'])).resolves.toEqual(
      new Set(),
    );
  });

  it('chunks large check-ignore input batches', async () => {
    const stdinInputs: string[] = [];
    let callCount = 0;
    mockExecFile((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['check-ignore', '-z', '--stdin']);
      const stdout = callCount === 0 ? 'path-0\0' : 'path-5000\0';
      callCount += 1;
      cb?.(null, { stdout, stderr: '' });
      return {
        stdinEnd: (input: string): void => {
          stdinInputs.push(input);
        },
      };
    });

    const paths = Array.from(
      { length: 5001 },
      (_value, index) => `path-${index}`,
    );
    await expect(checkIgnoredPaths('/repo', paths)).resolves.toEqual(
      new Set(['path-0', 'path-5000']),
    );
    expect(stdinInputs).toHaveLength(2);
    expect(stdinInputs[0]?.endsWith('\0')).toBe(true);
    expect(stdinInputs[1]).toBe('path-5000\0');
  });

  it('preserves leading and trailing whitespace in ignored paths', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['check-ignore', '-z', '--stdin']);
      cb?.(null, {
        stdout: ' leading-space\0trailing-space \0',
        stderr: '',
      });
      return {
        stdinEnd: jest.fn(),
      };
    });

    await expect(
      checkIgnoredPaths('/repo', [' leading-space', 'trailing-space ']),
    ).resolves.toEqual(new Set([' leading-space', 'trailing-space ']));
  });
});

describe('listIgnoredPathEntries', () => {
  it('lists ignored untracked paths in one pass with whole directories collapsed', async () => {
    const calls: string[][] = [];
    mockExecFile((_cmd, args, options, cb) => {
      calls.push(args);
      expect(options?.cwd).toBe('/repo');
      cb?.(null, {
        stdout: 'node_modules/\0 spaced.log \0build/out/\0',
        stderr: '',
      });
      return undefined;
    });

    await expect(listIgnoredPathEntries('/repo')).resolves.toEqual([
      'node_modules/',
      ' spaced.log ',
      'build/out/',
    ]);
    expect(calls).toEqual([
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ],
    ]);
  });

  it('rejects when git cannot list the working tree', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => {
      const error = new Error('not a git repository');
      Object.defineProperty(error, 'code', { value: 128 });
      cb?.(error, { stdout: '', stderr: '' });
      return undefined;
    });

    await expect(listIgnoredPathEntries('/repo')).rejects.toThrow(
      'not a git repository',
    );
  });
});

describe('initLocalRepo', () => {
  it('configures a local git identity before creating the initial commit', async () => {
    const calls: string[] = [];

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      calls.push(args.join(' '));
      cb?.(null, { stdout: '', stderr: '' });
    }) as typeof execFile);

    await initLocalRepo('/repo', 'canopy-test');

    expect(calls).toEqual([
      'init',
      'add README.md .gitignore canopy.json',
      '-c user.name=Canopy -c user.email=canopy@local.invalid commit -m Initial commit',
      'rev-parse HEAD',
    ]);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      join('/repo', 'README.md'),
      '# canopy-test\n',
      'utf-8',
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      join('/repo', '.gitignore'),
      '# Canopy multi-repo child repositories\nrepos/\n',
      'utf-8',
    );
  });
});

describe('cloneRepo', () => {
  it('passes `--` before the url so a hostile url cannot be parsed as a git option (argument injection)', async () => {
    const calls: string[] = [];

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      calls.push(args.join(' '));
      cb?.(null, { stdout: '', stderr: '' });
    }) as typeof execFile);

    await cloneRepo('https://github.com/org/repo.git', '/data/repos/repo');

    expect(calls).toEqual([
      'clone -- https://github.com/org/repo.git /data/repos/repo',
    ]);
  });

  it('sets the LFS skip-smudge environment when requested', async () => {
    let environment: NodeJS.ProcessEnv | undefined;
    mockedExecFile.mockImplementation(((
      _cmd: string,
      _args: string[],
      opts: ExecFileOptions,
      cb?: ExecFileCallback,
    ) => {
      environment = opts.env;
      cb?.(null, { stdout: '', stderr: '' });
    }) as typeof execFile);

    await cloneRepo('https://github.com/org/repo.git', '/data/repos/repo', {
      skipLfsSmudge: true,
    });

    expect(environment?.GIT_LFS_SKIP_SMUDGE).toBe('1');
  });

  it('passes an abort signal and timeout to the clone process', async () => {
    let options: ExecFileOptions | undefined;
    mockedExecFile.mockImplementation(((
      _cmd: string,
      _args: string[],
      execOptions: ExecFileOptions,
      cb?: ExecFileCallback,
    ) => {
      options = execOptions;
      cb?.(null, { stdout: '', stderr: '' });
    }) as typeof execFile);
    const controller = new AbortController();

    await cloneRepo('https://github.com/org/repo.git', '/data/repos/repo', {
      signal: controller.signal,
      timeoutMs: 1234,
    });

    expect(options?.signal).toBe(controller.signal);
    expect(options?.timeout).toBe(1234);
  });

  it('initializes and fetches only one filtered commit for bounded replica checkouts', async () => {
    const calls: Array<{ args: string; options: ExecFileOptions }> = [];
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      options: ExecFileOptions,
      cb?: ExecFileCallback,
    ) => {
      calls.push({ args: args.join(' '), options });
      cb?.(null, { stdout: '', stderr: '' });
    }) as typeof execFile);
    const controller = new AbortController();
    const sha = 'a'.repeat(40);

    await cloneRepoAtCommit(
      'https://github.com/org/repo.git',
      '/data/repos/repo',
      sha,
      {
        nonInteractive: true,
        skipLfsSmudge: true,
        signal: controller.signal,
        timeoutMs: 1234,
      },
    );

    expect(calls.map((call) => call.args)).toEqual([
      'init -- /data/repos/repo',
      'remote add origin https://github.com/org/repo.git',
      `fetch --depth=1 --filter=blob:none origin ${sha}`,
    ]);
    for (const call of calls) {
      expect(call.options.signal).toBe(controller.signal);
      expect(call.options.timeout).toBe(1234);
      expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe('0');
      expect(call.options.env?.GIT_LFS_SKIP_SMUDGE).toBe('1');
    }
  });
});

describe('addRemoteAndSync', () => {
  it('uses -X theirs for fresh repos (single commit) when linking a remote', async () => {
    const calls: string[] = [];

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'remote add origin https://example.com/repo.git') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'rev-parse --abbrev-ref HEAD') {
        cb?.(null, { stdout: 'master\n', stderr: '' });
        return;
      }
      if (key === 'rev-list --count HEAD') {
        cb?.(null, { stdout: '1\n', stderr: '' });
        return;
      }
      if (
        key ===
        'pull --no-rebase --no-edit -X theirs origin main --allow-unrelated-histories'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'push -u origin HEAD:main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    await addRemoteAndSync('/repo', 'https://example.com/repo.git');

    expect(calls).toContain(
      'pull --no-rebase --no-edit -X theirs origin main --allow-unrelated-histories',
    );
    expect(calls).toContain('push -u origin HEAD:main');
  });

  it('uses -X ours for repos with multiple commits to preserve local content', async () => {
    const calls: string[] = [];

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'remote add origin https://example.com/repo.git') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'rev-parse --abbrev-ref HEAD') {
        cb?.(null, { stdout: 'master\n', stderr: '' });
        return;
      }
      if (key === 'rev-list --count HEAD') {
        cb?.(null, { stdout: '5\n', stderr: '' });
        return;
      }
      if (
        key ===
        'pull --no-rebase --no-edit -X ours origin main --allow-unrelated-histories'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'push -u origin HEAD:main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    await addRemoteAndSync('/repo', 'https://example.com/repo.git');

    expect(calls).toContain(
      'pull --no-rebase --no-edit -X ours origin main --allow-unrelated-histories',
    );
  });

  it('uses the remote HEAD when the default branch is not a common fallback', async () => {
    const calls: string[] = [];

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'remote add origin https://example.com/repo.git') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'rev-parse --abbrev-ref HEAD') {
        cb?.(null, { stdout: 'main\n', stderr: '' });
        return;
      }
      if (key === 'rev-list --count HEAD') {
        cb?.(null, { stdout: '1\n', stderr: '' });
        return;
      }
      if (
        key ===
        'pull --no-rebase --no-edit -X theirs origin trunk --allow-unrelated-histories'
      ) {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'push -u origin HEAD:trunk') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    await addRemoteAndSync('/repo', 'https://example.com/repo.git');

    expect(calls).toContain(
      'pull --no-rebase --no-edit -X theirs origin trunk --allow-unrelated-histories',
    );
    expect(calls).toContain('push -u origin HEAD:trunk');
  });

  it('rolls back origin when syncing fails afterward', async () => {
    const calls: string[] = [];

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');
      calls.push(key);

      if (key === 'remote add origin https://example.com/repo.git') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'fetch origin') {
        cb?.(new Error('permission denied'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'merge --abort') {
        cb?.(new Error('no merge to abort'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'remote remove origin') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    await expect(
      addRemoteAndSync('/repo', 'https://example.com/repo.git'),
    ).rejects.toThrow('Failed to link remote: permission denied');
    expect(calls).toContain('remote remove origin');
  });
});

describe('isAncestor', () => {
  it('returns false when merge-base --is-ancestor exits 1 (not an ancestor)', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['merge-base', '--is-ancestor', 'abc123', 'HEAD']);
      const error = new Error(
        'Command failed: git merge-base --is-ancestor abc123 HEAD',
      );
      Object.defineProperty(error, 'code', { value: 1 });
      cb?.(error, { stdout: '', stderr: '' });
    });

    await expect(isAncestor('/repo', 'abc123', 'HEAD')).resolves.toBe(false);
  });

  it('rethrows when merge-base --is-ancestor fails with a non-1 exit code (bad revision)', async () => {
    mockExecFile((_cmd, args, _opts, cb) => {
      expect(args).toEqual([
        'merge-base',
        '--is-ancestor',
        'not-a-real-sha',
        'HEAD',
      ]);
      const error = new Error(
        'Command failed: git merge-base --is-ancestor not-a-real-sha HEAD\n' +
          'fatal: Not a valid commit name not-a-real-sha\n',
      );
      Object.defineProperty(error, 'code', { value: 128 });
      cb?.(error, { stdout: '', stderr: '' });
    });

    await expect(isAncestor('/repo', 'not-a-real-sha', 'HEAD')).rejects.toThrow(
      'Not a valid commit name not-a-real-sha',
    );
  });
});

describe('applyIndexPatch', () => {
  it('includes stderr in the rejection when git apply fails via stdin', async () => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      expect(args).toEqual(['apply', '--index']);
      const error = new Error('Command failed: git apply --index');
      cb?.(error, '', 'error: patch does not apply\n');
      return {
        stdin: { on: jest.fn(), end: (): void => undefined },
      };
    }) as unknown as typeof execFile);

    await expect(
      applyIndexPatch('/worktree', 'bogus patch', { unidiffZero: false }),
    ).rejects.toThrow('patch does not apply');
  });

  it('does not duplicate stderr when the error message already includes it', async () => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      expect(args).toEqual(['apply', '--index']);
      const stderrText = 'error: patch does not apply\n';
      const error = new Error(
        `Command failed: git apply --index\n${stderrText}`,
      );
      cb?.(error, '', stderrText);
      return {
        stdin: { on: jest.fn(), end: (): void => undefined },
      };
    }) as unknown as typeof execFile);

    await expect(
      applyIndexPatch('/worktree', 'bogus patch', { unidiffZero: false }),
    ).rejects.toThrow(
      /^Command failed: git apply --index\nerror: patch does not apply\n$/,
    );
  });
});

describe('Git input pipe failures', () => {
  it.each(['EOF', 'EPIPE'])(
    'rejects check-ignore on %s without an uncaught stream error',
    async (code) => {
      const child = new ChildProcess();
      const stdin = new PassThrough();
      Object.defineProperty(child, 'stdin', { value: stdin });
      mockedExecFile.mockReturnValue(child);
      const pending = checkIgnoredPaths('/repo', ['file.txt']);
      const outcome = pending.catch((error: unknown) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const error = Object.assign(new Error(`write ${code}`), {
        code,
        syscall: 'write',
      });
      expect(() => stdin.emit('error', error)).not.toThrow();
      expect(await outcome).toBe(error);
      // A late error after settlement must also remain owned by this stream.
      expect(() => stdin.emit('error', error)).not.toThrow();
    },
  );

  it('rejects patch application on EOF without losing the input failure', async () => {
    const child = new ChildProcess();
    const stdin = new PassThrough();
    Object.defineProperty(child, 'stdin', { value: stdin });
    mockedExecFile.mockReturnValue(child);
    const pending = applyIndexPatch('/repo', 'patch', { unidiffZero: false });
    const outcome = pending.catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const error = Object.assign(new Error('write EOF'), {
      code: 'EOF',
      syscall: 'write',
    });
    expect(() => stdin.emit('error', error)).not.toThrow();
    expect(await outcome).toBe(error);
  });
});
