import { readAllSidebarItems } from '../../lib/sidebar-items';
import { getCoworkWorkspaceRootDir } from '../../lib/paths';
import { authorizeProjectPipelineRequest } from '../pipeline-install-context';
jest.mock('../../lib/paths', () => ({ getCoworkWorkspaceRootDir: jest.fn() }));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest
    .fn()
    .mockResolvedValue({ items: [{ id: 'project-a' }] }),
}));
import { readWorkspaceConfigDetailed } from '../../lib/workspace-persistence';
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
}));
import { getStoredPipelineBySource } from '../pipeline-service';
import { getManagedCuratedPipeline } from '../curated-pipeline-catalog';
import * as validation from '../../lib/validation';
jest.mock('../curated-pipeline-catalog', () => ({
  getManagedCuratedPipeline: jest.fn(),
}));
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPipelineShareSourceContext,
  readPipelineShareSource,
} from '../pipeline-install-context';
import { getPipelineText, listPipelines } from '../pipeline-service';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import { getProjectPipelinesDirCandidates } from '@canopy/desktop-shared/pipelines/config-paths';
jest.mock('../pipeline-service', () => ({
  attachProjectPipelineRemoteMetadata: jest.fn(
    (pipelines: unknown[]): unknown[] => pipelines,
  ),
  getPipelineText: jest.fn(),
  getStoredPipelineBySource: jest.fn(),
  listPipelines: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
import { decideResourceContext } from '@canopy/desktop-shared/lib/resource-context-policy';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  assertNewPipelineShareContent,
  assertStoredPipelineContext,
  recordSharedPipelineInstall,
  copyPipelineInstallOrigin,
  assertPipelineShareOrigin,
} from '../pipeline-install-context';
import { createResourceInstallReceiptsStore } from '../../lib/resource-install-receipts';
import { getSharedPipeline } from '../canopy-server-client';
import type {
  PipelineData,
  SharedPipelineDetail,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  ResourceContextDecision,
  ResourceContextInput,
  InstallReceipt,
} from '@canopy/desktop-shared/lib/resource-context-policy';
let mockActiveContext: WorkspaceContext = { kind: 'personal' };
const mockEnabled = jest.fn(() => true);
const mockDecide = jest.fn<
  Promise<ResourceContextDecision>,
  [ResourceContextInput]
>(() => Promise.resolve({ allow: true }));
const mockFindLocal = jest.fn();
const mockFind = jest.fn();
const mockListOrganizationContentOwners = jest.fn<Promise<string[]>, []>(() =>
  Promise.resolve([]),
);
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
    initialize: jest.fn((): Promise<void> => Promise.resolve()),
    whenIdle: jest.fn((): Promise<void> => Promise.resolve()),
    accountEpoch: jest.fn((): number => 0),
    getState: jest.fn(() => ({ context: mockActiveContext, revision: 0 })),
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
    listOrganizationContentOwners: mockListOrganizationContentOwners,
    findLocal: mockFindLocal,
    find: mockFind,
    record: mockRecord,
  })),
}));
jest.mock('../canopy-server-client', () => ({ getSharedPipeline: jest.fn() }));
const detail: SharedPipelineDetail = {
  id: 'remote-a',
  name: 'Release',
  description: '',
  icon: '',
  version: '1',
  triggerTypes: ['dispatch'],
  createdBy: { id: 'user-a', name: 'User' },
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
  canUpdate: true,
  canDelete: true,
  rawPipeline: 'name: Release',
  contentHash: 'a'.repeat(64),
  shareScope: 'organization',
  owner: {
    type: 'organization',
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'A',
  },
};
const receipt: InstallReceipt = {
  family: 'pipelines',
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
  mockAccount.mockResolvedValue({
    status: 'ok',
    entry: { account: { id: 'user-a' } },
  });
  mockFind.mockResolvedValue(undefined);
  mockListOrganizationContentOwners.mockResolvedValue([]);
  mockActiveContext = { kind: 'personal' };
  mockDecide.mockImplementation(() => Promise.resolve({ allow: true }));
  mockFindLocal.mockResolvedValue(undefined);
  jest.mocked(getSharedPipeline).mockResolvedValue(detail);
});
it('preserves the flag-off local path without consulting account or receipts', async () => {
  mockEnabled.mockReturnValue(false);
  await assertStoredPipelineContext('local-a');
  await recordSharedPipelineInstall(detail, 'local-a');
  await copyPipelineInstallOrigin('local-a', 'local-b');
  await copyPipelineInstallOrigin('shared:canopy-cloud:remote-a', 'local-b');
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockAccount).not.toHaveBeenCalled();
  expect(mockDecide).not.toHaveBeenCalled();
});
it('checks genuine local resources through the policy service', async () => {
  await assertStoredPipelineContext('personal');
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      resource: { owner: { type: 'user', id: 'user-a', name: null } },
    }),
  );
});
it('rechecks remote authorization and provenance for an edited installed copy', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  await assertStoredPipelineContext('local-a');
  expect(getSharedPipeline).toHaveBeenCalledWith('remote-a');
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      resource: { owner: detail.owner, provenance: receipt },
    }),
  );
});
it('blocks revoked shared origins before reading local content', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  jest
    .mocked(getSharedPipeline)
    .mockRejectedValueOnce(new Error('Workflow unavailable (access-removed)'));
  await expect(assertStoredPipelineContext('local-a')).rejects.toThrow(
    'access-removed',
  );
});
it('blocks a copy installed under another account', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'other-user', receipt });
  await expect(assertStoredPipelineContext('local-a')).rejects.toThrow(
    'access-removed',
  );
  expect(getSharedPipeline).not.toHaveBeenCalled();
});
it('records remote identity, owner, content hash and local binding', async () => {
  await recordSharedPipelineInstall(detail, 'local-a');
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      family: 'pipelines',
      remoteId: 'remote-a',
      localResourceIds: ['local-a'],
      ownerContext: receipt.ownerContext,
    }),
  );
});
it('preserves origin before duplicating an installed copy', async () => {
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  await copyPipelineInstallOrigin('local-a', 'local-b');
  expect(mockRecord).toHaveBeenCalledWith({
    ...receipt,
    localResourceIds: ['local-b'],
  });
});

describe.each(['install', 'local copy', 'shared copy'])(
  '%s receipt authorization fence',
  (operation): void => {
    async function writeReceipt(): Promise<void> {
      if (operation === 'install') {
        await recordSharedPipelineInstall(detail, 'destination');
      } else {
        await copyPipelineInstallOrigin(
          operation === 'local copy'
            ? 'local-a'
            : 'shared:canopy-cloud:remote-a',
          'destination',
        );
      }
    }

    it.each(['account', 'context'])(
      'rejects a %s switch after authorization without writing',
      async (changed): Promise<void> => {
        mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
        mockDecide.mockImplementationOnce(
          (): Promise<ResourceContextDecision> => {
            if (changed === 'account') {
              mockAccount.mockResolvedValue({
                status: 'ok',
                entry: { account: { id: 'user-b' } },
              });
            } else {
              mockActiveContext = receipt.ownerContext;
            }
            return Promise.resolve({ allow: true });
          },
        );
        await expect(writeReceipt()).rejects.toThrow(
          'Workflow unavailable (access-removed)',
        );
        expect(mockRecord).not.toHaveBeenCalled();
      },
    );

    it('writes under the stable authorized account', async (): Promise<void> => {
      mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
      await writeReceipt();
      expect(createResourceInstallReceiptsStore).toHaveBeenLastCalledWith(
        'user-a',
      );
      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ localResourceIds: ['destination'] }),
      );
    });
  },
);

it.each(['account', 'context'])(
  'rejects a %s switch while fetching the shared duplicate origin',
  async (changed): Promise<void> => {
    jest
      .mocked(getSharedPipeline)
      .mockImplementationOnce((): Promise<SharedPipelineDetail> => {
        if (changed === 'account') {
          mockAccount.mockResolvedValue({
            status: 'ok',
            entry: { account: { id: 'user-b' } },
          });
        } else {
          mockActiveContext = receipt.ownerContext;
        }
        return Promise.resolve(detail);
      });
    await expect(
      copyPipelineInstallOrigin('shared:canopy-cloud:remote-a', 'destination'),
    ).rejects.toThrow('Workflow unavailable (access-removed)');
    expect(mockRecord).not.toHaveBeenCalled();
  },
);

it.each(['account', 'context'])(
  'rejects a %s switch during the pre-write rollback lookup',
  async (changed): Promise<void> => {
    mockFind.mockImplementationOnce((): Promise<undefined> => {
      if (changed === 'account') {
        mockAccount.mockResolvedValue({
          status: 'ok',
          entry: { account: { id: 'user-b' } },
        });
      } else {
        mockActiveContext = receipt.ownerContext;
      }
      return Promise.resolve(undefined);
    });
    const rollback = jest.fn();
    await expect(
      recordSharedPipelineInstall(detail, 'destination', rollback),
    ).rejects.toThrow('Workflow unavailable (access-removed)');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  },
);

it.each(['account', 'context'])(
  'rejects a %s switch during the duplicate binding lookup',
  async (changed): Promise<void> => {
    mockFindLocal.mockResolvedValueOnce({ accountId: 'user-a', receipt });
    mockFindLocal.mockImplementationOnce(
      (): Promise<{ accountId: string; receipt: InstallReceipt }> => {
        if (changed === 'account') {
          mockAccount.mockResolvedValue({
            status: 'ok',
            entry: { account: { id: 'user-b' } },
          });
        } else {
          mockActiveContext = receipt.ownerContext;
        }
        return Promise.resolve({ accountId: 'user-a', receipt });
      },
    );
    const rollback = jest.fn();
    await expect(
      copyPipelineInstallOrigin('local-a', 'destination', rollback),
    ).rejects.toThrow('Workflow unavailable (access-removed)');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  },
);

it.each(['local-a', 'shared:canopy-cloud:remote-a'])(
  'does not republish organization origin %s as private',
  async (source) => {
    mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
    mockDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'unsupported-target',
    });
    await expect(
      assertPipelineShareOrigin(source, {
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

it('keeps an organization duplicate unavailable after switching to Personal', async () => {
  mockActiveContext = receipt.ownerContext;
  mockDecide.mockImplementation((input) =>
    Promise.resolve(decideResourceContext(input)),
  );
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt });
  await copyPipelineInstallOrigin('local-a', 'local-copy');
  const copied = mockRecord.mock.calls[0]?.[0];
  expect(copied?.localResourceIds).toEqual(['local-copy']);
  mockFindLocal.mockResolvedValue({ accountId: 'user-a', receipt: copied });
  mockActiveContext = { kind: 'personal' };
  await expect(assertStoredPipelineContext('local-copy')).rejects.toThrow(
    'context-mismatch',
  );
});
it('records remote organization origin when duplicating a shared source', async () => {
  await copyPipelineInstallOrigin('shared:canopy-cloud:remote-a', 'local-copy');
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      remoteId: 'remote-a',
      localResourceIds: ['local-copy'],
      ownerContext: receipt.ownerContext,
    }),
  );
});

it('fails closed for ambiguous ownership even when a legacy capability policy allows it', async () => {
  mockDecide.mockResolvedValue({ allow: true });
  const { assertPipelineContext, pipelineContextAllowed } =
    await import('../resource-lanes');
  await expect(assertPipelineContext({ owner: undefined })).rejects.toThrow(
    'Workflow unavailable (unknown-provenance)',
  );
  await expect(pipelineContextAllowed({ owner: undefined })).resolves.toBe(
    false,
  );
});

it('loads project share bytes from the selected worktree file without consulting a colliding stored id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-share-source-'));
  const pipelineDir = getProjectPipelinesDirCandidates(root)[0];
  if (!pipelineDir) throw new Error('Missing pipeline directory');
  const file = join(pipelineDir, 'release.yaml');
  await mkdir(pipelineDir, { recursive: true });
  await writeFile(file, '# exact source bytes\nname: Release\n');
  jest.mocked(resolveWorktreeCwd).mockReturnValue(root);
  jest.mocked(readAllSidebarItems).mockResolvedValue({
    version: 1,
    items: [
      {
        type: 'single-repo',
        id: 'project-a',
        name: 'Project',
        repoPath: root,
        worktrees: [],
        color: '',
        collapsed: false,
        order: 0,
      },
    ],
  });
  jest.mocked(readWorkspaceConfigDetailed).mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
    config: { version: 1, type: 'single-repo', repoPath: root, repos: [] },
  });
  jest
    .mocked(getPipelineText)
    .mockReturnValue({ success: true, data: 'unrelated stored yaml' });
  try {
    await expect(
      readPipelineShareSource({
        kind: 'project',
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        pipelineFilePath: file,
      }),
    ).resolves.toBe('# exact source bytes\nname: Release\n');
    expect(getPipelineText).not.toHaveBeenCalled();
    mockDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'context-mismatch',
    });
    await expect(
      readPipelineShareSource({
        kind: 'project',
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        pipelineFilePath: file,
      }),
    ).rejects.toThrow('context-mismatch');
    await expect(
      readPipelineShareSource({ kind: 'stored', id: 'project--release.yaml' }),
    ).rejects.toThrow('unknown-provenance');
    expect(getPipelineText).not.toHaveBeenCalled();
    const outside = join(root, 'outside.yaml');
    await writeFile(outside, 'outside');
    await symlink(outside, join(pipelineDir, 'escape.yaml'));
    await expect(
      readPipelineShareSource({
        kind: 'project',
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        pipelineFilePath: join(pipelineDir, 'escape.yaml'),
      }),
    ).rejects.toThrow('unknown-provenance');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses reformatted existing Advisor content without a source locator', async () => {
  jest.mocked(listPipelines).mockReturnValue({
    success: true,
    data: [
      {
        id: 'local-a',
        name: 'Release',
        filename: 'release.yaml',
        description: '',
        icon: '',
        createdAt: '2026-09-23T00:00:00Z',
        updatedAt: '2026-09-23T00:00:00Z',
        readonly: false,
        source: 'user',
      },
    ],
  });
  await expect(
    assertNewPipelineShareContent(
      'pipeline:\n  name: Release\n  on: dispatch\n  jobs: {}\n',
    ),
  ).rejects.toThrow('context-mismatch');
});

it('allows source-less content to be shared back to its receipt organization', async () => {
  jest.mocked(listPipelines).mockReturnValue({ success: true, data: [] });
  jest.mocked(readAllSidebarItems).mockResolvedValue({ version: 1, items: [] });
  mockListOrganizationContentOwners.mockResolvedValue([
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ]);

  await expect(
    assertNewPipelineShareContent(
      'name: New pipeline\non: dispatch\njobs: {}',
      {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'A',
      },
    ),
  ).resolves.toBeUndefined();
});

it.each([
  {
    destination: {
      type: 'organization',
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      name: 'B',
    },
    label: 'another organization',
  },
  {
    destination: { type: 'user', id: 'user-a', name: 'User' },
    label: 'Personal',
  },
])(
  'refuses source-less organization content shared to $label',
  async ({ destination }): Promise<void> => {
    jest.mocked(listPipelines).mockReturnValue({ success: true, data: [] });
    mockListOrganizationContentOwners.mockResolvedValue([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);

    await expect(
      assertNewPipelineShareContent(
        'name: New pipeline\non: dispatch\njobs: {}',
        destination,
      ),
    ).rejects.toThrow('context-mismatch');
  },
);

it.each(['bundled', 'curated'])(
  'resolves %s share sources without user id validation',
  async (kind): Promise<void> => {
    const source: 'bundled' | 'curated' =
      kind === 'bundled' ? 'bundled' : 'curated';
    const id = source === 'curated' ? 'curated:release' : 'release';
    const root = await mkdtemp(join(tmpdir(), 'curated-share-'));
    const filePath = join(root, 'release.yaml');
    const data: PipelineData = {
      info: {
        filePath,
        id,
        name: 'Release',
        filename: 'release.yaml',
        description: '',
        icon: '',
        createdAt: '2026-09-23T00:00:00Z',
        updatedAt: '2026-09-23T00:00:00Z',
        readonly: true,
        source,
      },
      content: { name: 'Release', on: 'dispatch', jobs: {} },
      rawContent: '# trusted bytes\nname: Release\n',
    };
    await writeFile(filePath, data.rawContent ?? '');
    jest
      .mocked(getStoredPipelineBySource)
      .mockReturnValue({ success: true, data });
    jest.mocked(getManagedCuratedPipeline).mockResolvedValue(data);
    const validate = jest.spyOn(validation, 'validateId');
    try {
      await expect(
        readPipelineShareSource({ kind: 'stored', id, source }),
      ).resolves.toBe(data.rawContent);
      await assertPipelineShareSourceContext(
        { kind: 'stored', id, source },
        { type: 'user', id: 'local', name: null },
      );
      expect(validate).not.toHaveBeenCalled();
      expect(mockDecide).toHaveBeenCalledWith(
        expect.objectContaining({ resource: { owner: { type: 'system' } } }),
      );
      expect(mockFindLocal).not.toHaveBeenCalled();
      if (source === 'bundled')
        expect(getStoredPipelineBySource).toHaveBeenCalledWith('bundled', id);
      else expect(getManagedCuratedPipeline).toHaveBeenCalledWith(id);
    } finally {
      validate.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
it('still validates user share source ids', async (): Promise<void> => {
  await expect(
    readPipelineShareSource({ kind: 'stored', source: 'user', id: '../bad' }),
  ).rejects.toThrow('Invalid sourcePipelineId');
  await expect(
    assertPipelineShareSourceContext({
      kind: 'stored',
      source: 'user',
      id: '../bad',
    }),
  ).rejects.toThrow('Invalid sourcePipelineId');
});

it.each(['unreadable', 'absent', 'malformed'] as const)(
  'refuses project sharing with %s workspace authority',
  async (state): Promise<void> => {
    jest.mocked(readWorkspaceConfigDetailed).mockResolvedValue({
      authority: state === 'malformed' ? 'ok' : state,
      ownerMalformed: state === 'malformed',
      memoryMalformed: false,
      config: { version: 1, type: 'multi-repo', repos: [] },
    });
    await expect(
      assertPipelineShareSourceContext({
        kind: 'project',
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        pipelineFilePath: '/unused.yaml',
      }),
    ).rejects.toThrow('Workflow unavailable (unknown-provenance)');
    expect(mockDecide).not.toHaveBeenCalled();
  },
);

it('refuses project ids at the stored ownership boundary without reading receipts', async (): Promise<void> => {
  await expect(
    assertStoredPipelineContext('project--release.yaml'),
  ).rejects.toThrow('unknown-provenance');
  expect(mockFindLocal).not.toHaveBeenCalled();
});

it('authorizes managed cowork project pipelines from the canonical home', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-pipeline-'));
  const filePath = join(root, 'child.yaml');
  await writeFile(filePath, 'name: Child');
  jest.mocked(getCoworkWorkspaceRootDir).mockReturnValue(root);
  jest.mocked(readAllSidebarItems).mockResolvedValue({
    version: 1,
    items: [
      {
        type: 'cowork',
        id: 'cowork-a',
        name: 'Cowork',
        color: '',
        collapsed: false,
        order: 0,
      },
    ],
  });
  jest.mocked(readWorkspaceConfigDetailed).mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
    config: {
      version: 1,
      type: 'cowork',
      repos: [],
      owner: {
        type: 'organization',
        organizationId: 'org-a',
        projectId: 'project-a',
        instanceId: 'instance-a',
        bindingGeneration: 1,
      },
    },
  });
  try {
    await expect(
      authorizeProjectPipelineRequest({
        id: 'project--child.yaml',
        cwd: root,
        filePath,
      }),
    ).resolves.toMatchObject({
      projectId: 'cowork-a',
      owner: { type: 'organization', id: 'org-a' },
    });
    expect(mockFindLocal).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['repository', 'worktree', 'cowork', 'external', 'multi-repo'])(
  'rejects source-less project content from a %s root',
  async (location): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'source-less-project-'));
    const pipelineDir = getProjectPipelinesDirCandidates(root)[0];
    if (!pipelineDir) throw new Error('Missing pipeline directory');
    await mkdir(pipelineDir, { recursive: true });
    const raw = 'name: Project release\non: dispatch\njobs: {}\n';
    await writeFile(join(pipelineDir, 'release.yaml'), raw);
    jest.mocked(listPipelines).mockReturnValue({ success: true, data: [] });
    jest.mocked(resolveWorktreeCwd).mockReturnValue(root);
    jest.mocked(getCoworkWorkspaceRootDir).mockReturnValue(root);
    const common = {
      id: 'project-a',
      name: 'Project',
      color: '',
      collapsed: false,
      order: 0,
    };
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [
        location === 'cowork'
          ? { ...common, type: 'cowork' }
          : location === 'multi-repo'
            ? {
                ...common,
                type: 'multi-repo',
                repos: [{ id: 'repo-a', repoPath: root, name: 'Repo' }],
                worktrees: [],
              }
            : {
                ...common,
                type: 'single-repo',
                repoPath:
                  location === 'repository' ? root : join(root, 'unused'),
                ...(location === 'external' ? { externalPath: root } : {}),
                worktrees:
                  location === 'worktree'
                    ? [
                        {
                          id: 'worktree-a',
                          branchName: 'main',
                          createdAt: '2026-09-24T00:00:00Z',
                        },
                      ]
                    : [],
              },
      ],
    });
    try {
      await expect(assertNewPipelineShareContent(raw)).rejects.toThrow(
        'context-mismatch',
      );
      await expect(
        assertNewPipelineShareContent(
          'pipeline:\n  name: Project release\n  on: dispatch\n  jobs: {}\n',
        ),
      ).rejects.toThrow('context-mismatch');
      await expect(
        assertNewPipelineShareContent(
          'name: New pipeline\non: dispatch\njobs: {}\n',
        ),
      ).resolves.toBeUndefined();
      mockEnabled.mockReturnValue(false);
      await expect(assertNewPipelineShareContent(raw)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
