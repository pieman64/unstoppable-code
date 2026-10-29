import {
  assertStoredAgentContext,
  filterStoredAgentContexts,
  recordSharedAgentInstall,
  assertAgentShareOrigin,
  sharedAgentIsAuthoredByCurrentAccount,
} from '../agent-install-context';
import { getSharedAgent } from '../canopy-server-client';
import type { SharedAgentDetail } from '@canopy/desktop-shared/types/agent-models';
import type {
  ResourceContextDecision,
  ResourceContextInput,
  InstallReceipt,
} from '@canopy/desktop-shared/lib/resource-context-policy';
const mockEnabled = jest.fn(() => true);
const mockDecide = jest.fn<
  Promise<ResourceContextDecision>,
  [ResourceContextInput]
>(() => Promise.resolve({ allow: true }));
const mockFindLocal = jest.fn();
const mockRecord = jest.fn<Promise<void>, [InstallReceipt]>(() =>
  Promise.resolve(),
);
const mockAccount = jest.fn(() =>
  Promise.resolve({ status: 'ok', entry: { account: { id: 'user-a' } } }),
);
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({ isEnabled: mockEnabled })),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: jest.fn(() => Promise.resolve()),
    whenIdle: jest.fn(() => Promise.resolve()),
    accountEpoch: jest.fn(() => 1),
    getState: jest.fn(() => ({ revision: 1, context: { kind: 'personal' } })),
  })),
}));
jest.mock('../../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({ decide: mockDecide })),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: jest.fn(() => mockAccount()),
}));
jest.mock('../../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: mockFindLocal,
    record: mockRecord,
  })),
}));
jest.mock('../canopy-server-client', () => ({ getSharedAgent: jest.fn() }));
const detail: SharedAgentDetail = {
  id: 'remote-a',
  name: 'Release',
  modelId: 'agent_model_release',
  baseModel: 'sonnet',
  instructionsPreview: '',
  contentHash: 'hash',
  publicShare: null,
  createdBy: { id: 'user-a', name: 'User' },
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
  canUpdate: true,
  canDelete: true,
  agent: {
    version: 1,
    id: 'agent_model_release',
    name: 'Release',
    baseModel: 'sonnet',
    instructions: '',
    plugins: [],
  },
  shareScope: 'organization',
  owner: {
    type: 'organization',
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'A',
  },
};
const receipt: InstallReceipt = {
  family: 'agents',
  remoteId: detail.id,
  shareScope: 'organization',
  ownerContext: {
    kind: 'organization',
    organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  },
  hash: 'old',
  authorizedAt: '2026-09-23T00:00:00Z',
  localResourceIds: ['local-a'],
};
beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled.mockReturnValue(true);
  mockFindLocal.mockResolvedValue(undefined);
  jest.mocked(getSharedAgent).mockResolvedValue(detail);
});
it('preserves the flag-off local path without consulting account or receipts', async () => {
  mockEnabled.mockReturnValue(false);
  await assertStoredAgentContext('local-a');
  await recordSharedAgentInstall(detail, 'local-a');
  expect(mockAccount).not.toHaveBeenCalled();
  expect(mockDecide).not.toHaveBeenCalled();
});
it('checks genuine local resources through the policy service', async () => {
  await assertStoredAgentContext('personal');
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      resource: { owner: { type: 'user', id: 'local', name: null } },
    }),
  );
});
it('rechecks remote authorization and provenance for an edited installed copy', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  await assertStoredAgentContext('local-a');
  expect(getSharedAgent).toHaveBeenCalledWith('remote-a');
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      resource: { owner: detail.owner, provenance: receipt },
    }),
  );
});
it('blocks revoked shared origins before reading local content', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  jest
    .mocked(getSharedAgent)
    .mockRejectedValueOnce(new Error('Agent unavailable (access-removed)'));
  await expect(assertStoredAgentContext('local-a')).rejects.toThrow(
    'access-removed',
  );
});
it('blocks a copy installed under another account', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'other-user', receipt });
  await expect(assertStoredAgentContext('local-a')).rejects.toThrow(
    'access-removed',
  );
  expect(getSharedAgent).not.toHaveBeenCalled();
});
it('records remote identity, owner, content hash and local binding', async () => {
  await recordSharedAgentInstall(detail, 'local-a');
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      family: 'agents',
      remoteId: 'remote-a',
      localResourceIds: ['local-a'],
      ownerContext: receipt.ownerContext,
    }),
  );
});
it('recognizes a share created by the current cloud account', async () => {
  await expect(sharedAgentIsAuthoredByCurrentAccount(detail)).resolves.toBe(
    true,
  );
});
it('fails closed when the current cloud account did not create the share', async () => {
  mockAccount.mockResolvedValueOnce({
    status: 'ok',
    entry: { account: { id: 'other-user' } },
  });
  await expect(sharedAgentIsAuthoredByCurrentAccount(detail)).resolves.toBe(
    false,
  );
});
it('backfills receipts for pre-lane installed agents before returning content', async () => {
  await assertStoredAgentContext('legacy', undefined, detail.id);
  expect(getSharedAgent).toHaveBeenCalledWith(detail.id);
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      remoteId: detail.id,
      localResourceIds: ['legacy'],
    }),
  );
});
it('authorizes imported provenance when lanes are enabled after installation', async () => {
  const rows = [{ id: 'local-a', importedFromRemoteId: detail.id }];

  await expect(filterStoredAgentContexts(rows)).resolves.toEqual(rows);

  expect(getSharedAgent).toHaveBeenCalledWith(detail.id);
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      remoteId: detail.id,
      localResourceIds: ['local-a'],
    }),
  );
});

it.each(['local-a'])(
  'does not republish organization origin %s as private',
  async (source) => {
    mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
    mockDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'unsupported-target',
    });
    await expect(
      assertAgentShareOrigin(source, {
        type: 'user',
        id: 'user-a',
        name: 'User',
      }),
    ).rejects.toThrow('unsupported-target');
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { workspaceOwner: { kind: 'personal' } },
      }),
    );
  },
);
