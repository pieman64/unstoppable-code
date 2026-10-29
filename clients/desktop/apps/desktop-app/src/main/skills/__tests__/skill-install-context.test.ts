import {
  annotateSharedSkillInstalls,
  assertStoredSkillContext,
  recordSharedSkillInstall,
  getSharedSkillInstallIds,
  copySkillInstallOrigin,
  assertSkillShareOrigin,
  hasSkillInstallReceipt,
} from '../skill-install-context';
import { getSharedSkill } from '../canopy-server-client';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
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
const mockFind = jest.fn();
const mockRollback = jest.fn<
  Promise<void>,
  [InstallReceipt, InstallReceipt | undefined]
>(() => Promise.resolve());
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
    getState: jest.fn(() => ({ context: { kind: 'personal' } })),
  })),
}));
jest.mock('../../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({ decide: mockDecide })),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: jest.fn(() => mockAccount()),
}));
const mockListForAccount = jest.fn<Promise<InstallReceipt[]>, []>(() =>
  Promise.resolve([]),
);
jest.mock('../../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: mockFindLocal,
    find: mockFind,
    rollbackInstall: mockRollback,
    record: mockRecord,
    listForAccount: mockListForAccount,
  })),
}));
const mockListPackageInstalls = jest.fn<Promise<unknown[]>, []>(() =>
  Promise.resolve([]),
);
jest.mock('../../pipelines/pipeline-package-install-store', () => ({
  listCapabilityPackageInstalls: jest.fn(() => mockListPackageInstalls()),
}));
jest.mock('../../lib/paths', () => ({
  getPipelinePackageInstallStorePath: jest.fn(() => '/data/package-installs'),
}));
jest.mock('../canopy-server-client', () => ({ getSharedSkill: jest.fn() }));
const detail: SharedSkillDetail = {
  id: 'remote-a',
  name: 'Release',
  description: '',
  contentHash: 'hash',
  publicShare: null,
  createdBy: { id: 'user-a', name: 'User' },
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
  canUpdate: true,
  canDelete: true,
  rawSkill: 'name: Release',
  shareScope: 'organization',
  owner: {
    type: 'organization',
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'A',
  },
};
const receipt: InstallReceipt = {
  family: 'skills',
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
  mockFind.mockResolvedValue(undefined);
  mockListForAccount.mockResolvedValue([]);
  mockListPackageInstalls.mockResolvedValue([]);
  jest.mocked(getSharedSkill).mockResolvedValue(detail);
});

function installedSkill(name: string): InstalledSkillInfo {
  return {
    name,
    sourceId: 'custom:app',
    description: '',
    source: '',
    installedAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-23T00:00:00Z',
    updateAvailable: false,
    custom: true,
  };
}

describe('annotateSharedSkillInstalls', () => {
  it('names the share a receipted skill came from and its completed package', async () => {
    mockListForAccount.mockResolvedValue([
      { ...receipt, localResourceIds: ['custom:app/release'] },
    ]);
    mockListPackageInstalls.mockResolvedValue([
      {
        owner: { kind: 'skill', localId: 'release' },
        originExternalId: 'remote-other',
        packageDigest: 'sha256:other',
      },
      {
        owner: { kind: 'skill', localId: 'release' },
        originExternalId: detail.id,
        distributionMode: 'definition_only',
      },
      {
        owner: { kind: 'skill', localId: 'release' },
        originExternalId: detail.id,
        packageDigest: 'sha256:package',
      },
    ]);

    const rows = await annotateSharedSkillInstalls([
      installedSkill('release'),
      installedSkill('personal'),
    ]);

    expect(rows[0].installedFromShare).toEqual({
      remoteId: detail.id,
      packageDigest: 'sha256:package',
    });
    expect(rows[1]).toEqual(installedSkill('personal'));
  });

  it('attributes a local name two receipts list to the latest authorization', async () => {
    mockListForAccount.mockResolvedValue([
      {
        ...receipt,
        remoteId: 'remote-new',
        localResourceIds: ['custom:app/release'],
        authorizedAt: '2026-10-02T00:00:00Z',
      },
      {
        ...receipt,
        remoteId: 'remote-stale',
        localResourceIds: ['custom:app/release'],
        authorizedAt: '2026-09-01T00:00:00Z',
      },
    ]);

    const rows = await annotateSharedSkillInstalls([installedSkill('release')]);

    expect(rows[0].installedFromShare).toEqual({ remoteId: 'remote-new' });
  });

  it('omits the package digest when no package install completed', async () => {
    mockListForAccount.mockResolvedValue([
      { ...receipt, localResourceIds: ['custom:app/release'] },
    ]);

    const rows = await annotateSharedSkillInstalls([installedSkill('release')]);

    expect(rows[0].installedFromShare).toEqual({ remoteId: detail.id });
  });

  it('leaves rows untouched without enforcement or a readable account', async () => {
    mockEnabled.mockReturnValue(false);
    const rows = [installedSkill('release')];
    await expect(annotateSharedSkillInstalls(rows)).resolves.toBe(rows);
    expect(mockAccount).not.toHaveBeenCalled();

    mockEnabled.mockReturnValue(true);
    mockAccount.mockResolvedValueOnce({ status: 'error', entry: undefined });
    await expect(annotateSharedSkillInstalls(rows)).resolves.toBe(rows);
    expect(mockListForAccount).not.toHaveBeenCalled();
  });

  it('keeps the listing when the receipts cannot be read', async () => {
    mockListForAccount.mockRejectedValue(new Error('unreadable'));
    const rows = [installedSkill('release')];
    await expect(annotateSharedSkillInstalls(rows)).resolves.toBe(rows);
  });
});
it('preserves the flag-off local path without consulting account or receipts', async () => {
  mockEnabled.mockReturnValue(false);
  await assertStoredSkillContext('local-a');
  await recordSharedSkillInstall(detail, 'local-a');
  expect(await getSharedSkillInstallIds(detail.id)).toEqual(new Set());
  expect(mockAccount).not.toHaveBeenCalled();
  expect(mockDecide).not.toHaveBeenCalled();
});
it('reports no receipt without consulting the store when enforcement is off', async () => {
  mockEnabled.mockReturnValue(false);
  await expect(hasSkillInstallReceipt('custom:app/helper')).resolves.toBe(
    false,
  );
  expect(mockFindLocal).not.toHaveBeenCalled();
});

it('reports whether an install receipt binds a local skill', async () => {
  mockFindLocal.mockResolvedValue(undefined);
  await expect(hasSkillInstallReceipt('custom:app/helper')).resolves.toBe(
    false,
  );
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  await expect(hasSkillInstallReceipt('custom:app/helper')).resolves.toBe(true);
  expect(mockFindLocal).toHaveBeenLastCalledWith('skills', 'custom:app/helper');
});

it('treats a local skill as receipted when the account cannot be read', async () => {
  mockAccount.mockResolvedValueOnce({ status: 'error', entry: undefined });
  await expect(hasSkillInstallReceipt('custom:app/helper')).resolves.toBe(true);
  expect(mockFindLocal).not.toHaveBeenCalled();
});

it('checks genuine local resources through the policy service', async () => {
  await assertStoredSkillContext('personal');
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      resource: { owner: { type: 'user', id: 'local', name: null } },
    }),
  );
});
it('rechecks remote authorization and provenance for an edited installed copy', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  await assertStoredSkillContext('local-a');
  expect(getSharedSkill).toHaveBeenCalledWith('remote-a');
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      resource: { owner: detail.owner, provenance: receipt },
    }),
  );
});
it('blocks revoked shared origins before reading local content', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  jest
    .mocked(getSharedSkill)
    .mockRejectedValueOnce(new Error('Skill unavailable (access-removed)'));
  await expect(assertStoredSkillContext('local-a')).rejects.toThrow(
    'access-removed',
  );
});
it('blocks a copy installed under another account', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'other-user', receipt });
  await expect(assertStoredSkillContext('local-a')).rejects.toThrow(
    'access-removed',
  );
  expect(getSharedSkill).not.toHaveBeenCalled();
});
it('records remote identity, owner, content hash and local binding', async () => {
  await recordSharedSkillInstall(detail, 'local-a');
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      family: 'skills',
      remoteId: 'remote-a',
      localResourceIds: ['local-a'],
      ownerContext: receipt.ownerContext,
    }),
  );
});
it('preserves origin before duplicating an installed copy', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  await copySkillInstallOrigin('local-a', 'local-b');
  expect(mockRecord).toHaveBeenCalledWith({
    ...receipt,
    localResourceIds: ['local-b'],
  });
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
      assertSkillShareOrigin(source, {
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

it.each([undefined, receipt])(
  'captures the prior receipt for import rollback (%p)',
  async (previous): Promise<void> => {
    mockFind.mockResolvedValue(previous);
    const rollback = await recordSharedSkillInstall(detail, 'local-new');
    expect(rollback).toEqual(expect.any(Function));
    if (rollback) await rollback();
    expect(mockRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: detail.id,
        localResourceIds: ['local-new'],
      }),
      previous,
    );
  },
);

it.each([
  undefined,
  null,
  {},
  { type: 'organization' },
  { type: 'team', id: 'team' },
])(
  'rejects unknown owner %p before a permissive legacy policy',
  async (owner): Promise<void> => {
    const { assertSkillContext, skillContextAllowed } =
      await import('../resource-lanes');
    await expect(skillContextAllowed({ owner })).resolves.toBe(false);
    await expect(assertSkillContext({ owner })).rejects.toThrow(
      'unknown-provenance',
    );
    expect(mockDecide).not.toHaveBeenCalled();
  },
);

it('rejects a direct unknown owner before the legacy policy', async (): Promise<void> => {
  const { assertSkillContext } = await import('../resource-lanes');
  await expect(assertSkillContext({ owner: undefined })).rejects.toThrow(
    'unknown-provenance',
  );
  expect(mockDecide).not.toHaveBeenCalled();
});

it.each([undefined, receipt])(
  'only offers the current account source aliases for reuse (%p)',
  async (previous): Promise<void> => {
    mockFind.mockResolvedValue(previous);
    expect(await getSharedSkillInstallIds(detail.id)).toEqual(
      new Set(previous?.localResourceIds),
    );
    expect(mockFind).toHaveBeenCalledWith('skills', detail.id);
    const { createResourceInstallReceiptsStore } =
      await import('../../lib/resource-install-receipts');
    expect(createResourceInstallReceiptsStore).toHaveBeenCalledWith('user-a');
  },
);
