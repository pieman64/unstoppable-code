import * as fs from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';

jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemUninstall: jest.fn(),
}));
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';

let mockContextEnabled = false;
const mockDecide = jest.fn();
const mockFindLocal = jest.fn();
const mockRecord = jest.fn();
const mockRollbackInstall = jest.fn<Promise<void>, unknown[]>();
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn(() => mockContextEnabled),
  })),
}));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({ decide: mockDecide })),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: jest.fn(() => Promise.resolve()),
    whenIdle: jest.fn(() => Promise.resolve()),
    accountEpoch: jest.fn(() => 1),
    getState: jest.fn(() => ({ context: { kind: 'personal' }, revision: 1 })),
  })),
}));
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: mockFindLocal,
    record: mockRecord,
    rollbackInstall: mockRollbackInstall,
  })),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'user' } } }),
  ),
}));
jest.mock('../collections/canopy-server-client', () => ({
  getSharedCollection: jest.fn(() =>
    Promise.resolve({
      id: 'remote-a',
      contentHash: 'hash',
      owner: { type: 'organization', id: 'org-a', name: 'A' },
    }),
  ),
}));

const mockPublicSnapshot = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../canopy-cloud/public-share-client', () => ({
  getPublicCollectionShareSnapshot: (...args: unknown[]): Promise<unknown> =>
    mockPublicSnapshot(...args),
}));

let tempDir = '';

jest.mock('../lib/paths', () => ({
  getBundlesIndexFilePath: jest.fn(() =>
    path.join(tempDir, 'bundles', 'index.json'),
  ),
  getBundleConfigFilePath: jest.fn((bundleId: string) =>
    path.join(tempDir, 'bundles', `bundle-${bundleId}.json`),
  ),
  getCollectionsIndexFilePath: jest.fn(() =>
    path.join(tempDir, 'collections', 'index.json'),
  ),
  getCollectionConfigFilePath: jest.fn((collectionId: string) =>
    path.join(tempDir, 'collections', `collection-${collectionId}.json`),
  ),
}));

import {
  clearCollectionRemoteMetadataByRemoteId,
  deleteCollectionConfig,
  listCollectionSharedSourcesForBackfill,
  readCollectionConfig,
  readCollectionIndex,
  saveCollectionConfig,
  rollbackNewCollectionInstall,
  writeCollectionRemoteMetadata,
} from '../collections/collection-store';

describe('collection-store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecord.mockReset();
    mockContextEnabled = false;
    mockDecide.mockResolvedValue({ allow: false, reason: 'context-mismatch' });
    mockFindLocal.mockResolvedValue(undefined);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-collections-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('blocks direct reads and capability expansion of installed organization collections', async () => {
    const local = await saveCollectionConfig({ name: 'Org A' });
    mockContextEnabled = true;
    mockFindLocal.mockResolvedValue({
      accountId: 'user',
      receipt: {
        family: 'collections',
        remoteId: 'remote-a',
        ownerContext: { kind: 'organization', organizationId: 'org-a' },
      },
    });
    await expect(readCollectionConfig(local.id)).rejects.toThrow(
      'context-mismatch',
    );
    expect((await readCollectionIndex()).collections).toEqual([]);
  });

  it('refuses foreign installs before persisting collection content', async () => {
    mockContextEnabled = true;
    await expect(
      saveCollectionConfig({
        name: 'Org A',
        sharedSource: { remoteId: 'remote-a', fetchedAt: 'now' },
      }),
    ).rejects.toThrow('context-mismatch');
    expect(fs.existsSync(path.join(tempDir, 'collections', 'index.json'))).toBe(
      false,
    );
  });

  it('keeps hidden organization entries in the stored index when saving Personal content', async () => {
    const organization = await saveCollectionConfig({ name: 'Organization' });
    mockContextEnabled = true;
    mockFindLocal.mockImplementation((family: string, id: string) =>
      Promise.resolve(
        family === 'collections' && id === organization.id
          ? {
              accountId: 'user',
              receipt: {
                family,
                remoteId: 'remote-a',
                ownerContext: { kind: 'organization', organizationId: 'org-a' },
              },
            }
          : undefined,
      ),
    );
    mockDecide.mockImplementation(
      (input: { resource: { owner?: { type?: string } } }) =>
        Promise.resolve(
          input.resource.owner?.type === 'user'
            ? { allow: true }
            : { allow: false, reason: 'context-mismatch' },
        ),
    );
    await saveCollectionConfig({ name: 'Personal' });
    expect(
      (await readCollectionIndex()).collections.map((entry) => entry.name),
    ).toEqual(['Personal']);
    const stored = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'collections', 'index.json'), 'utf8'),
    ) as { collections: Array<{ name: string }> };
    expect(stored.collections.map((entry) => entry.name)).toEqual([
      'Organization',
      'Personal',
    ]);
  });

  it('records organization provenance before persisting an authorized install', async () => {
    mockContextEnabled = true;
    mockDecide.mockResolvedValue({ allow: true });
    mockRecord.mockImplementationOnce(() => {
      expect(
        fs.existsSync(path.join(tempDir, 'collections', 'index.json')),
      ).toBe(false);
      return Promise.resolve();
    });
    const installed = await saveCollectionConfig({
      name: 'Org A',
      sharedSource: { remoteId: 'remote-a', fetchedAt: 'now' },
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'collections',
        remoteId: 'remote-a',
        localResourceIds: [installed.id],
        ownerContext: { kind: 'organization', organizationId: 'org-a' },
      }),
    );
  });

  it('cannot erase a legacy installed origin through a partial direct-id update', async () => {
    const installed = await saveCollectionConfig({
      name: 'Org A',
      sharedSource: { remoteId: 'remote-a', fetchedAt: 'now' },
    });
    mockContextEnabled = true;
    mockDecide.mockImplementation(
      (input: { resource: { owner?: { type?: string } } }) =>
        Promise.resolve(
          input.resource.owner?.type === 'user'
            ? { allow: true }
            : { allow: false, reason: 'context-mismatch' },
        ),
    );
    await expect(
      saveCollectionConfig({ id: installed.id, name: 'Edited' }),
    ).rejects.toThrow('context-mismatch');
  });

  it('saves and reopens a non-owner Public import without scoped access', async () => {
    mockContextEnabled = true;
    mockDecide.mockResolvedValue({ allow: true });
    mockPublicSnapshot.mockResolvedValue({
      externalId: 'public-a',
      contentHash: 'public-hash',
    });
    const source = {
      remoteId: 'public-a',
      fetchedAt: 'now',
      fromPublicShare: true,
      contentHash: 'public-hash',
    };
    const installed = await saveCollectionConfig({
      name: 'Public kit',
      sharedSource: source,
    });
    expect(mockPublicSnapshot).toHaveBeenCalledWith('public-a');
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'collections',
        remoteId: 'public-a',
        sourceKind: 'public-share',
        ownerContext: { kind: 'personal' },
        localResourceIds: [installed.id],
      }),
    );
    const edited = await saveCollectionConfig({
      id: installed.id,
      name: 'Edited',
    });
    expect(edited.sharedSource).toEqual(source);
    expect(
      (await readCollectionConfig(installed.id))?.collection.sharedSource,
    ).toEqual(source);
    expect((await readCollectionIndex()).collections).toHaveLength(1);
    const { getSharedCollection } =
      await import('../collections/canopy-server-client');
    expect(getSharedCollection).not.toHaveBeenCalled();
  });

  it('rejects a changed Public snapshot before writing the install', async () => {
    mockContextEnabled = true;
    mockDecide.mockResolvedValue({ allow: true });
    mockPublicSnapshot.mockResolvedValue({
      externalId: 'public-a',
      contentHash: 'changed',
    });
    const source = {
      remoteId: 'public-a',
      fetchedAt: 'now',
      fromPublicShare: true,
      contentHash: 'expected',
    };
    await expect(
      saveCollectionConfig({ name: 'Public kit', sharedSource: source }),
    ).rejects.toThrow('shared collection changed');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, 'collections', 'index.json'))).toBe(
      false,
    );
  });

  it('rolls back its exact local write and receipt alias during a cloud outage', async () => {
    const local = await saveCollectionConfig({
      name: 'Pending',
      sharedSource: {
        remoteId: 'public-a',
        fetchedAt: 'now',
        fromPublicShare: true,
      },
    });
    mockContextEnabled = true;
    mockPublicSnapshot.mockRejectedValue(new Error('cloud unavailable'));
    mockFindLocal.mockResolvedValue({
      accountId: 'original-account',
      receipt: {
        family: 'collections',
        remoteId: 'public-a',
        localResourceIds: [local.id, 'peer'],
      },
    });
    await rollbackNewCollectionInstall(local);
    expect(mockPublicSnapshot).not.toHaveBeenCalled();
    expect(mockRollbackInstall).toHaveBeenCalledWith(
      expect.objectContaining({ localResourceIds: [local.id] }),
      undefined,
    );
    expect(
      fs.existsSync(
        path.join(tempDir, 'collections', `collection-${local.id}.json`),
      ),
    ).toBe(false);
    expect((await readCollectionIndex()).collections).toEqual([]);
  });

  it('cleans up the initial write when the prepared final save is denied', async () => {
    const initial = await saveCollectionConfig({ name: 'Pending' });
    const prepared = {
      ...initial,
      skills: [{ sourceId: 'custom:app', skillName: 'packaged' }],
      updatedAt: 'next',
    };
    await rollbackNewCollectionInstall(prepared, initial);
    expect((await readCollectionIndex()).collections).toEqual([]);
  });

  it('preserves a local collection edited after the install prepared its write', async () => {
    const initial = await saveCollectionConfig({ name: 'Pending' });
    const edited = await saveCollectionConfig({ ...initial, name: 'Edited' });
    await expect(rollbackNewCollectionInstall(initial)).rejects.toThrow(
      'Collection changed',
    );
    expect((await readCollectionConfig(initial.id))?.collection).toEqual(
      edited,
    );
  });

  it('preserves a local collection edited while its receipt alias is rolled back', async () => {
    const initial = await saveCollectionConfig({ name: 'Pending' });
    mockFindLocal.mockResolvedValue({
      accountId: 'original-account',
      receipt: {
        family: 'collections',
        remoteId: 'public-a',
        localResourceIds: [initial.id],
      },
    });
    let edited: CollectionConfig | undefined;
    mockRollbackInstall.mockImplementationOnce(async () => {
      edited = await saveCollectionConfig({ ...initial, name: 'Edited' });
    });
    await expect(rollbackNewCollectionInstall(initial)).rejects.toThrow(
      'Collection changed',
    );
    expect(edited?.name).toBe('Edited');
    expect((await readCollectionConfig(initial.id))?.collection).toEqual(
      edited,
    );
    expect((await readCollectionIndex()).collections).toEqual([
      expect.objectContaining({ id: initial.id, name: 'Edited' }),
    ]);
  });

  it('reads empty Collection storage', async () => {
    await expect(readCollectionIndex()).resolves.toEqual({
      version: 2,
      collections: [],
    });
  });

  it('persists author share metadata through edits and clears it on unshare', async () => {
    const collection = await saveCollectionConfig({ name: 'Shared' });
    const remote = {
      accountId: 'account-a',
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'hash-a',
      shareScope: 'organization' as const,
      sharedAt: '2026-09-24T16:00:00.000Z',
    };

    await expect(
      writeCollectionRemoteMetadata(collection.id, remote),
    ).resolves.toBe(true);
    expect((await readCollectionIndex()).collections).toContainEqual(
      expect.objectContaining({
        id: collection.id,
        hasExistingShare: true,
      }),
    );
    await expect(
      saveCollectionConfig({ id: collection.id, name: 'Edited' }),
    ).resolves.toMatchObject({ remote });
    await expect(
      clearCollectionRemoteMetadataByRemoteId(remote.remoteId),
    ).resolves.toBe(1);
    expect((await readCollectionConfig(collection.id))?.collection.remote).toBe(
      undefined,
    );
    expect((await readCollectionIndex()).collections).toContainEqual(
      expect.objectContaining({
        id: collection.id,
        hasExistingShare: false,
      }),
    );
  });

  it('restores Collection metadata when its index update fails', async () => {
    const collection = await saveCollectionConfig({ name: 'Shared' });
    const remote = {
      accountId: 'account-a',
      remoteId: '33333333-3333-4333-8333-333333333333',
      contentHash: 'hash-c',
      shareScope: 'organization' as const,
      sharedAt: '2026-09-24T16:00:00.000Z',
    };
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const actualWriteFile = fsPromises.writeFile;
    const writeSpy = jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementationOnce(actualWriteFile)
      .mockRejectedValueOnce(new Error('index write failed'));

    try {
      await expect(
        writeCollectionRemoteMetadata(collection.id, remote),
      ).rejects.toThrow('index write failed');
    } finally {
      writeSpy.mockRestore();
    }

    expect(
      (await readCollectionConfig(collection.id))?.collection.remote,
    ).toBeUndefined();
    expect((await readCollectionIndex()).collections).toContainEqual(
      expect.objectContaining({
        id: collection.id,
        hasExistingShare: false,
      }),
    );
  });

  it('restores Collection metadata when a repaired legacy index update fails', async () => {
    const collection = await saveCollectionConfig({ name: 'Legacy shared' });
    const remote = {
      accountId: 'account-a',
      remoteId: '55555555-5555-4555-8555-555555555555',
      contentHash: 'hash-e',
      shareScope: 'organization' as const,
      sharedAt: '2026-09-24T16:00:00.000Z',
    };
    const indexPath = path.join(tempDir, 'collections', 'index.json');
    const legacyIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      collections: Array<Record<string, unknown>>;
    };
    for (const entry of legacyIndex.collections) {
      delete entry.hasExistingShare;
    }
    fs.writeFileSync(indexPath, JSON.stringify(legacyIndex));

    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const actualWriteFile = fsPromises.writeFile;
    const writeSpy = jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementationOnce(actualWriteFile)
      .mockImplementationOnce(actualWriteFile)
      .mockRejectedValueOnce(new Error('index write failed'));

    try {
      await expect(
        writeCollectionRemoteMetadata(collection.id, remote),
      ).rejects.toThrow('index write failed');
    } finally {
      writeSpy.mockRestore();
    }

    expect(
      (await readCollectionConfig(collection.id))?.collection.remote,
    ).toBeUndefined();
    expect((await readCollectionIndex()).collections).toContainEqual(
      expect.objectContaining({
        id: collection.id,
        hasExistingShare: false,
      }),
    );
  });

  it('restores Collection metadata when its unshare index update fails', async () => {
    const collection = await saveCollectionConfig({ name: 'Shared' });
    const remote = {
      accountId: 'account-a',
      remoteId: '44444444-4444-4444-8444-444444444444',
      contentHash: 'hash-d',
      shareScope: 'organization' as const,
      sharedAt: '2026-09-24T16:00:00.000Z',
    };
    await writeCollectionRemoteMetadata(collection.id, remote);

    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const actualWriteFile = fsPromises.writeFile;
    const writeSpy = jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementationOnce(actualWriteFile)
      .mockRejectedValueOnce(new Error('index write failed'));

    try {
      await expect(
        clearCollectionRemoteMetadataByRemoteId(remote.remoteId),
      ).rejects.toThrow('index write failed');
    } finally {
      writeSpy.mockRestore();
    }

    expect(
      (await readCollectionConfig(collection.id))?.collection.remote,
    ).toEqual(remote);
    expect((await readCollectionIndex()).collections).toContainEqual(
      expect.objectContaining({
        id: collection.id,
        hasExistingShare: true,
      }),
    );
  });

  it('repairs legacy index entries from Collection share metadata', async () => {
    const collection = await saveCollectionConfig({ name: 'Legacy shared' });
    const remote = {
      accountId: 'account-a',
      remoteId: '22222222-2222-4222-8222-222222222222',
      contentHash: 'hash-b',
      shareScope: 'team' as const,
      sharedAt: '2026-09-24T16:00:00.000Z',
    };
    const configPath = path.join(
      tempDir,
      'collections',
      `collection-${collection.id}.json`,
    );
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      collection: CollectionConfig;
    };
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        collection: { ...config.collection, remote },
      }),
    );
    const indexPath = path.join(tempDir, 'collections', 'index.json');
    const legacyIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      collections: Array<Record<string, unknown>>;
    };
    for (const entry of legacyIndex.collections) {
      delete entry.hasExistingShare;
    }
    fs.writeFileSync(indexPath, JSON.stringify(legacyIndex));

    await expect(readCollectionIndex()).resolves.toMatchObject({
      collections: [
        expect.objectContaining({
          id: collection.id,
          hasExistingShare: true,
        }),
      ],
    });
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).toMatchObject({
      collections: [
        expect.objectContaining({
          id: collection.id,
          hasExistingShare: true,
        }),
      ],
    });
  });

  it('throws when the Collection index is malformed', async () => {
    fs.mkdirSync(path.join(tempDir, 'collections'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'collections', 'index.json'), '{bad');

    await expect(readCollectionIndex()).rejects.toThrow(
      'Malformed collections/index.json',
    );
  });

  it('migrates legacy Bundle files and preserves MCP refs', async () => {
    const bundleId = '11111111-1111-4111-8111-111111111111';
    fs.mkdirSync(path.join(tempDir, 'bundles'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'bundles', 'index.json'),
      JSON.stringify({
        version: 1,
        bundles: [
          {
            id: bundleId,
            name: 'Legacy',
            description: 'Old bundle',
            updatedAt: '2026-05-22T00:00:00.000Z',
            skillCount: 1,
            pluginCount: 0,
            mcpServerCount: 1,
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(tempDir, 'bundles', `bundle-${bundleId}.json`),
      JSON.stringify({
        version: 1,
        bundle: {
          id: bundleId,
          name: 'Legacy',
          description: 'Old bundle',
          skills: [{ sourceId: 'canopy', skillName: 'review' }],
          plugins: [],
          mcpServers: [
            {
              serverId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              configId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            },
          ],
          createdAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-22T00:00:00.000Z',
        },
      }),
    );

    const index = await readCollectionIndex();
    expect(index.collections).toHaveLength(1);
    const config = await readCollectionConfig(bundleId);
    expect(config).toMatchObject({
      version: 2,
      collection: {
        id: bundleId,
        name: 'Legacy',
        mcpServers: [
          {
            serverId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            configId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        ],
      },
    });
    expect(
      fs.existsSync(
        path.join(tempDir, 'collections', `collection-${bundleId}.json`),
      ),
    ).toBe(true);
  });

  it('saves and deletes version 2 Collection configs', async () => {
    const collection = await saveCollectionConfig({
      name: 'Saved',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    const file = await readCollectionConfig(collection.id);
    expect(file?.version).toBe(2);

    await deleteCollectionConfig(collection.id);
    await expect(readCollectionConfig(collection.id)).resolves.toBeNull();
  });
  describe('install subscriptions', () => {
    const publicSource = {
      remoteId: 'public-a',
      fetchedAt: 'now',
      fromPublicShare: true,
      contentHash: 'public-hash',
    };
    const teamSource = { remoteId: 'remote-a', fetchedAt: 'now' };

    it('registers public and team installs after the local write', async () => {
      const publicCollection = await saveCollectionConfig({
        name: 'Public kit',
        sharedSource: publicSource,
      });
      const teamCollection = await saveCollectionConfig({
        name: 'Team kit',
        sharedSource: teamSource,
      });
      expect(jest.mocked(recordSharedItemInstall).mock.calls).toEqual([
        [
          {
            kind: 'collection',
            remoteId: 'public-a',
            sourceKind: 'public',
            contentHash: 'public-hash',
            localId: publicCollection.id,
          },
        ],
        [
          {
            kind: 'collection',
            remoteId: 'remote-a',
            sourceKind: 'shared',
            contentHash: null,
            localId: teamCollection.id,
          },
        ],
      ]);
    });

    it('does not register a local edit or a refused install', async () => {
      const installed = await saveCollectionConfig({
        name: 'Public kit',
        sharedSource: publicSource,
      });
      jest.mocked(recordSharedItemInstall).mockClear();
      await saveCollectionConfig({ id: installed.id, name: 'Edited' });
      await saveCollectionConfig({ name: 'Local' });
      mockContextEnabled = true;
      await expect(
        saveCollectionConfig({ name: 'Org A', sharedSource: teamSource }),
      ).rejects.toThrow('context-mismatch');
      expect(recordSharedItemInstall).not.toHaveBeenCalled();
    });

    it('unregisters a deleted install, read before the file is removed', async () => {
      const installed = await saveCollectionConfig({
        name: 'Public kit',
        sharedSource: publicSource,
      });
      const local = await saveCollectionConfig({ name: 'Local' });
      await deleteCollectionConfig(local.id);
      expect(recordSharedItemUninstall).not.toHaveBeenCalled();
      await deleteCollectionConfig(installed.id);
      expect(recordSharedItemUninstall).toHaveBeenCalledWith({
        kind: 'collection',
        remoteId: 'public-a',
        sourceKind: 'public',
        localId: installed.id,
      });
    });

    it('unregisters an install that is rolled back', async () => {
      const installed = await saveCollectionConfig({
        name: 'Team kit',
        sharedSource: teamSource,
      });
      await rollbackNewCollectionInstall(installed);
      expect(recordSharedItemUninstall).toHaveBeenCalledWith({
        kind: 'collection',
        remoteId: 'remote-a',
        sourceKind: 'shared',
        localId: installed.id,
      });
    });

    it('lists shared sources for the subscription backfill', async () => {
      const installed = await saveCollectionConfig({
        name: 'Public kit',
        sharedSource: publicSource,
      });
      await saveCollectionConfig({ name: 'Local' });
      await expect(listCollectionSharedSourcesForBackfill()).resolves.toEqual([
        { id: installed.id, sharedSource: publicSource },
      ]);
    });
  });
});
