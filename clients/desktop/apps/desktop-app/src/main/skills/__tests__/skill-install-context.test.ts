import {
  annotateSharedSkillInstalls,
  assertStoredSkillContext,
  recordSharedSkillInstall,
  getSharedSkillInstallIds,
  copySkillInstallOrigin,
  assertSkillShareOrigin,
  hasSkillInstallReceipt,
  getSharedSkillWithInstallState,
  prepareSkillUninstall,
} from '../skill-install-context';
import { getSharedSkill } from '../canopy-server-client';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ResourceInstallReceiptsModule from '../../lib/resource-install-receipts';
import * as resourceLanes from '../resource-lanes';
import type { SharedSkillInstallOrigin } from '@canopy/protocol/skills';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
import type {
  ResourceContextDecision,
  ResourceContextInput,
  InstallReceipt,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import type {
  CanopyCloudAccountEntry,
  CanopyCloudAccountReadResult,
} from '../../lib/canopy-cloud-account-store';
const mockEnabled = jest.fn(() => true);
const mockPendingReplacement = jest.fn<Promise<boolean>, [string]>(() =>
  Promise.resolve(false),
);
jest.mock('../skill-replacement-state', () => ({
  hasPendingSkillReplacement: (name: string): Promise<boolean> =>
    mockPendingReplacement(name),
}));
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
const accountEntry: CanopyCloudAccountEntry = {
  apiKey: 'test-api-key',
  capabilities: [],
  account: {
    id: 'user-a',
    name: 'User',
    email: 'user@example.com',
    role: 'DEVELOPER',
  },
  createdAt: '',
  updatedAt: '',
};
const mockAccount = jest.fn<Promise<CanopyCloudAccountReadResult>, []>(() =>
  Promise.resolve({ status: 'ok', entry: accountEntry }),
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
  createdBy: { id: 'user-a', name: 'User', email: null },
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
function projectedReceipt(
  value: InstallReceipt = receipt,
): SharedSkillInstallOrigin {
  return {
    remoteId: value.remoteId,
    shareScope: value.shareScope,
    ownerContext: value.ownerContext,
    contentHash: value.hash,
    authorizedAt: value.authorizedAt,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled.mockReturnValue(true);
  mockPendingReplacement.mockResolvedValue(false);
  mockFindLocal.mockResolvedValue(undefined);
  mockFind.mockResolvedValue(undefined);
  mockListForAccount.mockResolvedValue([]);
  mockListPackageInstalls.mockResolvedValue([]);
  jest.mocked(getSharedSkill).mockResolvedValue(detail);
});

it('allows retry after the real receipt store compensates a failed first install', async () => {
  const { createResourceInstallReceiptsStore } = jest.requireActual<
    typeof ResourceInstallReceiptsModule
  >('../../lib/resource-install-receipts');
  const directory = await mkdtemp(join(tmpdir(), 'skill-install-retry-'));
  const store = createResourceInstallReceiptsStore('user-a', directory);
  try {
    const attempt = { ...receipt, localResourceIds: ['custom:app/helper'] };
    await store.record(attempt);
    // The file claim failed after receipt publication; no file was installed.
    await store.rollbackInstall(attempt, undefined);
    mockFind.mockImplementation(
      (family: string, remoteId: string, strict?: boolean) =>
        store.find(family, remoteId, strict),
    );
    await expect(getSharedSkillInstallIds(detail.id)).resolves.toEqual(
      new Set(),
    );
    // A subsequent successful attempt can publish that same identity again.
    await store.record(attempt);
    await expect(getSharedSkillInstallIds(detail.id)).resolves.toEqual(
      new Set(['custom:app/helper']),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('still requires recovery when legacy receipt aliases are unknown', async () => {
  mockFind.mockResolvedValue({ ...receipt, localResourceIds: undefined });
  await expect(getSharedSkillInstallIds(detail.id)).rejects.toThrow(
    'missing-copy',
  );
});

it('refuses receipt publication if the captured context changes during account lookup', async () => {
  const snapshot = jest
    .spyOn(resourceLanes, 'assertSkillContextSnapshot')
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('context-mismatch'));
  try {
    await expect(
      recordSharedSkillInstall(
        detail,
        'local-a',
        undefined,
        'captured-context',
      ),
    ).rejects.toThrow('context-mismatch');
    expect(mockRecord).not.toHaveBeenCalled();
  } finally {
    snapshot.mockRestore();
  }
});

it.each([{ copies: [] }, { copies: ['custom:app/missing-copy'] }])(
  'returns receipt identity independently of readable inventory: $copies',
  async ({ copies }) => {
    const snapshot = jest
      .spyOn(resourceLanes, 'skillContextSnapshot')
      .mockResolvedValue('context');
    const assertSnapshot = jest
      .spyOn(resourceLanes, 'assertSkillContextSnapshot')
      .mockResolvedValue(undefined);
    mockFind.mockResolvedValue(
      copies.length ? { ...receipt, localResourceIds: copies } : undefined,
    );
    try {
      await expect(
        getSharedSkillWithInstallState(detail.id),
      ).resolves.toMatchObject({ installedCopyIds: copies });
    } finally {
      snapshot.mockRestore();
      assertSnapshot.mockRestore();
    }
  },
);

it.each(['recorded', 'legacy'])(
  'exposes primary copies, not %s packaged dependencies, to Update and Uninstall',
  async (kind) => {
    const snapshot = jest
      .spyOn(resourceLanes, 'skillContextSnapshot')
      .mockResolvedValue('context');
    const assertSnapshot = jest
      .spyOn(resourceLanes, 'assertSkillContextSnapshot')
      .mockResolvedValue(undefined);
    mockFind.mockResolvedValue({
      ...receipt,
      localResourceIds: ['custom:app/z-primary', 'custom:app/a-dependency'],
      ...(kind === 'recorded'
        ? {
            localResourceRoles: {
              'custom:app/z-primary': 'primary',
              'custom:app/a-dependency': 'dependency',
            },
          }
        : {}),
    });
    mockListPackageInstalls.mockResolvedValue([
      {
        owner: { kind: 'skill', localId: 'z-primary' },
        originExternalId: detail.id,
      },
    ]);
    try {
      await expect(
        getSharedSkillWithInstallState(detail.id),
      ).resolves.toMatchObject({
        installedCopyIds: ['custom:app/z-primary'],
      });
      // Dependencies still need origin enforcement and package reuse.
      await expect(getSharedSkillInstallIds(detail.id)).resolves.toEqual(
        new Set(['custom:app/z-primary', 'custom:app/a-dependency']),
      );
    } finally {
      snapshot.mockRestore();
      assertSnapshot.mockRestore();
    }
  },
);

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
  it('exposes interrupted replacement even when content and package already match', async () => {
    mockListForAccount.mockResolvedValue([
      { ...receipt, localResourceIds: ['custom:app/release'] },
    ]);
    mockPendingReplacement.mockResolvedValue(true);
    const rows = await annotateSharedSkillInstalls([installedSkill('release')]);
    expect(rows[0].installedFromShare).toMatchObject({
      replacementPending: true,
      remoteId: detail.id,
    });
  });
  it('omits an ambiguous comparison hash when one receipt spans multiple local copies', async () => {
    mockListForAccount.mockResolvedValue([
      {
        ...receipt,
        hash: 'b'.repeat(64),
        ownerName: 'Acme',
        localResourceIds: ['custom:app/release', 'custom:app/release-2'],
      },
    ]);
    const rows = await annotateSharedSkillInstalls([
      installedSkill('release'),
      installedSkill('release-2'),
    ]);
    for (const row of rows) {
      expect(row.installedFromShare).toMatchObject({
        remoteId: receipt.remoteId,
        ownerName: 'Acme',
      });
      expect(row.installedFromShare).not.toHaveProperty('contentHash');
    }
  });
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
      ...projectedReceipt(),
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

    expect(rows[0].installedFromShare).toEqual({
      ...projectedReceipt(),
      remoteId: 'remote-new',
      authorizedAt: '2026-10-02T00:00:00Z',
    });
  });

  it('omits the package digest when no package install completed', async () => {
    mockListForAccount.mockResolvedValue([
      { ...receipt, localResourceIds: ['custom:app/release'] },
    ]);

    const rows = await annotateSharedSkillInstalls([installedSkill('release')]);

    expect(rows[0].installedFromShare).toEqual(projectedReceipt());
  });

  it('projects only the winning receipt snapshot and keeps unrelated aliases unannotated', async () => {
    mockListForAccount.mockResolvedValue([
      {
        ...receipt,
        localResourceIds: ['custom:app/release'],
        sharedByName: 'Old',
        teamName: 'Old team',
      },
      {
        ...receipt,
        remoteId: 'winner',
        localResourceIds: ['custom:app/release'],
        authorizedAt: '2026-10-26T00:00:00Z',
        hash: 'installed',
        ownerName: 'Acme',
        sharedByName: 'Lena',
      },
    ]);
    const rows = await annotateSharedSkillInstalls([
      installedSkill('release'),
      { ...installedSkill('release'), sourceId: 'other-source' },
    ]);
    expect(rows[0].installedFromShare).toEqual({
      ...projectedReceipt(),
      remoteId: 'winner',
      authorizedAt: '2026-10-26T00:00:00Z',
      contentHash: 'installed',
      ownerName: 'Acme',
      sharedByName: 'Lena',
    });
    expect(rows[1].installedFromShare).toBeUndefined();
  });

  it('leaves rows untouched without enforcement or a readable account', async () => {
    mockEnabled.mockReturnValue(false);
    const rows = [installedSkill('release')];
    await expect(annotateSharedSkillInstalls(rows)).resolves.toBe(rows);
    expect(mockAccount).not.toHaveBeenCalled();

    mockEnabled.mockReturnValue(true);
    mockAccount.mockResolvedValueOnce({
      status: 'error',
      error: new Error('unreadable'),
    });
    await expect(annotateSharedSkillInstalls(rows)).rejects.toThrow(
      'verification failed',
    );
    expect(mockListForAccount).not.toHaveBeenCalled();
  });

  it('fails verification when the receipts cannot be read', async () => {
    mockListForAccount.mockRejectedValue(new Error('unreadable'));
    const rows = [installedSkill('release')];
    await expect(annotateSharedSkillInstalls(rows)).rejects.toThrow(
      'verification failed',
    );
  });

  it('projects per-copy baselines without attributing a new hash to untouched aliases', async () => {
    const hash = 'a'.repeat(64);
    mockListForAccount.mockResolvedValue([
      {
        ...receipt,
        localResourceIds: ['custom:app/release', 'custom:app/other'],
        localContentHashes: { 'custom:app/release': hash },
      },
    ]);
    const rows = await annotateSharedSkillInstalls([
      installedSkill('release'),
      installedSkill('other'),
    ]);
    expect(rows[0].installedFromShare?.contentHash).toBe(hash);
    expect(rows[1].installedFromShare?.contentHash).toBeUndefined();
  });

  it('does not report a package as current when supporting files were preserved with different bytes', async () => {
    mockListForAccount.mockResolvedValue([
      { ...receipt, localResourceIds: ['custom:app/release'] },
    ]);
    mockListPackageInstalls.mockResolvedValue([
      {
        owner: { kind: 'skill', localId: 'release' },
        originExternalId: detail.id,
        packageDigest: 'package',
        supportingFilesComplete: false,
      },
    ]);
    const rows = await annotateSharedSkillInstalls([installedSkill('release')]);
    expect(rows[0].installedFromShare?.remoteId).toBe(detail.id);
    expect(rows[0].installedFromShare?.packageDigest).toBeUndefined();
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
  mockAccount.mockResolvedValueOnce({
    status: 'error',
    error: new Error('unreadable'),
  });
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
      hash: createHash('sha256').update(detail.rawSkill).digest('hex'),
      sharedByName: 'User',
      ownerName: 'A',
    }),
  );
});
it.each([
  {
    owner: detail.owner,
    shareScope: 'organization' as const,
    names: { ownerName: 'A', sharedByName: 'Lena' },
  },
  {
    owner: {
      type: 'team' as const,
      id: 'team',
      name: ' Release ',
      organization: {
        id:
          receipt.ownerContext.kind === 'organization'
            ? receipt.ownerContext.organizationId
            : '',
        name: ' Acme ',
      },
    },
    shareScope: 'team' as const,
    names: { ownerName: 'Acme', teamName: 'Release', sharedByName: 'Lena' },
  },
  {
    owner: { type: 'user' as const, id: 'user-a', name: 'Personal owner' },
    shareScope: 'private' as const,
    names: { sharedByName: 'Lena' },
  },
  {
    owner: { ...detail.owner, name: null },
    shareScope: 'organization' as const,
    names: { sharedByName: 'Lena' },
  },
])(
  'records authenticated attribution for $shareScope',
  async ({ owner, shareScope, names }) => {
    await recordSharedSkillInstall(
      {
        ...detail,
        owner,
        shareScope,
        createdBy: { ...detail.createdBy, name: ' Lena ' },
      },
      'local-a',
    );
    const { authorizedAt, ...recorded } = mockRecord.mock.calls[0][0];
    expect(Number.isFinite(Date.parse(authorizedAt))).toBe(true);
    expect(recorded).toEqual({
      family: 'skills',
      remoteId: detail.id,
      localResourceIds: ['local-a'],
      shareScope,
      ownerContext:
        shareScope === 'private' ? { kind: 'personal' } : receipt.ownerContext,
      hash: createHash('sha256').update(detail.rawSkill).digest('hex'),
      localContentHashes: {
        'local-a': createHash('sha256').update(detail.rawSkill).digest('hex'),
      },
      localResourceRoles: { 'local-a': 'primary' },
      ...names,
    });
  },
);

it('omits unknown and blank authenticated names', async () => {
  await recordSharedSkillInstall(
    {
      ...detail,
      owner: {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: '  ',
      },
      createdBy: { ...detail.createdBy, name: null },
    },
    'local-a',
  );
  expect(mockRecord.mock.calls[0][0]).not.toHaveProperty('sharedByName');
  expect(mockRecord.mock.calls[0][0]).not.toHaveProperty('ownerName');
  expect(mockRecord.mock.calls[0][0]).not.toHaveProperty('teamName');
});
it('preserves origin before duplicating an installed copy', async () => {
  const namedReceipt = {
    ...receipt,
    ownerName: 'Acme',
    teamName: 'Release',
    sharedByName: 'Lena',
  };
  mockFindLocal.mockResolvedValue({
    accountId: 'user-a',
    receipt: namedReceipt,
  });
  mockFind.mockResolvedValue(namedReceipt);
  await copySkillInstallOrigin('local-a', 'local-b');
  expect(mockRecord).toHaveBeenCalledWith({
    ...namedReceipt,
    localResourceIds: ['local-b'],
    localResourceRoles: { 'local-b': 'primary' },
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
    expect(mockFind).toHaveBeenCalledWith('skills', detail.id, true);
    const { createResourceInstallReceiptsStore } =
      await import('../../lib/resource-install-receipts');
    expect(createResourceInstallReceiptsStore).toHaveBeenCalledWith('user-a');
  },
);

it('distinguishes an explicitly uninstalled alias from a missing copy without erasing provenance', async () => {
  mockFind.mockResolvedValue({
    family: 'skills',
    remoteId: detail.id,
    localResourceIds: ['custom:app/gone', 'custom:app/kept'],
    uninstalledLocalResourceIds: ['custom:app/gone'],
  });
  await expect(getSharedSkillInstallIds(detail.id)).resolves.toEqual(
    new Set(['custom:app/kept']),
  );
  mockFind.mockResolvedValue({
    family: 'skills',
    remoteId: detail.id,
    localResourceIds: ['custom:app/gone'],
    uninstalledLocalResourceIds: ['custom:app/gone'],
  });
  await expect(getSharedSkillInstallIds(detail.id)).resolves.toEqual(new Set());
});

it('records explicit removal in the captured account while retaining the receipt origin', async () => {
  jest
    .spyOn(resourceLanes, 'skillContextSnapshot')
    .mockResolvedValue('snapshot');
  jest
    .spyOn(resourceLanes, 'assertSkillContextSnapshot')
    .mockResolvedValue(undefined);
  const receipt: InstallReceipt = {
    family: 'skills',
    remoteId: detail.id,
    localResourceIds: ['custom:app/helper', 'custom:app/sibling'],
    localContentHashes: {
      'custom:app/helper': 'a'.repeat(64),
      'custom:app/sibling': 'b'.repeat(64),
    },
    shareScope: 'organization',
    ownerContext: {
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    },
    hash: 'a'.repeat(64),
    authorizedAt: '2026-10-29T00:00:00.000Z',
  };
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  jest.mocked(getSharedSkill).mockResolvedValue(detail);
  const commit = await prepareSkillUninstall('custom:app/helper');
  await commit();
  expect(mockRecord).toHaveBeenLastCalledWith(
    expect.objectContaining({
      remoteId: detail.id,
      localResourceIds: ['custom:app/helper'],
      uninstalledLocalResourceIds: ['custom:app/helper'],
      localContentHashes: { 'custom:app/helper': 'a'.repeat(64) },
    }),
  );
});

it.each(['primary', 'dependency', 'legacy'] as const)(
  'copies %s provenance without carrying another alias removal marker to the new copy',
  async (role) => {
    const origin = {
      ...receipt,
      localResourceIds: ['source', 'gone'],
      uninstalledLocalResourceIds: ['gone'],
      ...(role === 'legacy' ? {} : { localResourceRoles: { source: role } }),
    };
    mockFindLocal.mockResolvedValue({
      accountId: 'user-a',
      receipt: origin,
    });
    mockFind.mockResolvedValue(origin);
    await copySkillInstallOrigin('source', 'destination');
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        localResourceIds: ['destination'],
        uninstalledLocalResourceIds: [],
        localResourceRoles: {
          destination: role === 'dependency' ? 'dependency' : 'primary',
        },
      }),
    );
  },
);
