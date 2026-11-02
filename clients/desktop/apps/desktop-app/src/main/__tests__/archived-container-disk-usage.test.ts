const resolveGitMock = jest.fn<Promise<string>, [NodeJS.ProcessEnv?]>(() =>
  Promise.resolve('git'),
);
const runArchiveIoRequestMock = jest.fn<
  Promise<unknown>,
  [request: ArchiveIoOperationRequest]
>();
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (
    env?: NodeJS.ProcessEnv,
  ): Promise<string> => resolveGitMock(env),
}));
jest.mock('../archive/archive-io-runner', () => ({
  runArchiveIoRequest: (request: ArchiveIoOperationRequest): Promise<unknown> =>
    runArchiveIoRequestMock(request),
}));

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArchivedContainerManifest,
  ArchivedContainerManifestV1,
  ArchivedGitRepositoryState,
} from '@canopy/desktop-shared/types';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';

jest.mock('../lib/paths', () => ({
  getArchivedContainerDir: jest.fn(),
}));
const readManifestMock = jest.fn<
  Promise<ArchivedContainerManifest>,
  [string, string]
>();
const commitMock = jest.fn<Promise<void>, [ArchivedContainerManifest]>(() =>
  Promise.resolve(),
);
const broadcastMock = jest.fn<void, [string]>();
jest.mock('../lib/archived-containers', () => ({
  readArchivedContainerManifest: (
    projectId: string,
    containerId: string,
  ): Promise<ArchivedContainerManifest> =>
    readManifestMock(projectId, containerId),
  commitArchivedContainer: (
    manifest: ArchivedContainerManifest,
  ): Promise<void> => commitMock(manifest),
  broadcastArchivedContainersChanged: (workspaceId: string): void =>
    broadcastMock(workspaceId),
  withArchivedContainerOperationLock: (
    _projectId: string,
    _containerId: string,
    operation: () => Promise<unknown>,
  ): Promise<unknown> => operation(),
}));

import {
  computeArchivedContainerDiskUsage,
  measureArchivedRepositoryGitBytes,
  measureDirectoryBytes,
  persistArchivedContainerDiskUsage,
  scheduleArchivedContainerDiskUsage,
  waitForScheduledArchivedContainerDiskUsage,
} from '../lib/archived-container-disk-usage';
import { getArchivedContainerDir } from '../lib/paths';
import { executeArchiveIoRequest } from '../archive/archive-io-engine';

let rootDir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function manifest(
  overrides: Partial<ArchivedContainerManifestV1> = {},
): ArchivedContainerManifestV1 {
  return {
    version: 1,
    id: 'container-1',
    kind: 'work-entry',
    projectId: 'workspace-1',
    name: 'Entry',
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: '2026-07-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-07-09T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
    ...overrides,
  };
}

describe('archived container disk usage', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    runArchiveIoRequestMock.mockImplementation(
      (request: ArchiveIoOperationRequest) =>
        executeArchiveIoRequest(request, new AbortController().signal, {
          progress: () => undefined,
          child: {
            started: () => undefined,
            exited: () => undefined,
          },
        }),
    );
    rootDir = await mkdtemp(join(tmpdir(), 'canopy-archive-disk-usage-'));
    jest
      .mocked(getArchivedContainerDir)
      .mockImplementation((projectId, containerId) =>
        join(rootDir, projectId, containerId),
      );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('sums every file under the container directory and treats a missing directory as empty', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-1');
    await mkdir(join(dir, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'a'.repeat(100));
    await writeFile(join(dir, 'nested', 'file.txt'), 'b'.repeat(50));
    await writeFile(join(dir, 'nested', 'deeper', 'x.bin'), 'c'.repeat(7));

    expect(await measureDirectoryBytes(dir)).toBe(157);
    expect(await measureDirectoryBytes(join(rootDir, 'missing'))).toBe(0);
  });

  it('reports the Git objects only the retained snapshot keeps alive', async () => {
    const repo = join(rootDir, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const baseCommit = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'feature.txt'), 'x'.repeat(4096));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feature');
    const featureCommit = git(repo, 'rev-parse', 'HEAD');

    const repository: ArchivedGitRepositoryState = {
      repoId: '__single_repo__',
      repoName: 'repo',
      relativePath: '.',
      referenceRepoPath: repo,
      comparisonBaseCommit: baseCommit,
      headCommit: featureCommit,
      indexSnapshotCommit: featureCommit,
      worktreeSnapshotCommit: featureCommit,
      snapshotRef:
        'refs/app/archived-containers/workspace-1/container-1/__single_repo__',
    };
    const env = {
      ...process.env,
      CANOPY_GIT_EXECUTABLE: '/custom/git',
    };
    const bytes = await measureArchivedRepositoryGitBytes(repository, env);
    expect(resolveGitMock).toHaveBeenCalledWith(env);
    expect(bytes).not.toBeNull();
    // The feature commit, its tree, and the 4 KiB blob are unique to the
    // snapshot; the base commit's objects are excluded.
    expect(bytes).toBeGreaterThan(0);
    const everything = await measureArchivedRepositoryGitBytes({
      ...repository,
      comparisonBaseCommit: featureCommit,
    });
    expect(everything).toBe(0);
  });

  it('returns null when Git cannot report a size', async () => {
    const bytes = await measureArchivedRepositoryGitBytes({
      repoId: '__single_repo__',
      repoName: 'repo',
      relativePath: '.',
      referenceRepoPath: join(rootDir, 'does-not-exist'),
      comparisonBaseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
      indexSnapshotCommit: 'b'.repeat(40),
      worktreeSnapshotCommit: 'b'.repeat(40),
      snapshotRef: 'refs/app/archived-containers/x/y/z',
    });
    expect(bytes).toBeNull();
  });

  it('computes files-only usage for version-1 manifests', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'a'.repeat(12));
    const usage = await computeArchivedContainerDiskUsage(
      manifest(),
      Date.parse('2026-09-07T00:00:00.000Z'),
    );
    expect(usage).toEqual({
      filesBytes: 12,
      gitBytes: 0,
      gitBytesComplete: true,
      totalBytes: 12,
      computedAt: '2026-09-07T00:00:00.000Z',
    });
  });

  it('preserves an incomplete Git measurement instead of reporting an exact zero', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'abc');
    const base = manifest();
    const repository: ArchivedGitRepositoryState = {
      repoId: '__single_repo__',
      repoName: 'missing',
      relativePath: '.',
      referenceRepoPath: join(rootDir, 'does-not-exist'),
      comparisonBaseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
      indexSnapshotCommit: 'b'.repeat(40),
      worktreeSnapshotCommit: 'b'.repeat(40),
      snapshotRef: 'refs/app/archived-containers/x/y/z',
    };
    const baseForWorktree: Omit<ArchivedContainerManifestV1, 'originalEntry'> =
      base;
    const usage = await computeArchivedContainerDiskUsage(
      {
        ...baseForWorktree,
        version: 2,
        kind: 'worktree',
        workspaceType: 'single-repo',
        originalWorktree: {
          id: 'container-1',
          branchName: 'feature/archive',
          createdAt: base.createdAt,
        },
        gitState: {
          version: 1,
          diffFormatVersion: 1,
          repositories: [repository],
        },
        gitChanges: {
          status: 'complete',
          capturedAt: base.archivedAt,
          fileCount: 0,
          insertions: 0,
          deletions: 0,
          repositories: [],
        },
        pullRequestMetadata: {
          capturedAt: base.archivedAt,
          repositories: [],
        },
      },
      Date.parse('2026-09-07T00:00:00.000Z'),
    );

    expect(usage).toEqual({
      filesBytes: 3,
      gitBytes: 0,
      gitBytesComplete: false,
      totalBytes: 3,
      computedAt: '2026-09-07T00:00:00.000Z',
    });
  });

  it('persists the measurement into the re-read manifest and broadcasts', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'a'.repeat(30));
    readManifestMock.mockResolvedValue(manifest());

    const usage = await persistArchivedContainerDiskUsage(
      'workspace-1',
      'container-1',
    );

    expect(usage?.filesBytes).toBe(30);
    expect(commitMock).toHaveBeenCalledTimes(1);
    const committed = commitMock.mock.calls[0]?.[0];
    expect(committed?.id).toBe('container-1');
    expect(committed?.diskUsage?.totalBytes).toBe(30);
    expect(broadcastMock).toHaveBeenCalledWith('workspace-1');
  });

  it('does not rewrite or broadcast an unchanged measurement', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'abc');
    const existingUsage = {
      filesBytes: 3,
      gitBytes: 0,
      gitBytesComplete: true,
      totalBytes: 3,
      computedAt: '2026-09-06T00:00:00.000Z',
    };
    readManifestMock.mockResolvedValue(manifest({ diskUsage: existingUsage }));

    const usage = await persistArchivedContainerDiskUsage(
      'workspace-1',
      'container-1',
    );

    expect(usage).toEqual(existingUsage);
    expect(commitMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('drops the result when the container disappeared before publishing', async () => {
    readManifestMock
      .mockResolvedValueOnce(manifest())
      .mockRejectedValueOnce(new Error('gone'));

    const usage = await persistArchivedContainerDiskUsage(
      'workspace-1',
      'container-1',
    );

    expect(usage).toBeNull();
    expect(commitMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('drops a measurement when the container generation changes before publishing', async () => {
    readManifestMock
      .mockResolvedValueOnce(manifest())
      .mockResolvedValueOnce(
        manifest({ createdAt: '2026-07-03T00:00:00.000Z' }),
      );

    const usage = await persistArchivedContainerDiskUsage(
      'workspace-1',
      'container-1',
    );

    expect(usage).toBeNull();
    expect(commitMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('deduplicates scheduled measurements per container and never throws', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'abc');
    let release: () => void = () => undefined;
    readManifestMock.mockImplementation(
      () =>
        new Promise<ArchivedContainerManifest>((resolve) => {
          release = (): void => resolve(manifest());
        }),
    );

    scheduleArchivedContainerDiskUsage('workspace-1', 'container-1');
    scheduleArchivedContainerDiskUsage('workspace-1', 'container-1');
    expect(readManifestMock).toHaveBeenCalledTimes(1);
    release();
    readManifestMock.mockResolvedValue(manifest());
    await waitForScheduledArchivedContainerDiskUsage();
    expect(commitMock).toHaveBeenCalledTimes(1);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      readManifestMock.mockResolvedValue(manifest());
      commitMock.mockRejectedValueOnce(new Error('disk full'));
      scheduleArchivedContainerDiskUsage('workspace-1', 'container-1');
      await waitForScheduledArchivedContainerDiskUsage();
      expect(warn).toHaveBeenCalledWith(
        'Failed to measure archived container disk usage.',
        expect.objectContaining({ containerId: 'container-1' }),
      );
    } finally {
      warn.mockRestore();
    }
    // Sanity: the persisted manifest file is never touched by this module.
    await expect(
      readFile(join(dir, 'container.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('bounds concurrent scheduled measurements across containers', async () => {
    const releases = new Map<string, () => void>();
    const firstReads = new Set<string>();
    let markContainerCStarted: () => void = () => undefined;
    const containerCStarted = new Promise<void>((resolve) => {
      markContainerCStarted = resolve;
    });
    readManifestMock.mockImplementation((_projectId, containerId) => {
      if (firstReads.has(containerId)) {
        return Promise.resolve(manifest({ id: containerId }));
      }
      firstReads.add(containerId);
      if (containerId === 'container-c') {
        markContainerCStarted();
      }
      return new Promise<ArchivedContainerManifest>((resolve) => {
        releases.set(containerId, () => resolve(manifest({ id: containerId })));
      });
    });

    scheduleArchivedContainerDiskUsage('workspace-1', 'container-a');
    scheduleArchivedContainerDiskUsage('workspace-1', 'container-b');
    scheduleArchivedContainerDiskUsage('workspace-1', 'container-c');
    await Promise.resolve();

    expect(firstReads).toEqual(new Set(['container-a', 'container-b']));
    releases.get('container-a')?.();
    await containerCStarted;
    expect(firstReads).toEqual(
      new Set(['container-a', 'container-b', 'container-c']),
    );

    releases.get('container-b')?.();
    releases.get('container-c')?.();
    await waitForScheduledArchivedContainerDiskUsage();
  });

  it('queues a fresh measurement after an in-flight measurement when forced', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'abc');
    let releaseFirstRead: () => void = () => undefined;
    readManifestMock
      .mockImplementationOnce(
        () =>
          new Promise<ArchivedContainerManifest>((resolve) => {
            releaseFirstRead = (): void => resolve(manifest());
          }),
      )
      .mockResolvedValue(manifest());

    scheduleArchivedContainerDiskUsage('workspace-1', 'container-1');
    Reflect.apply(scheduleArchivedContainerDiskUsage, undefined, [
      'workspace-1',
      'container-1',
      { forceAfterCurrent: true },
    ]);
    releaseFirstRead();
    await waitForScheduledArchivedContainerDiskUsage();

    expect(commitMock).toHaveBeenCalledTimes(2);
  });

  it('runs an incomplete-measurement retry at most once per process', async () => {
    const dir = join(rootDir, 'workspace-1', 'container-retry');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chats.json'), 'abc');
    readManifestMock.mockResolvedValue(manifest({ id: 'container-retry' }));

    scheduleArchivedContainerDiskUsage('workspace-1', 'container-retry', {
      retryIncomplete: true,
    });
    await waitForScheduledArchivedContainerDiskUsage();
    scheduleArchivedContainerDiskUsage('workspace-1', 'container-retry', {
      retryIncomplete: true,
    });
    await waitForScheduledArchivedContainerDiskUsage();

    expect(commitMock).toHaveBeenCalledTimes(1);
  });
});
