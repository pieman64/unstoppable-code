import { createHash } from 'node:crypto';
import type { CollectionConfig } from '@canopy/protocol/collections';
import type { CollectionUpdateSnapshot } from '../collection-mutations';

const mockLive = jest.fn<Promise<unknown>, unknown[]>();
const mockPackage = jest.fn<Promise<unknown>, unknown[]>();
const mockInstall = jest.fn<Promise<unknown>, unknown[]>();
const mockSkills = jest.fn<unknown, unknown[]>();
const mockPlugins = jest.fn<Promise<unknown>, unknown[]>();
const mockImportSkill = jest.fn<Promise<unknown>, unknown[]>();
const mockReadRaw = jest.fn<Promise<unknown>, unknown[]>();
const mockMcp = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../collection-store', () => ({
  readLocalCollectionSnapshot: jest.fn(),
  saveCollectionConfig: jest.fn(),
}));
jest.mock('../../lib/resource-context', () => ({
  resourceContextSnapshot: jest.fn(),
  assertResourceContextSnapshot: jest.fn(),
}));
jest.mock('../../canopy-cloud/public-share-client', () => ({
  getPublicCollectionShareSnapshot: (...args: unknown[]): Promise<unknown> =>
    mockLive(...args),
}));
jest.mock('../canopy-server-client', () => ({
  getSharedCollection: (...args: unknown[]): Promise<unknown> =>
    mockLive(...args),
  getCollectionPackage: (...args: unknown[]): Promise<unknown> =>
    mockPackage(...args),
  getPublicCollectionPackage: (...args: unknown[]): Promise<unknown> =>
    mockPackage(...args),
  getCollectionPackageBlob: jest.fn(),
  getPublicCollectionPackageBlob: jest.fn(),
}));
jest.mock('../../skills/skill-package-install', () => ({
  installSubjectCapabilityPackage: (...args: unknown[]): Promise<unknown> =>
    mockInstall(...args),
}));
jest.mock('../../skills/skill-service', () => ({
  installSkills: jest.fn(),
  loadSkills: (...args: unknown[]): unknown => mockSkills(...args),
  writeRawSkillForContext: (...args: unknown[]): Promise<unknown> =>
    mockImportSkill(...args),
  readRawSkill: (...args: unknown[]): Promise<unknown> => mockReadRaw(...args),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplaces: (...args: unknown[]): Promise<unknown> =>
    mockPlugins(...args),
}));
jest.mock('../../services/plugin-catalog-service', () => ({
  addPortalMarketplace: jest.fn(),
  installPortalBuiltInPlugin: jest.fn(),
  installPortalExternalPlugin: jest.fn(),
}));
jest.mock('../../skills/resource-lanes', () => ({
  skillContextSnapshot: (): Promise<string> => Promise.resolve('context'),
}));
jest.mock('../collection-handlers', () => ({
  resolveCollectionMcpRequirements: (...args: unknown[]): Promise<unknown> =>
    mockMcp(...args),
}));
jest.mock('../../mcp/connection-status', () => ({
  getMcpServerStatusByCatalogId: jest.fn(),
}));

import { collectionMutationPorts } from '../collection-mutation-ports';

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const source = { remoteId: 'source', fetchedAt: 'before' };
const initial: CollectionConfig = {
  id: 'abc',
  revision: 'r1',
  name: 'Local',
  description: '',
  skills: [],
  plugins: [],
  mcpServers: [],
  createdAt: 'before',
  updatedAt: 'before',
  sharedSource: source,
};

describe('collection mutation production adapters', () => {
  beforeEach(() => jest.resetAllMocks());

  it('reads the hash-covered scoped document and rejects mismatched bytes', async () => {
    const document = { version: 1, name: 'Live', description: '', items: [] };
    const rawCollection = JSON.stringify(document);
    mockLive.mockResolvedValue({
      rawCollection,
      contentHash: hash(rawCollection),
      collection: {},
      customSkills: [],
    });
    expect((await collectionMutationPorts.live(source)).collection).toEqual(
      document,
    );
    mockLive.mockResolvedValue({
      rawCollection,
      contentHash: 'wrong',
      customSkills: [],
    });
    await expect(collectionMutationPorts.live(source)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('refuses to install a package for another Collection revision', async () => {
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: { version: 1, name: 'Live', description: '', items: [] },
      customSkills: [],
      package: { version: 1, digest: 'digest' },
    };
    mockPackage.mockResolvedValue({
      digest: 'digest',
      manifest: { pipelineContentHash: 'other' },
    });
    await expect(
      collectionMutationPorts.installPackage(snapshot, initial, () =>
        Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('maps packaged custom members by resource id and exact SKILL.md hash, preserving numeric suffixes', async () => {
    const contentHash = hash('content');
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: {
        version: 1,
        name: 'Live',
        description: '',
        items: [
          {
            type: 'custom_skill',
            skillId: 'remote',
            skill_name: 'review-2',
            contentHash,
          },
        ],
      },
      customSkills: [],
      package: { version: 1, digest: 'digest' },
    };
    mockPackage.mockResolvedValue({
      digest: 'digest',
      manifest: {
        pipelineContentHash: 'hash',
        environmentRequirements: [],
        resources: [
          {
            id: 'right',
            trees: [{ entries: [{ path: 'SKILL.md', sha256: contentHash }] }],
          },
          {
            id: 'wrong',
            trees: [{ entries: [{ path: 'SKILL.md', sha256: 'other' }] }],
          },
        ],
      },
    });
    mockMcp.mockResolvedValue({ mcpServerRefs: [], unmetRequirements: [] });
    mockInstall.mockResolvedValue({
      installedSkills: [
        { resourceId: 'right', name: 'review-2', localName: 'review-2-7' },
        {
          resourceId: 'wrong',
          name: 'review-2',
          localName: 'different-source',
        },
      ],
    });
    const result = await collectionMutationPorts.installPackage(
      snapshot,
      initial,
      () => Promise.resolve(),
    );
    expect(result.customSkills.get('remote')).toEqual({
      sourceId: 'custom:app',
      skillName: 'review-2-7',
    });
    expect(mockImportSkill).not.toHaveBeenCalled();
    expect(mockInstall.mock.calls[0]?.[0]).not.toHaveProperty(
      'finalizeInstall',
    );
    expect(mockInstall.mock.calls[0]?.[0]).not.toHaveProperty(
      'rollbackFinalization',
    );
  });

  it('rejects ambiguous custom package mappings rather than importing again by name', async () => {
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: {
        version: 1,
        name: 'Live',
        description: '',
        items: [
          {
            type: 'custom_skill',
            skillId: 'remote',
            skill_name: 'review',
            contentHash: 'missing',
          },
        ],
      },
      customSkills: [],
      package: { version: 1, digest: 'digest' },
    };
    mockPackage.mockResolvedValue({
      digest: 'digest',
      manifest: {
        pipelineContentHash: 'hash',
        environmentRequirements: [],
        resources: [],
      },
    });
    mockMcp.mockResolvedValue({ mcpServerRefs: [], unmetRequirements: [] });
    mockInstall.mockResolvedValue({ installedSkills: [] });
    await expect(
      collectionMutationPorts.installPackage(snapshot, initial, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('mapping');
    expect(mockImportSkill).not.toHaveBeenCalled();
  });

  it('rejects same-name skills from the wrong source', async () => {
    mockSkills.mockReturnValue({
      success: true,
      data: [
        {
          sourceId: 'wrong',
          name: 'review',
          shareableSource: { type: 'github', repo: 'acme/other' },
        },
      ],
    });
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: { version: 1, name: 'Live', description: '', items: [] },
      customSkills: [],
    };
    await expect(
      collectionMutationPorts.resolve(
        {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'review',
        },
        snapshot,
        source,
        () => Promise.resolve(),
      ),
    ).rejects.toThrow('exact skill reference');
  });

  it('rechecks authorization after an async catalog read before installing a plugin', async () => {
    const { installPortalBuiltInPlugin } =
      await import('../../services/plugin-catalog-service');
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: { version: 1, name: 'Live', description: '', items: [] },
      customSkills: [],
    };
    mockPlugins.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'builtin:app',
            name: 'App',
            builtIn: true,
            plugins: [{ name: 'review', marketplaceId: 'builtin:app' }],
          },
        ],
      },
    });
    const assertCurrent = jest.fn(() =>
      Promise.reject(new Error('Access revoked')),
    );
    await expect(
      collectionMutationPorts.resolve(
        {
          type: 'claude_plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'review',
        },
        snapshot,
        source,
        assertCurrent,
      ),
    ).rejects.toThrow('Access revoked');
    expect(assertCurrent).toHaveBeenCalled();
    expect(installPortalBuiltInPlugin).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  'verifies custom skill bytes on %s public-share reads',
  async (fromPublicShare) => {
    const document = { version: 1, name: 'Live', description: '', items: [] };
    mockLive.mockResolvedValue({
      collection: document,
      contentHash: 'hash',
      customSkills: [
        {
          id: 'remote',
          name: 'review',
          rawSkill: 'changed',
          contentHash: hash('original'),
        },
      ],
    });
    await expect(
      collectionMutationPorts.live({ ...source, fromPublicShare }),
    ).rejects.toMatchObject({ code: 'conflict' });
  },
);

it.each(['missing', 'changed', 'success'] as const)(
  'resolves a legacy custom member only from authorized content: %s',
  async (state) => {
    jest.resetAllMocks();
    const contentHash = hash('content');
    const item = {
      type: 'custom_skill' as const,
      skillId: 'remote',
      skill_name: 'review-2',
      contentHash,
    };
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'collection-hash',
      collection: { version: 1, name: 'Live', description: '', items: [item] },
      customSkills:
        state === 'missing'
          ? []
          : [
              {
                id: 'remote',
                name: 'review-2',
                rawSkill: 'content',
                contentHash,
              },
            ],
    };
    mockImportSkill.mockResolvedValue({
      skillId: 'local',
      skillName: 'review-2-7',
    });
    mockReadRaw.mockResolvedValue(state === 'changed' ? 'changed' : 'content');
    const result = collectionMutationPorts.resolve(
      item,
      snapshot,
      { ...source, fromPublicShare: true },
      () => Promise.resolve(),
    );
    if (state === 'success') {
      await expect(result).resolves.toEqual({
        sourceId: 'custom:app',
        skillName: 'review-2-7',
      });
      expect(mockImportSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          inCollection: true,
          publicShare: {
            externalId: 'remote',
            contentHash,
            collection: {
              externalId: 'source',
              contentHash: 'collection-hash',
            },
          },
        }),
      );
    } else {
      await expect(result).rejects.toThrow(
        state === 'missing' ? 'missing' : 'changed during import',
      );
      if (state === 'missing') expect(mockImportSkill).not.toHaveBeenCalled();
    }
  },
);

it('refuses unresolved MCP requirements before installing a package', async () => {
  jest.resetAllMocks();
  const snapshot: CollectionUpdateSnapshot = {
    contentHash: 'hash',
    collection: { version: 1, name: 'Live', description: '', items: [] },
    customSkills: [],
    package: { version: 1, digest: 'digest' },
  };
  mockPackage.mockResolvedValue({
    digest: 'digest',
    manifest: {
      pipelineContentHash: 'hash',
      environmentRequirements: [],
      resources: [],
    },
  });
  mockMcp.mockResolvedValue({
    mcpServerRefs: [],
    unmetRequirements: ['missing'],
  });
  await expect(
    collectionMutationPorts.installPackage(snapshot, initial, () =>
      Promise.resolve(),
    ),
  ).rejects.toThrow('MCP requirement');
  expect(mockInstall).not.toHaveBeenCalled();
});

it.each(['failed inventory', 'missing', 'ambiguous'] as const)(
  'refuses unresolved builtin skills: %s',
  async (state) => {
    jest.resetAllMocks();
    const member = {
      sourceId: 'builtin:app',
      name: 'review',
      shareableSource: { type: 'builtin', id: 'app' },
    };
    mockSkills.mockReturnValue(
      state === 'failed inventory'
        ? { success: false }
        : { success: true, data: state === 'missing' ? [] : [member, member] },
    );
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: { version: 1, name: 'Live', description: '', items: [] },
      customSkills: [],
    };
    await expect(
      collectionMutationPorts.resolve(
        {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'review',
        },
        snapshot,
        source,
        () => Promise.resolve(),
      ),
    ).rejects.toThrow(
      state === 'failed inventory'
        ? 'installed skills'
        : 'exact skill reference',
    );
  },
);

it.each(['failed catalog', 'missing', 'ambiguous'] as const)(
  'refuses unresolved builtin plugins: %s',
  async (state) => {
    jest.resetAllMocks();
    const { installPortalBuiltInPlugin } =
      await import('../../services/plugin-catalog-service');
    const plugin = { name: 'review', marketplaceId: 'builtin:app' };
    mockPlugins.mockResolvedValue(
      state === 'failed catalog'
        ? { success: false }
        : {
            success: true,
            data: {
              marketplaces: [
                {
                  id: 'builtin:app',
                  name: 'App',
                  builtIn: true,
                  plugins: state === 'missing' ? [] : [plugin, plugin],
                },
              ],
            },
          },
    );
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: { version: 1, name: 'Live', description: '', items: [] },
      customSkills: [],
    };
    await expect(
      collectionMutationPorts.resolve(
        {
          type: 'claude_plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'review',
        },
        snapshot,
        source,
        () => Promise.resolve(),
      ),
    ).rejects.toThrow(
      state === 'failed catalog' ? 'plugin catalog' : 'exact plugin reference',
    );
    expect(installPortalBuiltInPlugin).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'imports a GitHub skill only when installation succeeds: %s',
  async (success) => {
    jest.resetAllMocks();
    const { installSkills } = await import('../../skills/skill-service');
    jest
      .mocked(installSkills)
      .mockResolvedValue(
        success
          ? { success: true }
          : { success: false, error: 'Unavailable repository' },
      );
    const inventory = {
      success: true,
      data: [
        {
          sourceId: 'github:acme:skills',
          name: 'review',
          shareableSource: { type: 'github', repo: 'acme/skills' },
        },
      ],
    };
    mockSkills
      .mockReturnValueOnce({ success: true, data: [] })
      .mockReturnValue(inventory);
    const snapshot: CollectionUpdateSnapshot = {
      contentHash: 'hash',
      collection: { version: 1, name: 'Live', description: '', items: [] },
      customSkills: [],
    };
    const result = collectionMutationPorts.resolve(
      {
        type: 'skill',
        source: { type: 'github', repo: 'acme/skills' },
        skill_name: 'review',
      },
      snapshot,
      source,
      () => Promise.resolve(),
    );
    if (success)
      await expect(result).resolves.toEqual({
        sourceId: 'github:acme:skills',
        skillName: 'review',
      });
    else {
      await expect(result).rejects.toThrow('Unavailable repository');
      expect(mockSkills).toHaveBeenCalledTimes(1);
    }
    expect(installSkills).toHaveBeenCalledWith('acme/skills', ['review']);
  },
);

it('reuses an exact installed GitHub member without downloading or overwriting local edits', async () => {
  jest.resetAllMocks();
  const { installSkills } = await import('../../skills/skill-service');
  jest
    .mocked(installSkills)
    .mockRejectedValue(new Error('Network unavailable'));
  mockSkills.mockReturnValue({
    success: true,
    data: [
      {
        sourceId: 'github:acme:skills',
        name: 'review',
        shareableSource: { type: 'github', repo: 'acme/skills' },
      },
    ],
  });
  await expect(
    collectionMutationPorts.resolve(
      {
        type: 'skill',
        source: { type: 'github', repo: 'acme/skills' },
        skill_name: 'review',
      },
      {
        contentHash: 'hash',
        collection: { version: 1, name: 'Live', description: '', items: [] },
        customSkills: [],
      },
      source,
      () => Promise.resolve(),
    ),
  ).resolves.toEqual({ sourceId: 'github:acme:skills', skillName: 'review' });
  expect(installSkills).not.toHaveBeenCalled();
});
