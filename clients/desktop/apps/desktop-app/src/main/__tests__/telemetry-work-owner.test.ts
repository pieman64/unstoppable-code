const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type WorkspaceType = 'single-repo' | 'multi-repo' | 'cowork';
type DetailedRead = {
  config: Record<string, unknown>;
  authority: 'ok' | 'absent' | 'unreadable';
  ownerMalformed: boolean;
};

const readWorkspaceConfigDetailedMock = jest.fn<
  Promise<DetailedRead>,
  [string]
>(() => Promise.reject(new Error('unconfigured')));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (workspaceId: string): Promise<DetailedRead> =>
    readWorkspaceConfigDetailedMock(workspaceId),
}));

const linkedOrganizationIdsMock = jest.fn<string[], [string]>(() => []);
jest.mock('../services/workspace-target', () => ({
  resolveWorkspaceTarget: (
    projectId: string,
    options: { workspaceOwner: unknown },
  ): Promise<{ workspaceOwner: unknown; linkedOrganizationIds: string[] }> =>
    Promise.resolve({
      workspaceOwner: options.workspaceOwner,
      linkedOrganizationIds: linkedOrganizationIdsMock(projectId),
    }),
}));

type TargetRef = { projectId: string; worktreeId: string } | null;
const getPlanExploreTargetMock = jest.fn<Promise<TargetRef>, [string]>(() =>
  Promise.resolve(null),
);
jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTarget: (id: string): Promise<TargetRef> =>
    getPlanExploreTargetMock(id),
}));

const getCodeReviewTargetMock = jest.fn<Promise<TargetRef>, [string]>(() =>
  Promise.resolve(null),
);
jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTarget: (id: string): Promise<TargetRef> =>
    getCodeReviewTargetMock(id),
}));

import { resolveWorkOwnerOrganization } from '../lib/work-owner';

function workspace(
  owner: string | undefined,
  type: WorkspaceType = 'single-repo',
): void {
  readWorkspaceConfigDetailedMock.mockResolvedValue({
    config: {
      version: 1,
      type,
      repos: [],
      ...(owner
        ? { owner: { type: 'organization', organizationId: owner } }
        : {}),
    },
    authority: 'ok',
    ownerMalformed: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  linkedOrganizationIdsMock.mockReturnValue([]);
  getPlanExploreTargetMock.mockResolvedValue(null);
  getCodeReviewTargetMock.mockResolvedValue(null);
});

describe('resolveWorkOwnerOrganization', () => {
  it('returns an org owner without consulting context', async () => {
    workspace(ORG_A);
    const getContext = jest.fn(() =>
      Promise.resolve({
        kind: 'organization' as const,
        organizationId: ORG_B,
      }),
    );

    await expect(
      resolveWorkOwnerOrganization(
        { projectId: 'project-a', worktreeId: 'wt-a' },
        getContext,
      ),
    ).resolves.toEqual({ kind: 'organization', organizationId: ORG_A });
    expect(getContext).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'organization' as const, organizationId: ORG_A }, true],
    [{ kind: 'organization' as const, organizationId: ORG_B }, false],
    [null, false],
  ])(
    'resolves a linked Personal owner from matching context',
    async (context, matches) => {
      workspace(undefined);
      linkedOrganizationIdsMock.mockReturnValue([ORG_A]);
      const getContext = jest.fn(() => Promise.resolve(context));

      await expect(
        resolveWorkOwnerOrganization(
          { projectId: 'personal-linked', worktreeId: 'wt-1' },
          getContext,
        ),
      ).resolves.toEqual(
        matches
          ? { kind: 'organization', organizationId: ORG_A }
          : { kind: 'none' },
      );
      expect(getContext).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['personal-unlinked', 'multi-repo' as const],
    ['cowork-persisted', 'cowork' as const],
  ])('returns none for %s', async (projectId, type) => {
    workspace(undefined, type);
    const getContext = jest.fn(() => Promise.resolve(null));
    await expect(
      resolveWorkOwnerOrganization(
        { projectId, worktreeId: 'wt-1' },
        getContext,
      ),
    ).resolves.toEqual({ kind: 'none' });
    expect(getContext).not.toHaveBeenCalled();
  });

  it('returns none for App Advisor without reading config', async () => {
    await expect(
      resolveWorkOwnerOrganization(
        { projectId: 'app-advisor', worktreeId: 'wt-1' },
        () => Promise.resolve(null),
      ),
    ).resolves.toEqual({ kind: 'none' });
    expect(readWorkspaceConfigDetailedMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an org-owned Cowork workspace', 'cowork-org-a', 'entry-1'],
    ['the legacy standalone sentinel', 'standalone-chat', 'cowork-org-a'],
  ])(
    'follows the saved organization owner of %s',
    async (_label, projectId, worktreeId) => {
      workspace(ORG_A, 'cowork');
      const getContext = jest.fn(() =>
        Promise.resolve({
          kind: 'organization' as const,
          organizationId: ORG_B,
        }),
      );

      await expect(
        resolveWorkOwnerOrganization({ projectId, worktreeId }, getContext),
      ).resolves.toEqual({ kind: 'organization', organizationId: ORG_A });
      expect(getContext).not.toHaveBeenCalled();
    },
  );

  it('never takes a Personal Cowork owner from the selected context', async () => {
    workspace(undefined, 'cowork');
    linkedOrganizationIdsMock.mockReturnValue([ORG_A]);
    const getContext = jest.fn(() =>
      Promise.resolve({
        kind: 'organization' as const,
        organizationId: ORG_A,
      }),
    );

    await expect(
      resolveWorkOwnerOrganization(
        { projectId: 'cowork-personal', worktreeId: 'entry-1' },
        getContext,
      ),
    ).resolves.toEqual({ kind: 'none' });
    expect(getContext).not.toHaveBeenCalled();
  });

  it.each([
    ['plan-explore-chat', getPlanExploreTargetMock],
    ['code-review-chat', getCodeReviewTargetMock],
  ])('maps %s to its real target', async (projectId, targetMock) => {
    targetMock.mockResolvedValue({
      projectId: 'real-project',
      worktreeId: 'real-wt',
    });
    workspace(ORG_A);
    await expect(
      resolveWorkOwnerOrganization(
        { projectId, worktreeId: 'sentinel-id' },
        () => Promise.resolve(null),
      ),
    ).resolves.toEqual({ kind: 'organization', organizationId: ORG_A });
    expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledWith(
      'real-project',
    );
  });

  it.each(['absent', 'unreadable'] as const)(
    'returns unknown for %s config authority',
    async (authority) => {
      readWorkspaceConfigDetailedMock.mockResolvedValue({
        config: { version: 1, type: 'single-repo', repos: [] },
        authority,
        ownerMalformed: false,
      });
      await expect(
        resolveWorkOwnerOrganization(
          { projectId: 'project-1', worktreeId: 'wt-1' },
          () => Promise.resolve(null),
        ),
      ).resolves.toEqual({ kind: 'unknown' });
    },
  );

  it('returns unknown for malformed config, thrown reads, and missing sentinels', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: { version: 1, type: 'single-repo', repos: [] },
      authority: 'ok',
      ownerMalformed: true,
    });
    await expect(
      resolveWorkOwnerOrganization(
        { projectId: 'project-1', worktreeId: 'wt-1' },
        () => Promise.resolve(null),
      ),
    ).resolves.toEqual({ kind: 'unknown' });

    readWorkspaceConfigDetailedMock.mockRejectedValue(new Error('EIO'));
    await expect(
      resolveWorkOwnerOrganization(
        { projectId: 'project-1', worktreeId: 'wt-1' },
        () => Promise.resolve(null),
      ),
    ).resolves.toEqual({ kind: 'unknown' });

    await expect(
      resolveWorkOwnerOrganization(
        { projectId: 'plan-explore-chat', worktreeId: 'missing' },
        () => Promise.resolve(null),
      ),
    ).resolves.toEqual({ kind: 'unknown' });
  });
});
