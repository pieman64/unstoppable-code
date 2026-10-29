import type {
  AppAdvisorProjectAgentAccess,
  ProjectOwnerContext,
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import type { getCodeReviewTarget } from '../lib/code-review-registry';
import type { getPlanExploreTarget } from '../lib/plan-explore-registry';
import {
  ADVISOR_ACCESS_DISABLED,
  decideAppAdvisorAccessForCaller,
  getAppAdvisorProjectAgentAccessSnapshot,
  onAppAdvisorProjectAgentAccessChange,
  resetAppAdvisorProjectAgentAccessForTests,
  setAppAdvisorProjectAgentAccess,
} from '../lib/app-advisor-project-agent-access';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const personal: ProjectOwnerContext = { kind: 'personal' };
const selectedOrganization: ProjectOwnerContext = {
  kind: 'organization',
  organizationId: ORG_A,
};

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
const mockWorkspaceOrganizations: Array<{
  id: string;
  name: string;
  role: string;
}> = [];
const mockWhenIdle = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => mockWhenIdle(),
    getState: (): unknown => ({
      context: { kind: 'personal' },
      organizations: mockWorkspaceOrganizations,
    }),
  })),
}));

function setMemberships(...organizationIds: string[]): void {
  mockWorkspaceOrganizations.splice(
    0,
    mockWorkspaceOrganizations.length,
    ...organizationIds.map((id) => ({ id, name: id, role: 'MEMBER' })),
  );
}
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

describe('App Advisor project-agent access policy', () => {
  beforeEach(() => {
    resetAppAdvisorProjectAgentAccessForTests();
    mockReadWorkspaceConfigDetailed.mockReset();
    mockGetCodeReviewTarget.mockReset();
    mockGetPlanExploreTarget.mockReset();
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('single-repo'),
    );
    setMemberships(ORG_A, ORG_B);
  });

  it('normalizes saved settings and returns snapshots isolated from the cache', async () => {
    const storedAccess = {
      mode: 'selected-owners',
      selectedOwners: [
        personal,
        { kind: 'personal' },
        { kind: 'organization', organizationId: ` ${ORG_A} ` },
        { kind: 'organization', organizationId: ORG_A },
        { kind: 'organization', organizationId: '  ' },
        { kind: 'unknown', organizationId: ORG_B },
        null,
      ],
    };
    setAppAdvisorProjectAgentAccess(storedAccess);

    const expectedAccess: AppAdvisorProjectAgentAccess = {
      mode: 'selected-owners',
      selectedOwners: [
        personal,
        { kind: 'organization', organizationId: ORG_A },
      ],
    };
    const snapshot = getAppAdvisorProjectAgentAccessSnapshot();
    expect(snapshot).toEqual(expectedAccess);

    snapshot.selectedOwners.splice(0);
    const organizationSnapshot =
      getAppAdvisorProjectAgentAccessSnapshot().selectedOwners.find(
        (owner) => owner.kind === 'organization',
      );
    if (organizationSnapshot?.kind === 'organization') {
      organizationSnapshot.organizationId = ORG_B;
    }
    expect(getAppAdvisorProjectAgentAccessSnapshot()).toEqual(expectedAccess);

    const workspaceReads: Record<
      string,
      Awaited<ReturnType<typeof readWorkspaceConfigDetailed>>
    > = {
      'personal-code': workspaceConfigRead('single-repo'),
      'organization-a-code': workspaceConfigRead(
        'multi-repo',
        organizationOwner(ORG_A),
      ),
      'organization-b-code': workspaceConfigRead(
        'single-repo',
        organizationOwner(ORG_B),
      ),
    };
    mockReadWorkspaceConfigDetailed.mockImplementation((workspaceId) =>
      Promise.resolve(
        workspaceReads[workspaceId] ?? workspaceConfigRead('single-repo'),
      ),
    );

    await expect(
      decideAppAdvisorAccessForCaller({ projectId: 'personal-code' }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      decideAppAdvisorAccessForCaller({ projectId: 'organization-a-code' }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      decideAppAdvisorAccessForCaller({ projectId: 'organization-b-code' }),
    ).resolves.toEqual({
      allowed: false,
      reason: ADVISOR_ACCESS_DISABLED,
    });
  });

  it('applies each live setting change to the next access decision', async () => {
    const caller = { projectId: 'personal-code' };
    setAppAdvisorProjectAgentAccess({
      mode: 'disabled',
      selectedOwners: [],
    });
    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: false,
      reason: 'advisor_access_disabled',
    });

    setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });
    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: true,
    });

    setAppAdvisorProjectAgentAccess({
      mode: 'selected-owners',
      selectedOwners: [selectedOrganization],
    });
    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: false,
      reason: 'advisor_access_disabled',
    });

    setAppAdvisorProjectAgentAccess({
      mode: 'selected-owners',
      selectedOwners: [personal],
    });
    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: true,
    });
  });

  it('grants a selected organization only while the account is still a member', async () => {
    mockReadWorkspaceConfigDetailed.mockResolvedValue(
      workspaceConfigRead('single-repo', organizationOwner(ORG_A)),
    );
    setAppAdvisorProjectAgentAccess({
      mode: 'selected-owners',
      selectedOwners: [selectedOrganization],
    });
    const caller = { projectId: 'organization-a-code' };

    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: true,
    });

    setMemberships(ORG_B);
    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: false,
      reason: ADVISOR_ACCESS_DISABLED,
    });

    // A queued account change that removes the membership settles first.
    setMemberships(ORG_A, ORG_B);
    mockWhenIdle.mockImplementationOnce(() => {
      setMemberships(ORG_B);
      return Promise.resolve();
    });
    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: false,
      reason: ADVISOR_ACCESS_DISABLED,
    });

    setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });
    await expect(decideAppAdvisorAccessForCaller(caller)).resolves.toEqual({
      allowed: true,
    });
  });

  it('lets App Advisor itself bypass the project-agent gate even when disabled', async () => {
    setAppAdvisorProjectAgentAccess({
      mode: 'disabled',
      selectedOwners: [],
    });

    await expect(
      decideAppAdvisorAccessForCaller({ projectId: APP_ADVISOR_PROJECT_ID }),
    ).resolves.toEqual({ allowed: true });
    expect(mockReadWorkspaceConfigDetailed).not.toHaveBeenCalled();
  });

  it('fails closed when saved owner resolution is unknown', async () => {
    mockReadWorkspaceConfigDetailed.mockRejectedValue(
      new Error('workspace config read failed'),
    );
    setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });

    await expect(
      decideAppAdvisorAccessForCaller({ projectId: 'unreadable-workspace' }),
    ).resolves.toEqual({ allowed: false, reason: 'owner_unknown' });
  });

  it('notifies change listeners after applying a preference until unsubscribed', () => {
    const seen: string[] = [];
    const throwing = onAppAdvisorProjectAgentAccessChange(() => {
      throw new Error('listener failed');
    });
    const unsubscribe = onAppAdvisorProjectAgentAccessChange(() => {
      seen.push(getAppAdvisorProjectAgentAccessSnapshot().mode);
    });

    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    unsubscribe();
    throwing();
    setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });

    expect(seen).toEqual(['disabled']);
  });

  it('does not notify listeners when a save leaves the setting unchanged', () => {
    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    const listener = jest.fn();
    const unsubscribe = onAppAdvisorProjectAgentAccessChange(listener);
    try {
      // Unrelated preference saves re-apply the same setting.
      setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
      expect(listener).not.toHaveBeenCalled();
      setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
