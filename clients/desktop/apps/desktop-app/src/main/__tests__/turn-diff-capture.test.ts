jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/repo'),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lib/git-tree-snapshot', () => ({
  captureWorkingTreeSha: jest.fn(),
  captureHeadCommitSha: jest.fn().mockResolvedValue(undefined),
  diffTreeObjects: jest.fn(),
  setGitTreeSnapshotRuntime: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  persistTurnDiffTreeRef: jest.fn(),
}));

import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import {
  captureHeadCommitSha,
  captureWorkingTreeSha,
  diffTreeObjects,
} from '../lib/git-tree-snapshot';
import { persistTurnDiffTreeRef } from '../lib/git';
import {
  captureTurnStart,
  captureTurnEndAndDiff,
} from '../lib/turn-diff-capture';

const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedCaptureWorkingTreeSha = jest.mocked(captureWorkingTreeSha);
const mockedCaptureHeadCommitSha = jest.mocked(captureHeadCommitSha);
const mockedDiffTreeObjects = jest.mocked(diffTreeObjects);
const mockedPersistTurnDiffTreeRef = jest.mocked(persistTurnDiffTreeRef);

describe('turn diff capture', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveWorktreeCwd.mockReturnValue('/repo');
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
    mockedCaptureHeadCommitSha.mockResolvedValue(undefined);
  });

  it('captures and diffs a single repo turn lifecycle', async () => {
    mockedCaptureWorkingTreeSha
      .mockResolvedValueOnce('tree-start')
      .mockResolvedValueOnce('tree-end');
    mockedDiffTreeObjects.mockResolvedValue([
      {
        path: 'src/app.ts',
        status: 'modified',
        insertions: 2,
        deletions: 1,
      },
    ]);

    await captureTurnStart('session-a', 'project', 'worktree');
    const result = await captureTurnEndAndDiff('session-a');

    expect(mockedDiffTreeObjects).toHaveBeenCalledWith(
      '/repo',
      'tree-start',
      'tree-end',
    );
    expect(mockedPersistTurnDiffTreeRef).toHaveBeenNthCalledWith(
      1,
      '/repo',
      'project',
      'worktree',
      'tree-start',
    );
    expect(mockedPersistTurnDiffTreeRef).toHaveBeenNthCalledWith(
      2,
      '/repo',
      'project',
      'worktree',
      'tree-end',
    );
    expect(result).toMatchObject({
      files: [
        {
          path: 'src/app.ts',
          status: 'modified',
          insertions: 2,
          deletions: 1,
        },
      ],
      totalInsertions: 2,
      totalDeletions: 1,
      treeRefs: [{ startTree: 'tree-start', endTree: 'tree-end' }],
    });
    expect(result?.capturedAt).toEqual(expect.any(Number));
  });

  it('aggregates multi-repo diffs with stable repo metadata', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/workspace');
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'repo-b', repoName: 'Repo B', repoPath: '/workspace/repos/b' },
      { repoId: 'repo-a', repoName: 'Repo A', repoPath: '/workspace/repos/a' },
    ]);
    mockedCaptureWorkingTreeSha
      .mockResolvedValueOnce('start-b')
      .mockResolvedValueOnce('start-a')
      .mockResolvedValueOnce('end-b')
      .mockResolvedValueOnce('end-a');
    mockedDiffTreeObjects
      .mockResolvedValueOnce([
        {
          path: 'zeta.ts',
          status: 'modified',
          insertions: 4,
          deletions: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          path: 'alpha.ts',
          status: 'added',
          insertions: 3,
          deletions: 0,
        },
      ]);

    await captureTurnStart('session-b', 'workspace', 'wt');
    const result = await captureTurnEndAndDiff('session-b');

    expect(result?.files).toEqual([
      {
        path: 'alpha.ts',
        status: 'added',
        insertions: 3,
        deletions: 0,
        repoId: 'repo-a',
        repoName: 'Repo A',
      },
      {
        path: 'zeta.ts',
        status: 'modified',
        insertions: 4,
        deletions: 1,
        repoId: 'repo-b',
        repoName: 'Repo B',
      },
    ]);
    expect(result?.totalInsertions).toBe(7);
    expect(result?.totalDeletions).toBe(1);
    expect(mockedPersistTurnDiffTreeRef).toHaveBeenNthCalledWith(
      1,
      '/workspace/repos/b',
      'workspace',
      'wt',
      'start-b',
    );
    expect(mockedPersistTurnDiffTreeRef).toHaveBeenNthCalledWith(
      2,
      '/workspace/repos/a',
      'workspace',
      'wt',
      'start-a',
    );
    expect(mockedPersistTurnDiffTreeRef).toHaveBeenNthCalledWith(
      3,
      '/workspace/repos/b',
      'workspace',
      'wt',
      'end-b',
    );
    expect(mockedPersistTurnDiffTreeRef).toHaveBeenNthCalledWith(
      4,
      '/workspace/repos/a',
      'workspace',
      'wt',
      'end-a',
    );
    expect(result?.treeRefs).toEqual([
      { startTree: 'start-b', endTree: 'end-b', repoId: 'repo-b' },
      { startTree: 'start-a', endTree: 'end-a', repoId: 'repo-a' },
    ]);
  });

  it('propagates startHeadCommitSha from turn start into the resulting treeRef', async () => {
    mockedCaptureWorkingTreeSha
      .mockResolvedValueOnce('tree-start')
      .mockResolvedValueOnce('tree-end');
    mockedCaptureHeadCommitSha.mockResolvedValueOnce(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    mockedDiffTreeObjects.mockResolvedValue([]);

    await captureTurnStart('session-h', 'project', 'worktree');
    const result = await captureTurnEndAndDiff('session-h');

    expect(result?.treeRefs).toEqual([
      {
        startTree: 'tree-start',
        endTree: 'tree-end',
        startHeadCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ]);
  });

  it('clears failed or missing snapshots instead of returning stale diffs', async () => {
    mockedCaptureWorkingTreeSha.mockRejectedValueOnce(new Error('timeout'));

    await captureTurnStart('session-c', 'project', 'worktree');

    expect(await captureTurnEndAndDiff('session-c')).toBeNull();
    expect(await captureTurnEndAndDiff('session-missing')).toBeNull();
  });
});
