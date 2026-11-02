jest.mock('../lib/desktop-telemetry', () => ({
  recordGitCommitTelemetry: jest.fn(),
  recordPullRequestOpenedTelemetry: jest.fn(),
}));
import {
  recordGitCommitTelemetry,
  recordPullRequestOpenedTelemetry,
} from '../lib/desktop-telemetry';
jest.mock('../lib/git', () => ({
  applyIndexPatch: jest.fn(),
  checkoutPathsFromRef: jest.fn(),
  removePaths: jest.fn(),
  resetHardTo: jest.fn(),
  cleanUntrackedFiles: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  resolveRefSha: jest.fn(),
  fetchOrigin: jest.fn(),
  isAncestor: jest.fn(),
  isBranchNameAvailable: jest.fn(),
  doesRemoteBranchExist: jest.fn(),
  checkoutBranch: jest.fn(),
  createBranchAt: jest.fn(),
  createBranchWithEmptyCommit: jest.fn(),
  pushNamedBranch: jest.fn(),
  mergeBranch: jest.fn(),
  deleteLocalBranch: jest.fn(),
  getTreeSha: jest.fn(),
  addDetachedWorktree: jest.fn(),
  removeGitWorktree: jest.fn(),
  getCheckedOutBranch: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/node/lib/pr-split-diff', () => ({
  planChildCarve: jest.fn(),
  computeChildBaseDiffU0: jest.fn(),
  matchRunsToOriginalHunks: jest.fn(),
  buildPatchFromRuns: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({ PATH: '/resolved/bin:/usr/bin' })),
}));

jest.mock('@canopy/desktop-shared/node/lib/path-lookup', () => ({
  findExecutableOnPath: jest.fn(
    (name: string) => `C:\\Windows\\System32\\${name}`,
  ),
}));

// Mocked only for the `buildDefaultSplitterDeps` notification tests below; the
// `executePrSplit` tests inject fake `deps` and never reach these modules.
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../lib/worktree-service', () => ({
  createSingleRepoWorktree: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  updateWorkspaceWorktree: jest.fn(),
}));

import type {
  DiffFileEntry,
  PrDiffSnapshot,
  SplitPlanChild,
} from '@canopy/desktop-shared/types/github';
import {
  addDetachedWorktree,
  applyIndexPatch,
  checkoutBranch,
  checkoutPathsFromRef,
  cleanUntrackedFiles,
  commitWithMessage,
  createBranchWithEmptyCommit,
  doesRemoteBranchExist,
  fetchOrigin,
  getCheckedOutBranch,
  getTreeSha,
  hasUncommittedChanges,
  isAncestor,
  isBranchNameAvailable,
  mergeBranch,
  pushNamedBranch,
  removeGitWorktree,
  removePaths,
  resetHardTo,
  resolveRefSha,
  stageAllChanges,
} from '../lib/git';
import {
  buildPatchFromRuns,
  computeChildBaseDiffU0,
  matchRunsToOriginalHunks,
  planChildCarve,
} from '@canopy/desktop-shared/node/lib/pr-split-diff';
import { validateSplitPlan } from '@canopy/desktop-shared/lib/pr-split-plan';
import type {
  PersistedPrSnapshotFileV1,
  RepoPrTrackingData,
  SplitPlan,
  SplitPrMap,
  SplitPrProgressEvent,
} from '@canopy/desktop-shared/types/github';
import { deriveSplitBranchNames } from '@canopy/desktop-shared/lib/pr-split-plan';
import {
  buildDefaultSplitterDeps,
  buildVerifyEnv,
  CarveError,
  carveChild,
  computePlanFingerprint,
  executePrSplit,
  resolveVerifyShellSpec,
  SplitPrExecutionError,
} from '../lib/github-pr-splitter';
import type {
  ExecutePrSplitOptions,
  SplitterDeps,
} from '../lib/github-pr-splitter';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { BrowserWindow } from 'electron';
import { createSingleRepoWorktree } from '../lib/worktree-service';
import { updateWorkspaceWorktree } from '../lib/workspace-persistence';
import { sendToWindow } from '../lib/window-send';

const mockedPlanChildCarve = jest.mocked(planChildCarve);
const mockedComputeU0 = jest.mocked(computeChildBaseDiffU0);
const mockedMatchRuns = jest.mocked(matchRunsToOriginalHunks);
const mockedBuildPatch = jest.mocked(buildPatchFromRuns);
const mockedApplyIndexPatch = jest.mocked(applyIndexPatch);
const mockedCheckoutPaths = jest.mocked(checkoutPathsFromRef);
const mockedRemovePaths = jest.mocked(removePaths);
const mockedResetHardTo = jest.mocked(resetHardTo);
const mockedCleanUntracked = jest.mocked(cleanUntrackedFiles);
const mockedStageAll = jest.mocked(stageAllChanges);
const mockedCommit = jest.mocked(commitWithMessage);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedResolveRefSha = jest.mocked(resolveRefSha);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedIsAncestor = jest.mocked(isAncestor);
const mockedIsBranchNameAvailable = jest.mocked(isBranchNameAvailable);
const mockedDoesRemoteBranchExist = jest.mocked(doesRemoteBranchExist);
const mockedCheckoutBranch = jest.mocked(checkoutBranch);
const mockedCreateBranchWithEmptyCommit = jest.mocked(
  createBranchWithEmptyCommit,
);
const mockedPushNamedBranch = jest.mocked(pushNamedBranch);
const mockedMergeBranch = jest.mocked(mergeBranch);
const mockedGetTreeSha = jest.mocked(getTreeSha);
const mockedAddDetachedWorktree = jest.mocked(addDetachedWorktree);
const mockedRemoveGitWorktree = jest.mocked(removeGitWorktree);
const mockedGetCheckedOutBranch = jest.mocked(getCheckedOutBranch);

function snapshotFile(path: string, oldPath?: string): DiffFileEntry {
  return {
    path,
    oldPath,
    kind: 'modified',
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [],
  };
}

function makeSnapshot(files: DiffFileEntry[] = []): PrDiffSnapshot {
  return {
    baseRef: 'base-sha',
    headRef: 'head-sha',
    files,
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

function makeChild(overrides: Partial<SplitPlanChild> = {}): SplitPlanChild {
  return {
    index: 1,
    title: 'refactor: extract helper',
    type: 'refactor',
    dependsOn: [],
    changes: [],
    renames: [],
    testProof: '',
    risk: 'low',
    rationale: '',
    ...overrides,
  };
}

function baseArgs(
  overrides: Partial<Parameters<typeof carveChild>[0]> = {},
): Parameters<typeof carveChild>[0] {
  return {
    repoPath: '/tmp/child-worktree',
    childBaseRef: 'child-base-sha',
    headSha: 'head-sha',
    child: makeChild(),
    snapshot: makeSnapshot(),
    buildTestCommand: '',
    commitMessage: '[1/3] refactor: extract helper',
    signal: new AbortController().signal,
    deps: { runVerifyCommand: jest.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedPlanChildCarve.mockReturnValue({ wholeFiles: [], hunkFiles: [] });
  mockedComputeU0.mockResolvedValue([]);
  mockedMatchRuns.mockReturnValue({ ok: true, runs: [] });
  mockedBuildPatch.mockReturnValue('PATCH');
  mockedCommit.mockResolvedValue('commit-sha-abc');
  // Default: worktree is clean and checked out exactly at the child base ref,
  // satisfying carveChild's destructive-restore precondition.
  mockedHasUncommittedChanges.mockResolvedValue(false);
  mockedResolveRefSha.mockResolvedValue('same-sha');
});

describe('carveChild whole-file handling', () => {
  it('checks out added/modified whole files from head', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [
        { path: 'src/added.ts', kind: 'added' },
        { path: 'src/modified.ts', kind: 'modified' },
      ],
      hunkFiles: [],
    });

    const result = await carveChild(baseArgs());

    expect(mockedCheckoutPaths).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'head-sha',
      ['src/added.ts'],
    );
    expect(mockedCheckoutPaths).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'head-sha',
      ['src/modified.ts'],
    );
    expect(mockedRemovePaths).not.toHaveBeenCalled();
    expect(mockedStageAll).toHaveBeenCalledWith('/tmp/child-worktree');
    expect(mockedCommit).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      '[1/3] refactor: extract helper',
    );
    expect(result.commitSha).toBe('commit-sha-abc');
    expect(result.verify.status).toBe('skipped');
  });

  it('removes deleted whole files', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [{ path: 'src/gone.ts', kind: 'deleted' }],
      hunkFiles: [],
    });

    await carveChild(baseArgs());

    expect(mockedRemovePaths).toHaveBeenCalledWith('/tmp/child-worktree', [
      'src/gone.ts',
    ]);
    expect(mockedCheckoutPaths).not.toHaveBeenCalled();
  });

  it('renames: removes old path and checks out new path from head', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [
        {
          path: 'src/new-name.ts',
          kind: 'renamed',
          oldPath: 'src/old-name.ts',
        },
      ],
      hunkFiles: [],
    });

    await carveChild(baseArgs());

    expect(mockedRemovePaths).toHaveBeenCalledWith('/tmp/child-worktree', [
      'src/old-name.ts',
    ]);
    expect(mockedCheckoutPaths).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'head-sha',
      ['src/new-name.ts'],
    );
  });
});

describe('carveChild hunk-file handling', () => {
  it('recomputes U0, matches runs, builds and applies only owned runs', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [],
      hunkFiles: [{ path: 'src/multi.ts', ownedHunkIndices: [0, 2] }],
    });
    const recomputed: DiffFileEntry = {
      path: 'src/multi.ts',
      kind: 'modified',
      isBinary: false,
      additions: 3,
      deletions: 0,
      hunks: [],
    };
    mockedComputeU0.mockResolvedValue([recomputed]);
    mockedMatchRuns.mockReturnValue({
      ok: true,
      runs: [
        { header: '@@ -1 +1 @@', bodyLines: ['+a'], ownerHunkIndex: 0 },
        { header: '@@ -5 +5 @@', bodyLines: ['+b'], ownerHunkIndex: 1 },
        { header: '@@ -9 +9 @@', bodyLines: ['+c'], ownerHunkIndex: 2 },
      ],
    });

    await carveChild(
      baseArgs({ snapshot: makeSnapshot([snapshotFile('src/multi.ts')]) }),
    );

    expect(mockedComputeU0).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'child-base-sha',
      'head-sha',
      ['src/multi.ts'],
    );
    // Only runs owned by hunk indices 0 and 2 are selected.
    const selected = mockedBuildPatch.mock.calls[0][2];
    expect(selected.map((r) => r.ownerHunkIndex)).toEqual([0, 2]);
    expect(mockedApplyIndexPatch).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'PATCH',
      { unidiffZero: true },
    );
  });

  it('refactor-then-feature: two carves recompute against their own base', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [],
      hunkFiles: [{ path: 'shared.ts', ownedHunkIndices: [0] }],
    });
    mockedComputeU0.mockResolvedValue([
      {
        path: 'shared.ts',
        kind: 'modified',
        isBinary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      },
    ]);
    mockedMatchRuns.mockReturnValue({
      ok: true,
      runs: [{ header: '@@ -1 +1 @@', bodyLines: ['+x'], ownerHunkIndex: 0 }],
    });

    const snapshot = makeSnapshot([snapshotFile('shared.ts')]);
    await carveChild(baseArgs({ childBaseRef: 'refactor-base', snapshot }));
    await carveChild(baseArgs({ childBaseRef: 'feature-base', snapshot }));

    expect(mockedComputeU0).toHaveBeenNthCalledWith(
      1,
      '/tmp/child-worktree',
      'refactor-base',
      'head-sha',
      ['shared.ts'],
    );
    expect(mockedComputeU0).toHaveBeenNthCalledWith(
      2,
      '/tmp/child-worktree',
      'feature-base',
      'head-sha',
      ['shared.ts'],
    );
  });
});

describe('carveChild restore-on-failure', () => {
  it('matcher failure restores and throws CarveError with file + hunk headers', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [],
      hunkFiles: [{ path: 'bad.ts', ownedHunkIndices: [0] }],
    });
    mockedComputeU0.mockResolvedValue([
      {
        path: 'bad.ts',
        kind: 'modified',
        isBinary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      },
    ]);
    mockedMatchRuns.mockReturnValue({
      ok: false,
      reason: 'unmatched-run',
      detail: 'no match',
      file: 'bad.ts',
      runHeader: '@@ -3 +3 @@',
    });

    await expect(
      carveChild(
        baseArgs({ snapshot: makeSnapshot([snapshotFile('bad.ts')]) }),
      ),
    ).rejects.toBeInstanceOf(CarveError);
    expect(mockedResetHardTo).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'child-base-sha',
    );
    expect(mockedCleanUntracked).toHaveBeenCalledWith('/tmp/child-worktree');
    expect(mockedApplyIndexPatch).not.toHaveBeenCalled();
  });

  it('carries file and runHeader on the CarveError', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [],
      hunkFiles: [{ path: 'bad.ts', ownedHunkIndices: [0] }],
    });
    mockedComputeU0.mockResolvedValue([
      {
        path: 'bad.ts',
        kind: 'modified',
        isBinary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      },
    ]);
    mockedMatchRuns.mockReturnValue({
      ok: false,
      reason: 'ambiguous-run',
      detail: 'spans two',
      file: 'bad.ts',
      runHeader: '@@ -3 +3 @@',
    });

    const error = await carveChild(
      baseArgs({ snapshot: makeSnapshot([snapshotFile('bad.ts')]) }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CarveError);
    if (error instanceof CarveError) {
      expect(error.file).toBe('bad.ts');
      expect(error.hunkHeaders).toContain('@@ -3 +3 @@');
    }
  });

  it('applyIndexPatch failure restores and throws CarveError', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [],
      hunkFiles: [{ path: 'apply.ts', ownedHunkIndices: [0] }],
    });
    mockedComputeU0.mockResolvedValue([
      {
        path: 'apply.ts',
        kind: 'modified',
        isBinary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      },
    ]);
    mockedMatchRuns.mockReturnValue({
      ok: true,
      runs: [{ header: '@@ -1 +1 @@', bodyLines: ['+z'], ownerHunkIndex: 0 }],
    });
    mockedApplyIndexPatch.mockRejectedValue(new Error('patch does not apply'));

    await expect(
      carveChild(
        baseArgs({ snapshot: makeSnapshot([snapshotFile('apply.ts')]) }),
      ),
    ).rejects.toBeInstanceOf(CarveError);
    expect(mockedResetHardTo).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'child-base-sha',
    );
    expect(mockedCleanUntracked).toHaveBeenCalledWith('/tmp/child-worktree');
    expect(mockedCommit).not.toHaveBeenCalled();
  });
});

describe('carveChild verify', () => {
  it('skips verification for empty/whitespace command and never calls runVerifyCommand', async () => {
    const runVerifyCommand = jest.fn();
    const result = await carveChild(
      baseArgs({ buildTestCommand: '   ', deps: { runVerifyCommand } }),
    );
    expect(runVerifyCommand).not.toHaveBeenCalled();
    expect(result.verify).toEqual({ status: 'skipped' });
  });

  it('marks green on exit code 0', async () => {
    const runVerifyCommand = jest
      .fn()
      .mockResolvedValue({ exitCode: 0, tail: 'all good' });
    const result = await carveChild(
      baseArgs({ buildTestCommand: 'npm test', deps: { runVerifyCommand } }),
    );
    expect(runVerifyCommand).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'npm test',
      expect.anything(),
    );
    expect(result.verify.status).toBe('green');
  });

  it('marks red with tail on non-zero exit', async () => {
    const runVerifyCommand = jest
      .fn()
      .mockResolvedValue({ exitCode: 1, tail: 'FAILED: 3 tests' });
    const result = await carveChild(
      baseArgs({ buildTestCommand: 'npm test', deps: { runVerifyCommand } }),
    );
    expect(result.verify.status).toBe('red');
    expect(result.verify.tail).toBe('FAILED: 3 tests');
  });

  it('invokes onVerifyStart after the commit and before running verify', async () => {
    const events: string[] = [];
    const runVerifyCommand = jest.fn().mockImplementation(() => {
      events.push('verify-run');
      return Promise.resolve({ exitCode: 0, tail: '' });
    });
    mockedCommit.mockImplementation(() => {
      events.push('commit');
      return Promise.resolve('commit-sha-abc');
    });

    await carveChild(
      baseArgs({
        buildTestCommand: 'npm test',
        deps: { runVerifyCommand },
        onVerifyStart: () => events.push('verify-start'),
      }),
    );

    expect(events).toEqual(['commit', 'verify-start', 'verify-run']);
  });

  it('does NOT invoke onVerifyStart when verification is skipped', async () => {
    const onVerifyStart = jest.fn();
    const runVerifyCommand = jest.fn();
    const result = await carveChild(
      baseArgs({
        buildTestCommand: '',
        deps: { runVerifyCommand },
        onVerifyStart,
      }),
    );
    expect(onVerifyStart).not.toHaveBeenCalled();
    expect(runVerifyCommand).not.toHaveBeenCalled();
    expect(result.verify).toEqual({ status: 'skipped' });
  });
});

describe('carveChild abort', () => {
  it('honors an already-aborted signal before verify and never runs verify', async () => {
    const controller = new AbortController();
    controller.abort();
    const runVerifyCommand = jest.fn();

    const error = await carveChild(
      baseArgs({
        buildTestCommand: 'npm test',
        signal: controller.signal,
        deps: { runVerifyCommand },
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.name).toBe('AbortError');
    }
    expect(runVerifyCommand).not.toHaveBeenCalled();
  });

  it('surfaces an abort that fires while verify is running instead of a red verify', async () => {
    const controller = new AbortController();
    const runVerifyCommand = jest.fn().mockImplementation(() => {
      // Simulate the verify subprocess being SIGTERM-killed by the abort
      // signal mid-run: it resolves with a non-zero exit code, but the
      // abort should take precedence over classifying this as a red verify.
      controller.abort();
      return Promise.resolve({ exitCode: 143, tail: 'Terminated' });
    });

    const error = await carveChild(
      baseArgs({
        buildTestCommand: 'npm test',
        signal: controller.signal,
        deps: { runVerifyCommand },
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.name).toBe('AbortError');
    }
    // The restore path runs like any other carveChild failure/abort.
    expect(mockedResetHardTo).toHaveBeenCalledWith(
      '/tmp/child-worktree',
      'child-base-sha',
    );
  });
});

describe('carveChild precondition guard', () => {
  it('throws CarveError and does NOT run the restore path when the worktree has uncommitted changes', async () => {
    mockedHasUncommittedChanges.mockResolvedValue(true);

    const error = await carveChild(baseArgs()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CarveError);
    if (error instanceof CarveError) {
      expect(error.message).toMatch(/not clean/i);
    }
    // Nothing was mutated yet, so restoring would be destructive to someone
    // else's tree — the restore path must not run for this precondition
    // failure.
    expect(mockedResetHardTo).not.toHaveBeenCalled();
    expect(mockedCleanUntracked).not.toHaveBeenCalled();
    expect(mockedPlanChildCarve).not.toHaveBeenCalled();
  });

  it('throws CarveError and does NOT run the restore path when HEAD is not at childBaseRef', async () => {
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedResolveRefSha.mockImplementation((_repoPath, ref) =>
      Promise.resolve(
        ref === 'HEAD' ? 'head-actual-sha' : 'child-base-actual-sha',
      ),
    );

    const error = await carveChild(baseArgs()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CarveError);
    if (error instanceof CarveError) {
      expect(error.message).toMatch(/child base/i);
    }
    expect(mockedResetHardTo).not.toHaveBeenCalled();
    expect(mockedCleanUntracked).not.toHaveBeenCalled();
    expect(mockedPlanChildCarve).not.toHaveBeenCalled();
  });

  it('proceeds normally when the worktree is clean and checked out at childBaseRef', async () => {
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedResolveRefSha.mockResolvedValue('same-sha-both');

    const result = await carveChild(baseArgs());

    expect(result.commitSha).toBe('commit-sha-abc');
    expect(mockedPlanChildCarve).toHaveBeenCalled();
  });
});

describe('carveChild zero-hunk guards', () => {
  it('skips buildPatchFromRuns/applyIndexPatch for a file whose owned hunks produce an empty selected-run set', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [],
      hunkFiles: [{ path: 'src/other-owner.ts', ownedHunkIndices: [] }],
    });
    mockedComputeU0.mockResolvedValue([
      {
        path: 'src/other-owner.ts',
        kind: 'modified',
        isBinary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      },
    ]);
    // All recomputed runs belong to a different child (ownerHunkIndex not in
    // ownedHunkIndices), so the selected-run set for this file is empty.
    mockedMatchRuns.mockReturnValue({
      ok: true,
      runs: [{ header: '@@ -1 +1 @@', bodyLines: ['+q'], ownerHunkIndex: 5 }],
    });

    const result = await carveChild(
      baseArgs({
        snapshot: makeSnapshot([snapshotFile('src/other-owner.ts')]),
      }),
    );

    expect(mockedBuildPatch).not.toHaveBeenCalled();
    expect(mockedApplyIndexPatch).not.toHaveBeenCalled();
    // The carve still continues through commit.
    expect(result.commitSha).toBe('commit-sha-abc');
    expect(mockedCommit).toHaveBeenCalled();
  });

  it('skips a file entirely missing from the recomputed U0 diff without error', async () => {
    mockedPlanChildCarve.mockReturnValue({
      wholeFiles: [],
      hunkFiles: [{ path: 'src/already-present.ts', ownedHunkIndices: [0] }],
    });
    // The recomputed diff omits this file entirely (e.g. all its hunks are
    // already present in the child base), so there is nothing to apply.
    mockedComputeU0.mockResolvedValue([]);

    const result = await carveChild(
      baseArgs({
        snapshot: makeSnapshot([snapshotFile('src/already-present.ts')]),
      }),
    );

    expect(mockedMatchRuns).not.toHaveBeenCalled();
    expect(mockedBuildPatch).not.toHaveBeenCalled();
    expect(mockedApplyIndexPatch).not.toHaveBeenCalled();
    expect(result.commitSha).toBe('commit-sha-abc');
  });
});

// ---------------------------------------------------------------------------
// executePrSplit (Phase B orchestrator)
// ---------------------------------------------------------------------------

const HEAD_BRANCH = 'feat/big';
const INTEGRATION_BRANCH = 'feat/big-split/integration';
const DETECTED_BASE = 'develop';
const HEAD_SHA = 'head-sha-original';
const ORIGINAL_WORKTREE_CWD = '/tmp/original-worktree';

// Child branch names produced by deriveSplitBranchNames for the plan below.
const CHILD1_BRANCH = 'feat/big-split/01-extract-helper';
const CHILD2_BRANCH = 'feat/big-split/02-add-feature';
const CHILD3_BRANCH = 'feat/big-split/03-tidy-imports';

function makeExecPlan(): SplitPlan {
  return {
    finalGoal: 'ship the big feature',
    concerns: [{ concern: 'seam', kind: 'refactor' }],
    children: [
      {
        index: 1,
        title: 'refactor: extract helper',
        type: 'refactor',
        dependsOn: [],
        changes: [{ file: 'src/a.ts', hunks: 'all' }],
        renames: [],
        testProof: 'unit',
        risk: 'low',
        rationale: '',
      },
      {
        index: 2,
        title: 'feat: add feature',
        type: 'feature',
        dependsOn: [1],
        changes: [{ file: 'src/a.ts', hunks: [1] }],
        renames: [],
        testProof: 'unit',
        risk: 'low',
        rationale: '',
      },
      {
        index: 3,
        title: 'refactor: tidy imports',
        type: 'refactor',
        dependsOn: [],
        changes: [{ file: 'src/b.ts', hunks: 'all' }],
        renames: [],
        testProof: 'unit',
        risk: 'low',
        rationale: '',
      },
    ],
    parallelizable: '1,3',
    landOrder: '1,2,3',
    buildTestCommand: 'npm test',
    unassignedHunks: [],
  };
}

function makeExecSnapshot(): PrDiffSnapshot {
  return {
    baseRef: 'base-sha',
    headRef: HEAD_SHA,
    files: [snapshotFile('src/a.ts'), snapshotFile('src/b.ts')],
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

/** Fingerprint of `makeExecPlan()` — the plan the resume tests re-approve. */
function execPlanFingerprint(): string {
  const plan = makeExecPlan();
  return computePlanFingerprint(
    plan,
    deriveSplitBranchNames(HEAD_BRANCH, plan),
  );
}

function makeInitialMap(overrides: Partial<SplitPrMap> = {}): SplitPrMap {
  return {
    version: 1,
    planFingerprint: execPlanFingerprint(),
    originalPrNumber: 100,
    originalPrUrl: 'https://github.com/o/r/pull/100',
    originalBaseBranch: DETECTED_BASE,
    originalHeadBranch: HEAD_BRANCH,
    originalHeadSha: HEAD_SHA,
    integrationBranch: INTEGRATION_BRANCH,
    originalWorktreeId: 'wt-original',
    children: [
      {
        index: 1,
        title: 'refactor: extract helper',
        type: 'refactor',
        branchName: CHILD1_BRANCH,
        baseBranch: INTEGRATION_BRANCH,
        dependsOn: [],
        changes: [{ file: 'src/a.ts', hunks: 'all' }],
      },
      {
        index: 2,
        title: 'feat: add feature',
        type: 'feature',
        branchName: CHILD2_BRANCH,
        baseBranch: CHILD1_BRANCH,
        dependsOn: [1],
        changes: [{ file: 'src/a.ts', hunks: [1] }],
      },
      {
        index: 3,
        title: 'refactor: tidy imports',
        type: 'refactor',
        branchName: CHILD3_BRANCH,
        baseBranch: INTEGRATION_BRANCH,
        dependsOn: [],
        changes: [{ file: 'src/b.ts', hunks: 'all' }],
      },
    ],
    buildTestCommand: 'npm test',
    status: 'executing',
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}

function makeTrackingData(): RepoPrTrackingData {
  const snapshot: PersistedPrSnapshotFileV1 = {
    version: 1,
    provider: 'github',
    capturedAt: 'now',
    includesComments: false,
    includesReviews: false,
    includesReviewComments: false,
    repository: { owner: 'o', name: 'r', fullName: 'o/r' },
    branch: {
      currentName: HEAD_BRANCH,
      headRefName: HEAD_BRANCH,
      baseRefName: DETECTED_BASE,
      headSha: HEAD_SHA,
      baseSha: 'base-sha',
    },
    pr: {
      id: 1,
      number: 100,
      nodeId: null,
      htmlUrl: 'https://github.com/o/r/pull/100',
      apiUrl: null,
      state: 'open',
      isDraft: false,
      title: 'big',
      body: '',
      author: null,
      createdAt: 'now',
      updatedAt: 'now',
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      isCrossRepository: false,
      labels: [],
      assignees: [],
      requestedReviewers: [],
    },
    issueComments: [],
    reviews: [],
    reviewComments: [],
  };
  return {
    status: {
      prNumber: 100,
      prUrl: 'https://github.com/o/r/pull/100',
      headSha: HEAD_SHA,
      state: 'open',
      title: 'big',
      checkStatus: 'passing',
      checkDetails: [],
      reviewStatus: 'approved',
      reviewers: [],
      hasConflicts: false,
      commentCount: 0,
      updatedAt: 'now',
    },
    snapshot,
    branchName: HEAD_BRANCH,
    remote: { owner: 'o', repo: 'r' },
  };
}

/**
 * Tracking data as seen from the INTEGRATION branch: the open PR on that branch
 * is the integration PR (a different PR number), NOT the original. A
 * checkout-derived `fetchPrData` returns this when asked for the integration
 * branch (or when branchName is omitted after retarget). Detecting from here
 * must NOT resolve the original PR — that is the whole point of the resume path
 * reading the map first and detecting against `map.originalHeadBranch`.
 */
function makeIntegrationTrackingData(): RepoPrTrackingData {
  const base = makeTrackingData();
  const snapshot =
    base.snapshot === null
      ? null
      : {
          ...base.snapshot,
          branch: {
            ...base.snapshot.branch,
            currentName: INTEGRATION_BRANCH,
            headRefName: INTEGRATION_BRANCH,
          },
          pr: {
            ...base.snapshot.pr,
            number: 300,
            htmlUrl: 'https://github.com/o/r/pull/300',
          },
        };
  return {
    status:
      base.status === null
        ? null
        : {
            ...base.status,
            prNumber: 300,
            prUrl: 'https://github.com/o/r/pull/300',
          },
    snapshot,
    branchName: INTEGRATION_BRANCH,
    remote: { owner: 'o', repo: 'r' },
  };
}

/**
 * A checkout-derived `fetchPrData` fake: returns the ORIGINAL PR only when asked
 * for the original head branch (or when branchName is omitted while HEAD is the
 * original head branch); returns integration-PR-shaped data when asked for the
 * integration branch (or when branchName is omitted while HEAD is the
 * integration branch). `currentCheckout` models `getCheckedOutBranch` for the
 * branchName-omitted path.
 */
function makeCheckoutDerivedFetchPrData(currentCheckout: string) {
  return (
    _repoPath: string,
    branchName?: string,
  ): Promise<RepoPrTrackingData> => {
    const branch = branchName ?? currentCheckout;
    if (branch === HEAD_BRANCH) {
      return Promise.resolve(makeTrackingData());
    }
    return Promise.resolve(makeIntegrationTrackingData());
  };
}

interface ExecHarness {
  deps: SplitterDeps;
  progress: SplitPrProgressEvent[];
  writes: SplitPrMap[];
  createPr: jest.MockedFunction<SplitterDeps['createPr']>;
  closePr: jest.MockedFunction<SplitterDeps['closePr']>;
  updatePrBody: jest.MockedFunction<SplitterDeps['updatePrBody']>;
  listOpenPrsBasedOnBranch: jest.MockedFunction<
    SplitterDeps['listOpenPrsBasedOnBranch']
  >;
  updatePrBase: jest.MockedFunction<SplitterDeps['updatePrBase']>;
  createWorktree: jest.MockedFunction<SplitterDeps['createWorktree']>;
  runWorktreeSetup: jest.MockedFunction<SplitterDeps['runWorktreeSetup']>;
  setWorktreeGrouping: jest.MockedFunction<SplitterDeps['setWorktreeGrouping']>;
  updateOriginalWorktree: jest.MockedFunction<
    SplitterDeps['updateOriginalWorktree']
  >;
  readMap: jest.MockedFunction<SplitterDeps['readMap']>;
  writeMap: jest.MockedFunction<SplitterDeps['writeMap']>;
  runVerifyCommand: jest.MockedFunction<SplitterDeps['runVerifyCommand']>;
  fetchPrData: jest.MockedFunction<SplitterDeps['fetchPrData']>;
  generateChildPrContent: jest.MockedFunction<
    SplitterDeps['generateChildPrContent']
  >;
  validatePlan: jest.MockedFunction<SplitterDeps['validatePlan']>;
}

function buildHarness(
  options: {
    existingMap?: SplitPrMap | null;
    verifyExit?: number;
    /**
     * When true, `generateChildPrContent` resolves null for every child so the
     * splitter exercises its provisional (fallback) title/body path.
     */
    generationUnavailable?: boolean;
    /**
     * PRs `listOpenPrsBasedOnBranch` resolves for the finalize dependent-PR
     * retarget step. Defaults to none.
     */
    dependentPrs?: Awaited<
      ReturnType<SplitterDeps['listOpenPrsBasedOnBranch']>
    >;
  } = {},
): ExecHarness {
  const progress: SplitPrProgressEvent[] = [];
  const writes: SplitPrMap[] = [];

  const createWorktree: jest.MockedFunction<SplitterDeps['createWorktree']> =
    jest
      .fn<
        ReturnType<SplitterDeps['createWorktree']>,
        Parameters<SplitterDeps['createWorktree']>
      >()
      .mockImplementation(({ branchName }) =>
        Promise.resolve({ id: `wt-${branchName}` }),
      );
  const runWorktreeSetup: jest.MockedFunction<
    SplitterDeps['runWorktreeSetup']
  > = jest
    .fn<
      ReturnType<SplitterDeps['runWorktreeSetup']>,
      Parameters<SplitterDeps['runWorktreeSetup']>
    >()
    .mockResolvedValue({ status: 'completed' });
  const setWorktreeGrouping: jest.MockedFunction<
    SplitterDeps['setWorktreeGrouping']
  > = jest
    .fn<
      ReturnType<SplitterDeps['setWorktreeGrouping']>,
      Parameters<SplitterDeps['setWorktreeGrouping']>
    >()
    .mockResolvedValue(undefined);
  const prNumbersByBranch: Record<string, number> = {
    [CHILD1_BRANCH]: 201,
    [CHILD2_BRANCH]: 202,
    [CHILD3_BRANCH]: 203,
    [INTEGRATION_BRANCH]: 300,
  };
  const createPr: jest.MockedFunction<SplitterDeps['createPr']> = jest
    .fn<
      ReturnType<SplitterDeps['createPr']>,
      Parameters<SplitterDeps['createPr']>
    >()
    .mockImplementation((_repoPath, branchName) =>
      Promise.resolve({
        prNumber: prNumbersByBranch[branchName] ?? 999,
        prUrl: `https://github.com/o/r/pull/${prNumbersByBranch[branchName] ?? 999}`,
        created: true,
      }),
    );
  const closePr: jest.MockedFunction<SplitterDeps['closePr']> = jest
    .fn<
      ReturnType<SplitterDeps['closePr']>,
      Parameters<SplitterDeps['closePr']>
    >()
    .mockResolvedValue(undefined);
  const updatePrBody: jest.MockedFunction<SplitterDeps['updatePrBody']> = jest
    .fn<
      ReturnType<SplitterDeps['updatePrBody']>,
      Parameters<SplitterDeps['updatePrBody']>
    >()
    .mockResolvedValue(undefined);
  const listOpenPrsBasedOnBranch: jest.MockedFunction<
    SplitterDeps['listOpenPrsBasedOnBranch']
  > = jest
    .fn<
      ReturnType<SplitterDeps['listOpenPrsBasedOnBranch']>,
      Parameters<SplitterDeps['listOpenPrsBasedOnBranch']>
    >()
    .mockResolvedValue(options.dependentPrs ?? []);
  const updatePrBase: jest.MockedFunction<SplitterDeps['updatePrBase']> = jest
    .fn<
      ReturnType<SplitterDeps['updatePrBase']>,
      Parameters<SplitterDeps['updatePrBase']>
    >()
    .mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/999' });
  const updateOriginalWorktree: jest.MockedFunction<
    SplitterDeps['updateOriginalWorktree']
  > = jest
    .fn<
      ReturnType<SplitterDeps['updateOriginalWorktree']>,
      Parameters<SplitterDeps['updateOriginalWorktree']>
    >()
    .mockResolvedValue(undefined);
  const readMap: jest.MockedFunction<SplitterDeps['readMap']> = jest
    .fn<
      ReturnType<SplitterDeps['readMap']>,
      Parameters<SplitterDeps['readMap']>
    >()
    .mockResolvedValue(options.existingMap ?? null);
  const writeMap: jest.MockedFunction<SplitterDeps['writeMap']> = jest
    .fn<
      ReturnType<SplitterDeps['writeMap']>,
      Parameters<SplitterDeps['writeMap']>
    >()
    .mockImplementation((_w, _t, map) => {
      // Capture a deep copy so later mutations don't rewrite earlier snapshots.
      writes.push(structuredClone(map));
      return Promise.resolve(true);
    });
  const runVerifyCommand: jest.MockedFunction<
    SplitterDeps['runVerifyCommand']
  > = jest
    .fn<
      ReturnType<SplitterDeps['runVerifyCommand']>,
      Parameters<SplitterDeps['runVerifyCommand']>
    >()
    .mockResolvedValue({ exitCode: options.verifyExit ?? 0, tail: 'ok' });
  const fetchPrData: jest.MockedFunction<SplitterDeps['fetchPrData']> = jest
    .fn<
      ReturnType<SplitterDeps['fetchPrData']>,
      Parameters<SplitterDeps['fetchPrData']>
    >()
    .mockResolvedValue(makeTrackingData());
  const validatePlan: jest.MockedFunction<SplitterDeps['validatePlan']> = jest
    .fn<
      ReturnType<SplitterDeps['validatePlan']>,
      Parameters<SplitterDeps['validatePlan']>
    >()
    .mockReturnValue({ valid: true, issues: [] });
  const generateChildPrContent: jest.MockedFunction<
    SplitterDeps['generateChildPrContent']
  > = jest
    .fn<
      ReturnType<SplitterDeps['generateChildPrContent']>,
      Parameters<SplitterDeps['generateChildPrContent']>
    >()
    .mockImplementation(({ branchName }) =>
      Promise.resolve(
        options.generationUnavailable
          ? null
          : {
              title: `Generated ${branchName}`,
              body: `Generated body for ${branchName}\n\n## Summary\n- did stuff`,
            },
      ),
    );

  const deps: SplitterDeps = {
    recordGitCommitTelemetry,
    recordPullRequestOpenedTelemetry,
    createWorktree,
    runWorktreeSetup,
    setWorktreeGrouping,
    createPr,
    closePr,
    updatePrBody,
    listOpenPrsBasedOnBranch,
    updatePrBase,
    updateOriginalWorktree,
    readMap,
    writeMap,
    runVerifyCommand,
    resolveChildWorktreePath: (worktreeId: string): Promise<string> =>
      Promise.resolve(`/tmp/${worktreeId}`),
    resolveOriginalWorktreePath: (): Promise<string> =>
      Promise.resolve(ORIGINAL_WORKTREE_CWD),
    fetchPrData,
    generateChildPrContent,
    validatePlan,
  };

  return {
    deps,
    progress,
    writes,
    createPr,
    closePr,
    updatePrBody,
    listOpenPrsBasedOnBranch,
    updatePrBase,
    createWorktree,
    runWorktreeSetup,
    setWorktreeGrouping,
    updateOriginalWorktree,
    readMap,
    writeMap,
    runVerifyCommand,
    fetchPrData,
    generateChildPrContent,
    validatePlan,
  };
}

function buildExecOptions(
  harness: ExecHarness,
  overrides: Partial<ExecutePrSplitOptions> = {},
): ExecutePrSplitOptions {
  return {
    projectId: 'ws-1',
    worktreeId: 'wt-original',
    plan: makeExecPlan(),
    snapshot: makeExecSnapshot(),
    signal: new AbortController().signal,
    onProgress: (event: SplitPrProgressEvent): void => {
      harness.progress.push(event);
    },
    deps: harness.deps,
    ...overrides,
  };
}

function setupHappyGitMocks(): void {
  mockedFetchOrigin.mockResolvedValue(undefined);
  mockedIsAncestor.mockResolvedValue(true);
  mockedIsBranchNameAvailable.mockResolvedValue(true);
  // Default: origin does not already have any branch this run touches. Tests
  // that simulate a resume against a pushed-but-locally-gone branch override
  // this per-branch.
  mockedDoesRemoteBranchExist.mockResolvedValue(false);
  mockedCheckoutBranch.mockResolvedValue(undefined);
  mockedCreateBranchWithEmptyCommit.mockResolvedValue('init-commit');
  mockedPushNamedBranch.mockResolvedValue(undefined);
  mockedMergeBranch.mockResolvedValue(undefined);
  mockedAddDetachedWorktree.mockResolvedValue(undefined);
  mockedRemoveGitWorktree.mockResolvedValue(undefined);
  // Reconstructed-tip check: tree of original head === tree of verify tip.
  mockedGetTreeSha.mockResolvedValue('same-tree-sha');
  // Pre-flight: HEAD === originalHeadSha, clean checkout.
  mockedResolveRefSha.mockResolvedValue(HEAD_SHA);
  mockedHasUncommittedChanges.mockResolvedValue(false);
  // Retarget step: original worktree is on some other branch by default, so
  // the checkout happens. Tests asserting idempotent-skip override this.
  mockedGetCheckedOutBranch.mockResolvedValue(HEAD_BRANCH);
}

describe('executePrSplit happy path', () => {
  beforeEach(() => {
    setupHappyGitMocks();
  });

  it('creates integration branch, carves children, opens PRs with correct bases, updates bodies, retargets and closes original', async () => {
    const harness = buildHarness();
    const map = await executePrSplit(buildExecOptions(harness));

    expect(recordGitCommitTelemetry).toHaveBeenCalledTimes(4);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(4);
    expect(recordGitCommitTelemetry).toHaveBeenCalledWith({
      projectId: 'ws-1',
      source: 'manual',
      flow: 'split_pr',
      repoCount: 1,
    });
    // Integration branch created off origin/<detectedBase> with an empty init
    // commit, then pushed.
    expect(mockedCreateBranchWithEmptyCommit).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
      `origin/${DETECTED_BASE}`,
      expect.stringContaining('integration'),
    );
    expect(mockedPushNamedBranch).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
    );

    // Child PR base wiring per the topology table.
    const childCalls = harness.createPr.mock.calls.filter(
      (c) => c[1] !== INTEGRATION_BRANCH,
    );
    const baseByBranch = new Map(childCalls.map((c) => [c[1], c[4]]));
    expect(baseByBranch.get(CHILD1_BRANCH)).toBe(INTEGRATION_BRANCH);
    expect(baseByBranch.get(CHILD2_BRANCH)).toBe(CHILD1_BRANCH);
    expect(baseByBranch.get(CHILD3_BRANCH)).toBe(INTEGRATION_BRANCH);

    // Integration PR opened last against the detected base.
    const integrationCall = harness.createPr.mock.calls.find(
      (c) => c[1] === INTEGRATION_BRANCH,
    );
    expect(integrationCall).toBeDefined();
    expect(integrationCall?.[4]).toBe(DETECTED_BASE);
    expect(integrationCall?.[3]).toContain('Splits #100');
    // Integration PR title is the ORIGINAL PR title ("big") + " (split)", NOT
    // the branch-derived title.
    expect(integrationCall?.[2]).toBe('big (split)');

    // Child titles prepend `[X/Y]` to the GENERATED title, and child bodies are
    // the generated base body + a `---` separator + the stack block.
    const child1Create = harness.createPr.mock.calls.find(
      (c) => c[1] === CHILD1_BRANCH,
    );
    expect(child1Create?.[2]).toBe(`[1/3] Generated ${CHILD1_BRANCH}`);
    expect(child1Create?.[3]).toContain(`Generated body for ${CHILD1_BRANCH}`);
    expect(child1Create?.[3]).toContain('\n\n---\n\n');
    expect(child1Create?.[3]).toContain('Part of a Split PR of #100');

    // Body-update pass hits every child PR and the integration PR.
    const updatedPrNumbers = harness.updatePrBody.mock.calls.map((c) => c[1]);
    expect(updatedPrNumbers).toEqual(
      expect.arrayContaining([201, 202, 203, 300]),
    );

    // The integration PR's updated body keeps its "Splits #N" header framing
    // (not the child-oriented "Part of a Split PR of #N" block).
    const integrationBodyUpdate = harness.updatePrBody.mock.calls.find(
      (c) => c[1] === 300,
    );
    expect(integrationBodyUpdate?.[2]).toContain('Splits #100');
    expect(integrationBodyUpdate?.[2]).not.toContain('Part of a Split PR');
    // Child bodies keep the child-oriented framing AND preserve the generated
    // base content above a `---` separator (the update pass only refreshes the
    // stack block below it).
    const childBodyUpdate = harness.updatePrBody.mock.calls.find(
      (c) => c[1] === 201,
    );
    expect(childBodyUpdate?.[2]).toContain('Part of a Split PR of #100');
    expect(childBodyUpdate?.[2]).toContain(
      `Generated body for ${CHILD1_BRANCH}`,
    );
    expect(childBodyUpdate?.[2]).toContain('\n\n---\n\n');

    // Original retargeted to the integration branch and closed with a comment
    // linking the integration PR.
    expect(mockedCheckoutBranch).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
    );
    expect(harness.deps.updateOriginalWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-original',
      { branchName: INTEGRATION_BRANCH, trackedBaseBranch: DETECTED_BASE },
    );
    const closeCall = harness.closePr.mock.calls[0];
    expect(closeCall[1]).toBe(100);
    expect(closeCall[2]).toContain('#300');

    expect(map.status).toBe('completed');
    expect(harness.progress.some((event) => event.phase === 'done')).toBe(true);
  });

  it('opens the integration PR only after the reconstructed-tip tree matches', async () => {
    const harness = buildHarness();
    await executePrSplit(buildExecOptions(harness));

    // Leaves (children 2 and 3) are merged into the temp reconstruct worktree.
    const mergedBranches = mockedMergeBranch.mock.calls.map((c) => c[1]);
    expect(mergedBranches).toEqual(
      expect.arrayContaining([CHILD2_BRANCH, CHILD3_BRANCH]),
    );
    expect(mergedBranches).not.toContain(CHILD1_BRANCH);
    // Temp worktree removed in finally.
    expect(mockedRemoveGitWorktree).toHaveBeenCalled();
  });

  it('writes the map after each side effect in checkpoint order (worktreeId → carve sha → prNumber)', async () => {
    const harness = buildHarness();
    await executePrSplit(buildExecOptions(harness));

    function firstWriteWith(pred: (map: SplitPrMap) => boolean): number {
      return harness.writes.findIndex(pred);
    }

    const child1WorktreeSet = firstWriteWith((m) =>
      Boolean(m.children.find((c) => c.index === 1)?.worktreeId),
    );
    const child1CarveSet = firstWriteWith((m) =>
      Boolean(m.children.find((c) => c.index === 1)?.carveCommitSha),
    );
    const child1PrSet = firstWriteWith((m) =>
      Boolean(m.children.find((c) => c.index === 1)?.prNumber),
    );

    expect(child1WorktreeSet).toBeGreaterThanOrEqual(0);
    expect(child1WorktreeSet).toBeLessThan(child1CarveSet);
    expect(child1CarveSet).toBeLessThan(child1PrSet);
  });

  it('persists a created child worktree before grouping so resume can find it', async () => {
    const harness = buildHarness();
    harness.setWorktreeGrouping.mockRejectedValueOnce(
      new Error('grouping failed'),
    );

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      'grouping failed',
    );

    const child1Checkpoint = harness.writes.find((map) =>
      Boolean(map.children.find((child) => child.index === 1)?.worktreeId),
    );
    expect(
      child1Checkpoint?.children.find((child) => child.index === 1),
    ).toEqual(expect.objectContaining({ worktreeId: `wt-${CHILD1_BRANCH}` }));
    expect(harness.runWorktreeSetup).not.toHaveBeenCalled();
  });

  it('stops before external side effects when the initial checkpoint cannot be written', async () => {
    const harness = buildHarness();
    harness.writeMap.mockResolvedValueOnce(false);

    await expect(
      executePrSplit(buildExecOptions(harness)),
    ).rejects.toMatchObject({
      code: 'checkpoint_write_failed',
    });

    expect(mockedCreateBranchWithEmptyCommit).not.toHaveBeenCalled();
    expect(mockedPushNamedBranch).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
    expect(harness.createPr).not.toHaveBeenCalled();
  });

  it('falls back to the current title/body shapes when child generation returns null', async () => {
    const harness = buildHarness({ generationUnavailable: true });
    await executePrSplit(buildExecOptions(harness));

    const child1Create = harness.createPr.mock.calls.find(
      (c) => c[1] === CHILD1_BRANCH,
    );
    // Title falls back to the planner-derived child title (unchanged behavior).
    expect(child1Create?.[2]).toBe('[1/3] refactor: extract helper');
    // Body falls back to the provisional stack-only block: no generated content,
    // no `---` separator.
    expect(child1Create?.[3]).toContain('Part of a Split PR of #100');
    expect(child1Create?.[3]).not.toContain('\n\n---\n\n');

    // The body-update pass also emits the stack-only body for fallback children:
    // no `---` separator, but the full stack table with real PR numbers and a
    // "← this change" marker for this child (matching pre-fallback-regression
    // update behavior).
    const child1BodyUpdate = harness.updatePrBody.mock.calls.find(
      (c) => c[1] === 201,
    );
    expect(child1BodyUpdate?.[2]).not.toContain('\n\n---\n\n');
    expect(child1BodyUpdate?.[2]).toContain('← this change');
    expect(child1BodyUpdate?.[2]).toContain('#202');
  });

  it('never generates content for a child that fails verification (stops red before generation)', async () => {
    const harness = buildHarness({ verifyExit: 1 });

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /failed verification/,
    );

    expect(harness.generateChildPrContent).not.toHaveBeenCalled();
    expect(harness.createPr).not.toHaveBeenCalledWith(
      expect.anything(),
      CHILD1_BRANCH,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('executePrSplit dependent PR retargeting', () => {
  beforeEach(() => {
    setupHappyGitMocks();
  });

  it('retargets a dependent PR onto the integration branch before closing the original', async () => {
    const harness = buildHarness({
      dependentPrs: [
        {
          prNumber: 46,
          prUrl: 'https://github.com/o/r/pull/46',
          headBranch: 'feat/downstream',
        },
      ],
    });

    const map = await executePrSplit(buildExecOptions(harness));

    expect(harness.listOpenPrsBasedOnBranch).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      HEAD_BRANCH,
    );
    expect(harness.updatePrBase).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      46,
      INTEGRATION_BRANCH,
    );
    // updatePrBase must run before the original PR is closed.
    const updatePrBaseOrder = harness.updatePrBase.mock.invocationCallOrder[0];
    const closePrOrder = harness.closePr.mock.invocationCallOrder[0];
    expect(updatePrBaseOrder).toBeLessThan(closePrOrder);

    expect(map.retargetedDependentPrs).toEqual([
      {
        prNumber: 46,
        prUrl: 'https://github.com/o/r/pull/46',
        headBranch: 'feat/downstream',
      },
    ]);

    const dependentsEvent = harness.progress.find(
      (event) => event.phase === 'retargeting_dependents',
    );
    expect(dependentsEvent).toBeDefined();
    expect(dependentsEvent?.message).toContain('46');
  });

  it('does not call updatePrBase or emit retargeting_dependents when there are no dependents', async () => {
    const harness = buildHarness({ dependentPrs: [] });

    await executePrSplit(buildExecOptions(harness));

    expect(harness.updatePrBase).not.toHaveBeenCalled();
    expect(
      harness.progress.some(
        (event) => event.phase === 'retargeting_dependents',
      ),
    ).toBe(false);
  });

  it('filters out PRs that belong to this split (children, integration, original)', async () => {
    const harness = buildHarness({
      dependentPrs: [
        // Child 1's own PR number, defensively returned by a stale/odd query.
        {
          prNumber: 201,
          prUrl: 'https://github.com/o/r/pull/201',
          headBranch: CHILD1_BRANCH,
        },
        // A genuine external dependent that must still be retargeted.
        {
          prNumber: 46,
          prUrl: 'https://github.com/o/r/pull/46',
          headBranch: 'feat/downstream',
        },
      ],
    });

    const map = await executePrSplit(buildExecOptions(harness));

    expect(harness.updatePrBase).toHaveBeenCalledTimes(1);
    expect(harness.updatePrBase).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      46,
      INTEGRATION_BRANCH,
    );
    expect(map.retargetedDependentPrs).toEqual([
      {
        prNumber: 46,
        prUrl: 'https://github.com/o/r/pull/46',
        headBranch: 'feat/downstream',
      },
    ]);
  });

  it('checkpoints each retargeted dependent so a crash mid-batch keeps the record of already-moved PRs', async () => {
    const harness = buildHarness({
      dependentPrs: [
        {
          prNumber: 46,
          prUrl: 'https://github.com/o/r/pull/46',
          headBranch: 'feat/downstream',
        },
        {
          prNumber: 47,
          prUrl: 'https://github.com/o/r/pull/47',
          headBranch: 'feat/further-downstream',
        },
      ],
    });
    // First base update lands on GitHub, the second dies mid-batch.
    harness.updatePrBase
      .mockResolvedValueOnce({ prUrl: 'https://github.com/o/r/pull/46' })
      .mockRejectedValueOnce(new Error('base update failed'));

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      'base update failed',
    );

    // PR #46 was retargeted before the crash; the persisted record must
    // retain it even though the batch never completed, and the original PR
    // must still be open.
    const lastWrite = harness.writes[harness.writes.length - 1];
    expect(lastWrite.retargetedDependentPrs).toEqual([
      {
        prNumber: 46,
        prUrl: 'https://github.com/o/r/pull/46',
        headBranch: 'feat/downstream',
      },
    ]);
    expect(lastWrite.status).toBe('failed');
    expect(harness.closePr).not.toHaveBeenCalled();
  });
});

describe('executePrSplit resume', () => {
  beforeEach(() => {
    setupHappyGitMocks();
  });

  it('refuses when the persisted map has a different originalHeadSha (PR changed)', async () => {
    const stale = makeInitialMap({ originalHeadSha: 'different-sha' });
    const harness = buildHarness({ existingMap: stale });

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /PR changed/i,
    );
    expect(harness.createPr).not.toHaveBeenCalled();
  });

  it('proceeds when the approved plan matches the in-progress split (same fingerprint)', async () => {
    const resumed = makeInitialMap();
    const harness = buildHarness({ existingMap: resumed });

    const map = await executePrSplit(buildExecOptions(harness));
    expect(map.status).toBe('completed');
  });

  it('refuses when the approved plan differs from the in-progress split (edited changes)', async () => {
    const resumed = makeInitialMap();
    const harness = buildHarness({ existingMap: resumed });

    // Re-approve a plan whose child 2 owns a DIFFERENT hunk index — a
    // carve-affecting edit, so the fingerprint no longer matches.
    const editedPlan = makeExecPlan();
    editedPlan.children[1].changes = [{ file: 'src/a.ts', hunks: [2] }];

    let thrown: unknown;
    try {
      await executePrSplit(buildExecOptions(harness, { plan: editedPlan }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SplitPrExecutionError);
    if (thrown instanceof SplitPrExecutionError) {
      expect(thrown.code).toBe('plan_mismatch');
      expect(thrown.message).toMatch(/differs from the split/i);
    }
    expect(harness.createPr).not.toHaveBeenCalled();
  });

  it('does NOT refuse for a title-only edit (fingerprint excludes title)', async () => {
    const resumed = makeInitialMap();
    const harness = buildHarness({ existingMap: resumed });

    const editedPlan = makeExecPlan();
    editedPlan.children[0].title = 'refactor: a totally different title';

    const map = await executePrSplit(
      buildExecOptions(harness, { plan: editedPlan }),
    );
    expect(map.status).toBe('completed');
  });

  it('falls back to the head-branch-derived integration title on a legacy map (no originalPrTitle)', async () => {
    // Legacy resume: the map predates `originalPrTitle`, and live detection can
    // no longer find an open original PR (prior run already closed/retargeted),
    // so `detectOriginalPr` falls back to the map identity with an undefined
    // title. The integration title then uses `${originalHeadBranch} (split)`.
    const legacy = makeInitialMap({ originalPrTitle: undefined });
    for (const child of legacy.children) {
      child.worktreeId = `wt-${child.branchName}`;
      child.carveCommitSha = 'child-carve';
      child.verifyStatus = 'green';
      child.prNumber = 200 + child.index;
      child.prUrl = `https://github.com/o/r/pull/${200 + child.index}`;
    }
    const harness = buildHarness({ existingMap: legacy });
    // No open original PR from detection → map-identity fallback.
    harness.fetchPrData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: HEAD_BRANCH,
      remote: { owner: 'o', repo: 'r' },
    });
    // Every child worktree HEAD matches its recorded carve sha so all carves are
    // skipped and only the integration PR is opened this run. The original
    // checkout resolves to the PR head for the pre-flight gate.
    mockedResolveRefSha.mockImplementation((cwd) =>
      Promise.resolve(cwd === ORIGINAL_WORKTREE_CWD ? HEAD_SHA : 'child-carve'),
    );

    await executePrSplit(buildExecOptions(harness));

    const integrationCall = harness.createPr.mock.calls.find(
      (c) => c[1] === INTEGRATION_BRANCH,
    );
    expect(integrationCall?.[2]).toBe(`${HEAD_BRANCH} (split)`);
  });

  it('refuses to resume an old map that lacks a plan fingerprint', async () => {
    const legacy = makeInitialMap({ planFingerprint: undefined });
    const harness = buildHarness({ existingMap: legacy });

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /differs from the split/i,
    );
    expect(harness.createPr).not.toHaveBeenCalled();
  });

  it('refuses a fresh split when the integration branch already exists on origin', async () => {
    const harness = buildHarness();
    mockedDoesRemoteBranchExist.mockImplementation((_repo, branch) =>
      Promise.resolve(branch === INTEGRATION_BRANCH),
    );

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /Integration branch ".*" already exists/,
    );

    expect(harness.writeMap).not.toHaveBeenCalled();
    expect(mockedCreateBranchWithEmptyCommit).not.toHaveBeenCalled();
    expect(mockedPushNamedBranch).not.toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
    );
  });

  it('refuses a fresh split when the integration branch already exists locally', async () => {
    const harness = buildHarness();
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /Integration branch ".*" already exists/,
    );

    expect(harness.writeMap).not.toHaveBeenCalled();
    expect(mockedCreateBranchWithEmptyCommit).not.toHaveBeenCalled();
    expect(mockedPushNamedBranch).not.toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
    );
  });

  it('skips creating AND pushing the integration branch when origin already has it', async () => {
    // Origin already has the integration branch (its push happened last run
    // and is visible via the post-fetch remote-tracking ref), regardless of
    // whether a local branch also exists. Both create and push must be
    // skipped.
    const resumed = makeInitialMap();
    const harness = buildHarness({ existingMap: resumed });
    mockedDoesRemoteBranchExist.mockImplementation((_repo, branch) =>
      Promise.resolve(branch === INTEGRATION_BRANCH),
    );

    await executePrSplit(buildExecOptions(harness));

    expect(mockedCreateBranchWithEmptyCommit).not.toHaveBeenCalled();
    expect(mockedPushNamedBranch).not.toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
    );
  });

  it('checkpoints the integration push: local branch exists but origin does not, so create is skipped but push still runs', async () => {
    // Simulates a resume where the local integration branch survived (e.g.
    // same machine, prior crash before persist) but the push never landed or
    // was never confirmed. Origin lacks the branch, so create must be skipped
    // (it already exists locally) while push must still run to checkpoint it.
    const resumed = makeInitialMap();
    const harness = buildHarness({ existingMap: resumed });
    mockedDoesRemoteBranchExist.mockResolvedValue(false);
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );

    await executePrSplit(buildExecOptions(harness));

    expect(mockedCreateBranchWithEmptyCommit).not.toHaveBeenCalled();
    expect(mockedPushNamedBranch).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
    );
  });

  it('creates and pushes the integration branch when neither local nor origin has it', async () => {
    const resumed = makeInitialMap();
    const harness = buildHarness({ existingMap: resumed });
    mockedDoesRemoteBranchExist.mockResolvedValue(false);
    mockedIsBranchNameAvailable.mockResolvedValue(true);

    await executePrSplit(buildExecOptions(harness));

    expect(mockedCreateBranchWithEmptyCommit).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
      `origin/${DETECTED_BASE}`,
      expect.stringContaining('integration'),
    );
    expect(mockedPushNamedBranch).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      INTEGRATION_BRANCH,
    );
  });

  it('refuses a foreign origin-only child branch with no recorded artifacts as a collision', async () => {
    // A branch with this exact name exists on origin but the map has no
    // worktreeId/prNumber recorded for it — this is NOT our resume state, it
    // is a genuine foreign collision and must be refused, even though the
    // local-only isBranchNameAvailable check would say it's available.
    const resumed = makeInitialMap();
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockResolvedValue(true);
    mockedDoesRemoteBranchExist.mockImplementation((_repo, branch) =>
      Promise.resolve(branch === CHILD1_BRANCH),
    );

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /already exists/i,
    );
    expect(harness.createPr).not.toHaveBeenCalled();
  });

  it('skips carve and PR for a child whose carveCommitSha and prNumber are already recorded', async () => {
    const resumed = makeInitialMap();
    const firstChild = resumed.children[0];
    firstChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    firstChild.carveCommitSha = 'child1-carve';
    firstChild.verifyStatus = 'green';
    firstChild.prNumber = 201;
    firstChild.prUrl = 'https://github.com/o/r/pull/201';
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    // Child 1's worktree HEAD already matches the recorded carve sha (skip
    // signal). The original checkout's HEAD matches the PR head (pre-flight).
    // For every other cwd, HEAD and the child base resolve equal so
    // carveChild's clean-at-base precondition passes.
    mockedResolveRefSha.mockImplementation((cwd) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}`) {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });

    await executePrSplit(buildExecOptions(harness));

    // Child 1 PR is not re-opened.
    const child1Create = harness.createPr.mock.calls.find(
      (c) => c[1] === CHILD1_BRANCH,
    );
    expect(child1Create).toBeUndefined();
    // Its PR already exists, so no content generation runs for it either.
    const generatedBranches = harness.generateChildPrContent.mock.calls.map(
      (c) => c[0].branchName,
    );
    expect(generatedBranches).not.toContain(CHILD1_BRANCH);
    // But downstream children 2 and 3 still get created.
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD2_BRANCH),
    ).toBe(true);
  });

  it('re-verifies (not re-carves) a red-recorded child whose carve tip matches, and proceeds when it goes green', async () => {
    // First child stopped at a red verify on a prior run: carve sha + red
    // status recorded, worktree present, but no PR opened. Its worktree HEAD
    // still sits at the recorded carve commit.
    const resumed = makeInitialMap();
    const redChild = resumed.children[0];
    redChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    redChild.carveCommitSha = 'child1-carve';
    redChild.verifyStatus = 'red';
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    // Child 1's worktree HEAD matches its recorded carve sha (carve-skip
    // signal). The original checkout matches the PR head (pre-flight). Every
    // other cwd resolves HEAD === child base so downstream carves pass their
    // clean-at-base precondition.
    mockedResolveRefSha.mockImplementation((cwd) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}`) {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });
    // Re-verify is green this time.
    harness.runVerifyCommand.mockResolvedValue({ exitCode: 0, tail: 'ok' });

    const map = await executePrSplit(buildExecOptions(harness));

    // carveChild was NOT called for child 1: no carve-only git steps ran for
    // it (commit/stage are carve internals; the re-verify path never commits).
    // The definitive signal is that the standalone verifier ran for the child
    // worktree and the recorded carve sha is unchanged.
    expect(harness.runVerifyCommand).toHaveBeenCalledWith(
      `/tmp/wt-${CHILD1_BRANCH}`,
      'npm test',
      expect.anything(),
    );
    const resumedChild1 = map.children.find((c) => c.index === 1);
    expect(resumedChild1?.carveCommitSha).toBe('child1-carve');
    expect(resumedChild1?.verifyStatus).toBe('green');
    // Its branch was pushed (the red run stopped before pushing it) and its PR
    // opened, so the run proceeds to completion.
    expect(mockedPushNamedBranch).toHaveBeenCalledWith(
      `/tmp/wt-${CHILD1_BRANCH}`,
      CHILD1_BRANCH,
    );
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD1_BRANCH),
    ).toBe(true);
    expect(map.status).toBe('completed');
  });

  it('refuses to re-verify a red-recorded child when its worktree is dirty', async () => {
    const resumed = makeInitialMap();
    const redChild = resumed.children[0];
    redChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    redChild.carveCommitSha = 'child1-carve';
    redChild.verifyStatus = 'red';
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    mockedResolveRefSha.mockImplementation((cwd) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}`) {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });
    mockedHasUncommittedChanges.mockImplementation((cwd) =>
      Promise.resolve(cwd === `/tmp/wt-${CHILD1_BRANCH}`),
    );

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /uncommitted changes.*red-verify resume/,
    );

    expect(harness.runVerifyCommand).not.toHaveBeenCalled();
    expect(mockedPushNamedBranch).not.toHaveBeenCalledWith(
      `/tmp/wt-${CHILD1_BRANCH}`,
      CHILD1_BRANCH,
    );
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD1_BRANCH),
    ).toBe(false);
    expect(harness.writes[harness.writes.length - 1].status).toBe('failed');
  });

  it('refuses to re-verify a red-recorded child if setup moves HEAD off the recorded carve commit', async () => {
    const resumed = makeInitialMap();
    const redChild = resumed.children[0];
    redChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    redChild.carveCommitSha = 'child1-carve';
    redChild.verifyStatus = 'red';
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    let childHeadReads = 0;
    mockedResolveRefSha.mockImplementation((cwd, ref) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}` && ref === 'HEAD') {
        childHeadReads += 1;
        return Promise.resolve(
          childHeadReads === 1 ? 'child1-carve' : 'moved-sha',
        );
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}` && ref === 'child1-carve') {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /recorded carve commit.*wrong commit/,
    );

    expect(harness.runVerifyCommand).not.toHaveBeenCalled();
    expect(mockedPushNamedBranch).not.toHaveBeenCalledWith(
      `/tmp/wt-${CHILD1_BRANCH}`,
      CHILD1_BRANCH,
    );
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD1_BRANCH),
    ).toBe(false);
    expect(harness.writes[harness.writes.length - 1].status).toBe('failed');
  });

  it('pushes an already-carved green child whose PR was never opened before creating its PR (crash-before-push window)', async () => {
    // Crash window: a prior run persisted `carveCommitSha` + green
    // `verifyStatus` but crashed BEFORE `pushNamedBranch`, so the child branch
    // was never pushed to origin and no PR was opened. On resume the carve is
    // skipped (tip matches) and the verify is already green, so neither the
    // fresh-carve nor the re-verify push runs. The resume must still push the
    // branch before creating the PR, or PR creation fails against a missing
    // origin branch.
    const resumed = makeInitialMap();
    const greenChild = resumed.children[0];
    greenChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    greenChild.carveCommitSha = 'child1-carve';
    greenChild.verifyStatus = 'green';
    // prNumber intentionally left undefined — PR was never opened.
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    mockedResolveRefSha.mockImplementation((cwd) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}`) {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });

    await executePrSplit(buildExecOptions(harness));

    // The child branch was pushed from its worktree even though carve+verify
    // were both skipped.
    expect(mockedPushNamedBranch).toHaveBeenCalledWith(
      `/tmp/wt-${CHILD1_BRANCH}`,
      CHILD1_BRANCH,
    );
    // And a PR was opened for it.
    const child1Create = harness.createPr.mock.calls.find(
      (c) => c[1] === CHILD1_BRANCH,
    );
    expect(child1Create).toBeDefined();

    // Push happened BEFORE PR creation for this child.
    const child1PushOrder = mockedPushNamedBranch.mock.calls
      .map((call, i) => ({
        call,
        order: mockedPushNamedBranch.mock.invocationCallOrder[i],
      }))
      .filter(({ call }) => call[1] === CHILD1_BRANCH)
      .map(({ order }) => order);
    const child1CreateOrder = harness.createPr.mock.calls
      .map((call, i) => ({
        call,
        order: harness.createPr.mock.invocationCallOrder[i],
      }))
      .filter(({ call }) => call[1] === CHILD1_BRANCH)
      .map(({ order }) => order);
    expect(child1PushOrder.length).toBe(1);
    expect(child1CreateOrder.length).toBe(1);
    expect(child1PushOrder[0]).toBeLessThan(child1CreateOrder[0]);
  });

  it('re-verifies a red-recorded child and stops again when it is still red', async () => {
    const resumed = makeInitialMap();
    const redChild = resumed.children[0];
    redChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    redChild.carveCommitSha = 'child1-carve';
    redChild.verifyStatus = 'red';
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    mockedResolveRefSha.mockImplementation((cwd) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}`) {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });
    // Still red on resume, with a fresh tail.
    harness.runVerifyCommand.mockResolvedValue({
      exitCode: 1,
      tail: 'still failing',
    });

    let thrown: unknown = null;
    try {
      await executePrSplit(buildExecOptions(harness));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SplitPrExecutionError);
    if (thrown instanceof SplitPrExecutionError) {
      expect(thrown.childIndex).toBe(1);
      expect(thrown.verifyTail).toContain('still failing');
    }
    // Branch not pushed and no PR opened for the still-red child.
    expect(mockedPushNamedBranch).not.toHaveBeenCalledWith(
      `/tmp/wt-${CHILD1_BRANCH}`,
      CHILD1_BRANCH,
    );
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD1_BRANCH),
    ).toBe(false);
    const lastWrite = harness.writes[harness.writes.length - 1];
    expect(lastWrite.status).toBe('failed');
    expect(lastWrite.children.find((c) => c.index === 1)?.verifyStatus).toBe(
      'red',
    );
  });

  it('honors an abort fired during re-verify of a red-recorded child (cancellation, not red)', async () => {
    const controller = new AbortController();
    const resumed = makeInitialMap();
    const redChild = resumed.children[0];
    redChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    redChild.carveCommitSha = 'child1-carve';
    redChild.verifyStatus = 'red';
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    mockedResolveRefSha.mockImplementation((cwd) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}`) {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });
    // The verifier resolves non-zero (as the real runner does when killed by
    // the signal) but only after aborting: `runVerify` must classify this as
    // an abort, not a red result.
    harness.runVerifyCommand.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ exitCode: 143, tail: 'killed' });
    });

    const map = await executePrSplit(
      buildExecOptions(harness, { signal: controller.signal }),
    );

    // Re-verify actually ran, then the abort took precedence over the observed
    // non-zero exit: the run is cancelled (control-flow), not failed-red, and no
    // child PR was opened.
    expect(harness.runVerifyCommand).toHaveBeenCalledWith(
      `/tmp/wt-${CHILD1_BRANCH}`,
      'npm test',
      expect.anything(),
    );
    expect(map.status).toBe('cancelled');
    expect(map.status).not.toBe('failed');
    expect(harness.progress.some((e) => e.phase === 'cancelled')).toBe(true);
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD1_BRANCH),
    ).toBe(false);
  });

  it('skips the retarget checkout when the original worktree is already on the integration branch', async () => {
    const harness = buildHarness();
    mockedGetCheckedOutBranch.mockResolvedValue(INTEGRATION_BRANCH);

    const map = await executePrSplit(buildExecOptions(harness));

    expect(mockedCheckoutBranch).not.toHaveBeenCalled();
    // The rest of the retarget step still runs.
    expect(harness.updateOriginalWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-original',
      { branchName: INTEGRATION_BRANCH, trackedBaseBranch: DETECTED_BASE },
    );
    expect(map.status).toBe('completed');
  });

  it('resumes after retarget with a checkout-derived fetchPrData: HEAD is on the integration branch, detection still targets the original PR via the map, and the run completes', async () => {
    // Model the real production seam: after retarget the original worktree is
    // checked out on the integration branch, so a checkout-derived fetchPrData
    // (branchName omitted) would resolve the INTEGRATION PR, not the original.
    // The resume must read the map first and detect against
    // `map.originalHeadBranch`, so matchingMap is found and the post-retarget
    // gates are skipped.
    const resumed = makeInitialMap({
      integrationPrNumber: 300,
      integrationPrUrl: 'https://github.com/o/r/pull/300',
      children: makeInitialMap().children.map((child, i) => ({
        ...child,
        worktreeId: `child-wt-${i + 1}`,
        carveCommitSha: HEAD_SHA,
        verifyStatus: 'green',
        prNumber: 201 + i,
        prUrl: `https://github.com/o/r/pull/${201 + i}`,
      })),
    });
    const harness = buildHarness({ existingMap: resumed });
    // HEAD is the integration branch (post-retarget); origin already has it and
    // every child branch so no branch is (re)created.
    mockedGetCheckedOutBranch.mockResolvedValue(INTEGRATION_BRANCH);
    mockedDoesRemoteBranchExist.mockResolvedValue(true);
    harness.fetchPrData.mockImplementation(
      makeCheckoutDerivedFetchPrData(INTEGRATION_BRANCH),
    );

    const map = await executePrSplit(buildExecOptions(harness));

    // Detection targeted the ORIGINAL head branch (the map's authoritative
    // identity), NOT the checked-out integration branch.
    expect(harness.fetchPrData).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      HEAD_BRANCH,
    );
    // Post-retarget gate skip: the pre-retarget HEAD-match refusal never fires,
    // the retarget checkout is not re-run, and the run closes the original PR.
    expect(mockedCheckoutBranch).not.toHaveBeenCalled();
    expect(harness.closePr).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      100,
      expect.any(String),
    );
    expect(map.status).toBe('completed');
  });

  it('fresh run (no map) is unaffected: detection uses the checked-out branch and requires an open PR', async () => {
    const harness = buildHarness();
    // No existingMap → fetchPrData is called with branchName undefined so
    // detection falls back to the checked-out branch (HEAD_BRANCH here).
    harness.fetchPrData.mockImplementation(
      makeCheckoutDerivedFetchPrData(HEAD_BRANCH),
    );

    const map = await executePrSplit(buildExecOptions(harness));

    expect(harness.fetchPrData).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      undefined,
    );
    expect(map.status).toBe('completed');
  });

  it('resume completes even when the original PR was already closed: the map identity is authoritative and the open-PR requirement is skipped', async () => {
    // Prior run closed the original PR but its final map write failed, so on
    // resume re-detecting `map.originalHeadBranch` finds no open PR at all.
    // The map identity is authoritative, so the split still completes.
    const resumed = makeInitialMap({
      integrationPrNumber: 300,
      integrationPrUrl: 'https://github.com/o/r/pull/300',
      children: makeInitialMap().children.map((child, i) => ({
        ...child,
        worktreeId: `child-wt-${i + 1}`,
        carveCommitSha: HEAD_SHA,
        verifyStatus: 'green',
        prNumber: 201 + i,
        prUrl: `https://github.com/o/r/pull/${201 + i}`,
      })),
    });
    const harness = buildHarness({ existingMap: resumed });
    mockedGetCheckedOutBranch.mockResolvedValue(INTEGRATION_BRANCH);
    mockedDoesRemoteBranchExist.mockResolvedValue(true);
    // The original head branch no longer has ANY open/closed PR resolvable.
    harness.fetchPrData.mockResolvedValue({
      status: null,
      snapshot: null,
      branchName: HEAD_BRANCH,
      remote: { owner: 'o', repo: 'r' },
    });

    const map = await executePrSplit(buildExecOptions(harness));

    expect(map.status).toBe('completed');
    expect(harness.closePr).toHaveBeenCalledWith(
      ORIGINAL_WORKTREE_CWD,
      100,
      expect.any(String),
    );
  });
});

describe('executePrSplit worktree setup', () => {
  beforeEach(() => {
    setupHappyGitMocks();
  });

  it('runs setup for each child worktree before carving it', async () => {
    const harness = buildHarness();

    await executePrSplit(buildExecOptions(harness));

    // Setup ran once per created child worktree.
    const setupWorktreeIds = harness.runWorktreeSetup.mock.calls.map(
      (call) => call[0],
    );
    expect(setupWorktreeIds).toEqual(
      expect.arrayContaining([
        `wt-${CHILD1_BRANCH}`,
        `wt-${CHILD2_BRANCH}`,
        `wt-${CHILD3_BRANCH}`,
      ]),
    );

    // For each child, the running_setup progress event precedes carving_child.
    for (const idx of [1, 2, 3]) {
      const setupAt = harness.progress.findIndex(
        (e) => e.phase === 'running_setup' && e.childIndex === idx,
      );
      const carveAt = harness.progress.findIndex(
        (e) => e.phase === 'carving_child' && e.childIndex === idx,
      );
      expect(setupAt).toBeGreaterThanOrEqual(0);
      expect(carveAt).toBeGreaterThanOrEqual(0);
      expect(setupAt).toBeLessThan(carveAt);
    }
  });

  it('proceeds silently when setup is skipped (no setup script configured)', async () => {
    const harness = buildHarness();
    harness.runWorktreeSetup.mockResolvedValue({ status: 'skipped' });

    const map = await executePrSplit(buildExecOptions(harness));

    expect(map.status).toBe('completed');
    // No failure message emitted for a skipped setup.
    expect(
      harness.progress.some(
        (e) => e.phase === 'running_setup' && e.message !== undefined,
      ),
    ).toBe(false);
  });

  it('proceeds when setup completes', async () => {
    const harness = buildHarness();
    harness.runWorktreeSetup.mockResolvedValue({ status: 'completed' });

    const map = await executePrSplit(buildExecOptions(harness));

    expect(map.status).toBe('completed');
  });

  it('proceeds and emits a message when setup fails (does not hard-fail the split)', async () => {
    const harness = buildHarness();
    harness.runWorktreeSetup.mockResolvedValue({
      status: 'failed',
      detail: 'setup script exited with code 1',
    });

    const map = await executePrSplit(buildExecOptions(harness));

    // The split still completes; a setup failure does not stop it.
    expect(map.status).toBe('completed');
    // A progress message was emitted noting the setup failure.
    const failureMessage = harness.progress.find(
      (e) => e.phase === 'running_setup' && e.message !== undefined,
    );
    expect(failureMessage?.message).toMatch(/setup script failed/i);
    expect(failureMessage?.message).toContain('exited with code 1');
    // The carve/verify still ran for the first child.
    expect(harness.runVerifyCommand).toHaveBeenCalled();
  });

  it('honors an abort fired during setup: cancellation path, no carve', async () => {
    const controller = new AbortController();
    const harness = buildHarness();
    // The first child's setup aborts mid-run (as the real runner would when its
    // process group is killed) and reports failure.
    harness.runWorktreeSetup.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ status: 'failed', detail: 'aborted' });
    });

    const map = await executePrSplit(
      buildExecOptions(harness, { signal: controller.signal }),
    );

    expect(map.status).toBe('cancelled');
    // Setup ran, but the abort took precedence before any carve/verify.
    expect(harness.runWorktreeSetup).toHaveBeenCalledTimes(1);
    expect(harness.runVerifyCommand).not.toHaveBeenCalled();
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD1_BRANCH),
    ).toBe(false);
    expect(harness.progress.some((e) => e.phase === 'cancelled')).toBe(true);
  });

  it('runs setup before the standalone re-verify when a red-recorded child worktree was recreated this run', async () => {
    // A prior run stopped at child 1's red verify. On resume its worktree was
    // recreated (no HEAD match to the recorded carve sha here), but the map is
    // driven through the re-verify branch by matching the carve sha. Model the
    // survived-carve re-verify path: carve sha matches, verify was red.
    const resumed = makeInitialMap();
    const redChild = resumed.children[0];
    redChild.worktreeId = `wt-${CHILD1_BRANCH}`;
    redChild.carveCommitSha = 'child1-carve';
    redChild.verifyStatus = 'red';
    const harness = buildHarness({ existingMap: resumed });
    mockedIsBranchNameAvailable.mockImplementation((_repo, branch) =>
      Promise.resolve(branch !== INTEGRATION_BRANCH),
    );
    mockedResolveRefSha.mockImplementation((cwd) => {
      if (cwd === ORIGINAL_WORKTREE_CWD) {
        return Promise.resolve(HEAD_SHA);
      }
      if (cwd === `/tmp/wt-${CHILD1_BRANCH}`) {
        return Promise.resolve('child1-carve');
      }
      return Promise.resolve('same-sha');
    });
    harness.runVerifyCommand.mockResolvedValue({ exitCode: 0, tail: 'ok' });

    await executePrSplit(buildExecOptions(harness));

    // Setup ran for the re-verified child before its standalone verify.
    expect(harness.runWorktreeSetup).toHaveBeenCalledWith(
      `wt-${CHILD1_BRANCH}`,
      expect.anything(),
    );
    const setupAt = harness.progress.findIndex(
      (e) => e.phase === 'running_setup' && e.childIndex === 1,
    );
    const verifyAt = harness.progress.findIndex(
      (e) => e.phase === 'verifying_child' && e.childIndex === 1,
    );
    expect(setupAt).toBeGreaterThanOrEqual(0);
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(setupAt).toBeLessThan(verifyAt);
  });
});

describe('executePrSplit failure and cancellation', () => {
  beforeEach(() => {
    setupHappyGitMocks();
  });

  it('does not count adopted PRs and tolerates injected telemetry failures', async () => {
    const harness = buildHarness();
    harness.createPr.mockImplementation((_repo, branch) =>
      Promise.resolve({
        prNumber: 1,
        prUrl: `https://github.com/o/r/pull/${branch}`,
        created: false,
      }),
    );
    jest.mocked(recordGitCommitTelemetry).mockImplementationOnce(() => {
      throw new Error('telemetry');
    });
    await expect(
      executePrSplit(buildExecOptions(harness)),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
  });

  it('stops at the first red child: no PR for it and no integration PR', async () => {
    const harness = buildHarness({ verifyExit: 1 });

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow();

    // No child PR was opened (first child went red before push/PR).
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === CHILD1_BRANCH),
    ).toBe(false);
    // No integration PR.
    expect(
      harness.createPr.mock.calls.some((c) => c[1] === INTEGRATION_BRANCH),
    ).toBe(false);
    const lastWrite = harness.writes[harness.writes.length - 1];
    expect(lastWrite.status).toBe('failed');
    const redChild = lastWrite.children.find((c) => c.index === 1);
    expect(redChild?.verifyStatus).toBe('red');
    // The carve commit succeeded (only verify failed), so its sha is recorded
    // alongside the red status so a resume can re-verify instead of re-carving.
    expect(redChild?.carveCommitSha).toBe('commit-sha-abc');
    expect(recordGitCommitTelemetry).toHaveBeenCalledTimes(2);
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
    expect(harness.progress.some((e) => e.phase === 'error')).toBe(true);
  });

  it('cancels between children: status cancelled, no further createPr, map returned', async () => {
    const controller = new AbortController();
    const harness = buildHarness();
    // Abort right after the first child PR is opened.
    harness.createPr.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({
        prNumber: 201,
        prUrl: 'https://github.com/o/r/pull/201',
        created: true,
      });
    });

    const map = await executePrSplit(
      buildExecOptions(harness, { signal: controller.signal }),
    );

    expect(map.status).toBe('cancelled');
    // Only the first child PR was created; no second child, no integration PR.
    expect(harness.createPr).toHaveBeenCalledTimes(1);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(1);
    expect(recordGitCommitTelemetry).toHaveBeenCalledTimes(2);
    expect(harness.progress.some((e) => e.phase === 'cancelled')).toBe(true);
  });

  it('fails before the integration PR when the reconstructed tip tree drifts', async () => {
    const harness = buildHarness();
    mockedGetTreeSha.mockImplementation((_repo, ref) =>
      Promise.resolve(ref === HEAD_SHA ? 'tree-A' : 'tree-B'),
    );

    await expect(executePrSplit(buildExecOptions(harness))).rejects.toThrow(
      /reconstruct|tip|tree|drift/i,
    );

    expect(
      harness.createPr.mock.calls.some((c) => c[1] === INTEGRATION_BRANCH),
    ).toBe(false);
    // Temp worktree still cleaned up.
    expect(mockedRemoveGitWorktree).toHaveBeenCalled();
    const lastWrite = harness.writes[harness.writes.length - 1];
    expect(lastWrite.status).toBe('failed');
  });
});

describe('executePrSplit server-side re-validation', () => {
  beforeEach(() => {
    setupHappyGitMocks();
  });

  it('rejects an invalid edited plan using the real validateSplitPlan (unassigned hunk)', async () => {
    const harness = buildHarness();
    // Use the REAL validateSplitPlan (pr-split-plan is not mocked in this file)
    // rather than the passthrough, so this exercises genuine server-side
    // re-validation of the edited plan.
    harness.deps.validatePlan = validateSplitPlan;

    // Snapshot has a file/hunk that no child claims → unassigned-hunk error.
    const snapshot: PrDiffSnapshot = {
      baseRef: 'base-sha',
      headRef: HEAD_SHA,
      files: [
        {
          path: 'src/orphan.ts',
          kind: 'modified',
          isBinary: false,
          additions: 1,
          deletions: 0,
          hunks: [],
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
    };
    const plan: SplitPlan = {
      finalGoal: 'g',
      concerns: [],
      children: [
        {
          index: 1,
          title: 'refactor: x',
          type: 'refactor',
          dependsOn: [],
          changes: [],
          renames: [],
          testProof: 't',
          risk: 'low',
          rationale: '',
        },
      ],
      parallelizable: '',
      landOrder: '',
      buildTestCommand: '',
      unassignedHunks: [],
    };

    await expect(
      executePrSplit(buildExecOptions(harness, { plan, snapshot })),
    ).rejects.toThrow(/invalid|validat/i);
    expect(harness.createPr).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Verify runner: platform-appropriate shell + env allowlist
// ---------------------------------------------------------------------------

describe('resolveVerifyShellSpec', () => {
  const originalPlatform = process.platform;
  const savedEnv = { ...process.env };
  const mockFindExecutableOnPath = jest.mocked(findExecutableOnPath);

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    process.env = { ...savedEnv };
    mockFindExecutableOnPath.mockReset();
    mockFindExecutableOnPath.mockImplementation(
      (name: string) => `C:\\Windows\\System32\\${name}`,
    );
  });

  it('uses /bin/sh -c on POSIX', () => {
    setPlatform('darwin');
    expect(resolveVerifyShellSpec('npm ci && npm test')).toEqual({
      file: '/bin/sh',
      args: ['-c', 'npm ci && npm test'],
    });
  });

  it('uses pwsh.exe -NoProfile -NonInteractive -Command when pwsh is on PATH (win32)', () => {
    setPlatform('win32');
    mockFindExecutableOnPath.mockImplementation((name: string) =>
      name === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null,
    );
    const spec = resolveVerifyShellSpec('npm ci && npm test');
    expect(mockFindExecutableOnPath).toHaveBeenCalledWith('pwsh.exe');
    expect(spec).toEqual({
      file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'npm ci && npm test'],
    });
  });

  it('never routes through powershell.exe (PS5.1 && parse-error risk) on win32', () => {
    setPlatform('win32');
    mockFindExecutableOnPath.mockImplementation((name: string) =>
      name === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null,
    );
    const spec = resolveVerifyShellSpec('npm ci && npm test');
    expect(spec.file).not.toMatch(/powershell\.exe$/i);
    expect(mockFindExecutableOnPath).not.toHaveBeenCalledWith('powershell.exe');
  });

  it('falls back to cmd.exe /d /s /c with a single verbatim wrapped arg when pwsh is absent from PATH (win32)', () => {
    setPlatform('win32');
    delete process.env.ComSpec;
    mockFindExecutableOnPath.mockImplementation(() => null);
    const spec = resolveVerifyShellSpec('npm ci && npm test');
    expect(mockFindExecutableOnPath).toHaveBeenCalledWith('pwsh.exe');
    expect(spec).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '"npm ci && npm test"'],
      windowsVerbatimArguments: true,
    });
  });

  it('honors ComSpec for the cmd.exe fallback when pwsh is absent (win32)', () => {
    setPlatform('win32');
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    mockFindExecutableOnPath.mockImplementation(() => null);
    const spec = resolveVerifyShellSpec('npm test');
    expect(spec).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"npm test"'],
      windowsVerbatimArguments: true,
    });
  });

  it('does not set windowsVerbatimArguments on the pwsh branch (win32)', () => {
    setPlatform('win32');
    mockFindExecutableOnPath.mockImplementation((name: string) =>
      name === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null,
    );
    const spec = resolveVerifyShellSpec('npm test');
    expect(spec.windowsVerbatimArguments).toBeUndefined();
  });

  it('does not set windowsVerbatimArguments on POSIX', () => {
    setPlatform('darwin');
    const spec = resolveVerifyShellSpec('npm test');
    expect(spec.windowsVerbatimArguments).toBeUndefined();
  });

  it('rejects a % -containing command on the cmd.exe fallback branch (win32)', () => {
    setPlatform('win32');
    mockFindExecutableOnPath.mockImplementation(() => null);
    expect(() => resolveVerifyShellSpec('echo %PATH%')).toThrow(/%/);
  });

  it('rejects a newline-containing command on the cmd.exe fallback branch (win32)', () => {
    setPlatform('win32');
    mockFindExecutableOnPath.mockImplementation(() => null);
    expect(() => resolveVerifyShellSpec('npm ci\nnpm test')).toThrow(
      /newline/i,
    );
  });

  it('does not reject a % -containing command on the pwsh branch (win32)', () => {
    setPlatform('win32');
    mockFindExecutableOnPath.mockImplementation((name: string) =>
      name === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null,
    );
    expect(() => resolveVerifyShellSpec('echo %PATH%')).not.toThrow();
  });

  it('does not reject a % -containing command on POSIX', () => {
    setPlatform('darwin');
    expect(() => resolveVerifyShellSpec('echo %PATH%')).not.toThrow();
  });
});

describe('buildVerifyEnv', () => {
  const originalPlatform = process.platform;
  const savedEnv = { ...process.env };

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    process.env = { ...savedEnv };
  });

  it('POSIX: allowlists PATH + HOME/TMPDIR/LANG and nothing else', () => {
    setPlatform('darwin');
    process.env = {
      HOME: '/Users/dev',
      TMPDIR: '/tmp/dev',
      LANG: 'en_US.UTF-8',
      // Must never leak into the allowlist:
      SECRET_TOKEN: 'nope',
      SystemRoot: 'C:\\Windows',
    };
    const env = buildVerifyEnv();
    expect(env).toEqual({
      PATH: '/resolved/bin:/usr/bin',
      HOME: '/Users/dev',
      TMPDIR: '/tmp/dev',
      LANG: 'en_US.UTF-8',
    });
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.SystemRoot).toBeUndefined();
  });

  it('win32: allowlists SystemRoot/ComSpec/PATHEXT/TEMP and other Windows vars when present', () => {
    setPlatform('win32');
    process.env = {
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\dev',
      TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
      // Must never leak:
      SECRET_TOKEN: 'nope',
      RANDOM_VAR: 'leak',
    };
    const env = buildVerifyEnv();
    expect(env.PATH).toBe('/resolved/bin:/usr/bin');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');
    expect(env.TEMP).toBe('C:\\Users\\dev\\AppData\\Local\\Temp');
    expect(env.USERPROFILE).toBe('C:\\Users\\dev');
    // Unlisted vars never leak.
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
    // POSIX-only keys are not synthesized on Windows.
    expect(env.HOME).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
  });

  it('win32: omits allowlisted keys that are absent from process.env', () => {
    setPlatform('win32');
    process.env = {
      SystemRoot: 'C:\\Windows',
      // ComSpec/PATHEXT/TEMP intentionally absent.
    };
    const env = buildVerifyEnv();
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect('ComSpec' in env).toBe(false);
    expect('PATHEXT' in env).toBe(false);
    expect('TEMP' in env).toBe(false);
  });
});

describe('buildDefaultSplitterDeps sidebar notifications', () => {
  const mockedCreate = jest.mocked(createSingleRepoWorktree);
  const mockedUpdate = jest.mocked(updateWorkspaceWorktree);
  const mockedSend = jest.mocked(sendToWindow);
  // The split engine writes worktrees.json entirely main-side; a real
  // BrowserWindow is unnecessary because `sendToWindow` is mocked and only its
  // captured arguments are asserted.
  const fakeWindow = { id: 7 } as unknown as BrowserWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUpdate.mockResolvedValue(true);
  });

  it('broadcasts workspaceWorktreesUpdated after creating a split child worktree', async () => {
    mockedCreate.mockResolvedValue({
      id: 'child-1',
      branchName: 'split/01-a',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const deps = buildDefaultSplitterDeps('ws-1', 'wt-orig', () => fakeWindow);

    const created = await deps.createWorktree({
      workspaceId: 'ws-1',
      branchName: 'split/01-a',
      baseBranch: 'main',
      startPostCreateSetup: true,
    });

    expect(created.id).toBe('child-1');
    expect(mockedSend).toHaveBeenCalledWith(
      fakeWindow,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1' },
    );
  });

  it('broadcasts workspaceWorktreesUpdated after grouping and after retargeting the original', async () => {
    const deps = buildDefaultSplitterDeps('ws-1', 'wt-orig', () => fakeWindow);

    await deps.setWorktreeGrouping('ws-1', 'child-1');
    await deps.updateOriginalWorktree('ws-1', 'wt-orig', {
      branchName: 'integration/pr-42',
      trackedBaseBranch: 'main',
    });

    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(mockedSend).toHaveBeenNthCalledWith(
      1,
      fakeWindow,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1' },
    );
    expect(mockedSend).toHaveBeenNthCalledWith(
      2,
      fakeWindow,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1' },
    );
  });

  it('records grouping and retarget through the Git observation, keeping rows already in that state', async () => {
    const deps = buildDefaultSplitterDeps('ws-1', 'wt-orig', () => fakeWindow);

    await deps.setWorktreeGrouping('ws-1', 'child-1');
    await deps.updateOriginalWorktree('ws-1', 'wt-orig', {
      branchName: 'integration/pr-42',
      trackedBaseBranch: 'main',
    });

    const grouped = {
      id: 'child-1',
      branchName: 'split/01-a',
      createdAt: '2026-07-01T00:00:00.000Z',
      branchGroupingOverride: 'group' as const,
    };
    const retargeted = {
      id: 'wt-orig',
      branchName: 'integration/pr-42',
      createdAt: '2026-07-01T00:00:00.000Z',
      trackedBaseBranch: 'main',
    };
    // The same row back is the persistence layer's "no write".
    expect(mockedUpdate.mock.calls[0]?.[2](grouped)).toBe(grouped);
    expect(mockedUpdate.mock.calls[1]?.[2](retargeted)).toBe(retargeted);
  });

  it('does not broadcast when no window is available', async () => {
    mockedCreate.mockResolvedValue({
      id: 'child-1',
      branchName: 'split/01-a',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const deps = buildDefaultSplitterDeps('ws-1', 'wt-orig', () => null);

    await deps.createWorktree({
      workspaceId: 'ws-1',
      branchName: 'split/01-a',
      baseBranch: 'main',
      startPostCreateSetup: true,
    });

    expect(mockedSend).not.toHaveBeenCalled();
  });
});
