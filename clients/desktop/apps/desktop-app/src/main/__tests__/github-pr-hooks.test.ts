jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/tmp/canopy-github-pr-hooks-test'),
}));

const recordUsageMetricEventMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordUsageMetricEvent: recordUsageMetricEventMock,
  })),
}));

import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HookTriggerName } from '@canopy/desktop-shared/hooks';
import type {
  GitHubCheckSnapshot,
  GitHubIssueCommentSnapshot,
  GitHubReviewSnapshot,
  PersistedPrSnapshotFileV1,
  PrMergeQueueMembership,
  PrMergeQueueTimelineEvent,
} from '@canopy/desktop-shared/types/github';
import {
  advancePrTrackingState,
  deletePrTrackingState,
  findTrackedPrSnapshot,
  readCurrentPrTrackingSnapshot,
  resetPrPreviewIndexForTests,
} from '../lib/github-pr-hook-state';
import { getGitHubPrStateDir } from '../lib/paths';

describe('tracked PR preview projection', () => {
  it.each(['advance', 'delete'] as const)(
    'retains active directory ownership across writer %s invalidation',
    async (operation) => {
      const fs = jest.requireActual<typeof Fs>('node:fs/promises');
      let reject: (error: Error) => void = (): void => undefined;
      const held = new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
      const read = jest.spyOn(fs, 'readdir').mockImplementation(() => held);
      const location = (
        index: number,
      ): { projectId: string; worktreeId: string } => ({
        projectId: 'preview-project',
        worktreeId: `invalidation-${index}`,
      });
      const target = { owner: 'acme', repository: 'repo', number: 91 };
      jest.useFakeTimers();
      const lookups = Array.from({ length: 500 }, (_, index) =>
        findTrackedPrSnapshot(target, 'scope-a', [location(index)]),
      );
      try {
        await jest.advanceTimersByTimeAsync(501);
        expect(read).toHaveBeenCalledTimes(500);
        for (let revision = 0; revision < 2; revision += 1) {
          const writer = {
            projectId: 'preview-project',
            worktreeId: 'writer',
            repoStorageKey: 'project-root',
          };
          if (operation === 'advance') {
            await advancePrTrackingState({
              ...writer,
              branchName: `revision-${revision}`,
              currentSnapshot: buildSnapshot({ credentialScope: 'scope-a' }),
            });
          } else {
            await deletePrTrackingState(writer);
          }
          lookups.push(
            findTrackedPrSnapshot(target, 'scope-a', [location(0)]),
            findTrackedPrSnapshot(target, 'scope-a', [
              location(500 + revision),
            ]),
          );
          await jest.advanceTimersByTimeAsync(501);
          expect(read).toHaveBeenCalledTimes(500);
        }
        expect(
          (await Promise.all(lookups)).every((value) => value === null),
        ).toBe(true);
      } finally {
        reject(
          Object.assign(new Error('release directories'), { code: 'EIO' }),
        );
        await jest.advanceTimersByTimeAsync(0);
        await Promise.all(lookups);
        read.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  it('bounds outstanding uncancellable directory reads instead of evicting active reads', async () => {
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    let reject: (error: Error) => void = (): void => undefined;
    const held = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const read = jest.spyOn(fs, 'readdir').mockImplementation(() => held);
    jest.useFakeTimers();
    const lookups = Array.from({ length: 501 }, (_, index) =>
      findTrackedPrSnapshot(
        { owner: 'acme', repository: 'repo', number: 42 },
        'scope-a',
        [
          {
            projectId: 'preview-project',
            worktreeId: `concurrent-directory-${index}`,
          },
        ],
      ),
    );
    try {
      await jest.advanceTimersByTimeAsync(501);
      expect(
        (await Promise.all(lookups)).every((value) => value === null),
      ).toBe(true);
      expect(read).toHaveBeenCalledTimes(500);
    } finally {
      reject(
        Object.assign(new Error('released pending directories'), {
          code: 'EIO',
        }),
      );
      await jest.advanceTimersByTimeAsync(0);
      await Promise.all(lookups);
      read.mockRestore();
      jest.useRealTimers();
    }
  });

  it('shares an uncancellable directory read across timed-out retries and recovers after it fails', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'held-directory',
    };
    await advancePrTrackingState({
      ...location,
      repoStorageKey: 'project-root',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({ credentialScope: 'scope-a' }),
    });
    resetPrPreviewIndexForTests();
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    let reject: (error: Error) => void = (): void => undefined;
    const held = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const read = jest.spyOn(fs, 'readdir').mockImplementationOnce(() => held);
    const target = { owner: 'acme', repository: 'repo', number: 42 };
    jest.useFakeTimers();
    try {
      const first = findTrackedPrSnapshot(target, 'scope-a', [location]);
      await jest.advanceTimersByTimeAsync(501);
      expect(await first).toBeNull();
      const second = findTrackedPrSnapshot(target, 'scope-a', [location]);
      await jest.advanceTimersByTimeAsync(501);
      expect(await second).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
      reject(
        Object.assign(new Error('directory recovered after failure'), {
          code: 'EIO',
        }),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toMatchObject({ pr: { number: 42 } });
    } finally {
      reject(new Error('release held directory'));
      await jest.advanceTimersByTimeAsync(0);
      read.mockRestore();
      jest.useRealTimers();
    }
  });

  it('retries a transient snapshot read error instead of retaining a null hint', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'transient-file',
      repoStorageKey: 'project-root',
    };
    await advancePrTrackingState({
      ...location,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({ credentialScope: 'scope-a' }),
    });
    resetPrPreviewIndexForTests();
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    const read = jest.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('temporary snapshot I/O error'), {
        code: 'EIO',
      }),
    );
    const target = { owner: 'acme', repository: 'repo', number: 42 };
    try {
      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toBeNull();
      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toMatchObject({ pr: { number: 42 } });
    } finally {
      read.mockRestore();
    }
  });

  it('retries a transient directory error instead of caching a permanent miss', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'transient-directory',
    };
    await advancePrTrackingState({
      ...location,
      repoStorageKey: 'project-root',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({ credentialScope: 'scope-a' }),
    });
    resetPrPreviewIndexForTests();
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    const read = jest
      .spyOn(fs, 'readdir')
      .mockRejectedValueOnce(
        Object.assign(new Error('temporarily unavailable'), { code: 'EIO' }),
      );
    const target = { owner: 'acme', repository: 'repo', number: 42 };
    try {
      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toBeNull();
      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toMatchObject({ pr: { number: 42 } });
    } finally {
      read.mockRestore();
    }
  });

  it('releases a held cold read and starts no later reads after its deadline', async () => {
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    let release: (value: Buffer) => void = (): void => undefined;
    const held = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const read = jest.spyOn(fs, 'readFile').mockImplementationOnce(() => held);
    jest.useFakeTimers();
    const locations = ['held', 'after-held'].map((worktreeId) => ({
      projectId: 'preview-project',
      worktreeId,
      repoStorageKey: 'project-root',
    }));
    let settled = false;
    const pending = findTrackedPrSnapshot(
      { owner: 'acme', repository: 'repo', number: 42 },
      'scope-a',
      locations,
    ).then((value) => {
      settled = true;
      return value;
    });
    try {
      await jest.advanceTimersByTimeAsync(1001);
      expect(settled).toBe(true);
      expect(await pending).toBeNull();
    } finally {
      release(Buffer.from('null'));
      await pending;
      await jest.advanceTimersByTimeAsync(0);
      try {
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        read.mockRestore();
        jest.useRealTimers();
      }
    }
  });

  it('bounds oversized cold inventories before starting filesystem reads', async () => {
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    const read = jest
      .spyOn(fs, 'readFile')
      .mockImplementation(() => Promise.resolve(Buffer.from('null')));
    const locations = Array.from({ length: 1025 }, (_, index) => ({
      projectId: 'preview-project',
      worktreeId: `large-${index}`,
      repoStorageKey: 'project-root',
    }));
    try {
      expect(
        await findTrackedPrSnapshot(
          { owner: 'acme', repository: 'repo', number: 42 },
          'scope-a',
          locations,
        ),
      ).toBeNull();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('keeps accepted writer hints usable above the cold inventory limit', async () => {
    const locations = Array.from({ length: 1025 }, (_, index) => ({
      projectId: 'preview-project',
      worktreeId: `warm-large-${index}`,
      repoStorageKey: 'project-root',
    }));
    const location = locations[1024];
    if (!location) throw new Error('Expected final tracked location');
    await advancePrTrackingState({
      ...location,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({ credentialScope: 'scope-a' }),
    });
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    const read = jest.spyOn(fs, 'readFile');
    try {
      expect(
        await findTrackedPrSnapshot(
          { owner: 'acme', repository: 'repo', number: 42 },
          'scope-a',
          locations,
        ),
      ).toMatchObject({ pr: { number: 42 } });
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  it('does not let a delayed cold read replace an accepted writer snapshot', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'writer-race',
      repoStorageKey: 'project-root',
    };
    const old = buildSnapshot({
      credentialScope: 'scope-old',
      capturedAt: '2026-10-13T12:00:00Z',
    });
    await advancePrTrackingState({
      ...location,
      branchName: 'feature-1',
      currentSnapshot: old,
    });
    resetPrPreviewIndexForTests();
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    let release: (value: Buffer) => void = (): void => undefined;
    const held = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const read = jest.spyOn(fs, 'readFile').mockImplementationOnce(() => held);
    const query = { owner: 'acme', repository: 'repo', number: 42 };
    const pending = findTrackedPrSnapshot(query, 'scope-old', [location]);
    try {
      await advancePrTrackingState({
        ...location,
        branchName: 'feature-1',
        currentSnapshot: buildSnapshot({
          credentialScope: 'scope-new',
          capturedAt: '2026-10-13T12:01:00Z',
          pr: { ...old.pr, title: 'Accepted latest' },
        }),
      });
      release(Buffer.from(JSON.stringify(old)));
      expect(await pending).toBeNull();
      expect(
        await findTrackedPrSnapshot(query, 'scope-new', [location]),
      ).toMatchObject({
        credentialScope: 'scope-new',
        pr: { title: 'Accepted latest' },
      });
    } finally {
      release(Buffer.from(JSON.stringify(old)));
      await pending;
      read.mockRestore();
    }
  });

  it('shares the completed cold scan across concurrent repository lookups', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'cold-worktree',
    };
    for (const [repoStorageKey, number] of [
      ['first', 42],
      ['second', 43],
    ] as const) {
      await advancePrTrackingState({
        ...location,
        repoStorageKey,
        branchName: 'feature-1',
        currentSnapshot: buildSnapshot({
          credentialScope: 'scope-a',
          capturedAt: new Date().toISOString(),
          pr: { ...buildSnapshot().pr, number },
        }),
      });
    }
    resetPrPreviewIndexForTests();
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    const readdirSpy = jest.spyOn(fs, 'readdir');
    try {
      const results = await Promise.all(
        [42, 43].map((number) =>
          findTrackedPrSnapshot(
            { owner: 'acme', repository: 'repo', number },
            'scope-a',
            [location],
          ),
        ),
      );
      expect(results.map((snapshot) => snapshot?.pr.number)).toEqual([42, 43]);
      expect(readdirSpy).toHaveBeenCalledTimes(1);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('uses the warmed location index for a distinct PR without rereading other snapshots', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'warm-distinct-reference',
    };
    for (const [repoStorageKey, number] of [
      ['first', 42],
      ['second', 43],
    ] as const) {
      await advancePrTrackingState({
        ...location,
        repoStorageKey,
        branchName: 'feature-1',
        currentSnapshot: buildSnapshot({
          credentialScope: 'scope-a',
          capturedAt: '2026-10-13T12:00:00Z',
          pr: { ...buildSnapshot().pr, number },
        }),
      });
    }
    resetPrPreviewIndexForTests();
    expect(
      await findTrackedPrSnapshot(
        { owner: 'acme', repository: 'repo', number: 42 },
        'scope-a',
        [location],
      ),
    ).toMatchObject({ pr: { number: 42 } });

    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    const readSpy = jest.spyOn(fs, 'readFile');
    const readdirSpy = jest.spyOn(fs, 'readdir');
    try {
      expect(
        await findTrackedPrSnapshot(
          { owner: 'acme', repository: 'repo', number: 43 },
          'scope-a',
          [location],
        ),
      ).toMatchObject({ pr: { number: 43 } });
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it('finds a snapshot in the 501st eligible worktree location', async () => {
    const locations = Array.from({ length: 501 }, (_, index) => ({
      projectId: 'preview-project',
      worktreeId: `eligible-${index}`,
      repoStorageKey: 'project-root',
    }));
    const last = locations[500];
    if (!last) throw new Error('Expected a 501st worktree location');
    await advancePrTrackingState({
      ...last,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        credentialScope: 'scope-a',
        capturedAt: '2026-10-13T12:00:00Z',
      }),
    });
    resetPrPreviewIndexForTests();

    expect(
      await findTrackedPrSnapshot(
        { owner: 'acme', repository: 'repo', number: 42 },
        'scope-a',
        locations,
      ),
    ).toMatchObject({ credentialScope: 'scope-a', pr: { number: 42 } });
  });

  it('finds a cold snapshot beyond the first 20 repository directories', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'many-repositories',
    };
    const keys = Array.from({ length: 32 }, (_, index) => `repo-${index}`);
    await Promise.all(
      keys.map((repoStorageKey) =>
        mkdir(
          getGitHubPrStateDir(
            location.projectId,
            location.worktreeId,
            repoStorageKey,
          ),
          { recursive: true },
        ),
      ),
    );
    const repositoryRoot = dirname(
      getGitHubPrStateDir(location.projectId, location.worktreeId, 'repo-0'),
    );
    const actualOrder = (await readdir(repositoryRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const targetKey = actualOrder[25];
    if (!targetKey) {
      throw new Error('Expected at least 26 repository directories');
    }
    await advancePrTrackingState({
      ...location,
      repoStorageKey: targetKey,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        credentialScope: 'scope-a',
        capturedAt: '2026-10-13T12:00:00Z',
      }),
    });
    resetPrPreviewIndexForTests();

    expect(
      await findTrackedPrSnapshot(
        { owner: 'acme', repository: 'repo', number: 42 },
        'scope-a',
        [location],
      ),
    ).toMatchObject({ credentialScope: 'scope-a', pr: { number: 42 } });
  });

  it('recovers an existing snapshot after more than 500 later locations evict it', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'evicted-repository',
    };
    const target = { owner: 'acme', repository: 'repo', number: 42 };
    await advancePrTrackingState({
      ...location,
      repoStorageKey: 'original',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        credentialScope: 'scope-a',
        capturedAt: '2026-10-13T12:00:00Z',
      }),
    });
    resetPrPreviewIndexForTests();
    expect(
      await findTrackedPrSnapshot(target, 'scope-a', [location]),
    ).toMatchObject({ pr: { number: 42 } });

    for (let start = 0; start < 500; start += 25) {
      await Promise.all(
        Array.from({ length: 25 }, (_, offset) => {
          const index = start + offset;
          return advancePrTrackingState({
            ...location,
            repoStorageKey: `later-${index}`,
            branchName: 'feature-1',
            currentSnapshot: buildSnapshot({
              credentialScope: 'scope-a',
              capturedAt: '2026-10-13T12:01:00Z',
              pr: {
                ...buildSnapshot().pr,
                id: 101 + index,
                number: 43 + index,
              },
            }),
          });
        }),
      );
    }

    expect(
      await findTrackedPrSnapshot(target, 'scope-a', [location]),
    ).toMatchObject({
      credentialScope: 'scope-a',
      pr: { number: 42 },
    });
  });

  it('caches a scoped miss until a hook writer advances the snapshots', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'negative-lookup',
    };
    const target = { owner: 'acme', repository: 'repo', number: 42 };
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    const readdirSpy = jest.spyOn(fs, 'readdir');
    try {
      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toBeNull();
      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toBeNull();
      expect(readdirSpy).toHaveBeenCalledTimes(1);

      await advancePrTrackingState({
        ...location,
        repoStorageKey: 'project-root',
        branchName: 'feature-1',
        currentSnapshot: buildSnapshot({ credentialScope: 'scope-a' }),
      });

      expect(
        await findTrackedPrSnapshot(target, 'scope-a', [location]),
      ).toMatchObject({ pr: { number: 42 } });
      expect(readdirSpy).toHaveBeenCalledTimes(1);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('locates exact repository and number only for the fetching credential', async () => {
    const location = {
      projectId: 'preview-project',
      worktreeId: 'preview-worktree',
      repoStorageKey: 'project-root',
    };
    await advancePrTrackingState({
      ...location,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        capturedAt: new Date().toISOString(),
        credentialScope: 'scope-a',
      }),
    });
    const query = { owner: 'acme', repository: 'repo', number: 42 };
    expect(
      await findTrackedPrSnapshot(query, 'scope-a', [location]),
    ).toMatchObject({ pr: { number: 42 }, credentialScope: 'scope-a' });
    expect(
      await findTrackedPrSnapshot(query, 'scope-b', [location]),
    ).toBeNull();
    expect(
      await findTrackedPrSnapshot(
        { ...query, repository: 'other' },
        'scope-a',
        [location],
      ),
    ).toBeNull();
  });

  it('ignores legacy unscoped files and chooses the newest duplicate', async () => {
    const first = {
      projectId: 'preview-project',
      worktreeId: 'preview-one',
      repoStorageKey: 'project-root',
    };
    const second = { ...first, worktreeId: 'preview-two' };
    const query = { owner: 'acme', repository: 'repo', number: 42 };
    await advancePrTrackingState({
      ...first,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        capturedAt: '2026-10-13T12:00:00Z',
      }),
    });
    expect(await findTrackedPrSnapshot(query, 'scope-a', [first])).toBeNull();
    await advancePrTrackingState({
      ...first,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        capturedAt: '2026-10-13T12:00:00Z',
        credentialScope: 'scope-a',
      }),
    });
    await advancePrTrackingState({
      ...second,
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        capturedAt: '2026-10-13T12:01:00Z',
        credentialScope: 'scope-a',
        pr: { ...buildSnapshot().pr, title: 'Newest' },
      }),
    });
    expect(
      (await findTrackedPrSnapshot(query, 'scope-a', [first, second]))?.pr
        .title,
    ).toBe('Newest');
  });
});

function buildCheck(
  overrides: Partial<GitHubCheckSnapshot> = {},
): GitHubCheckSnapshot {
  return {
    id: 1,
    name: 'test',
    appSlug: 'github-actions',
    appName: 'GitHub Actions',
    status: 'pending',
    rawStatus: 'in_progress',
    conclusion: null,
    detailsUrl: 'https://example.com/checks/1',
    startedAt: '2026-04-09T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function buildSnapshot(
  overrides: Partial<PersistedPrSnapshotFileV1> = {},
): PersistedPrSnapshotFileV1 {
  return {
    version: 1,
    provider: 'github',
    capturedAt: '2026-04-09T00:00:00.000Z',
    includesComments: true,
    includesReviews: true,
    includesReviewComments: true,
    repository: {
      owner: 'acme',
      name: 'repo',
      fullName: 'acme/repo',
    },
    branch: {
      currentName: 'feature-1',
      headRefName: 'feature-1',
      baseRefName: 'main',
      headSha: 'head-sha',
      baseSha: 'base-sha',
    },
    pr: {
      id: 100,
      number: 42,
      nodeId: 'PR_node',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      apiUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      state: 'open',
      isDraft: false,
      title: 'Test PR',
      body: 'Body',
      author: null,
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
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
    checks: {
      headSha: 'head-sha',
      items: [],
    },
    mergeConflicts: {
      hasConflicts: false,
      mergeable: true,
      mergeableState: 'clean',
    },
    ...overrides,
  };
}

beforeEach(async () => {
  resetPrPreviewIndexForTests();
  jest.clearAllMocks();
  await rm('/tmp/canopy-github-pr-hooks-test', {
    recursive: true,
    force: true,
  });
});

describe('PR collection credential provenance', () => {
  const at = '2026-04-09T00:00:00.000Z';
  function complete(
    credentialScope: string | undefined,
    id = 1,
  ): PersistedPrSnapshotFileV1 {
    return buildSnapshot({
      credentialScope,
      issueComments: [
        {
          id,
          nodeId: null,
          htmlUrl: null,
          apiUrl: null,
          author: null,
          authorAssociation: null,
          body: `private-${id}`,
          createdAt: at,
          updatedAt: at,
        },
      ],
      reviews: [
        {
          id,
          nodeId: null,
          htmlUrl: null,
          apiUrl: null,
          author: null,
          state: 'APPROVED',
          body: `review-${id}`,
          commitId: 'head-sha',
          submittedAt: at,
        },
      ],
      reviewComments: [
        {
          id,
          nodeId: null,
          htmlUrl: null,
          apiUrl: null,
          pullRequestReviewId: id,
          inReplyToId: null,
          author: null,
          authorAssociation: null,
          body: `inline-${id}`,
          path: 'src/file.ts',
          commitId: 'head-sha',
          originalCommitId: 'head-sha',
          diffHunk: null,
          line: 1,
          originalLine: 1,
          startLine: null,
          originalStartLine: null,
          side: 'RIGHT',
          startSide: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
    });
  }
  const location = {
    projectId: 'ws-provenance',
    worktreeId: 'wt-provenance',
    repoStorageKey: 'repo-a',
  };
  const advance = (
    currentSnapshot: PersistedPrSnapshotFileV1,
  ): ReturnType<typeof advancePrTrackingState> =>
    advancePrTrackingState({
      ...location,
      branchName: 'feature-1',
      currentSnapshot,
    });
  const partial = (
    credentialScope: string | undefined,
  ): PersistedPrSnapshotFileV1 =>
    buildSnapshot({
      credentialScope,
      includesComments: false,
      includesReviews: false,
      includesReviewComments: false,
    });

  it.each([
    ['scope-a', 'scope-b'],
    [undefined, 'scope-b'],
    ['scope-a', undefined],
  ])(
    'does not relabel unfetched collections when scope changes from %s to %s',
    async (before, after) => {
      await advance(complete(before));
      const result = await advance(partial(after));
      expect(result.currentSnapshot).toMatchObject({
        credentialScope: after,
        includesComments: false,
        includesReviews: false,
        includesReviewComments: false,
        issueComments: [],
        reviews: [],
        reviewComments: [],
      });
      expect(result.triggers).toEqual([]);
      const { snapshot } = await readCurrentPrTrackingSnapshot(location);
      expect(snapshot).toEqual(result.currentSnapshot);
      await expect(readFile(result.previousSnapshotPath)).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
    },
  );

  it.each([
    ['scope-a', 'scope-b', true],
    [undefined, 'scope-b', true],
    ['scope-a', undefined, true],
    ['scope-a', 'scope-a', false],
    [undefined, undefined, false],
  ])(
    'handles absent PR context when scope changes from %s to %s',
    async (before, after, removePrevious) => {
      await advance(complete(before));
      const observation = {
        ...location,
        branchName: 'feature-1',
        currentSnapshot: null,
        credentialScope: after,
      };
      const result = await advancePrTrackingState(observation);
      expect(result.currentSnapshot).toBeNull();
      expect(result.triggers).toEqual([]);
      await expect(readFile(result.currentSnapshotPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      if (removePrevious) {
        await expect(
          readFile(result.previousSnapshotPath),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        const previous: unknown = JSON.parse(
          await readFile(result.previousSnapshotPath, 'utf8'),
        );
        expect(previous).toMatchObject({
          issueComments: [{ body: 'private-1' }],
        });
        if (before !== undefined) {
          expect(previous).toMatchObject({ credentialScope: before });
        }
      }
    },
  );

  it('does not carry mergeability from the previous credential', async () => {
    const previous = complete('scope-a');
    await advance({
      ...previous,
      mergeConflicts: {
        hasConflicts: true,
        mergeable: false,
        mergeableState: 'dirty',
      },
    });
    const current = partial('scope-b');
    const mergeConflicts = {
      hasConflicts: false,
      mergeable: null,
      mergeableState: 'unknown',
    };
    const result = await advance({ ...current, mergeConflicts });
    expect(result.currentSnapshot?.mergeConflicts).toEqual(mergeConflicts);
  });

  it('does not carry a merge-queue cursor from the previous credential', async () => {
    const previous = complete('scope-a');
    const membership = {
      inQueue: false,
      entryId: null,
      enqueuedAt: null,
      position: null,
    };
    await advance({
      ...previous,
      mergeQueue: {
        required: true,
        membership,
        history: {
          status: 'complete',
          filteredCount: 1,
          firstIndex: 0,
          events: [{ type: 'added', id: 'a-only-event', createdAt: at }],
        },
      },
    });
    const result = await advance({
      ...partial('scope-b'),
      mergeQueue: {
        required: true,
        membership,
        history: { status: 'unavailable' },
      },
    });
    expect(
      result.currentSnapshot?.mergeQueue?.cursor?.lastEventId ?? null,
    ).toBeNull();
  });

  it('keeps same-scope collections across partial refreshes', async () => {
    const previous = complete('scope-a');
    await advance(previous);
    const result = await advance(partial('scope-a'));
    expect(result.currentSnapshot).toMatchObject({
      credentialScope: 'scope-a',
      includesComments: true,
      includesReviews: true,
      includesReviewComments: true,
      issueComments: previous.issueComments,
      reviews: previous.reviews,
      reviewComments: previous.reviewComments,
    });
    expect(result.triggers).toEqual([]);
  });

  it('baselines replacement collections and then reports subsequent same-scope changes', async () => {
    await advance(complete('scope-a'));
    const replacement = await advance(complete('scope-b', 2));
    expect(replacement.triggers).toEqual([]);
    expect(replacement.currentSnapshot?.issueComments[0]?.body).toBe(
      'private-2',
    );
    const later = await advance(complete('scope-b', 3));
    expect(later.triggers).toEqual([
      'pr:update:comments',
      'pr:reviews:new',
      'pr:reviews:new:has-comments',
    ]);
    expect(later.currentSnapshot?.issueComments[0]?.body).toBe('private-3');
  });

  it('preserves real PR-state transitions without exposing the previous credential snapshot to hooks', async () => {
    const previous = complete('scope-a');
    await advance(previous);
    const current = partial('scope-b');
    const result = await advance({
      ...current,
      pr: { ...current.pr, state: 'merged', mergedAt: at, closedAt: at },
    });
    expect(result.triggers).toEqual(['pr:merged']);
    await expect(readFile(result.previousSnapshotPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('advancePrTrackingState', () => {
  it.each([
    {
      name: 'valid recent post-creation merge',
      createdAt: '2026-07-20T00:00:00.000Z',
      mergedAt: '2026-07-25T00:00:00.000Z',
      expected: 1,
    },
    {
      name: 'pre-creation merge',
      createdAt: '2026-07-26T00:00:00.000Z',
      mergedAt: '2026-07-25T00:00:00.000Z',
      expected: 0,
    },
    {
      name: 'out-of-window merge',
      createdAt: '2026-06-01T00:00:00.000Z',
      mergedAt: '2026-07-01T00:00:00.000Z',
      expected: 0,
    },
    {
      name: 'future merge',
      createdAt: '2026-07-20T00:00:00.000Z',
      mergedAt: '2026-07-31T00:00:00.000Z',
      expected: 0,
    },
    {
      name: 'invalid creation',
      createdAt: 'invalid',
      mergedAt: '2026-07-25T00:00:00.000Z',
      expected: 0,
    },
    {
      name: 'exact window boundary',
      createdAt: '2026-07-01T00:00:00.000Z',
      mergedAt: '2026-07-16T00:00:00.000Z',
      expected: 1,
    },
  ])(
    'records merged first-snapshot usage only for $name',
    async ({ createdAt, mergedAt, expected }) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
      const worktreeId = `wt-${expected}-${mergedAt}`;
      const result = await advancePrTrackingState({
        projectId: 'ws-catch-up',
        worktreeId,
        repoStorageKey: `repo-${createdAt}-${mergedAt}`,
        branchName: 'feature-catch-up',
        worktreeCreatedAt: createdAt,
        currentSnapshot: buildSnapshot({
          pr: {
            ...buildSnapshot().pr,
            state: 'merged',
            mergedAt,
          },
        }),
      });
      expect(result.triggers).not.toContain('pr:merged');
      expect(recordUsageMetricEventMock).toHaveBeenCalledTimes(expected);
      if (expected === 1) {
        expect(recordUsageMetricEventMock).toHaveBeenCalledWith(
          expect.objectContaining({
            id: `worktree-pr-merged:ws-catch-up/${worktreeId}:repo-${createdAt}-${mergedAt}:42`,
            mergedAt,
          }),
        );
      }
      jest.useRealTimers();
    },
  );

  it('suppresses bootstrap triggers and then fires pr:create when a PR appears later', async () => {
    const first = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: null,
    });
    expect(first.triggers).toEqual([]);

    const second = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot(),
    });
    expect(second.triggers).toEqual(['pr:create']);
  });

  it('fires label updates when label membership changes', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: null,
    });
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot(),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        pr: {
          ...buildSnapshot().pr,
          labels: [
            {
              id: 1,
              nodeId: null,
              name: 'bug',
              color: 'ff0000',
              description: null,
            },
          ],
        },
      }),
    });

    expect(result.triggers).toEqual(['pr:update:labels']);
  });

  it('fires pr:merged and pr:closed on the corresponding state transitions', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged',
      branchName: 'feature-merged',
      currentSnapshot: null,
    });
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged',
      branchName: 'feature-merged',
      currentSnapshot: buildSnapshot({
        branch: {
          ...buildSnapshot().branch,
          currentName: 'feature-merged',
        },
      }),
    });

    const merged = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged',
      branchName: 'feature-merged',
      currentSnapshot: buildSnapshot({
        branch: {
          ...buildSnapshot().branch,
          currentName: 'feature-merged',
        },
        pr: {
          ...buildSnapshot().pr,
          state: 'merged',
          mergedAt: '2026-04-09T01:00:00.000Z',
        },
      }),
    });
    expect(merged.triggers).toEqual(['pr:merged']);
    expect(recordUsageMetricEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worktree_pr_merged',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-merged',
        prNumber: 42,
      }),
    );
    recordUsageMetricEventMock.mockClear();
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged',
      branchName: 'feature-merged',
      currentSnapshot: buildSnapshot({
        branch: {
          ...buildSnapshot().branch,
          currentName: 'feature-merged',
        },
        pr: {
          ...buildSnapshot().pr,
          state: 'merged',
          mergedAt: '2026-04-09T01:00:00.000Z',
        },
      }),
    });
    expect(recordUsageMetricEventMock).not.toHaveBeenCalled();

    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-closed',
      branchName: 'feature-closed',
      currentSnapshot: null,
    });
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-closed',
      branchName: 'feature-closed',
      currentSnapshot: buildSnapshot({
        branch: {
          ...buildSnapshot().branch,
          currentName: 'feature-closed',
        },
        pr: {
          ...buildSnapshot().pr,
          id: 101,
          number: 43,
        },
      }),
    });

    const closed = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-closed',
      branchName: 'feature-closed',
      currentSnapshot: buildSnapshot({
        branch: {
          ...buildSnapshot().branch,
          currentName: 'feature-closed',
        },
        pr: {
          ...buildSnapshot().pr,
          id: 101,
          number: 43,
          state: 'closed',
          closedAt: '2026-04-09T02:00:00.000Z',
        },
      }),
    });
    expect(closed.triggers).toEqual(['pr:closed']);
  });

  it('suppresses comment updates when the previous snapshot was incomplete', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        includesComments: false,
        includesReviews: false,
        includesReviewComments: false,
      }),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        issueComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            authorAssociation: null,
            body: 'hello',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
        ],
      }),
    });

    expect(result.triggers).toEqual([]);
  });

  it('fires comment updates after an incomplete poll when a complete baseline was preserved', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        issueComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            authorAssociation: null,
            body: 'before disable',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
        ],
      }),
    });

    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        includesComments: false,
        includesReviews: false,
        includesReviewComments: false,
      }),
    });

    const reenabled = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        issueComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            authorAssociation: null,
            body: 'arrived while disabled',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T01:00:00.000Z',
          },
        ],
      }),
    });

    expect(reenabled.triggers).toEqual(['pr:update:comments']);
  });

  it('fires comment updates when complete snapshots differ', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot(),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-a',
      branchName: 'feature-1',
      currentSnapshot: buildSnapshot({
        issueComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            authorAssociation: null,
            body: 'changed',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T01:00:00.000Z',
          },
        ],
      }),
    });

    expect(result.triggers).toEqual(['pr:update:comments']);
  });

  it('fires both review triggers when a new review includes inline comments', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-reviews',
      branchName: 'feature-reviews',
      currentSnapshot: buildSnapshot({
        reviews: [
          {
            id: 10,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            state: 'COMMENTED',
            body: '',
            commitId: 'head-sha',
            submittedAt: '2026-04-09T00:00:00.000Z',
          },
        ],
        reviewComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            pullRequestReviewId: 10,
            inReplyToId: null,
            author: null,
            authorAssociation: null,
            body: 'existing',
            path: 'src/file.ts',
            commitId: 'head-sha',
            originalCommitId: 'head-sha',
            diffHunk: '@@ -1,1 +1,1 @@',
            line: 1,
            originalLine: 1,
            startLine: null,
            originalStartLine: null,
            side: 'RIGHT',
            startSide: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
        ],
      }),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-reviews',
      branchName: 'feature-reviews',
      currentSnapshot: buildSnapshot({
        reviews: [
          {
            id: 10,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            state: 'COMMENTED',
            body: '',
            commitId: 'head-sha',
            submittedAt: '2026-04-09T00:00:00.000Z',
          },
          {
            id: 11,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            state: 'COMMENTED',
            body: '',
            commitId: 'head-sha',
            submittedAt: '2026-04-09T01:00:00.000Z',
          },
        ],
        reviewComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            pullRequestReviewId: 10,
            inReplyToId: null,
            author: null,
            authorAssociation: null,
            body: 'existing',
            path: 'src/file.ts',
            commitId: 'head-sha',
            originalCommitId: 'head-sha',
            diffHunk: '@@ -1,1 +1,1 @@',
            line: 1,
            originalLine: 1,
            startLine: null,
            originalStartLine: null,
            side: 'RIGHT',
            startSide: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
          {
            id: 2,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            pullRequestReviewId: 11,
            inReplyToId: null,
            author: null,
            authorAssociation: null,
            body: 'new inline comment',
            path: 'src/file.ts',
            commitId: 'head-sha',
            originalCommitId: 'head-sha',
            diffHunk: '@@ -1,1 +1,1 @@',
            line: 2,
            originalLine: 2,
            startLine: null,
            originalStartLine: null,
            side: 'RIGHT',
            startSide: null,
            createdAt: '2026-04-09T01:00:00.000Z',
            updatedAt: '2026-04-09T01:00:00.000Z',
          },
        ],
      }),
    });

    expect(result.triggers).toEqual([
      'pr:update:comments',
      'pr:reviews:new',
      'pr:reviews:new:has-comments',
    ]);
  });

  it('does not fire pr:reviews:new when only a follow-up review-thread comment is added', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-review-thread-comments',
      branchName: 'feature-review-thread-comments',
      currentSnapshot: buildSnapshot({
        reviews: [
          {
            id: 10,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            state: 'COMMENTED',
            body: '',
            commitId: 'head-sha',
            submittedAt: '2026-04-09T00:00:00.000Z',
          },
        ],
        reviewComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            pullRequestReviewId: 10,
            inReplyToId: null,
            author: null,
            authorAssociation: null,
            body: 'before',
            path: 'src/file.ts',
            commitId: 'head-sha',
            originalCommitId: 'head-sha',
            diffHunk: '@@ -1,1 +1,1 @@',
            line: 1,
            originalLine: 1,
            startLine: null,
            originalStartLine: null,
            side: 'RIGHT',
            startSide: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
        ],
      }),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-review-thread-comments',
      branchName: 'feature-review-thread-comments',
      currentSnapshot: buildSnapshot({
        reviews: [
          {
            id: 10,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            state: 'COMMENTED',
            body: '',
            commitId: 'head-sha',
            submittedAt: '2026-04-09T00:00:00.000Z',
          },
        ],
        reviewComments: [
          {
            id: 1,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            pullRequestReviewId: 10,
            inReplyToId: null,
            author: null,
            authorAssociation: null,
            body: 'existing',
            path: 'src/file.ts',
            commitId: 'head-sha',
            originalCommitId: 'head-sha',
            diffHunk: '@@ -1,1 +1,1 @@',
            line: 1,
            originalLine: 1,
            startLine: null,
            originalStartLine: null,
            side: 'RIGHT',
            startSide: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
          {
            id: 2,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            pullRequestReviewId: 10,
            inReplyToId: 1,
            author: null,
            authorAssociation: null,
            body: 'reply only',
            path: 'src/file.ts',
            commitId: 'head-sha',
            originalCommitId: 'head-sha',
            diffHunk: '@@ -1,1 +1,1 @@',
            line: 1,
            originalLine: 1,
            startLine: null,
            originalStartLine: null,
            side: 'RIGHT',
            startSide: null,
            createdAt: '2026-04-09T01:00:00.000Z',
            updatedAt: '2026-04-09T01:00:00.000Z',
          },
        ],
      }),
    });

    expect(result.triggers).toEqual(['pr:update:comments']);
  });

  it('fires pr:reviews:new for a new review with only review body text', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-review-body',
      branchName: 'feature-review-body',
      currentSnapshot: buildSnapshot(),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-review-body',
      branchName: 'feature-review-body',
      currentSnapshot: buildSnapshot({
        reviews: [
          {
            id: 10,
            nodeId: null,
            htmlUrl: null,
            apiUrl: null,
            author: null,
            state: 'COMMENTED',
            body: 'looks good overall',
            commitId: 'head-sha',
            submittedAt: '2026-04-09T01:00:00.000Z',
          },
        ],
      }),
    });

    expect(result.triggers).toEqual(['pr:update:comments', 'pr:reviews:new']);
  });

  it('fires PR check pass and fail triggers as new outcomes are detected', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-checks',
      branchName: 'feature-checks',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [
            buildCheck({
              id: 1,
              name: 'test',
              status: 'pending',
              rawStatus: 'in_progress',
            }),
            buildCheck({
              id: 2,
              name: 'lint',
              status: 'pending',
              rawStatus: 'queued',
            }),
          ],
        },
      }),
    });

    const passResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-checks',
      branchName: 'feature-checks',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [
            buildCheck({
              id: 1,
              name: 'test',
              status: 'passing',
              rawStatus: 'completed',
              conclusion: 'success',
              completedAt: '2026-04-09T01:00:00.000Z',
            }),
            buildCheck({
              id: 2,
              name: 'lint',
              status: 'pending',
              rawStatus: 'queued',
            }),
          ],
        },
      }),
    });

    expect(passResult.triggers).toEqual(['pr:checks:pass']);

    const failResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-checks',
      branchName: 'feature-checks',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [
            buildCheck({
              id: 1,
              name: 'test',
              status: 'passing',
              rawStatus: 'completed',
              conclusion: 'success',
              completedAt: '2026-04-09T01:00:00.000Z',
            }),
            buildCheck({
              id: 2,
              name: 'lint',
              status: 'failing',
              rawStatus: 'completed',
              conclusion: 'failure',
              completedAt: '2026-04-09T01:05:00.000Z',
            }),
          ],
        },
      }),
    });

    expect(failResult.triggers).toEqual([
      'pr:checks:fail',
      'pr:checks:finished',
      'pr:checks:finished:has-fail',
    ]);
  });

  it('fires aggregate check triggers when all checks pass or finish', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-aggregate-checks',
      branchName: 'feature-aggregate-checks',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [
            buildCheck({
              id: 1,
              name: 'test',
              status: 'passing',
              rawStatus: 'completed',
              conclusion: 'success',
              completedAt: '2026-04-09T01:00:00.000Z',
            }),
            buildCheck({
              id: 2,
              name: 'lint',
              status: 'pending',
              rawStatus: 'queued',
            }),
          ],
        },
      }),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-aggregate-checks',
      branchName: 'feature-aggregate-checks',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [
            buildCheck({
              id: 1,
              name: 'test',
              status: 'passing',
              rawStatus: 'completed',
              conclusion: 'success',
              completedAt: '2026-04-09T01:00:00.000Z',
            }),
            buildCheck({
              id: 2,
              name: 'lint',
              status: 'neutral',
              rawStatus: 'completed',
              conclusion: 'neutral',
              completedAt: '2026-04-09T01:10:00.000Z',
            }),
          ],
        },
      }),
    });

    expect(result.triggers).toEqual([
      'pr:checks:pass:all',
      'pr:checks:finished',
    ]);
  });

  it('fires aggregate check triggers when a retry finishes between polls', async () => {
    const failedCheck = buildCheck({
      id: 1,
      name: 'approval',
      status: 'failing',
      rawStatus: 'completed',
      conclusion: 'failure',
      startedAt: '2026-04-09T01:00:00.000Z',
      completedAt: '2026-04-09T01:01:00.000Z',
    });

    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-check-retries',
      branchName: 'feature-check-retries',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [failedCheck],
        },
      }),
    });

    const repeatedFailure = buildCheck({
      ...failedCheck,
      id: 2,
      startedAt: '2026-04-09T01:02:00.000Z',
      completedAt: '2026-04-09T01:03:00.000Z',
    });
    const failedRetryResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-check-retries',
      branchName: 'feature-check-retries',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [repeatedFailure],
        },
      }),
    });

    expect(failedRetryResult.triggers).toEqual([
      'pr:checks:finished',
      'pr:checks:finished:has-fail',
    ]);

    const unchangedResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-check-retries',
      branchName: 'feature-check-retries',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [repeatedFailure],
        },
      }),
    });

    expect(unchangedResult.triggers).toEqual([]);

    const successfulRetryResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-check-retries',
      branchName: 'feature-check-retries',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [
            buildCheck({
              ...repeatedFailure,
              id: 3,
              status: 'passing',
              conclusion: 'success',
              startedAt: '2026-04-09T01:04:00.000Z',
              completedAt: '2026-04-09T01:05:00.000Z',
            }),
          ],
        },
      }),
    });

    expect(successfulRetryResult.triggers).toEqual([
      'pr:checks:pass',
      'pr:checks:pass:all',
      'pr:checks:finished',
    ]);
  });

  it('fires aggregate check triggers when a passing retry finishes between polls', async () => {
    const passingCheck = buildCheck({
      id: 1,
      name: 'approval',
      status: 'passing',
      rawStatus: 'completed',
      conclusion: 'success',
      startedAt: '2026-04-09T01:00:00.000Z',
      completedAt: '2026-04-09T01:01:00.000Z',
    });

    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-passing-check-retries',
      branchName: 'feature-passing-check-retries',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [passingCheck],
        },
      }),
    });

    const passingRetry = buildCheck({
      ...passingCheck,
      id: 2,
      startedAt: '2026-04-09T01:02:00.000Z',
      completedAt: '2026-04-09T01:03:00.000Z',
    });
    const passingRetryResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-passing-check-retries',
      branchName: 'feature-passing-check-retries',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [passingRetry],
        },
      }),
    });

    expect(passingRetryResult.triggers).toEqual([
      'pr:checks:pass:all',
      'pr:checks:finished',
    ]);

    const unchangedResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-passing-check-retries',
      branchName: 'feature-passing-check-retries',
      currentSnapshot: buildSnapshot({
        checks: {
          headSha: 'head-sha',
          items: [passingRetry],
        },
      }),
    });

    expect(unchangedResult.triggers).toEqual([]);
  });

  it('fires pr:merge-conflicts when conflicts are first detected', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-conflicts',
      branchName: 'feature-conflicts',
      currentSnapshot: buildSnapshot(),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-conflicts',
      branchName: 'feature-conflicts',
      currentSnapshot: buildSnapshot({
        mergeConflicts: {
          hasConflicts: true,
          mergeable: false,
          mergeableState: 'dirty',
        },
      }),
    });

    expect(result.triggers).toEqual(['pr:merge-conflicts']);
  });

  const conflicted = {
    hasConflicts: true,
    mergeable: false,
    mergeableState: 'dirty',
  };

  function buildMergedSnapshot(): PersistedPrSnapshotFileV1 {
    const base = buildSnapshot();
    return buildSnapshot({
      pr: {
        ...base.pr,
        state: 'merged',
        mergedAt: '2026-04-10T00:00:00.000Z',
      },
      mergeConflicts: conflicted,
    });
  }

  it('does not fire pr:merge-conflicts when GitHub reports conflicts on the poll that sees the merge', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged-conflicts',
      branchName: 'feature-merged-conflicts',
      currentSnapshot: buildSnapshot(),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged-conflicts',
      branchName: 'feature-merged-conflicts',
      currentSnapshot: buildMergedSnapshot(),
    });

    expect(result.triggers).toEqual(['pr:merged']);
  });

  it('does not fire pr:merge-conflicts when an already-merged PR is first tracked', async () => {
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged-first-seen',
      branchName: 'feature-merged-first-seen',
      currentSnapshot: null,
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-merged-first-seen',
      branchName: 'feature-merged-first-seen',
      currentSnapshot: buildMergedSnapshot(),
    });

    expect(result.triggers).toEqual([]);
  });

  it('does not fire pr:merge-conflicts for a closed draft snapshot', async () => {
    const base = buildSnapshot();
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-closed-draft-conflicts',
      branchName: 'feature-closed-draft-conflicts',
      currentSnapshot: buildSnapshot(),
    });

    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-closed-draft-conflicts',
      branchName: 'feature-closed-draft-conflicts',
      currentSnapshot: buildSnapshot({
        pr: {
          ...base.pr,
          state: 'draft',
          isDraft: true,
          closedAt: '2026-04-10T00:00:00.000Z',
        },
        mergeConflicts: conflicted,
      }),
    });

    expect(result.triggers).not.toContain('pr:merge-conflicts');
  });

  it('fires pr:merge-conflicts when a closed PR with conflicts is reopened', async () => {
    const base = buildSnapshot();
    await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-reopened-conflicts',
      branchName: 'feature-reopened-conflicts',
      currentSnapshot: buildSnapshot(),
    });

    const closedResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-reopened-conflicts',
      branchName: 'feature-reopened-conflicts',
      currentSnapshot: buildSnapshot({
        pr: {
          ...base.pr,
          state: 'closed',
          closedAt: '2026-04-10T00:00:00.000Z',
        },
        mergeConflicts: conflicted,
      }),
    });
    expect(closedResult.triggers).toEqual(['pr:closed']);

    const reopenedResult = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'repo-reopened-conflicts',
      branchName: 'feature-reopened-conflicts',
      currentSnapshot: buildSnapshot({ mergeConflicts: conflicted }),
    });
    expect(reopenedResult.triggers).toEqual(['pr:merge-conflicts']);
  });

  // GitHub recomputes mergeability after the base branch moves and reports
  // mergeable: null / mergeable_state: 'unknown' until it finishes.
  const recomputing = {
    hasConflicts: false,
    mergeable: null,
    mergeableState: 'unknown',
  };
  const clean = {
    hasConflicts: false,
    mergeable: true,
    mergeableState: 'clean',
  };

  it('does not carry a closed PR conflict into unknown mergeability after reopening', async () => {
    const base = buildSnapshot();
    const repoStorageKey = 'repo-reopened-unknown-conflicts';
    const tracking = {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey,
      branchName: 'feature-reopened-unknown-conflicts',
    };

    await advancePrTrackingState({
      ...tracking,
      currentSnapshot: buildSnapshot({
        pr: {
          ...base.pr,
          state: 'closed',
          closedAt: '2026-04-10T00:00:00.000Z',
        },
        mergeConflicts: conflicted,
      }),
    });

    const reopened = await advancePrTrackingState({
      ...tracking,
      currentSnapshot: buildSnapshot({ mergeConflicts: recomputing }),
    });
    expect(reopened.triggers).not.toContain('pr:merge-conflicts');
    expect(
      (await readCurrentPrTrackingSnapshot(tracking)).snapshot?.mergeConflicts,
    ).toEqual(recomputing);

    const confirmedClean = await advancePrTrackingState({
      ...tracking,
      currentSnapshot: buildSnapshot({ mergeConflicts: clean }),
    });
    expect(confirmedClean.triggers).not.toContain('pr:merge-conflicts');
  });

  async function advanceConflicts(
    repoStorageKey: string,
    mergeConflicts: PersistedPrSnapshotFileV1['mergeConflicts'],
  ): Promise<HookTriggerName[]> {
    const result = await advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey,
      branchName: `feature-${repoStorageKey}`,
      currentSnapshot: buildSnapshot({ mergeConflicts }),
    });
    return result.triggers;
  }

  it('does not refire pr:merge-conflicts after GitHub recomputes an already-conflicted PR', async () => {
    const key = 'repo-recomputed-conflicts';
    await advanceConflicts(key, undefined);
    expect(await advanceConflicts(key, conflicted)).toEqual([
      'pr:merge-conflicts',
    ]);
    expect(await advanceConflicts(key, recomputing)).toEqual([]);
    expect(await advanceConflicts(key, conflicted)).toEqual([]);
    expect(await advanceConflicts(key, recomputing)).toEqual([]);
    expect(await advanceConflicts(key, undefined)).toEqual([]);
    expect(await advanceConflicts(key, conflicted)).toEqual([]);
  });

  it('fires pr:merge-conflicts when a clean PR becomes conflicted after GitHub recomputes', async () => {
    const key = 'repo-recomputed-clean';
    await advanceConflicts(key, undefined);
    expect(await advanceConflicts(key, recomputing)).toEqual([]);
    expect(await advanceConflicts(key, conflicted)).toEqual([
      'pr:merge-conflicts',
    ]);
    expect(await advanceConflicts(key, recomputing)).toEqual([]);
    expect(await advanceConflicts(key, clean)).toEqual([]);
    expect(await advanceConflicts(key, recomputing)).toEqual([]);
    expect(await advanceConflicts(key, conflicted)).toEqual([
      'pr:merge-conflicts',
    ]);
  });
});

describe('merge queue hook triggers', () => {
  const OUT = {
    inQueue: false,
    entryId: null,
    enqueuedAt: null,
    position: null,
  };
  const ENQUEUED_AT = '2026-04-09T00:00:00.000Z';
  const queued = (entryId: string): PrMergeQueueMembership => ({
    inQueue: true,
    entryId,
    phase: 'queued',
    enqueuedAt: ENQUEUED_AT,
    position: 1,
  });
  const added = (id: string): PrMergeQueueTimelineEvent => ({
    type: 'added',
    id,
    createdAt: ENQUEUED_AT,
  });
  const removed = (id: string, reason: string): PrMergeQueueTimelineEvent => ({
    type: 'removed',
    id,
    createdAt: '2026-04-09T00:00:30.000Z',
    reason,
  });
  const withQueue = (
    membership: PrMergeQueueMembership,
    events: PrMergeQueueTimelineEvent[] | null,
    overrides: Partial<PersistedPrSnapshotFileV1> = {},
  ): PersistedPrSnapshotFileV1 =>
    buildSnapshot({
      mergeQueue: {
        required: true,
        membership,
        history: events
          ? {
              status: 'complete',
              filteredCount: events.length,
              firstIndex: 0,
              events,
            }
          : { status: 'unavailable' },
      },
      ...overrides,
    });
  const merged = (): PersistedPrSnapshotFileV1 => {
    const base = buildSnapshot();
    return buildSnapshot({
      pr: { ...base.pr, state: 'merged', mergedAt: '2026-04-10T00:00:00.000Z' },
    });
  };

  async function advance(
    repoStorageKey: string,
    currentSnapshot: PersistedPrSnapshotFileV1 | null,
  ): Promise<Awaited<ReturnType<typeof advancePrTrackingState>>> {
    return advancePrTrackingState({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey,
      branchName: 'feature-1',
      currentSnapshot,
    });
  }

  it('baselines queue state silently and stores a cursor instead of history', async () => {
    const first = await advance(
      'queue-baseline',
      withQueue(queued('A'), [added('a1')]),
    );
    expect(first.triggers).toEqual([]);
    expect(first.currentSnapshot?.mergeQueue).toEqual({
      required: true,
      membership: queued('A'),
      cursor: { count: 1, lastEventId: 'a1' },
    });

    const stored = await readCurrentPrTrackingSnapshot({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'queue-baseline',
    });
    expect(stored.snapshot?.mergeQueue).not.toHaveProperty('history');
  });

  it('baselines a stored snapshot from a build without queue data', async () => {
    await advance('queue-upgrade', buildSnapshot());
    const upgraded = await advance(
      'queue-upgrade',
      withQueue(queued('A'), [added('a1')]),
    );
    expect(upgraded.triggers).toEqual([]);
  });

  it('fires entry and removal triggers with their evidence stored', async () => {
    await advance('queue-cycle', withQueue(OUT, []));
    const entered = await advance(
      'queue-cycle',
      withQueue(queued('A'), [added('a1')]),
    );
    expect(entered.triggers).toEqual(['pr:queue:entered']);
    expect(entered.currentSnapshot?.mergeQueue?.lastEntered).toMatchObject({
      entryId: 'A',
      reentry: false,
    });

    const removedResult = await advance(
      'queue-cycle',
      withQueue(OUT, [added('a1'), removed('r1', 'failed_checks')]),
    );
    expect(removedResult.triggers).toEqual(['pr:queue:removed']);
    expect(
      removedResult.currentSnapshot?.mergeQueue?.lastRemoved,
    ).toMatchObject({
      entryId: 'A',
      reason: 'failed_checks',
      evidence: 'timeline',
    });

    const stored = await readCurrentPrTrackingSnapshot({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoStorageKey: 'queue-cycle',
    });
    expect(stored.snapshot?.mergeQueue?.lastRemoved?.entryId).toBe('A');
  });

  it('reports a requeue as a removal, then an entry', async () => {
    await advance('queue-requeue', withQueue(queued('A'), [added('a1')]));
    const result = await advance(
      'queue-requeue',
      withQueue(queued('B'), [
        added('a1'),
        removed('r1', 'failed_checks'),
        added('a2'),
      ]),
    );
    expect(result.triggers).toEqual(['pr:queue:removed', 'pr:queue:entered']);
  });

  it('fires only pr:merged for a pull request merged from the queue', async () => {
    await advance('queue-merge', withQueue(queued('A'), [added('a1')]));
    const held = await advance(
      'queue-merge',
      withQueue(OUT, [added('a1'), removed('r1', 'merged')]),
    );
    expect(held.triggers).toEqual([]);
    expect(held.currentSnapshot?.mergeQueue?.pendingExit).toMatchObject({
      heldFor: 'merged_reason',
    });

    const mergedResult = await advance('queue-merge', merged());
    expect(mergedResult.triggers).toEqual(['pr:merged']);
    expect(mergedResult.currentSnapshot?.mergeQueue).toMatchObject({
      membership: OUT,
    });
    expect(mergedResult.currentSnapshot?.mergeQueue).not.toHaveProperty(
      'pendingExit',
    );

    await advance('queue-merge-direct', withQueue(queued('A'), [added('a1')]));
    expect((await advance('queue-merge-direct', merged())).triggers).toEqual([
      'pr:merged',
    ]);
  });

  it('never fires on unknown queue state and keeps the stored state', async () => {
    await advance('queue-unknown', withQueue(queued('A'), [added('a1')]));
    const unknown = await advance('queue-unknown', buildSnapshot());
    expect(unknown.triggers).toEqual([]);
    expect(unknown.currentSnapshot?.mergeQueue?.membership).toEqual(
      queued('A'),
    );

    const removedResult = await advance(
      'queue-unknown',
      withQueue(OUT, [added('a1'), removed('r1', 'failed_checks')]),
    );
    expect(removedResult.triggers).toEqual(['pr:queue:removed']);
  });

  it('confirms a dequeue when a queued pull request is converted to draft', async () => {
    const base = buildSnapshot();
    const draft = (capturedAt: string): Partial<PersistedPrSnapshotFileV1> => ({
      capturedAt,
      pr: { ...base.pr, state: 'draft', isDraft: true },
    });
    await advance('queue-draft', withQueue(queued('A'), null));

    const held = await advance(
      'queue-draft',
      withQueue(OUT, null, draft('2026-04-09T00:01:00.000Z')),
    );
    expect(held.triggers).toEqual([]);
    expect(held.currentSnapshot?.mergeQueue?.pendingExit).toMatchObject({
      heldFor: 'confirm',
      entryId: 'A',
    });

    const confirmed = await advance(
      'queue-draft',
      withQueue(OUT, null, draft('2026-04-09T00:02:00.000Z')),
    );
    expect(confirmed.triggers).toEqual(['pr:queue:removed']);
    expect(confirmed.currentSnapshot?.mergeQueue?.lastRemoved).toMatchObject({
      entryId: 'A',
      evidence: 'membership',
    });
  });

  it('baselines queue state for a new pull request', async () => {
    await advance('queue-new-pr', withQueue(OUT, []));
    const base = buildSnapshot();
    const result = await advance(
      'queue-new-pr',
      withQueue(queued('B'), [added('b1')], {
        pr: { ...base.pr, id: 101, number: 43 },
      }),
    );
    expect(result.triggers).toEqual(['pr:create']);
  });
});

describe('sweep read sequences', () => {
  type Step = PersistedPrSnapshotFileV1 | null;

  async function runSequence(
    worktreeId: string,
    steps: Step[],
  ): Promise<HookTriggerName[][]> {
    const triggers: HookTriggerName[][] = [];
    for (const snapshot of steps) {
      const result = await advancePrTrackingState({
        projectId: 'ws-sweep',
        worktreeId,
        repoStorageKey: 'repo-a',
        branchName: 'feature-1',
        currentSnapshot: snapshot,
      });
      triggers.push(result.triggers);
    }
    return triggers;
  }

  function at(minute: number, snapshot: PersistedPrSnapshotFileV1): Step {
    return {
      ...snapshot,
      capturedAt: new Date(Date.UTC(2026, 3, 9, 0, minute)).toISOString(),
    };
  }

  function withoutComments(
    snapshot: PersistedPrSnapshotFileV1,
  ): PersistedPrSnapshotFileV1 {
    return {
      ...snapshot,
      includesComments: false,
      includesReviews: false,
      includesReviewComments: false,
      issueComments: [],
      reviews: [],
      reviewComments: [],
    };
  }

  const comment = (id: number, body: string): GitHubIssueCommentSnapshot => ({
    id,
    nodeId: null,
    htmlUrl: null,
    apiUrl: null,
    author: null,
    authorAssociation: null,
    body,
    createdAt: '2026-04-09T00:00:00.000Z',
    updatedAt: '2026-04-09T00:00:00.000Z',
  });
  const review = (id: number): GitHubReviewSnapshot => ({
    id,
    nodeId: null,
    htmlUrl: null,
    apiUrl: null,
    author: null,
    state: 'APPROVED',
    body: '',
    commitId: 'head-sha',
    submittedAt: '2026-04-09T00:00:00.000Z',
  });
  const pending = buildSnapshot({
    checks: { headSha: 'head-sha', items: [buildCheck()] },
    issueComments: [comment(1, 'first')],
  });
  const passed = buildSnapshot({
    checks: {
      headSha: 'head-sha',
      items: [
        buildCheck({
          status: 'passing',
          rawStatus: 'completed',
          conclusion: 'success',
          completedAt: '2026-04-09T00:05:00.000Z',
        }),
      ],
    },
    issueComments: [comment(1, 'first')],
  });
  const commented = {
    ...passed,
    issueComments: [comment(1, 'first'), comment(2, 'second')],
  };
  const reviewed = { ...commented, reviews: [review(7)] };
  const merged = buildSnapshot({
    ...reviewed,
    pr: {
      ...reviewed.pr,
      state: 'merged',
      mergedAt: '2026-04-09T00:20:00.000Z',
      closedAt: '2026-04-09T00:20:00.000Z',
    },
  });

  it('fires the same transitions as polling every read in full', async () => {
    // A poll read everything every time.
    const polled = await runSequence('wt-polled', [
      at(0, pending),
      at(1, pending),
      at(2, passed),
      at(3, passed),
      at(4, commented),
      at(5, reviewed),
      at(6, reviewed),
      at(7, merged),
      at(8, merged),
    ]);
    // A sweep reuses the last read while the fingerprint holds, reads checks
    // without comments when only status moved, and reads comments when
    // remarks moved.
    const swept = await runSequence('wt-swept', [
      at(0, pending),
      at(1, pending),
      at(2, withoutComments(passed)),
      at(3, withoutComments(passed)),
      at(4, commented),
      at(5, reviewed),
      at(6, reviewed),
      at(7, withoutComments(merged)),
      at(8, withoutComments(merged)),
    ]);

    expect(swept).toEqual(polled);
    expect(polled).toEqual([
      [],
      [],
      ['pr:checks:pass', 'pr:checks:pass:all', 'pr:checks:finished'],
      [],
      ['pr:update:comments'],
      ['pr:update:comments', 'pr:reviews:new'],
      [],
      ['pr:merged'],
      [],
    ]);
  });

  it('keeps the stored comment baseline across reads that skip comments', async () => {
    await runSequence('wt-baseline', [at(0, pending)]);
    await runSequence('wt-baseline', [at(1, withoutComments(passed))]);

    const { snapshot } = await readCurrentPrTrackingSnapshot({
      projectId: 'ws-sweep',
      worktreeId: 'wt-baseline',
      repoStorageKey: 'repo-a',
    });
    expect(snapshot?.includesComments).toBe(true);
    expect(snapshot?.issueComments).toEqual([comment(1, 'first')]);
    expect(snapshot?.checks?.items[0]?.conclusion).toBe('success');
  });
});
