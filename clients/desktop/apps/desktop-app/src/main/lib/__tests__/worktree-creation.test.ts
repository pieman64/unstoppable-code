// CAN-3810: admission and projection of the worktree creation boundary, with
// the create service mocked. Real-Git round trips are in
// worktree-creation.integration.test.ts.
jest.mock('../worktree-service', () => ({
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
}));

import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { createWorktreeFromSelection } from '../worktree-creation';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from '../worktree-service';

const mockedCreateSingle = jest.mocked(createSingleRepoWorktree);
const mockedCreateMulti = jest.mocked(createMultiRepoWorktree);

describe('worktree creation boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('projects the typed selection and passes the host lifecycle through', async () => {
    const onGitReady = jest.fn();
    mockedCreateSingle.mockResolvedValueOnce({
      id: 'otter',
      branchName: 'feature/x',
      createdAt: '2026-10-12T00:00:00.000Z',
      trackedBaseBranch: 'main',
      setupPhase: 'git-pending',
    });

    const outcome = await createWorktreeFromSelection({
      workspaceId: 'project',
      workspaceKind: 'single-repo',
      branch: { kind: 'existing', branchName: ' feature/x ' },
      base: { kind: 'branch', baseBranch: 'main' },
      sidebarItemGroupId: 'sig-1',
      existingWorktreeIds: ['heron'],
      deferGitSetup: true,
      startPostCreateSetup: true,
      onGitReady,
    });

    expect(mockedCreateSingle.mock.calls).toEqual([
      [
        {
          workspaceId: 'project',
          existingBranch: 'feature/x',
          baseBranch: 'main',
          sidebarItemGroupId: 'sig-1',
          existingWorktreeIds: ['heron'],
          deferGitSetup: true,
          startPostCreateSetup: true,
          onGitReady,
        },
      ],
    ]);
    expect(mockedCreateMulti).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'created',
      workspaceKind: 'single-repo',
      record: {
        worktreeId: 'otter',
        branchName: 'feature/x',
        createdAt: '2026-10-12T00:00:00.000Z',
        setupPhase: 'git-pending',
        trackedBaseBranch: 'main',
        trackedRepoBaseBranches: {},
        includedRepoIds: null,
      },
      response: {
        id: 'otter',
        branchName: 'feature/x',
        createdAt: '2026-10-12T00:00:00.000Z',
        trackedBaseBranch: 'main',
        setupPhase: 'git-pending',
      },
    });
  });

  it('reports a ready multi-repository creation with its repository scope', async () => {
    mockedCreateMulti.mockResolvedValueOnce({
      id: 'otter',
      branchName: 'otter-1',
      createdAt: '2026-10-12T00:00:00.000Z',
      trackedRepoBaseBranches: { api: 'main' },
    });

    const outcome = await createWorktreeFromSelection({
      workspaceId: 'project',
      workspaceKind: 'multi-repo',
      branch: { kind: 'default' },
      base: { kind: 'per-repository', baseBranches: { api: 'main' } },
      includedRepoIds: ['api'],
    });

    expect(mockedCreateMulti.mock.calls).toEqual([
      [
        {
          workspaceId: 'project',
          baseBranchesByRepo: { api: 'main' },
          includedRepoIds: ['api'],
        },
      ],
    ]);
    expect(outcome).toMatchObject({
      status: 'created',
      record: {
        setupPhase: 'git-ready',
        trackedBaseBranch: null,
        trackedRepoBaseBranches: { api: 'main' },
        includedRepoIds: ['api'],
      },
    });
  });

  it('reports a workspace root that needs repair', async () => {
    const repairIssues = [
      {
        code: 'missing-claude-md' as const,
        message: 'CLAUDE.md is missing',
        blocking: true,
      },
    ];
    mockedCreateMulti.mockResolvedValueOnce({
      id: 'otter',
      branchName: 'otter-1',
      needsRepair: true,
      repairIssues,
    });

    const outcome = await createWorktreeFromSelection({
      workspaceId: 'project',
      workspaceKind: 'multi-repo',
      branch: { kind: 'default' },
      base: { kind: 'repository-default' },
      surfaceNeedsRepairInResponse: true,
    });

    expect(outcome).toMatchObject({
      status: 'needs-repair',
      worktreeId: 'otter',
      branchName: 'otter-1',
      repairIssues,
    });
  });

  describe('admission denies before the service is entered', () => {
    it.each([
      {
        name: 'the read-only shared-container scope',
        request: {
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'default' as const },
          base: { kind: 'repository-default' as const },
        },
        reason: 'read-only-scope',
        message: 'Shared-container recipient workspaces are read-only',
      },
      {
        name: 'a per-repository base for a single repository',
        request: {
          workspaceId: 'project',
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'default' as const },
          base: {
            kind: 'per-repository' as const,
            baseBranches: { api: 'main' },
          },
        },
        reason: 'invalid-selection',
        message:
          'baseBranchesByRepo is only supported for multi-repository projects',
      },
      {
        name: 'an existing branch with a base worktree',
        request: {
          workspaceId: 'project',
          workspaceKind: 'multi-repo' as const,
          branch: { kind: 'existing' as const, branchName: 'feature/x' },
          base: { kind: 'worktree' as const, baseWorktreeId: 'heron' },
        },
        reason: 'invalid-selection',
        message:
          'baseWorktreeId is mutually exclusive with baseBranch and existingBranch',
      },
      {
        name: 'a blank branch name',
        request: {
          workspaceId: 'project',
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'new' as const, branchName: '  ' },
          base: { kind: 'repository-default' as const },
        },
        reason: 'invalid-selection',
        message: 'Branch name must be a non-empty value',
      },
      {
        name: 'included repositories for a single repository',
        request: {
          workspaceId: 'project',
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'default' as const },
          base: { kind: 'repository-default' as const },
          includedRepoIds: ['api'],
        },
        reason: 'invalid-repository-selection',
        message:
          'includedRepoIds is only supported for multi-repository projects',
      },
    ])('refuses $name', async ({ request, reason, message }) => {
      await expect(createWorktreeFromSelection(request)).rejects.toMatchObject({
        reason,
        message,
      });
      expect(mockedCreateSingle).not.toHaveBeenCalled();
      expect(mockedCreateMulti).not.toHaveBeenCalled();
    });

    it('validates the workspace id first', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: 'Not Valid',
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toThrow(
        'Invalid workspaceId: must be lowercase alphanumeric with hyphens',
      );
      expect(mockedCreateSingle).not.toHaveBeenCalled();
    });
  });
});
