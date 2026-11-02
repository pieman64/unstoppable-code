import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import type { PortalAdapterContext } from '../types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockQuery = jest.fn<Promise<unknown>, [string, unknown, unknown]>();
const mockInstruction = jest.fn();
const mockCredentials = jest.fn();
const mockDevice = jest.fn();
const mockRefresh = jest.fn();
const mockPreference = jest.fn();
const mockStart = jest.fn();
const mockCancel = jest.fn();
const mockProgress = jest.fn();
const mockPreferences = jest.fn();
let mockDefaultRoot: string;
jest.mock('../../../lib/paths', () => ({
  getDefaultReposDir: (): string => mockDefaultRoot,
}));
jest.mock('../../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    query: mockQuery,
    instruction: mockInstruction,
  }),
}));
jest.mock('../../../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): unknown => mockCredentials(),
}));
jest.mock('../../../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: (): unknown => mockDevice(),
}));
jest.mock('../../../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): object => ({
    refresh: mockRefresh,
    setPreference: mockPreference,
  }),
}));
jest.mock('../../../lib/org-project-materialization', () => ({
  getOrgProjectMaterialization: (): object => ({
    startSetup: mockStart,
    cancelSetup: mockCancel,
    getProgress: mockProgress,
  }),
}));
jest.mock('../../../lib/preferences-store', () => ({
  readPreferencesFile: (): unknown => mockPreferences(),
}));
import { handlePortalSharedMultiRepo } from '../shared-multi-repo-adapter';

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const organizationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const projectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const identity = { version: 1, accountId, deviceId };
const scope = { accountId, deviceId, organizationId };
const mockComplete = jest.fn();
const mockFail = jest.fn();
const context: PortalAdapterContext = {
  sessionId: 'paired-session',
  getWindow: (): null => null,
  enqueueEvent: jest.fn(),
  complete: mockComplete,
  fail: mockFail,
};
function command(payload: unknown): PortalCommandEnvelope {
  return {
    id: 'transport-id',
    sequence: 1,
    type: 'portal.org_projects.shared_multi_repo',
    payload,
    createdAt: '2026-10-26T00:00:00.000Z',
    expiresAt: null,
  };
}
beforeEach(async (): Promise<void> => {
  mockDefaultRoot = await mkdtemp(join(tmpdir(), 'can-3571-default-'));
  jest.clearAllMocks();
  mockPreferences.mockResolvedValue({
    orgProjectDefaultDestinationRoot: '/paired/destinations',
  });
  mockCredentials.mockResolvedValue({
    account: { id: accountId },
    organizations: [{ id: organizationId }],
  });
  mockDevice.mockResolvedValue(deviceId);
  mockRefresh.mockResolvedValue({
    stale: false,
    error: null,
    projects: [{ id: projectId, capabilities: { use: true } }],
  });
  mockQuery.mockResolvedValue({ state: 'create-unconfirmed' });
});
afterEach(async () => {
  await rm(mockDefaultRoot, { recursive: true, force: true });
});
it('rejects unknown versions and unpaired provenance before invoking backend ports', async () => {
  const request = command({ ...identity, version: 2, action: 'listCreations' });
  await handlePortalSharedMultiRepo(request, context);
  await handlePortalSharedMultiRepo(
    command({ ...identity, action: 'listCreations' }),
    { ...context, sessionId: null },
  );
  expect(mockFail).toHaveBeenCalledTimes(2);
  expect(mockCredentials).not.toHaveBeenCalled();
  expect(mockQuery).not.toHaveBeenCalled();
});
it.each(['account', 'device'])(
  'refuses a changed %s before dispatch or observation',
  async (changed) => {
    if (changed === 'account')
      mockCredentials.mockResolvedValue({ account: { id: projectId } });
    else mockDevice.mockResolvedValue(projectId);
    await handlePortalSharedMultiRepo(
      command({
        ...identity,
        action: 'getCreation',
        creationKey: 'immutable-key',
      }),
      context,
    );
    expect(mockFail).toHaveBeenCalledWith(
      expect.anything(),
      'invalid_target',
      expect.any(String),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockInstruction).not.toHaveBeenCalled();
  },
);
it('observes through the core query without replaying creation', async () => {
  const request = command({
    ...identity,
    action: 'getCreation',
    creationKey: 'immutable-key',
  });
  await handlePortalSharedMultiRepo(request, context);
  expect(mockQuery).toHaveBeenCalledWith(
    'core.workspace.sharedMultiRepo.getCreation',
    { creationKey: 'immutable-key' },
    expect.anything(),
  );
  const options: unknown = mockQuery.mock.calls[0]?.[2];
  expect(options).toMatchObject({
    caller: {
      interfaceKind: 'portal',
      clientInstanceId: 'portal-session:paired-session',
    },
  });
  expect(mockInstruction).not.toHaveBeenCalled();
  expect(mockComplete).toHaveBeenCalledWith(request, {
    state: 'create-unconfirmed',
  });
});
it('wraps saved attempts so the browser command route preserves the list', async () => {
  const creations = [
    {
      creationKey: 'immutable-key',
      organizationId,
      deviceId,
      state: 'create-unconfirmed',
      updatedAt: '2026-10-26T19:00:00.000Z',
    },
  ];
  mockQuery.mockResolvedValue(creations);
  const request = command({ ...identity, action: 'listCreations', limit: 50 });
  await handlePortalSharedMultiRepo(request, context);
  expect(mockQuery).toHaveBeenCalledWith(
    'core.workspace.sharedMultiRepo.listCreations',
    { limit: 50 },
    expect.anything(),
  );
  expect(mockComplete).toHaveBeenCalledWith(request, { version: 1, creations });
});
it('pins setup, cancellation and progress to the selected desktop and account', async () => {
  for (const action of ['startSetup', 'cancelSetup', 'setupProgress']) {
    await handlePortalSharedMultiRepo(
      command({ ...identity, action, organizationId, projectId }),
      context,
    );
  }
  expect(mockStart).toHaveBeenCalledWith(
    projectId,
    '/paired/destinations',
    scope,
  );
  expect(mockCancel).toHaveBeenCalledWith(projectId, scope);
  expect(mockProgress).toHaveBeenCalledWith(projectId, scope);
});
it('does not start setup when current project authorization is missing', async () => {
  mockRefresh.mockResolvedValue({ stale: false, error: null, projects: [] });
  await expect(
    handlePortalSharedMultiRepo(
      command({ ...identity, action: 'startSetup', organizationId, projectId }),
      context,
    ),
  ).rejects.toThrow('Project access');
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockPreference).not.toHaveBeenCalled();
});
it('uses the paired desktop standard clone folder on a first setup with no remembered destination', async () => {
  mockPreferences.mockResolvedValue({});
  await handlePortalSharedMultiRepo(
    command({ ...identity, action: 'startSetup', organizationId, projectId }),
    context,
  );
  expect(mockStart).toHaveBeenCalledWith(projectId, mockDefaultRoot, scope);
});
it('pages complete catalog rows without truncating an individual definition', async () => {
  const projects = [1, 2, 3].map((index) => ({
    id: String(index),
    repositories: [{ name: 'one' }, { name: 'two' }],
  }));
  mockRefresh.mockResolvedValue({ stale: false, error: null, projects });
  const request = command({
    ...identity,
    action: 'catalog',
    organizationId,
    offset: 1,
    limit: 1,
  });
  await handlePortalSharedMultiRepo(request, context);
  expect(mockComplete).toHaveBeenCalledWith(request, {
    stale: false,
    error: null,
    projects: [projects[1]],
    nextOffset: 2,
  });
});
