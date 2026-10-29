import {
  registerWorktreePrActions,
  runWorktreePrAction,
} from '../pr-worktree-actions';

const target = { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' };
const createIdentity = {
  expectedBaseBranch: 'develop',
  expectedHeadBranch: 'feature',
};
const mergeIdentity = { ...createIdentity, expectedPrNumber: 42 };
const repo = {
  repoId: 'repo-1',
  repoName: 'Repo',
  status: { number: 42 },
  baseBranch: 'develop',
  headBranch: 'feature',
  canCreate: true,
  canMerge: false,
  mergeWarning: false,
};
const state = jest.fn();
const create = jest.fn();
const merge = jest.fn();

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: Error) => void;
} {
  let rejectDeferred: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((_, reject) => {
    rejectDeferred = reject;
  });
  if (!rejectDeferred) {
    throw new Error('Expected deferred rejection handler to be assigned');
  }
  return { promise, reject: rejectDeferred };
}

beforeEach(() => {
  jest.resetAllMocks();
  state.mockResolvedValue({ busy: false, repos: [repo] });
  create.mockResolvedValue({
    repos: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
      },
    ],
    skippedRepos: [],
    localOnlyCommittedRepos: [],
  });
  merge.mockResolvedValue({
    requiresUnresolvedConfirmation: [],
    mergedRepos: [],
    failedRepos: [],
  });
  registerWorktreePrActions({ state, create, merge });
});

it('creates only the explicitly selected eligible repository through the desktop operation', async () => {
  await runWorktreePrAction({
    ...target,
    ...createIdentity,
    action: 'create_auto',
    repoIds: ['repo-1'],
  });
  expect(create).toHaveBeenCalledWith({
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    repoIds: ['repo-1'],
    expectedBaseBranch: 'develop',
    expectedHeadBranch: 'feature',
  });
});

it('surfaces a selected create failure represented by an empty aggregate result', async () => {
  create.mockResolvedValueOnce({
    repos: [],
    skippedRepos: [],
    localOnlyCommittedRepos: [],
  });
  await expect(
    runWorktreePrAction({
      ...target,
      ...createIdentity,
      action: 'create_auto',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow('Pull request creation failed');
});

it.each([undefined, [], ['repo-1', 'other'], ['unknown']])(
  'rejects absent, broad or stale repo selection: %j',
  async (repoIds) => {
    await expect(
      runWorktreePrAction({
        ...target,
        ...createIdentity,
        action: 'create_auto',
        repoIds,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it('does not merge when fresh eligibility no longer permits it', async () => {
  await expect(
    runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow('PR state changed');
  expect(merge).not.toHaveBeenCalled();
});

it('preserves the unresolved-thread confirmation round trip', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, canMerge: true }],
  });
  const confirmation = {
    requiresUnresolvedConfirmation: [
      { repoId: 'repo-1', unresolvedReviewThreadCount: 2 },
    ],
    mergedRepos: [],
    failedRepos: [],
  };
  merge.mockResolvedValueOnce(confirmation).mockResolvedValueOnce({
    requiresUnresolvedConfirmation: [],
    mergedRepos: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
      },
    ],
    failedRepos: [],
  });
  expect(
    await runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
    }),
  ).toEqual(confirmation);
  expect(merge).toHaveBeenLastCalledWith(
    expect.objectContaining({
      confirmUnresolvedComments: false,
      expectedBaseBranch: 'develop',
      expectedHeadBranch: 'feature',
      expectedPrNumber: 42,
    }),
  );
  await runWorktreePrAction({
    ...target,
    ...mergeIdentity,
    action: 'merge',
    repoIds: ['repo-1'],
    confirmUnresolvedComments: true,
  });
  expect(merge).toHaveBeenLastCalledWith(
    expect.objectContaining({ confirmUnresolvedComments: true }),
  );
});

it('surfaces a fresh merge refusal instead of reporting success', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, canMerge: true }],
  });
  merge.mockResolvedValueOnce({
    verifiedRepos: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        mergeable: false,
        blockedReason: 'base_changed',
      },
    ],
    requiresUnresolvedConfirmation: [],
    mergedRepos: [],
    failedRepos: [],
  });

  await expect(
    runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow('base branch changed during verification');
});

it('reports a merge queue enqueue as success', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, canMerge: true }],
  });
  const enqueued = {
    verifiedRepos: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        mergeable: true,
      },
    ],
    requiresUnresolvedConfirmation: [],
    mergedRepos: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        mergeMethod: 'merge',
        mergeCommitSha: null,
        status: 'enqueued',
        queuePosition: 3,
      },
    ],
    failedRepos: [],
  };
  merge.mockResolvedValueOnce(enqueued);

  await expect(
    runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
    }),
  ).resolves.toEqual(enqueued);
});

it('explains a refusal for a PR already in the merge queue', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, canMerge: true }],
  });
  merge.mockResolvedValueOnce({
    verifiedRepos: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        mergeable: false,
        blockedReason: 'in_merge_queue',
      },
    ],
    requiresUnresolvedConfirmation: [],
    mergedRepos: [],
    failedRepos: [],
  });

  await expect(
    runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow(/^This pull request is already in the merge queue\.$/);
});

it('surfaces a stale merge that completes without an outcome', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, canMerge: true }],
  });

  await expect(
    runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow('Pull request merge failed');
});

it('disables simultaneous commands and releases the lock after failure', async () => {
  const failure = createDeferred<never>();
  create.mockImplementationOnce(() => failure.promise);
  const first = runWorktreePrAction({
    ...target,
    ...createIdentity,
    action: 'create_auto',
    repoIds: ['repo-1'],
  });
  await Promise.resolve();
  expect(
    await runWorktreePrAction({ ...target, action: 'get_actions' }),
  ).toEqual(expect.objectContaining({ busy: true }));
  await expect(
    runWorktreePrAction({
      ...target,
      ...createIdentity,
      action: 'create_auto',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow('already running');
  failure.reject(new Error('GitHub unavailable'));
  await expect(first).rejects.toThrow('GitHub unavailable');
  await expect(
    runWorktreePrAction({
      ...target,
      ...createIdentity,
      action: 'create_auto',
      repoIds: ['repo-1'],
    }),
  ).resolves.toBeDefined();
});

it('respects a merge or create already started from desktop', async () => {
  state.mockResolvedValue({ busy: true, repos: [repo] });
  await expect(
    runWorktreePrAction({
      ...target,
      ...createIdentity,
      action: 'create_auto',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow('already running');
  expect(create).not.toHaveBeenCalled();
});

it('rejects create when the displayed branch identity is stale', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, headBranch: 'different-feature' }],
  });

  await expect(
    runWorktreePrAction({
      ...target,
      ...createIdentity,
      action: 'create_auto',
      repoIds: ['repo-1'],
    }),
  ).rejects.toThrow('PR state changed');
  expect(create).not.toHaveBeenCalled();
});

it('rejects merge confirmation when the displayed pull request is stale', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, status: { number: 43 }, canMerge: true }],
  });

  await expect(
    runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
      confirmUnresolvedComments: true,
    }),
  ).rejects.toThrow('PR state changed');
  expect(merge).not.toHaveBeenCalled();
});

it('passes through merge queue handoffs without claiming a merge', async () => {
  state.mockResolvedValue({
    busy: false,
    repos: [{ ...repo, canMerge: true }],
  });
  const result = {
    dryRun: false,
    verifiedRepos: [],
    mergedRepos: [],
    requiresUnresolvedConfirmation: [],
    failedRepos: [],
    mergeQueueChats: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        chatId: 'queue-chat',
      },
    ],
  };
  merge.mockResolvedValueOnce(result);
  await expect(
    runWorktreePrAction({
      ...target,
      ...mergeIdentity,
      action: 'merge',
      repoIds: ['repo-1'],
    }),
  ).resolves.toEqual(result);
});
