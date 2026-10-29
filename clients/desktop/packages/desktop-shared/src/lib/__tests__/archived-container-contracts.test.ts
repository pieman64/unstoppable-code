import type {
  ArchivedContainerManifest,
  ArchivedContainerManifestV1,
  ArchivedContainerManifestV2,
  ArchivedContainerRecoveryManifest,
  ArchivedContainerSummary,
  ArchivedPullRequestMetadata,
  ArchivedPullRequestRepositoryCapture,
  ArchivedPullRequestState,
} from '../../types';
import {
  isArchivedContainerManifest,
  toArchivedContainerSummary,
} from '../archived-container-contracts';
import {
  buildConfirmedNoneArchiveManifest,
  buildMixedPullRequestArchiveManifest,
  buildOnePullRequestArchiveManifest,
} from './archived-container-contract-fixtures';

const baseManifest = {
  id: 'archive-1',
  projectId: 'workspace-1',
  name: 'feature/archive',
  createdAt: '2026-07-01T00:00:00.000Z',
  archivedAt: '2026-07-02T00:00:00.000Z',
  retentionDays: 7,
  expiresAt: '2026-07-09T00:00:00.000Z',
  chatCount: 2,
  archivedChatCount: 1,
  executionCount: 3,
  branchName: 'feature/archive',
  workspaceType: 'single-repo' as const,
  restoredTo: {
    kind: 'worktree' as const,
    id: 'restored-1',
    restoredAt: '2026-07-03T00:00:00.000Z',
    createdAt: '2026-07-03T00:00:00.000Z',
  },
};

const version1Manifest: ArchivedContainerManifestV1 = {
  ...baseManifest,
  version: 1,
  kind: 'worktree',
};

test('recovery manifests preserve explicit fidelity limits while hiding filesystem receipts from the renderer', () => {
  const recovery: ArchivedContainerRecoveryManifest = {
    ...baseManifest,
    version: 3,
    kind: 'worktree',
    originalWorktree: {
      id: baseManifest.id,
      branchName: baseManifest.branchName,
      createdAt: baseManifest.createdAt,
    },
    restoreStaging: {
      kind: 'worktree',
      id: 'recovery-destination-1',
      createdAt: '2026-07-03T00:00:00.000Z',
    },
    recovery: {
      kind: 'files-only',
      source: 'retained',
      digest: 'a'.repeat(64),
      payloadId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      gitCleanupPending: true,
    },
  };
  expect(isArchivedContainerManifest(recovery)).toBe(true);
  expect(toArchivedContainerSummary(recovery)).toMatchObject({
    version: 3,
    recovery: {
      kind: 'files-only',
      source: 'retained',
      gitCleanupPending: true,
    },
  });
  expect(JSON.stringify(toArchivedContainerSummary(recovery))).not.toContain(
    'payloadId',
  );
  expect(JSON.stringify(toArchivedContainerSummary(recovery))).not.toContain(
    'digest',
  );
  expect(JSON.stringify(toArchivedContainerSummary(recovery))).not.toContain(
    'restoreStaging',
  );
  expect(
    isArchivedContainerManifest({
      ...recovery,
      recovery: { ...recovery.recovery, payloadId: '../../outside' },
    }),
  ).toBe(false);
  expect(
    isArchivedContainerManifest({
      ...recovery,
      originalWorktree: {
        ...recovery.originalWorktree,
        createdAt: baseManifest.archivedAt,
      },
    }),
  ).toBe(false);
  expect(
    isArchivedContainerManifest({
      ...recovery,
      restoreStaging: {
        ...recovery.restoreStaging,
        id: '',
      },
    }),
  ).toBe(false);
  expect(
    isArchivedContainerManifest({
      ...recovery,
      restoreStaging: {
        ...recovery.restoreStaging,
        id: '../outside',
      },
    }),
  ).toBe(false);
});

function cloneManifest(
  manifest: ArchivedContainerManifestV2 = buildOnePullRequestArchiveManifest(),
): ArchivedContainerManifestV2 {
  return structuredClone(manifest);
}

function firstPullRequest(
  manifest: ArchivedContainerManifestV2,
): ArchivedPullRequestMetadata {
  const repository = manifest.pullRequestMetadata.repositories[0];
  if (repository?.status !== 'complete' || repository.pullRequest === null) {
    throw new Error('Expected the fixture to contain one pull request');
  }
  return repository.pullRequest;
}

function repositoryAt(
  manifest: ArchivedContainerManifestV2,
  index: number,
): ArchivedPullRequestRepositoryCapture {
  const repository = manifest.pullRequestMetadata.repositories[index];
  if (!repository) throw new Error(`Missing fixture repository at ${index}`);
  return repository;
}

function gitRepositoryAt(
  manifest: ArchivedContainerManifestV2,
  index: number,
): ArchivedContainerManifestV2['gitState']['repositories'][number] {
  const repository = manifest.gitState.repositories[index];
  if (!repository)
    throw new Error(`Missing Git fixture repository at ${index}`);
  return repository;
}

function unavailableRepository(
  manifest: ArchivedContainerManifestV2,
): Extract<ArchivedPullRequestRepositoryCapture, { status: 'unavailable' }> {
  const repository = manifest.pullRequestMetadata.repositories.find(
    (candidate) => candidate.status === 'unavailable',
  );
  if (!repository || repository.status !== 'unavailable') {
    throw new Error('Expected the fixture to contain an unavailable lookup');
  }
  return repository;
}

function deleteFixtureProperty(value: object, property: PropertyKey): void {
  if (!Reflect.deleteProperty(value, property)) {
    throw new Error(`Unable to delete fixture property ${String(property)}`);
  }
}

function setFixtureProperty(
  value: object,
  property: PropertyKey,
  propertyValue: unknown,
): void {
  if (!Reflect.set(value, property, propertyValue)) {
    throw new Error(`Unable to set fixture property ${String(property)}`);
  }
}

type ManifestMutation = (manifest: ArchivedContainerManifestV2) => void;
type PullRequestMutation = (pullRequest: ArchivedPullRequestMetadata) => void;

describe('archived-container contracts', () => {
  it('accepts and projects a measured diskUsage, rejecting inconsistent totals', () => {
    const measured: ArchivedContainerManifest = {
      ...version1Manifest,
      diskUsage: {
        filesBytes: 100,
        gitBytes: 50,
        gitBytesComplete: false,
        totalBytes: 150,
        computedAt: '2026-07-03T00:00:00.000Z',
      },
    };
    expect(isArchivedContainerManifest(measured)).toBe(true);
    expect(toArchivedContainerSummary(measured).diskUsage).toEqual({
      filesBytes: 100,
      gitBytes: 50,
      gitBytesComplete: false,
      totalBytes: 150,
      computedAt: '2026-07-03T00:00:00.000Z',
    });
    expect(toArchivedContainerSummary(measured).diskUsage).not.toBe(
      measured.diskUsage,
    );

    const inconsistent = structuredClone(measured);
    setFixtureProperty(inconsistent, 'diskUsage', {
      filesBytes: 100,
      gitBytes: 50,
      totalBytes: 151,
      computedAt: '2026-07-03T00:00:00.000Z',
    });
    expect(isArchivedContainerManifest(inconsistent)).toBe(false);
    const negative = structuredClone(measured);
    setFixtureProperty(negative, 'diskUsage', {
      filesBytes: -1,
      gitBytes: 0,
      totalBytes: -1,
      computedAt: '2026-07-03T00:00:00.000Z',
    });
    expect(isArchivedContainerManifest(negative)).toBe(false);
    expect(
      toArchivedContainerSummary(version1Manifest).diskUsage,
    ).toBeUndefined();
  });

  it('keeps version 1 assignable and readable for both archive kinds', () => {
    const worktree: ArchivedContainerManifest = version1Manifest;
    const workEntry: ArchivedContainerManifest = {
      ...baseManifest,
      version: 1,
      kind: 'work-entry',
    };

    expect(isArchivedContainerManifest(worktree)).toBe(true);
    expect(isArchivedContainerManifest(workEntry)).toBe(true);
  });

  it('accepts valid single- and multi-repository PR captures', () => {
    expect(
      isArchivedContainerManifest(buildConfirmedNoneArchiveManifest()),
    ).toBe(true);
    expect(
      isArchivedContainerManifest(buildOnePullRequestArchiveManifest()),
    ).toBe(true);
    expect(
      isArchivedContainerManifest(buildMixedPullRequestArchiveManifest()),
    ).toBe(true);
  });

  it('allows an empty Git capture only for a workspace-root-only archive', () => {
    const manifest = cloneManifest(buildMixedPullRequestArchiveManifest());
    manifest.restoreScope = 'workspace-root-only';
    manifest.gitState.repositories = [];
    manifest.gitChanges = {
      status: 'complete',
      capturedAt: manifest.archivedAt,
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      repositories: [],
    };
    manifest.pullRequestMetadata = {
      capturedAt: manifest.archivedAt,
      repositories: [],
    };

    expect(isArchivedContainerManifest(manifest)).toBe(true);
    expect(
      isArchivedContainerManifest({
        ...manifest,
        restoreScope: undefined,
      }),
    ).toBe(false);
  });

  it.each<ArchivedPullRequestState>(['open', 'draft', 'closed', 'merged'])(
    'accepts the %s pull-request state',
    (state) => {
      expect(
        isArchivedContainerManifest(buildOnePullRequestArchiveManifest(state)),
      ).toBe(true);
    },
  );

  it('requires version 2 to be a worktree with complete Git and PR contracts', () => {
    type Version2Manifest = Extract<ArchivedContainerManifest, { version: 2 }>;
    type Version2WorkEntry = Extract<
      ArchivedContainerManifest,
      { version: 2; kind: 'work-entry' }
    >;
    const version2Kind: Version2Manifest['kind'] = 'worktree';
    const excludesVersion2WorkEntries: Version2WorkEntry extends never
      ? true
      : false = true;
    const version2Manifest = buildOnePullRequestArchiveManifest();
    const withoutPullRequestMetadata = structuredClone(version2Manifest);
    deleteFixtureProperty(withoutPullRequestMetadata, 'pullRequestMetadata');

    expect(isArchivedContainerManifest(version2Manifest)).toBe(true);
    expect(version2Kind).toBe('worktree');
    expect(excludesVersion2WorkEntries).toBe(true);
    expect(
      isArchivedContainerManifest({
        ...version2Manifest,
        kind: 'work-entry',
      }),
    ).toBe(false);
    expect(
      isArchivedContainerManifest({
        ...version2Manifest,
        gitState: undefined,
      }),
    ).toBe(false);
    expect(isArchivedContainerManifest(withoutPullRequestMetadata)).toBe(false);
    expect(
      isArchivedContainerManifest({
        ...version2Manifest,
        archivedAt: '2026-07-02',
      }),
    ).toBe(false);
    expect(
      isArchivedContainerManifest({
        ...version2Manifest,
        originalWorktree: {
          id: version2Manifest.id,
          createdAt: version2Manifest.createdAt,
        },
      }),
    ).toBe(false);
    expect(
      isArchivedContainerManifest({
        ...version2Manifest,
        gitChanges: {
          ...version2Manifest.gitChanges,
          fileCount: 99,
        },
      }),
    ).toBe(false);
    const invalidBaseCommit = cloneManifest(version2Manifest);
    gitRepositoryAt(invalidBaseCommit, 0).baseBranchCommit = 'invalid';
    expect(isArchivedContainerManifest(invalidBaseCommit)).toBe(false);
  });

  it('distinguishes confirmed absence from an unavailable lookup', () => {
    const confirmedNone = buildConfirmedNoneArchiveManifest();
    const mixed = buildMixedPullRequestArchiveManifest();

    expect(confirmedNone.pullRequestMetadata.repositories).toEqual([
      expect.objectContaining({ status: 'complete', pullRequest: null }),
    ]);
    expect(mixed.pullRequestMetadata.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'complete', pullRequest: null }),
        expect.objectContaining({ status: 'unavailable' }),
      ]),
    );
    expect(
      mixed.pullRequestMetadata.repositories.find(
        (repository) => repository.status === 'unavailable',
      ),
    ).not.toHaveProperty('pullRequest');
  });

  const repositoryCaptureMutations: Array<readonly [string, ManifestMutation]> =
    [
      [
        'duplicate repository',
        (manifest: ArchivedContainerManifestV2): void => {
          manifest.pullRequestMetadata.repositories.push(
            structuredClone(repositoryAt(manifest, 0)),
          );
        },
      ],
      [
        'missing repository',
        (manifest: ArchivedContainerManifestV2): void => {
          manifest.pullRequestMetadata.repositories.pop();
        },
      ],
      [
        'extra repository',
        (manifest: ArchivedContainerManifestV2): void => {
          manifest.pullRequestMetadata.repositories.push({
            repoId: 'extra',
            repoName: 'extra',
            status: 'unavailable',
          });
        },
      ],
      [
        'name-mismatched repository',
        (manifest: ArchivedContainerManifestV2): void => {
          repositoryAt(manifest, 0).repoName = 'wrong-name';
        },
      ],
    ];

  it.each(repositoryCaptureMutations)(
    'rejects a %s PR capture',
    (_label, mutate) => {
      const manifest = cloneManifest(buildMixedPullRequestArchiveManifest());
      mutate(manifest);

      expect(isArchivedContainerManifest(manifest)).toBe(false);
    },
  );

  it('requires a pullRequest key for complete repository captures', () => {
    const manifest = cloneManifest();
    const repository = repositoryAt(manifest, 0);
    deleteFixtureProperty(repository, 'pullRequest');

    expect(isArchivedContainerManifest(manifest)).toBe(false);
  });

  it('forbids a pullRequest key for unavailable repository captures', () => {
    const manifest = cloneManifest(buildMixedPullRequestArchiveManifest());
    const repository = unavailableRepository(manifest);
    setFixtureProperty(repository, 'pullRequest', null);

    expect(isArchivedContainerManifest(manifest)).toBe(false);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a %s pull-request number', (_label, number) => {
    const manifest = cloneManifest();
    firstPullRequest(manifest).number = number;

    expect(isArchivedContainerManifest(manifest)).toBe(false);
  });

  const invalidPullRequestMutations: Array<
    readonly [string, PullRequestMutation]
  > = [
    [
      'empty title',
      (pullRequest: ArchivedPullRequestMetadata): void => {
        pullRequest.title = '';
      },
    ],
    [
      'blank title',
      (pullRequest: ArchivedPullRequestMetadata): void => {
        pullRequest.title = '   ';
      },
    ],
    [
      'empty base branch',
      (pullRequest: ArchivedPullRequestMetadata): void => {
        pullRequest.baseRefName = '';
      },
    ],
    [
      'blank base branch',
      (pullRequest: ArchivedPullRequestMetadata): void => {
        pullRequest.baseRefName = '   ';
      },
    ],
    [
      'invalid state',
      (pullRequest: ArchivedPullRequestMetadata): void => {
        setFixtureProperty(pullRequest, 'state', 'unknown');
      },
    ],
  ];

  it.each(invalidPullRequestMutations)('rejects an %s', (_label, mutate) => {
    const manifest = cloneManifest();
    mutate(firstPullRequest(manifest));

    expect(isArchivedContainerManifest(manifest)).toBe(false);
  });

  it.each([
    'not a URL',
    'http://github.com/acme/client/pull/42',
    'https://user:secret@github.com/acme/client/pull/42',
    'https://www.github.com/acme/client/pull/42',
    'https://github.com.evil.test/acme/client/pull/42',
    'https://github.com:444/acme/client/pull/42',
    'https://github.com/acme/client/issues/42',
    'https://github.com/acme/client/pull/41',
  ])('rejects invalid pull-request URL %s', (url) => {
    const manifest = cloneManifest();
    firstPullRequest(manifest).url = url;

    expect(isArchivedContainerManifest(manifest)).toBe(false);
  });

  it('requires canonical capture and pull-request timestamps', () => {
    const invalidCapture = cloneManifest();
    invalidCapture.pullRequestMetadata.capturedAt = '2026-07-02T00:00:00Z';
    const invalidPullRequest = cloneManifest();
    firstPullRequest(invalidPullRequest).updatedAt = '2026-07-01';

    expect(isArchivedContainerManifest(invalidCapture)).toBe(false);
    expect(isArchivedContainerManifest(invalidPullRequest)).toBe(false);
  });

  it('deeply clones and whitelists version-2 renderer summaries', () => {
    const manifest = buildMixedPullRequestArchiveManifest();
    const expectedPullRequestMetadata = structuredClone(
      manifest.pullRequestMetadata,
    );
    const expectedBaseBranches = manifest.gitState.repositories.map(
      (repository) => {
        if (!repository.comparisonBaseBranch || !repository.baseBranchCommit) {
          throw new Error('Expected complete base metadata');
        }
        return {
          repoId: repository.repoId,
          repoName: repository.repoName,
          status: 'complete' as const,
          branchName: repository.comparisonBaseBranch,
          commit: repository.baseBranchCommit,
        };
      },
    );
    const pullRequest = firstPullRequest(manifest);
    Object.assign(manifest.pullRequestMetadata, {
      stagingPath: '/private/archive/staging',
    });
    Object.assign(repositoryAt(manifest, 2), {
      lookupError: 'token expired for secret-user',
    });
    Object.assign(pullRequest, {
      headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headRefName: 'private-branch',
      remoteUrl: 'https://secret-user:secret@github.com/acme/service-api.git',
    });

    const summary = toArchivedContainerSummary(manifest);
    if (summary.version !== 2) {
      throw new Error('Expected a version-2 renderer summary');
    }
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      version: 2,
      kind: 'worktree',
      restoredTo: manifest.restoredTo,
      baseBranches: expectedBaseBranches,
      gitChanges: manifest.gitChanges,
      pullRequestMetadata: expectedPullRequestMetadata,
    });
    expect(summary.pullRequestMetadata).not.toBe(manifest.pullRequestMetadata);
    expect(summary.pullRequestMetadata.repositories[0]).not.toBe(
      manifest.pullRequestMetadata.repositories[0],
    );
    const summaryPullRequest =
      summary.pullRequestMetadata.repositories[0]?.status === 'complete'
        ? summary.pullRequestMetadata.repositories[0].pullRequest
        : null;
    expect(summaryPullRequest).not.toBe(pullRequest);
    expect(summary).not.toHaveProperty('gitState');
    expect(summary).not.toHaveProperty('originalWorktree');
    expect(summary).not.toHaveProperty('originalEntry');
    expect(serialized).not.toContain('/private/repos/');
    expect(serialized).not.toContain('/private/archive/staging');
    expect(serialized).not.toContain('refs/app/archived-containers');
    expect(serialized).not.toContain(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(serialized).not.toContain('private-branch');
    expect(serialized).not.toContain('secret-user');
    expect(serialized).not.toContain('lookupError');

    manifest.pullRequestMetadata.capturedAt = '2030-01-01T00:00:00.000Z';
    gitRepositoryAt(manifest, 0).baseBranchCommit = '9'.repeat(40);
    repositoryAt(manifest, 0).repoName = 'mutated';
    pullRequest.title = 'Mutated after projection';
    expect(summary.pullRequestMetadata).toEqual(expectedPullRequestMetadata);
    expect(summary.baseBranches).toEqual(expectedBaseBranches);
  });

  it('projects only a boolean pending execution-restore marker', () => {
    const manifest = cloneManifest();
    Object.assign(manifest, { executionRestorePending: true });

    expect(isArchivedContainerManifest(manifest)).toBe(true);
    expect(toArchivedContainerSummary(manifest)).toMatchObject({
      executionRestorePending: true,
    });
    expect(
      isArchivedContainerManifest({
        ...manifest,
        executionRestorePending: 'yes',
      }),
    ).toBe(false);
  });

  it('projects an unavailable base entry for pre-metadata version-2 archives', () => {
    const manifest = cloneManifest();
    delete gitRepositoryAt(manifest, 0).baseBranchCommit;

    const summary = toArchivedContainerSummary(manifest);

    expect(summary.version).toBe(2);
    if (summary.version !== 2) throw new Error('Expected version 2');
    expect(summary.baseBranches).toEqual([
      {
        repoId: '__single_repo__',
        repoName: 'client',
        status: 'unavailable',
        branchName: 'main',
      },
    ]);
  });

  it('keeps backend-only fields out of the renderer summary type', () => {
    const excludesGitState: 'gitState' extends keyof ArchivedContainerSummary
      ? false
      : true = true;
    const excludesOriginalWorktree: 'originalWorktree' extends keyof ArchivedContainerSummary
      ? false
      : true = true;
    const excludesOriginalEntry: 'originalEntry' extends keyof ArchivedContainerSummary
      ? false
      : true = true;

    expect(excludesGitState).toBe(true);
    expect(excludesOriginalWorktree).toBe(true);
    expect(excludesOriginalEntry).toBe(true);
  });

  it('retains version-1 worktree and work-entry validation and projection', () => {
    const worktreeSummary = toArchivedContainerSummary(version1Manifest);
    const workEntryManifest: ArchivedContainerManifestV1 = {
      ...version1Manifest,
      kind: 'work-entry',
    };
    const workEntrySummary = toArchivedContainerSummary(workEntryManifest);

    expect(worktreeSummary).toEqual({
      ...baseManifest,
      version: 1,
      kind: 'worktree',
    });
    expect(workEntrySummary).toEqual({
      ...baseManifest,
      version: 1,
      kind: 'work-entry',
    });
    expect(worktreeSummary).not.toHaveProperty('pullRequestMetadata');
    expect(workEntrySummary).not.toHaveProperty('pullRequestMetadata');
  });
});
