import type {
  DesktopOrgProjectCatalogSnapshot,
  SidebarItem,
  WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import { CanopyCloudConfigError } from '../canopy-cloud/config';
const mockEnabled = jest.fn<boolean, [string]>();
const mockCredentials = jest.fn();
const mockReadItems = jest.fn();
const mockRemote = jest.fn();
const mockReadLinks = jest.fn();
const mockDismiss = jest.fn();
const mockCatalog = jest.fn();
const mockNetworkCatalog = jest.fn();
const mockSwitch = jest.fn();
let epoch = 0;
let state: WorkspaceContextState;
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({ isEnabled: mockEnabled }),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  get getCanopyCloudCredentials(): typeof mockCredentials {
    return mockCredentials;
  },
}));
jest.mock('../lib/sidebar-items', () => ({
  get readAllSidebarItems(): typeof mockReadItems {
    return mockReadItems;
  },
}));
jest.mock('../lib/git', () => ({
  get getRemoteUrlStrict(): typeof mockRemote {
    return mockRemote;
  },
}));
jest.mock('../lib/org-project-links', () => ({
  get readOrgProjectLinks(): typeof mockReadLinks {
    return mockReadLinks;
  },
  get dismissOrgProjectLink(): typeof mockDismiss {
    return mockDismiss;
  },
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): unknown => ({
    peek: mockCatalog,
    list: mockNetworkCatalog,
  }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    getState: (): WorkspaceContextState => state,
    accountEpoch: (): number => epoch,
    setContext: mockSwitch,
  }),
}));
import {
  listOrgProjectRelationships,
  decideOrgProjectRelationship,
  resolveOrgProjectRelationships,
} from '../services/org-project-relationship-service';
const snapshot: DesktopOrgProjectCatalogSnapshot = {
  context: 'org:org',
  revision: '1',
  fetchedAt: '',
  stale: false,
  error: null,
  projects: [
    {
      id: 'project',
      organizationId: 'org',
      name: 'Repo',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'repo',
        providerRepoId: '123',
        verification: 'VERIFIED',
        defaultBranch: 'main',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { use: true, administer: false, manageCloud: false },
      instance: null,
    },
  ],
};
const personal: SidebarItem = {
  id: 'personal',
  type: 'single-repo',
  name: 'Private name',
  repoPath: '/private/path',
  color: '',
  worktrees: [],
  collapsed: false,
  order: 0,
};
beforeEach((): void => {
  jest.clearAllMocks();
  epoch = 0;
  state = {
    context: { kind: 'organization', organizationId: 'org' },
    revision: 1,
    organizations: [{ id: 'org', name: 'Org', role: 'MEMBER' }],
  };
  mockEnabled.mockReturnValue(true);
  mockCredentials.mockResolvedValue({ account: { id: 'account' } });
  mockReadItems.mockResolvedValue({ items: [personal] });
  mockRemote.mockResolvedValue('git@github.com:acme/repo.git');
  mockReadLinks.mockResolvedValue({ version: 1, byAccount: {} });
  mockCatalog.mockReturnValue(snapshot);
  mockNetworkCatalog.mockResolvedValue(snapshot);
});
it('returns only local ids and does not pass Personal inventory to the catalog', async (): Promise<void> => {
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'resolved',
    links: [{ projectId: 'project', personalWorkspaceId: 'personal' }],
  });
  expect(mockCatalog.mock.calls).toEqual([
    [{ kind: 'organization', organizationId: 'org' }],
  ]);
  expect(mockNetworkCatalog).not.toHaveBeenCalled();
  expect(mockRemote).toHaveBeenCalledWith('/private/path');
  expect(JSON.stringify(snapshot)).not.toContain('personal');
});
it.each(['ADMIN', 'OWNER'])(
  'still matches the viewer\u2019s OWN Personal checkout as %s',
  async (role): Promise<void> => {
    // The privacy property is that the match is computed on this device from
    // this device's inventory, so it is never another member's data. An admin
    // with the same repository in Personal has the same duplicate-checkout
    // problem this notice exists to prevent, and gating on role would hand
    // them the duplicate silently.
    state = {
      ...state,
      organizations: [
        { id: 'org', name: 'Org', role: role === 'ADMIN' ? 'ADMIN' : 'OWNER' },
      ],
    };
    expect(await listOrgProjectRelationships()).toEqual({
      status: 'resolved',
      links: [{ projectId: 'project', personalWorkspaceId: 'personal' }],
    });
    await decideOrgProjectRelationship({
      projectId: 'project',
      personalWorkspaceId: 'personal',
      decision: 'dismiss',
    });
    expect(mockDismiss).toHaveBeenCalled();
  },
);
it('gates both reads and decisions before touching private inventory', async (): Promise<void> => {
  mockEnabled.mockReturnValue(false);
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'resolved',
    links: [],
  });
  await expect(
    decideOrgProjectRelationship({
      projectId: 'project',
      personalWorkspaceId: 'personal',
      decision: 'view',
    }),
  ).rejects.toThrow();
  expect(mockReadItems).not.toHaveBeenCalled();
  expect(mockCatalog).not.toHaveBeenCalled();
});
it('discards an account transition during local remote reading', async (): Promise<void> => {
  mockRemote.mockImplementation((): Promise<string> => {
    epoch += 1;
    return Promise.resolve('git@github.com:acme/repo');
  });
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'unknown',
    reason: 'context-changed',
  });
});
it('persists only the authenticated account and validates the relationship', async (): Promise<void> => {
  await decideOrgProjectRelationship({
    projectId: 'project',
    personalWorkspaceId: 'personal',
    decision: 'dismiss',
  });
  expect(mockDismiss).toHaveBeenCalledWith('account', 'project', 'personal');
  await expect(
    decideOrgProjectRelationship({
      projectId: 'project',
      personalWorkspaceId: 'other',
      decision: 'dismiss',
    }),
  ).rejects.toThrow();
  expect(mockDismiss).toHaveBeenCalledTimes(1);
});
it('filters only this account’s dismissals', async (): Promise<void> => {
  mockReadLinks.mockResolvedValue({
    version: 1,
    byAccount: { other: { 'project:personal': 'dismissed' } },
  });
  expect(await listOrgProjectRelationships()).toMatchObject({
    status: 'resolved',
    links: [expect.any(Object)],
  });
  mockReadLinks.mockResolvedValue({
    version: 1,
    byAccount: { account: { 'project:personal': 'dismissed' } },
  });
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'resolved',
    links: [],
  });
});
it('View switches and selects the organization project without persisting or setting up', async (): Promise<void> => {
  expect(
    await decideOrgProjectRelationship({
      projectId: 'project',
      personalWorkspaceId: 'personal',
      decision: 'view',
    }),
  ).toEqual({
    ok: true,
    organizationId: 'org',
    projectId: 'project',
    workspaceId: null,
  });
  expect(mockSwitch).toHaveBeenCalledWith(
    { kind: 'organization', organizationId: 'org' },
    1,
  );
  expect(mockDismiss).not.toHaveBeenCalled();
});

it('does not fetch a catalog or inspect Personal while the authorized cache is absent', async (): Promise<void> => {
  mockCatalog.mockReturnValue(null);
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'unknown',
    reason: 'catalog-unavailable',
  });
  expect(mockNetworkCatalog).not.toHaveBeenCalled();
  expect(mockReadItems).not.toHaveBeenCalled();
});

it('treats a stale offline catalog as unavailable authorization evidence', async (): Promise<void> => {
  mockCatalog.mockReturnValue({ ...snapshot, stale: true, error: 'offline' });
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'unknown',
    reason: 'catalog-unavailable',
  });
  expect(mockReadItems).not.toHaveBeenCalled();
});

it('reports a remote lookup failure as unknown but a missing origin as resolved', async (): Promise<void> => {
  mockRemote.mockRejectedValueOnce(new Error('git unavailable'));
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'unknown',
    reason: 'remote-unavailable',
  });
  mockRemote.mockResolvedValueOnce(null);
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'resolved',
    links: [],
  });
});

it('reports missing credentials as unknown', async (): Promise<void> => {
  mockCredentials.mockRejectedValue(
    new CanopyCloudConfigError('api-key-required', 'API key is required'),
  );
  expect(await listOrgProjectRelationships()).toEqual({
    status: 'unknown',
    reason: 'credentials-unavailable',
  });
});

it('resolves an explicit member organization independently of the active context', async (): Promise<void> => {
  state = {
    context: { kind: 'personal' },
    revision: 1,
    organizations: [{ id: 'org', name: 'Org', role: 'MEMBER' }],
  };
  expect(await resolveOrgProjectRelationships('org')).toEqual({
    status: 'resolved',
    links: [{ projectId: 'project', personalWorkspaceId: 'personal' }],
  });
});

it.each([
  { label: 'archived', patch: { state: 'ARCHIVED' as const } },
  {
    label: 'ready',
    patch: { instance: { id: 'instance', state: 'READY' as const } },
  },
  { label: 'unlisted', patch: { listed: false } },
])('does not link a $label catalog project', async ({ patch }) => {
  mockCatalog.mockReturnValue({
    ...snapshot,
    projects: [{ ...snapshot.projects[0], ...patch }],
  });
  expect(await resolveOrgProjectRelationships('org')).toEqual({
    status: 'resolved',
    links: [],
  });
});

it('treats a non-member organization as ineligible without reading inventory', async (): Promise<void> => {
  state = { ...state, organizations: [] };
  expect(await resolveOrgProjectRelationships('org')).toEqual({
    status: 'ineligible',
  });
  expect(mockReadItems).not.toHaveBeenCalled();
});
