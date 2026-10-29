import type {
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import type { getCodeReviewTarget } from '../lib/code-review-registry';
import type { getPlanExploreTarget } from '../lib/plan-explore-registry';
import {
  decideSameOwnerAccess,
  isSameProjectOwner,
  resolveAutomationTargetProject,
  resolveProjectSavedOwner,
  type ResolvedProjectOwner,
  type SameOwnerAccessDependencies,
} from '../lib/project-owner';
import { resolveBackgroundWorkspaceTarget } from '../services/background-execution-context';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const mockReadWorkspaceConfigDetailed = jest.fn<
  ReturnType<typeof readWorkspaceConfigDetailed>,
  Parameters<typeof readWorkspaceConfigDetailed>
>();
const mockGetCodeReviewTarget = jest.fn<
  ReturnType<typeof getCodeReviewTarget>,
  Parameters<typeof getCodeReviewTarget>
>();
const mockGetPlanExploreTarget = jest.fn<
  ReturnType<typeof getPlanExploreTarget>,
  Parameters<typeof getPlanExploreTarget>
>();

const mockResolveCoworkWorkspaceId = jest.fn((id: string): string => id);
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (id: string): string =>
    mockResolveCoworkWorkspaceId(id),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (
    ...args: Parameters<typeof mockReadWorkspaceConfigDetailed>
  ): ReturnType<typeof readWorkspaceConfigDetailed> =>
    mockReadWorkspaceConfigDetailed(...args),
}));
jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTarget: (
    ...args: Parameters<typeof mockGetCodeReviewTarget>
  ): ReturnType<typeof getCodeReviewTarget> => mockGetCodeReviewTarget(...args),
}));
jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTarget: (
    ...args: Parameters<typeof mockGetPlanExploreTarget>
  ): ReturnType<typeof getPlanExploreTarget> =>
    mockGetPlanExploreTarget(...args),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({ isEnabled: jest.fn(() => true) })),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): unknown => ({
      context: { kind: 'personal' },
      organizations: [],
    }),
  })),
}));
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: jest.fn(),
}));

function organizationOwner(organizationId: string): WorkspaceOwnerBinding {
  return {
    type: 'organization',
    organizationId,
    projectId: 'organization-project-definition',
    instanceId: 'local-workspace-instance',
    bindingGeneration: 1,
  };
}

function workspaceConfigRead(
  type: WorkspaceConfigFile['type'],
  owner?: WorkspaceOwnerBinding,
): Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> {
  const config: WorkspaceConfigFile = {
    version: 1,
    type,
    repos: [],
    ...(owner ? { owner } : {}),
  };
  return {
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
    config,
  };
}

describe('resolveProjectSavedOwner', () => {
  beforeEach(() => {
    mockReadWorkspaceConfigDetailed.mockReset();
    mockGetCodeReviewTarget.mockReset();
    mockGetPlanExploreTarget.mockReset();
    mockGetCodeReviewTarget.mockResolvedValue(null);
    mockGetPlanExploreTarget.mockResolvedValue(null);
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('single-repo'),
    );
  });

  it('resolves the persisted organization owner of a code workspace', async () => {
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('single-repo', organizationOwner(ORG_A)),
    );

    await expect(
      resolveProjectSavedOwner({
        projectId: 'organization-owned-code-project',
        worktreeId: 'main-worktree',
      }),
    ).resolves.toEqual({ kind: 'organization', organizationId: ORG_A });
    expect(mockReadWorkspaceConfigDetailed).toHaveBeenCalledWith(
      'organization-owned-code-project',
    );
  });

  it('resolves an unbound code workspace as Personal', async () => {
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('multi-repo'),
    );

    await expect(
      resolveProjectSavedOwner({ projectId: 'personal-code-project' }),
    ).resolves.toEqual({ kind: 'personal' });
  });

  it('keeps a linked Personal single-repo workspace Personal', async () => {
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('single-repo'),
    );

    await expect(
      resolveBackgroundWorkspaceTarget('linked-personal-code-project', 'main'),
    ).resolves.toMatchObject({
      workspaceOwner: { kind: 'personal' },
      linkedPersonalCandidate: true,
    });
    await expect(
      resolveProjectSavedOwner({
        projectId: 'linked-personal-code-project',
        worktreeId: 'main',
      }),
    ).resolves.toEqual({ kind: 'personal' });
  });

  it('resolves the default Cowork workspace as Personal', async () => {
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('cowork'),
    );

    await expect(
      resolveProjectSavedOwner({ projectId: 'cowork-default' }),
    ).resolves.toEqual({ kind: 'personal' });
  });

  it('resolves a Cowork organization UUID from the saved owner binding', async () => {
    const coworkWorkspaceId = `cowork-org-${ORG_A}`;
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('cowork', organizationOwner(ORG_A)),
    );

    await expect(
      resolveProjectSavedOwner({ projectId: coworkWorkspaceId }),
    ).resolves.toEqual({ kind: 'organization', organizationId: ORG_A });
    expect(mockReadWorkspaceConfigDetailed).toHaveBeenCalledWith(
      coworkWorkspaceId,
    );
  });

  it('resolves App Advisor as having no saved owner without reading a workspace', async () => {
    await expect(
      resolveProjectSavedOwner({ projectId: APP_ADVISOR_PROJECT_ID }),
    ).resolves.toEqual({ kind: 'none' });
    expect(mockReadWorkspaceConfigDetailed).not.toHaveBeenCalled();
  });

  it('maps a plan-explore sentinel through its persisted real target', async () => {
    mockGetPlanExploreTarget.mockResolvedValue({
      projectId: 'plan-owner-project',
      worktreeId: 'plan-owner-worktree',
    });
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('multi-repo', organizationOwner(ORG_A)),
    );

    await expect(
      resolveProjectSavedOwner({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-id',
      }),
    ).resolves.toEqual({ kind: 'organization', organizationId: ORG_A });
    expect(mockGetPlanExploreTarget).toHaveBeenCalledWith('plan-id');
    expect(mockReadWorkspaceConfigDetailed).toHaveBeenCalledWith(
      'plan-owner-project',
    );
  });

  it('maps a code-review sentinel through its persisted real target', async () => {
    mockGetCodeReviewTarget.mockResolvedValue({
      projectId: 'review-owner-project',
      worktreeId: 'review-owner-worktree',
    });
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('single-repo', organizationOwner(ORG_A)),
    );

    await expect(
      resolveProjectSavedOwner({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'review-scope-key',
      }),
    ).resolves.toEqual({ kind: 'organization', organizationId: ORG_A });
    expect(mockGetCodeReviewTarget).toHaveBeenCalledWith('review-scope-key');
    expect(mockReadWorkspaceConfigDetailed).toHaveBeenCalledWith(
      'review-owner-project',
    );
  });

  it('fails closed when a sentinel has no persisted target mapping', async () => {
    await expect(
      resolveProjectSavedOwner({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'missing-plan',
      }),
    ).resolves.toEqual({ kind: 'unknown' });
    await expect(
      resolveProjectSavedOwner({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'missing-review',
      }),
    ).resolves.toEqual({ kind: 'unknown' });
    expect(mockReadWorkspaceConfigDetailed).not.toHaveBeenCalled();
  });

  it('fails closed when the workspace owner cannot be read', async () => {
    mockReadWorkspaceConfigDetailed.mockRejectedValue(
      new Error('workspace config read failed'),
    );

    await expect(
      resolveProjectSavedOwner({ projectId: 'unreadable-workspace' }),
    ).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('same-owner rule', () => {
  const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const orgA: ResolvedProjectOwner = {
    kind: 'organization',
    organizationId: ORG_A,
  };
  const target = { projectId: 'target-project' };
  const dependencies = (
    owner: ResolvedProjectOwner,
    missing = false,
  ): SameOwnerAccessDependencies => ({
    resolveTargetOwner: (): Promise<ResolvedProjectOwner> =>
      Promise.resolve(owner),
    isMissingTarget: (): Promise<boolean> => Promise.resolve(missing),
  });

  it('compares Personal and organization owners exactly', () => {
    expect(isSameProjectOwner({ kind: 'personal' }, { kind: 'personal' })).toBe(
      true,
    );
    expect(
      isSameProjectOwner(
        { kind: 'organization', organizationId: ORG_A },
        { kind: 'organization', organizationId: ORG_A.toUpperCase() },
      ),
    ).toBe(true);
    expect(
      isSameProjectOwner(
        { kind: 'organization', organizationId: ORG_A },
        { kind: 'organization', organizationId: ORG_B },
      ),
    ).toBe(false);
    expect(
      isSameProjectOwner(
        { kind: 'personal' },
        { kind: 'organization', organizationId: ORG_A },
      ),
    ).toBe(false);
  });

  it('allows same-owner targets and hides other owners and missing projects', async () => {
    await expect(
      decideSameOwnerAccess(orgA, target, dependencies(orgA)),
    ).resolves.toEqual({ kind: 'allowed' });
    await expect(
      decideSameOwnerAccess(
        { kind: 'personal' },
        target,
        dependencies({ kind: 'personal' }),
      ),
    ).resolves.toEqual({ kind: 'allowed' });
    await expect(
      decideSameOwnerAccess(
        orgA,
        target,
        dependencies({ kind: 'organization', organizationId: ORG_B }),
      ),
    ).resolves.toEqual({ kind: 'hidden' });
    await expect(
      decideSameOwnerAccess(orgA, target, dependencies({ kind: 'personal' })),
    ).resolves.toEqual({ kind: 'hidden' });
    await expect(
      decideSameOwnerAccess(orgA, target, dependencies({ kind: 'none' })),
    ).resolves.toEqual({ kind: 'hidden' });
    await expect(
      decideSameOwnerAccess(
        orgA,
        target,
        dependencies({ kind: 'unknown' }, true),
      ),
    ).resolves.toEqual({ kind: 'hidden' });
  });

  it('reports an existing target whose owner cannot be read', async () => {
    await expect(
      decideSameOwnerAccess(orgA, target, dependencies({ kind: 'unknown' })),
    ).resolves.toEqual({ kind: 'target_owner_unknown' });
  });

  it('does not limit App Advisor and reports an unknown caller owner', async () => {
    const resolveTargetOwner = jest.fn(
      (): Promise<ResolvedProjectOwner> =>
        Promise.resolve({ kind: 'personal' }),
    );
    const deps: SameOwnerAccessDependencies = {
      resolveTargetOwner,
      isMissingTarget: (): Promise<boolean> => Promise.resolve(false),
    };
    await expect(
      decideSameOwnerAccess({ kind: 'none' }, target, deps),
    ).resolves.toEqual({ kind: 'allowed' });
    await expect(
      decideSameOwnerAccess({ kind: 'unknown' }, target, deps),
    ).resolves.toEqual({ kind: 'caller_owner_unknown' });
    expect(resolveTargetOwner).not.toHaveBeenCalled();
  });

  it('treats an absent workspace as missing and an unreadable one as unknown', async () => {
    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      authority: 'absent',
      ownerMalformed: false,
      memoryMalformed: false,
      config: { version: 1, type: 'single-repo', repos: [] },
    });
    await expect(
      decideSameOwnerAccess(orgA, { projectId: 'deleted-project' }),
    ).resolves.toEqual({ kind: 'hidden' });

    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      authority: 'unreadable',
      ownerMalformed: false,
      memoryMalformed: false,
      config: { version: 1, type: 'single-repo', repos: [] },
    });
    await expect(
      decideSameOwnerAccess(orgA, { projectId: 'corrupt-project' }),
    ).resolves.toEqual({ kind: 'target_owner_unknown' });
  });
});

describe('resolveAutomationTargetProject', () => {
  it('maps a legacy standalone chat project to its cowork workspace', () => {
    mockResolveCoworkWorkspaceId.mockImplementation((id: string) =>
      id === 'legacy-project-chat' ? 'cowork-1' : id,
    );
    expect(
      resolveAutomationTargetProject({
        type: 'standalone_prompt',
        chatProjectId: 'legacy-project-chat',
        prompt: 'Run',
      }),
    ).toEqual({ kind: 'project', projectId: 'cowork-1' });
    expect(
      resolveAutomationTargetProject({
        type: 'worktree_prompt',
        workspaceId: 'legacy-project-chat',
        prompt: 'Run',
      }),
    ).toEqual({ kind: 'project', projectId: 'legacy-project-chat' });
  });
});
