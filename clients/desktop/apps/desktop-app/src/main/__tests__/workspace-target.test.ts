import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { resolveOrgProjectRelationships } from '../services/org-project-relationship-service';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { resolveWorkspaceTarget } from '../services/workspace-target';
import type { WorkspaceTargetResolutionError } from '../services/workspace-target';

jest.mock('../lib/sidebar-items', () => ({ readAllSidebarItems: jest.fn() }));
jest.mock('../services/org-project-relationship-service', () => ({
  resolveOrgProjectRelationships: jest.fn(),
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: jest.fn(),
}));

const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const personal: WorkspaceContext = { kind: 'personal' };
const catalogSnapshot = {
  context: `org:${orgA}`,
  revision: 'catalog-1',
  projects: [],
  fetchedAt: '2026-09-26T00:00:00.000Z',
  stale: false,
  error: null,
};
const catalogService = {
  peek: jest.fn().mockReturnValue(catalogSnapshot),
  refresh: jest.fn().mockResolvedValue(catalogSnapshot),
};

beforeEach((): void => {
  jest.clearAllMocks();
  catalogService.peek.mockReturnValue(catalogSnapshot);
  catalogService.refresh.mockResolvedValue(catalogSnapshot);
  jest
    .mocked(getOrgProjectCatalogService)
    .mockReturnValue(
      catalogService as unknown as ReturnType<
        typeof getOrgProjectCatalogService
      >,
    );
  jest.mocked(readAllSidebarItems).mockResolvedValue({
    version: 1,
    items: [
      {
        id: 'personal',
        type: 'single-repo',
        name: 'Personal',
        repoPath: '/repo',
        color: '',
        worktrees: [],
        collapsed: false,
        order: 0,
      },
    ],
  });
  jest.mocked(resolveOrgProjectRelationships).mockResolvedValue({
    status: 'resolved',
    links: [],
  });
});

it('returns an organization owner without treating it as linked', async (): Promise<void> => {
  const workspaceOwner: WorkspaceContext = {
    kind: 'organization',
    organizationId: orgA,
  };
  expect(
    await resolveWorkspaceTarget('workspace', {
      workspaceOwner,
      organizationId: orgA,
    }),
  ).toEqual({ workspaceOwner, linkedOrganizationIds: [] });
  expect(resolveOrgProjectRelationships).not.toHaveBeenCalled();
});

it('returns the requested organization for a linked Personal workspace', async (): Promise<void> => {
  jest.mocked(resolveOrgProjectRelationships).mockResolvedValue({
    status: 'resolved',
    links: [{ projectId: 'project', personalWorkspaceId: 'personal' }],
  });
  expect(
    await resolveWorkspaceTarget('personal', { organizationId: orgA }),
  ).toEqual({
    workspaceOwner: personal,
    linkedOrganizationIds: [orgA],
  });
});

it('refreshes a missing pinned organization catalog before resolving links', async (): Promise<void> => {
  catalogService.peek.mockReturnValueOnce(null);
  jest.mocked(resolveOrgProjectRelationships).mockResolvedValue({
    status: 'resolved',
    links: [{ projectId: 'project', personalWorkspaceId: 'personal' }],
  });

  await expect(
    resolveWorkspaceTarget('personal', { organizationId: orgA }),
  ).resolves.toEqual({
    workspaceOwner: personal,
    linkedOrganizationIds: [orgA],
  });
  expect(catalogService.refresh).toHaveBeenCalledWith({
    kind: 'organization',
    organizationId: orgA,
  });
});

it('keeps a resolved unlinked Personal workspace strict', async (): Promise<void> => {
  expect(
    await resolveWorkspaceTarget('personal', { organizationId: orgA }),
  ).toEqual({ workspaceOwner: personal, linkedOrganizationIds: [] });
});

it('turns an unknown link answer into a bounded transient error', async (): Promise<void> => {
  jest.mocked(resolveOrgProjectRelationships).mockResolvedValue({
    status: 'unknown',
    reason: 'catalog-unavailable',
  });
  await expect(
    resolveWorkspaceTarget('personal', { organizationId: orgA }),
  ).rejects.toMatchObject<WorkspaceTargetResolutionError>({
    reason: 'unknown-provenance',
    transient: true,
  });
});

it('bounds an unavailable sidebar inventory as transient', async (): Promise<void> => {
  jest.mocked(readAllSidebarItems).mockRejectedValue(new Error('unavailable'));
  await expect(
    resolveWorkspaceTarget('personal', { organizationId: orgA }),
  ).rejects.toMatchObject<WorkspaceTargetResolutionError>({
    reason: 'unknown-provenance',
    transient: true,
  });
});

it('does not consult relationships for a non-repository Personal target', async (): Promise<void> => {
  expect(
    await resolveWorkspaceTarget('cowork', {
      organizationId: orgA,
      workspaceOwner: personal,
      linkedPersonalCandidate: false,
    }),
  ).toEqual({ workspaceOwner: personal, linkedOrganizationIds: [] });
  expect(resolveOrgProjectRelationships).not.toHaveBeenCalled();
});
