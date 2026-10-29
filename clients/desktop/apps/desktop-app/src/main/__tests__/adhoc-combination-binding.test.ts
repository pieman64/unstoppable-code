/** @jest-environment node */
import type {
  AdhocExistingWorktreeCombineResponse,
  AdhocMultiRepoCombineResponse,
  MultiRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { bindCombinationAfterJoin } from '../lib/adhoc-combination-binding';
import {
  convertOrgProjectCombinationNow,
  reportOrgProjectAutoConversionFailure,
} from '../services/org-project-auto-conversion-host';
import { listWorkspaceItems } from '../lib/workspace-service';

jest.mock('../services/org-project-auto-conversion-host', () => ({
  convertOrgProjectCombinationNow: jest.fn(),
  reportOrgProjectAutoConversionFailure: jest.fn(),
}));
jest.mock('../lib/workspace-service', () => ({
  listWorkspaceItems: jest.fn(),
}));

const mockConvertNow = jest.mocked(convertOrgProjectCombinationNow);
const mockList = jest.mocked(listWorkspaceItems);
const mockFailure = jest.mocked(reportOrgProjectAutoConversionFailure);

const workspace: MultiRepoSidebarItem = {
  id: 'combined',
  type: 'multi-repo',
  name: 'Combined',
  color: '#000000',
  repos: [],
  worktrees: [],
  collapsed: false,
  order: 0,
  temporary: true,
};
const owned: MultiRepoSidebarItem = {
  ...workspace,
  owner: {
    type: 'organization',
    organizationId: 'org',
    projectId: 'member',
    instanceId: 'instance',
    bindingGeneration: 1,
  },
};
function response(
  overrides: Partial<AdhocExistingWorktreeCombineResponse> = {},
): AdhocExistingWorktreeCombineResponse {
  return {
    sourceWorkspaceId: 'source',
    sourceWorktreeId: 'source-tree',
    destinationWorkspaceId: workspace.id,
    destinationWorktreeId: 'destination-tree',
    destinationWorkspace: workspace,
    destinationWorktree: {
      id: 'destination-tree',
      branchName: 'feature',
      createdAt: '2026-10-08T00:00:00Z',
    },
    repoMappings: [
      {
        sourceRepoId: 'old',
        destinationRepoId: 'new',
        repoPath: '/repo',
        repoName: 'Repo',
        newWorktreePath: '/destination/repo',
      },
    ],
    selectedRepoIdRewrites: { old: 'new' },
    sourceRootRepoIdRewrite: 'new',
    filePathRewrites: [{ fromRoot: '/source', toRoot: '/destination' }],
    compatibilitySymlinks: [],
    createdTemporaryWorkspace: true,
    reusedWorkspace: false,
    removedSourceWorktree: true,
    removedTemporaryWorkspaceId: 'removed-source',
    joinedWorktree: {
      workspaceId: 'joined',
      worktreeId: 'joined-tree',
      repoMappings: [],
      selectedRepoIdRewrites: { other: 'new' },
      filePathRewrites: [],
      compatibilitySymlinks: [],
      removedTemporaryWorkspaceId: 'removed-joined',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockConvertNow.mockResolvedValue(null);
  mockList.mockResolvedValue([owned]);
});

it.each([false, true])(
  'binds a new or reused unowned temporary combination (reuse: %s), preserving all response fields',
  async (reusedWorkspace) => {
    const original = response({
      reusedWorkspace,
      createdTemporaryWorkspace: !reusedWorkspace,
    });
    const refreshed = await bindCombinationAfterJoin(original, 'temporary');
    expect(convertOrgProjectCombinationNow).toHaveBeenCalledWith('combined');
    expect(listWorkspaceItems).toHaveBeenCalledWith({
      includeEmptyTemporary: true,
    });
    expect(refreshed).toEqual({ ...original, destinationWorkspace: owned });
    expect(refreshed.joinedWorktree).toBe(original.joinedWorktree);
    expect(original.destinationWorkspace.owner).toBeUndefined();
  },
);

it('preserves the ordinary combine response type', async () => {
  const original: AdhocMultiRepoCombineResponse = response();
  const refreshed: AdhocMultiRepoCombineResponse =
    await bindCombinationAfterJoin(original, 'temporary');
  expect(refreshed).toEqual({ ...original, destinationWorkspace: owned });
});

it.each(['owned', 'permanent', 'missing-temporary', 'update'] as const)(
  'skips %s destinations',
  async (guard) => {
    const original = response({
      destinationWorkspace:
        guard === 'owned'
          ? owned
          : {
              ...workspace,
              temporary:
                guard === 'missing-temporary'
                  ? undefined
                  : guard !== 'permanent',
            },
    });
    await expect(
      bindCombinationAfterJoin(
        original,
        guard === 'update' ? 'update-source-workspace' : 'temporary',
      ),
    ).resolves.toBe(original);
    expect(convertOrgProjectCombinationNow).not.toHaveBeenCalled();
    expect(listWorkspaceItems).not.toHaveBeenCalled();
  },
);

it.each(['null', 'refused', 'threw'] as const)(
  'refreshes a concurrently persisted owner when conversion %s',
  async (decision) => {
    if (decision === 'refused')
      jest.mocked(convertOrgProjectCombinationNow).mockResolvedValue({
        outcome: 'failed',
        workspaceId: 'combined',
        organizationId: 'org',
        reason: 'busy',
        retry: 'later',
      });
    if (decision === 'threw')
      jest
        .mocked(convertOrgProjectCombinationNow)
        .mockRejectedValue(new Error('host failure'));
    const original = response();
    await expect(
      bindCombinationAfterJoin(original, 'temporary'),
    ).resolves.toEqual({ ...original, destinationWorkspace: owned });
    expect(reportOrgProjectAutoConversionFailure).toHaveBeenCalledTimes(
      decision === 'threw' ? 1 : 0,
    );
  },
);

it('awaits conversion before the disk refresh', async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mockConvertNow.mockImplementation(async () => {
    entered();
    await blocked;
    return null;
  });
  const result = bindCombinationAfterJoin(response(), 'temporary');
  await started;
  expect(listWorkspaceItems).not.toHaveBeenCalled();
  release();
  await result;
  expect(listWorkspaceItems).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'wrong-type', 'read-failure'] as const)(
  'retains the committed join response after %s, even when diagnostics fail',
  async (failure) => {
    if (failure === 'missing') mockList.mockResolvedValue([]);
    if (failure === 'wrong-type')
      jest.mocked(listWorkspaceItems).mockResolvedValue([
        {
          id: 'combined',
          type: 'cowork',
          name: 'Task',
          color: '#000000',
          collapsed: false,
          order: 0,
        },
      ]);
    if (failure === 'read-failure')
      mockList.mockRejectedValue(new Error('disk'));
    jest.mocked(convertOrgProjectCombinationNow).mockResolvedValue({
      outcome: 'converted',
      workspaceId: 'combined',
      organizationId: 'event-only-org',
      projectId: 'event-only-project',
    });
    jest
      .mocked(reportOrgProjectAutoConversionFailure)
      .mockImplementation(() => {
        throw new Error('diagnostics');
      });
    const original = response();
    await expect(bindCombinationAfterJoin(original, 'temporary')).resolves.toBe(
      original,
    );
    expect(reportOrgProjectAutoConversionFailure).toHaveBeenCalledTimes(1);
    expect(original.destinationWorkspace.owner).toBeUndefined();
  },
);

it('still refreshes after both the host and its diagnostic fail', async () => {
  jest
    .mocked(convertOrgProjectCombinationNow)
    .mockRejectedValue(new Error('host'));
  mockFailure.mockImplementation(() => {
    throw new Error('diagnostics');
  });
  const original = response();
  await expect(
    bindCombinationAfterJoin(original, 'temporary'),
  ).resolves.toEqual({ ...original, destinationWorkspace: owned });
});

it.each(['null', 'refused', 'threw', 'converted'] as const)(
  'trusts an unowned persisted destination when conversion %s',
  async (decision) => {
    mockList.mockResolvedValue([workspace]);
    if (decision === 'threw')
      mockConvertNow.mockRejectedValue(new Error('conversion'));
    if (decision === 'refused')
      mockConvertNow.mockResolvedValue({
        outcome: 'skipped',
        workspaceId: 'combined',
        reason: 'repositories-span-organizations',
      });
    if (decision === 'converted')
      mockConvertNow.mockResolvedValue({
        outcome: 'converted',
        workspaceId: 'combined',
        organizationId: 'event-only-org',
        projectId: 'event-only-project',
      });
    const original = response();
    const result = await bindCombinationAfterJoin(original, 'temporary');
    expect(result).toEqual(original);
    expect(result.destinationWorkspace.owner).toBeUndefined();
    expect(mockList).toHaveBeenCalledTimes(1);
  },
);
