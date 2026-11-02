import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
const mockInventory = jest.fn();
const mockOwnership = jest.fn();
const mockCatalog = jest.fn();
const mockPending = jest.fn();
jest.mock('../lib/org-project-materialization', () => ({
  getOrgProjectMaterialization: (): object => ({
    hasPendingSetup: mockPending,
  }),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItemsSnapshot: (): unknown => mockInventory(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceOwnership: (): unknown => mockOwnership(),
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): object => ({
    refresh: mockCatalog,
    list: mockCatalog,
  }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): object => ({
    getState: (): object => ({ context: { kind: 'personal' } }),
  }),
}));
jest.mock('../lib/git', () => ({ getRemoteUrlStrict: jest.fn() }));
import { assertLegacyCombineAllowed } from '../lib/org-shared-multi-repo-legacy-guard';
import { assertSharedMultiRepoWorkReady } from '../lib/org-shared-multi-repo-readiness';
const owner = {
  type: 'organization',
  organizationId: 'org',
  projectId: 'definition',
  instanceId: 'instance',
  bindingGeneration: 1,
};
const project: OrgProjectSummary = {
  id: 'definition',
  organizationId: 'org',
  name: 'Shared',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  topology: 'multi-repo',
  repository: null,
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'ADDED',
  listed: true,
  capabilities: { use: true, administer: true, manageCloud: false },
  instance: { id: 'instance', state: 'CLAIMED' },
};
beforeEach((): void => {
  jest.clearAllMocks();
  mockPending.mockResolvedValue(false);
  mockInventory.mockResolvedValue({
    authority: 'ok',
    file: { items: [{ id: 'local', type: 'multi-repo', owner }] },
  });
  mockOwnership.mockResolvedValue({
    authority: 'ok',
    type: 'multi-repo',
    owner,
  });
  mockCatalog.mockResolvedValue({
    stale: false,
    error: null,
    projects: [project],
  });
});
it('refuses legacy combine of a shared source before it can be consumed', async () => {
  await expect(assertLegacyCombineAllowed(['local'])).rejects.toThrow(
    'new shared multi-repo',
  );
});
it('preserves the private-member legacy path only after authoritative classification', async () => {
  mockCatalog.mockResolvedValue({
    stale: false,
    error: null,
    projects: [{ ...project, memberOwned: true, visibility: 'private' }],
  });
  await expect(assertLegacyCombineAllowed(['local'])).resolves.toBeUndefined();
});
it('fails closed when ownership or shared/private classification cannot be read', async () => {
  mockOwnership.mockResolvedValueOnce({ authority: 'unreadable' });
  await expect(assertLegacyCombineAllowed(['local'])).rejects.toThrow(
    'could not be checked',
  );
  mockCatalog.mockResolvedValue({
    stale: true,
    error: 'offline',
    projects: [],
  });
  await expect(assertLegacyCombineAllowed(['local'])).rejects.toThrow(
    'new shared multi-repo',
  );
});
it('does not admit work from a bound but unconfirmed instance', async () => {
  await expect(assertSharedMultiRepoWorkReady('local')).rejects.toThrow(
    'has not finished',
  );
  mockCatalog.mockResolvedValue({
    stale: false,
    error: null,
    projects: [
      { ...project, instance: { id: 'different-instance', state: 'READY' } },
    ],
  });
  await expect(assertSharedMultiRepoWorkReady('local')).rejects.toThrow(
    'has not finished',
  );
});
it('admits work only for the same acknowledged instance, and preserves Personal behavior', async () => {
  mockCatalog.mockResolvedValue({
    stale: false,
    error: null,
    projects: [
      { ...project, instance: { id: owner.instanceId, state: 'READY' } },
    ],
  });
  await expect(
    assertSharedMultiRepoWorkReady('local'),
  ).resolves.toBeUndefined();
  mockOwnership.mockResolvedValue({ authority: 'ok', type: 'multi-repo' });
  await expect(assertLegacyCombineAllowed(['local'])).resolves.toBeUndefined();
  await expect(
    assertSharedMultiRepoWorkReady('local'),
  ).resolves.toBeUndefined();
});

it('keeps new work blocked by an unacknowledged journal even when a cached instance says READY', async () => {
  mockCatalog.mockResolvedValue({
    stale: false,
    error: null,
    projects: [
      { ...project, instance: { id: owner.instanceId, state: 'READY' } },
    ],
  });
  mockPending.mockResolvedValue(true);
  await expect(assertSharedMultiRepoWorkReady('local')).rejects.toThrow(
    'has not finished',
  );
});
