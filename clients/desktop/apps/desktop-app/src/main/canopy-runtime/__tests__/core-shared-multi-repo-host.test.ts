import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
const mockInventory = jest.fn();
const mockCredentials = jest.fn();
const mockRefresh = jest.fn();
const mockRemote = jest.fn();
const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrg = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const sourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const apiId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItemsSnapshot: (): unknown => mockInventory(),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): unknown => mockCredentials(),
}));
jest.mock('../../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): object => ({ refresh: mockRefresh }),
}));
jest.mock('../../lib/git', () => ({
  getRemoteUrlStrict: (path: string): unknown => mockRemote(path),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): object => ({
    getState: (): object => ({
      context: { kind: 'organization', organizationId: otherOrg },
    }),
  }),
}));
jest.mock('../../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: (): Promise<string> =>
    Promise.resolve('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): object => ({ isEnabled: (): boolean => true }),
}));
jest.mock('../../lib/org-project-materialization', () => ({
  getOrgProjectMaterialization: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getOrgSharedMultiRepoCreationsDir: (): string => '/unused',
}));
jest.mock('../../lib/atomic-file', () => ({ writeFileAtomically: jest.fn() }));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('../../canopy-cloud/client', () => ({
  requestCanopyCloudJson: jest.fn(),
}));
import { prepareDesktopSharedMultiRepo } from '../core-shared-multi-repo-host';
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  authorityId: 'local-desktop',
  clientInstanceId: 'test',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read'],
};
const repository = {
  provider: 'github' as const,
  host: 'github.com',
  owner: 'acme',
  name: 'web',
  providerRepoId: '1',
  defaultBranch: 'main',
  verification: 'VERIFIED' as const,
};
const source: OrgProjectSummary = {
  id: sourceId,
  organizationId: org,
  name: 'Web',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  topology: 'multi-repo',
  repository,
  repositories: [
    repository,
    { ...repository, name: 'api', providerRepoId: '2' },
  ],
  repositoryCount: 2,
  repositoriesComplete: true,
  materializationVersion: 1,
  state: 'ACTIVE',
  revision: 3,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'ADDED',
  listed: true,
  capabilities: { use: true, administer: true, manageCloud: false },
  instance: null,
};
const owned = {
  id: 'source-local',
  type: 'multi-repo',
  owner: { type: 'organization', organizationId: org, projectId: sourceId },
  repos: [],
};
beforeEach((): void => {
  jest.clearAllMocks();
  mockInventory.mockResolvedValue({
    authority: 'ok',
    file: { items: [owned] },
  });
  mockCredentials.mockResolvedValue({
    account: { id: 'account' },
    organizations: [
      { id: otherOrg, role: 'ADMIN' },
      { id: org, role: 'ADMIN' },
    ],
    capabilities: ['org-shared-multi-repo-v1'],
  });
  mockRefresh.mockResolvedValue({
    projects: [source],
    stale: false,
    error: null,
  });
  mockRemote.mockResolvedValue(null);
});
it('uses the source owner and complete server definition, independently of navigation/membership order', async () => {
  const preview = await prepareDesktopSharedMultiRepo(caller, {
    mode: 'convert',
    selections: [{ kind: 'workspace', id: owned.id }],
  });
  expect(preview).toMatchObject({
    organizationId: org,
    canCreate: true,
    sourceProjects: [{ projectId: sourceId, expectedRevision: 3 }],
  });
  expect(preview.repositories).toHaveLength(2);
  expect(mockRemote).not.toHaveBeenCalled();
});
it('refuses cross-organization owned sources before any catalog request', async () => {
  mockInventory.mockResolvedValue({
    authority: 'ok',
    file: {
      items: [
        owned,
        {
          ...owned,
          id: 'foreign',
          owner: {
            type: 'organization',
            organizationId: otherOrg,
            projectId: apiId,
          },
        },
      ],
    },
  });
  await expect(
    prepareDesktopSharedMultiRepo(caller, {
      mode: 'combine',
      selections: [
        { kind: 'workspace', id: owned.id },
        { kind: 'workspace', id: 'foreign' },
      ],
    }),
  ).rejects.toThrow('different organizations');
  expect(mockRefresh).not.toHaveBeenCalled();
});
it('locks the complete existing definition and requires an actual new repository for Add', async () => {
  const api: OrgProjectSummary = {
    ...source,
    id: apiId,
    topology: 'single-repo',
    repository: source.repositories?.[1] ?? repository,
  };
  mockRefresh.mockResolvedValue({
    projects: [source, api],
    stale: false,
    error: null,
  });
  await expect(
    prepareDesktopSharedMultiRepo(caller, {
      mode: 'add-repositories',
      selections: [
        { kind: 'workspace', id: owned.id },
        { kind: 'project', id: apiId },
      ],
    }),
  ).rejects.toThrow('additional repository');
});
it('refuses a remote-less selected Personal child instead of silently dropping it', async () => {
  mockInventory.mockResolvedValue({
    authority: 'ok',
    file: {
      items: [
        owned,
        {
          id: 'personal',
          type: 'multi-repo',
          repos: [{ repoPath: '/personal/child' }],
        },
      ],
    },
  });
  await expect(
    prepareDesktopSharedMultiRepo(caller, {
      mode: 'combine',
      selections: [
        { kind: 'workspace', id: owned.id },
        { kind: 'workspace', id: 'personal' },
      ],
    }),
  ).rejects.toThrow('no supported remote');
});
it('keeps creation disabled for members and unknown hosted support', async () => {
  mockCredentials.mockResolvedValue({
    account: { id: 'account' },
    organizations: [{ id: org, role: 'MEMBER' }],
    capabilities: [],
  });
  expect(
    await prepareDesktopSharedMultiRepo(caller, {
      mode: 'convert',
      selections: [{ kind: 'workspace', id: owned.id }],
    }),
  ).toMatchObject({ canCreate: false });
});
