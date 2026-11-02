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
  captureTurnEndAndDiffs,
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

  it("diffs a wake's end against its prompt's start, until the next turn starts", async () => {
    mockedCaptureWorkingTreeSha
      .mockResolvedValueOnce('tree-start')
      .mockResolvedValueOnce('tree-turn-end')
      .mockResolvedValueOnce('tree-wake-end')
      .mockResolvedValueOnce('tree-next-start')
      .mockResolvedValueOnce('tree-next-end');
    mockedDiffTreeObjects.mockResolvedValue([
      { path: 'src/app.ts', status: 'modified', insertions: 1, deletions: 0 },
    ]);

    await captureTurnStart('session-w', 'project', 'worktree');
    await captureTurnEndAndDiff('session-w');
    const wake = await captureTurnEndAndDiff('session-w');

    expect(wake?.treeRefs).toEqual([
      { startTree: 'tree-start', endTree: 'tree-wake-end' },
    ]);
    expect(mockedDiffTreeObjects).toHaveBeenCalledWith(
      '/repo',
      'tree-start',
      'tree-wake-end',
    );

    await captureTurnStart('session-w', 'project', 'worktree');
    await captureTurnEndAndDiff('session-w');
    expect(mockedDiffTreeObjects).toHaveBeenLastCalledWith(
      '/repo',
      'tree-next-start',
      'tree-next-end',
    );
  });

  it("diffs a wake's own edits from the previous end, until the next turn starts (turn-state phase 40f)", async () => {
    mockedCaptureWorkingTreeSha
      .mockResolvedValueOnce('tree-start')
      .mockResolvedValueOnce('tree-turn-end')
      .mockResolvedValueOnce('tree-wake-end')
      .mockResolvedValueOnce('tree-next-start')
      .mockResolvedValueOnce('tree-next-end');
    mockedDiffTreeObjects.mockResolvedValue([
      { path: 'src/app.ts', status: 'modified', insertions: 1, deletions: 0 },
    ]);

    await captureTurnStart('session-own', 'project', 'worktree');
    const prompt = await captureTurnEndAndDiffs('session-own');
    expect(prompt?.sinceLastEnd).toBeUndefined();

    const wake = await captureTurnEndAndDiffs('session-own');
    // The prompt's diff stays cumulative; the wake's own diff starts at the
    // previous end.
    expect(wake?.turn.treeRefs).toEqual([
      { startTree: 'tree-start', endTree: 'tree-wake-end' },
    ]);
    expect(wake?.sinceLastEnd?.treeRefs).toEqual([
      { startTree: 'tree-turn-end', endTree: 'tree-wake-end' },
    ]);
    expect(wake?.sinceLastEnd?.files).toEqual([
      expect.objectContaining({ path: 'src/app.ts' }),
    ]);
    expect(mockedDiffTreeObjects).toHaveBeenCalledWith(
      '/repo',
      'tree-turn-end',
      'tree-wake-end',
    );

    await captureTurnStart('session-own', 'project', 'worktree');
    const next = await captureTurnEndAndDiffs('session-own');
    expect(next?.sinceLastEnd).toBeUndefined();
  });

  it("resolves a session's end captures in call order", async () => {
    let finishPromptEnd: (tree: string) => void = () => undefined;
    mockedCaptureWorkingTreeSha
      .mockResolvedValueOnce('tree-start')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishPromptEnd = resolve;
          }),
      )
      .mockResolvedValueOnce('tree-wake-end');
    mockedDiffTreeObjects.mockResolvedValue([]);

    await captureTurnStart('session-o', 'project', 'worktree');
    const order: string[] = [];
    const promptEnd = captureTurnEndAndDiff('session-o').then((diff) => {
      order.push(diff?.treeRefs?.[0]?.endTree ?? 'none');
    });
    const wakeEnd = captureTurnEndAndDiff('session-o').then((diff) => {
      order.push(diff?.treeRefs?.[0]?.endTree ?? 'none');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishPromptEnd('tree-prompt-end');
    await Promise.all([promptEnd, wakeEnd]);

    expect(order).toEqual(['tree-prompt-end', 'tree-wake-end']);
  });

  it('keeps a queued end capture on the baseline of the turn that ended', async () => {
    let finishPromptEnd: (tree: string) => void = () => undefined;
    mockedCaptureWorkingTreeSha
      .mockResolvedValueOnce('tree-start')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishPromptEnd = resolve;
          }),
      )
      .mockResolvedValueOnce('tree-next-start')
      .mockResolvedValueOnce('tree-wake-end')
      .mockResolvedValueOnce('tree-next-end');
    mockedDiffTreeObjects.mockResolvedValue([]);

    await captureTurnStart('session-q', 'project', 'worktree');
    const promptEnd = captureTurnEndAndDiffs('session-q');
    const wakeEnd = captureTurnEndAndDiffs('session-q');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The next turn starts while both end captures are still queued.
    await captureTurnStart('session-q', 'project', 'worktree');
    finishPromptEnd('tree-prompt-end');
    await promptEnd;
    const wake = await wakeEnd;

    expect(wake?.turn.treeRefs).toEqual([
      { startTree: 'tree-start', endTree: 'tree-wake-end' },
    ]);
    expect(wake?.sinceLastEnd?.treeRefs).toEqual([
      { startTree: 'tree-prompt-end', endTree: 'tree-wake-end' },
    ]);
    // The old turn's ends never become the next turn's previous end.
    const next = await captureTurnEndAndDiffs('session-q');
    expect(next?.turn.treeRefs).toEqual([
      { startTree: 'tree-next-start', endTree: 'tree-next-end' },
    ]);
    expect(next?.sinceLastEnd).toBeUndefined();
  });

  it('clears failed or missing snapshots instead of returning stale diffs', async () => {
    mockedCaptureWorkingTreeSha.mockRejectedValueOnce(new Error('timeout'));

    await captureTurnStart('session-c', 'project', 'worktree');

    expect(await captureTurnEndAndDiff('session-c')).toBeNull();
    expect(await captureTurnEndAndDiff('session-missing')).toBeNull();
  });
});
