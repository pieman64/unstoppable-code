import {
  decideResourceContext,
  type InstallReceipt,
  type ResourceContextInput,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  assertInstalledResourceContext,
  assertInstalledResourceShare,
  classifyInstalledResourceOrigin,
  recordResourceInstall,
} from '../resource-install-context';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let mockContext: WorkspaceContext = { kind: 'organization', organizationId };
let mockEnabled = true;
const mockAccount = jest.fn<Promise<unknown>, []>();
const mockFindLocal = jest.fn();
const mockRecord = jest.fn();
const mockFetch = jest.fn();
const mockPublicSnapshot = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../canopy-cloud/public-share-client', () => ({
  getPublicCollectionShareSnapshot: (...args: unknown[]): Promise<unknown> =>
    mockPublicSnapshot(...args),
}));
const mockDecide = jest.fn((input: ResourceContextInput) =>
  Promise.resolve(decideResourceContext(input)),
);

describe('classifyInstalledResourceOrigin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount.mockResolvedValue({
      status: 'ok',
      entry: { account: { id: 'account' } },
    });
  });

  it('classifies local, Personal, and organization-installed resources without a cloud read', async () => {
    mockFindLocal
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        accountId: 'account',
        receipt: {
          family: 'skills',
          remoteId: 'personal',
          shareScope: 'private',
          ownerContext: { kind: 'personal' },
          hash: 'personal-hash',
          authorizedAt: '2026-09-23T00:00:00Z',
        },
      })
      .mockResolvedValueOnce({
        accountId: 'account',
        receipt: {
          family: 'skills',
          remoteId: 'organization',
          shareScope: 'organization',
          ownerContext: { kind: 'organization', organizationId },
          hash: 'organization-hash',
          authorizedAt: '2026-09-23T00:00:00Z',
        },
      });

    await expect(
      classifyInstalledResourceOrigin('skills', 'local'),
    ).resolves.toBe('local');
    await expect(
      classifyInstalledResourceOrigin('skills', 'personal'),
    ).resolves.toBe('personal');
    await expect(
      classifyInstalledResourceOrigin('skills', 'organization'),
    ).resolves.toBe('excluded');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the account store is unreadable', async () => {
    mockAccount.mockResolvedValue({ status: 'unreadable' });
    await expect(
      classifyInstalledResourceOrigin('collections', 'local'),
    ).rejects.toThrow('account');
    expect(mockFindLocal).not.toHaveBeenCalled();
  });
});
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn(() => mockEnabled),
  })),
}));
jest.mock('../workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    getState: jest.fn(() => ({ context: mockContext })),
  })),
}));
jest.mock('../../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({ decide: mockDecide })),
}));
jest.mock('../canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: jest.fn(() => mockAccount()),
}));
jest.mock('../resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: mockFindLocal,
    record: mockRecord,
  })),
}));

const detail = {
  id: 'remote',
  owner: { type: 'organization', id: organizationId, name: 'A' },
  shareScope: 'organization' as const,
  contentHash: 'hash',
};

describe.each(['automations', 'collections'] as const)(
  '%s installed context',
  (family) => {
    let receipt: InstallReceipt;
    beforeEach(() => {
      jest.clearAllMocks();
      mockEnabled = true;
      mockContext = { kind: 'organization', organizationId };
      mockAccount.mockResolvedValue({
        status: 'ok',
        entry: { account: { id: 'account' } },
      });
      receipt = {
        family,
        remoteId: detail.id,
        shareScope: 'organization',
        ownerContext: mockContext,
        hash: detail.contentHash,
        authorizedAt: '2026-09-23T00:00:00Z',
        localResourceIds: ['local'],
      };
      mockFindLocal.mockResolvedValue({ accountId: 'account', receipt });
      mockFetch.mockResolvedValue(detail);
      mockRecord.mockResolvedValue(undefined);
    });
    it('reauthorizes remote origin on every use of an edited local copy', async () => {
      await assertInstalledResourceContext(family, 'local', mockFetch);
      expect(mockFetch).toHaveBeenCalledWith('remote');
      expect(mockDecide).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: { owner: detail.owner, provenance: receipt },
        }),
      );
      mockFetch.mockRejectedValueOnce(new Error('revoked'));
      await expect(
        assertInstalledResourceContext(family, 'local', mockFetch),
      ).rejects.toThrow('revoked');
    });
    it('cannot turn the installed origin into Personal by sharing it', async () => {
      await expect(
        assertInstalledResourceShare(
          family,
          'local',
          { kind: 'personal' },
          mockFetch,
        ),
      ).rejects.toThrow('unsupported-target');
    });
    it('retains private portability when sharing from an organization context', async () => {
      mockFindLocal.mockResolvedValue({
        accountId: 'account',
        receipt: {
          ...receipt,
          shareScope: 'private',
          ownerContext: { kind: 'personal' },
        },
      });
      mockFetch.mockResolvedValue({
        ...detail,
        owner: { type: 'user', id: 'user', name: 'User' },
      });
      await expect(
        assertInstalledResourceShare(
          family,
          'local',
          { kind: 'personal' },
          mockFetch,
        ),
      ).resolves.toBeUndefined();
    });
    it('refuses a prior-account origin after sign-out', async () => {
      mockAccount.mockResolvedValue({ status: 'ok', entry: null });
      await expect(
        assertInstalledResourceContext(family, 'local', mockFetch),
      ).rejects.toThrow('Resource unavailable');
      expect(mockFetch).not.toHaveBeenCalled();
    });
    it('records the authenticated remote owner with a durable local alias', async () => {
      await recordResourceInstall(family, detail, ['local']);
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          family,
          remoteId: 'remote',
          localResourceIds: ['local'],
          ownerContext: { kind: 'organization', organizationId },
        }),
      );
    });
    it('does not consult identity, receipts or policy with the flag disabled', async () => {
      mockEnabled = false;
      await assertInstalledResourceContext(family, 'local', mockFetch);
      await recordResourceInstall(family, detail, ['local']);
      expect(mockAccount).not.toHaveBeenCalled();
      expect(mockDecide).not.toHaveBeenCalled();
    });
  },
);

it('reauthorizes a Public collection receipt without the scoped endpoint, including sharing', async () => {
  jest.clearAllMocks();
  mockEnabled = true;
  mockContext = { kind: 'personal' };
  mockAccount.mockResolvedValue({
    status: 'ok',
    entry: { account: { id: 'account' } },
  });
  mockFindLocal.mockResolvedValue({
    accountId: 'account',
    receipt: {
      family: 'collections',
      remoteId: 'public-a',
      sourceKind: 'public-share',
      shareScope: 'private',
      ownerContext: { kind: 'personal' },
      hash: 'hash',
      authorizedAt: '2026-09-23T00:00:00Z',
      localResourceIds: ['local'],
    },
  });
  mockPublicSnapshot.mockResolvedValue({
    externalId: 'public-a',
    contentHash: 'hash',
  });
  await expect(
    assertInstalledResourceContext('collections', 'local', mockFetch),
  ).resolves.toBeUndefined();
  await expect(
    assertInstalledResourceShare(
      'collections',
      'local',
      { kind: 'personal' },
      mockFetch,
    ),
  ).resolves.toBeUndefined();
  expect(mockPublicSnapshot).toHaveBeenCalledWith('public-a');
  expect(mockFetch).not.toHaveBeenCalled();
  mockPublicSnapshot.mockRejectedValueOnce(new Error('revoked'));
  await expect(
    assertInstalledResourceContext('collections', 'local', mockFetch),
  ).rejects.toThrow('revoked');
});

describe('Public collection installs without the installing account', () => {
  const publicDetail = {
    id: 'public-a',
    contentHash: 'hash',
    owner: { shareScope: 'private' },
    shareScope: 'private' as const,
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnabled = true;
    mockContext = { kind: 'personal' };
    mockRecord.mockResolvedValue(undefined);
    mockPublicSnapshot.mockResolvedValue({
      externalId: 'public-a',
      contentHash: 'hash',
    });
    mockFindLocal.mockResolvedValue({
      accountId: 'account',
      receipt: {
        family: 'collections',
        remoteId: 'public-a',
        sourceKind: 'public-share',
        shareScope: 'private',
        ownerContext: { kind: 'personal' },
        hash: 'hash',
        authorizedAt: '2026-09-23T00:00:00Z',
        localResourceIds: ['local'],
      },
    });
  });

  it.each([
    ['after sign-out', null],
    ['under another account', { account: { id: 'other' } }],
  ])('stays available %s', async (_label, entry) => {
    mockAccount.mockResolvedValue({ status: 'ok', entry });
    await expect(
      assertInstalledResourceContext('collections', 'local', mockFetch),
    ).resolves.toBeUndefined();
    expect(mockPublicSnapshot).toHaveBeenCalledWith('public-a');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records an install made while signed out', async () => {
    mockAccount.mockResolvedValue({ status: 'ok', entry: null });
    await recordResourceInstall(
      'collections',
      publicDetail,
      ['local'],
      'public-share',
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: 'public-a',
        sourceKind: 'public-share',
        localResourceIds: ['local'],
        ownerContext: { kind: 'personal' },
      }),
    );
  });

  it('still requires an account for an owned install', async () => {
    mockAccount.mockResolvedValue({ status: 'ok', entry: null });
    await expect(
      recordResourceInstall('collections', publicDetail, ['local']),
    ).rejects.toThrow('Resource unavailable');
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
