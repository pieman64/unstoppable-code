import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';

const registered = new Map<string, (...args: unknown[]) => unknown>();
const mockWriteCollectionRemoteMetadata = jest.fn();
const mockRollbackNewCollectionInstall = jest.fn(() => Promise.resolve());

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(channel, handler);
    },
  ),
}));

jest.mock('../canopy-cloud/client', () => ({
  // Share handlers classify failures against the real error class.
  CanopyCloudClientError: class CanopyCloudClientError extends Error {},
  assertCanopyCloudCapability: jest.fn(() => Promise.resolve()),
}));

jest.mock('../collections/collection-store', () => ({
  rollbackNewCollectionInstall: mockRollbackNewCollectionInstall,
  deleteCollectionConfig: jest.fn(() => Promise.resolve()),
  readCollectionConfig: jest.fn(() =>
    Promise.resolve({ collection: { id: 'local-1', name: 'Local' } }),
  ),
  readCollectionIndex: jest.fn(() =>
    Promise.resolve({ collections: [{ id: 'local-1', name: 'Local' }] }),
  ),
  saveCollectionConfig: jest.fn((input: unknown) => Promise.resolve(input)),
  writeCollectionRemoteMetadata: mockWriteCollectionRemoteMetadata,
  clearCollectionRemoteMetadataByRemoteId: jest.fn(() => Promise.resolve()),
}));

jest.mock('../collections/canopy-server-client', () => ({
  createSharedCollection: jest.fn((request: unknown) =>
    Promise.resolve(request),
  ),
  deleteSharedCollection: jest.fn(() => Promise.resolve()),
  getSharedCollection: jest.fn((collectionId: string) =>
    Promise.resolve({ collectionId }),
  ),
  getCollectionPackage: jest.fn(),
  getCollectionPackageBlob: jest.fn(),
  listSharedCollections: jest.fn((request: unknown) =>
    Promise.resolve(request),
  ),
  updateSharedCollection: jest.fn((request: unknown) =>
    Promise.resolve(request),
  ),
}));

jest.mock('../skills/skill-package-install', () => ({
  installSubjectCapabilityPackage: jest.fn(),
}));

jest.mock('../mcp/connection-status', () => ({
  getMcpServerStatusByCatalogId: jest.fn(() => Promise.resolve(null)),
  getMcpServerStatusByName: jest.fn(() => Promise.resolve(null)),
}));

import { assertCanopyCloudCapability } from '../canopy-cloud/client';
import { registerCollectionHandlers } from '../collections/collection-handlers';
import {
  createSharedCollection,
  deleteSharedCollection,
  getCollectionPackage,
  updateSharedCollection,
} from '../collections/canopy-server-client';
import {
  readCollectionConfig,
  saveCollectionConfig,
} from '../collections/collection-store';
import { installSubjectCapabilityPackage } from '../skills/skill-package-install';
import { getMcpServerStatusByCatalogId } from '../mcp/connection-status';

const mockGetCollectionPackage = jest.mocked(getCollectionPackage);
const mockReadCollectionConfig = jest.mocked(readCollectionConfig);
const mockSaveCollectionConfig = jest.mocked(saveCollectionConfig);
const mockInstallSubjectCapabilityPackage = jest.mocked(
  installSubjectCapabilityPackage,
);
const mockGetMcpServerStatusByCatalogId = jest.mocked(
  getMcpServerStatusByCatalogId,
);

const localCollection = {
  id: 'local-1',
  name: 'Local',
  description: 'Imported',
  skills: [{ sourceId: 'builtin:core', skillName: 'review' }],
  plugins: [],
  mcpServers: [],
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
};

const packageDigest = `pp:v1:${'A'.repeat(43)}`;

describe('collection IPC handlers', () => {
  beforeEach(() => {
    registered.clear();
    jest.clearAllMocks();
    mockWriteCollectionRemoteMetadata.mockReset();
    mockReadCollectionConfig.mockResolvedValue({
      version: 2,
      collection: localCollection,
    });
    mockSaveCollectionConfig.mockImplementation((input) =>
      Promise.resolve({ ...localCollection, ...input }),
    );
    mockGetCollectionPackage.mockResolvedValue({
      digest: packageDigest,
      manifest: {
        version: 1,
        pipelineContentHash: 'content-hash',
        resources: [],
        environmentRequirements: [],
        bindings: {},
      },
    });
  });

  it('deletes a newly created remote Collection when local link persistence fails', async () => {
    jest.mocked(createSharedCollection).mockResolvedValue({
      id: 'remote-collection',
      contentHash: 'hash-a',
      createdBy: { id: 'account-a' },
      shareScope: 'private',
      updatedAt: '2026-09-25T00:00:00.000Z',
    } as never);
    mockWriteCollectionRemoteMetadata.mockRejectedValueOnce(
      new Error('collection config is read-only'),
    );
    registerCollectionHandlers();

    const handler = registered.get(COLLECTIONS_CHANNELS.SHARED_CREATE);
    await expect(
      handler?.(null, {
        sourceCollectionId: 'local-1',
        rawCollection: '{"version":1,"name":"Review","items":[]}',
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'unknown' },
    });

    expect(deleteSharedCollection).toHaveBeenCalledWith({
      collectionId: 'remote-collection',
    });
  });

  it('deletes a newly created remote Collection when its local source is missing', async () => {
    jest.mocked(createSharedCollection).mockResolvedValue({
      id: 'remote-collection',
      contentHash: 'hash-a',
      createdBy: { id: 'account-a' },
      shareScope: 'private',
      updatedAt: '2026-09-25T00:00:00.000Z',
    } as never);
    mockWriteCollectionRemoteMetadata.mockResolvedValueOnce(false);
    registerCollectionHandlers();

    const handler = registered.get(COLLECTIONS_CHANNELS.SHARED_CREATE);
    await expect(
      handler?.(null, {
        sourceCollectionId: 'missing-local',
        rawCollection: '{"version":1,"name":"Review","items":[]}',
      }),
    ).resolves.toMatchObject({
      ok: false,
      // The remote share was removed again, so the outcome is certain.
      failure: { kind: 'unknown', commitState: 'not-committed' },
    });

    expect(deleteSharedCollection).toHaveBeenCalledWith({
      collectionId: 'remote-collection',
    });
  });

  it('gates shared collection calls by collections-crud-v1 capability', async () => {
    registerCollectionHandlers();

    const handler = registered.get(COLLECTIONS_CHANNELS.SHARED_LIST);
    expect(handler).toBeDefined();
    await handler?.(null, {});

    expect(assertCanopyCloudCapability).toHaveBeenCalledWith(
      'collections-crud-v1',
    );
  });

  it('maps shared collection update IPC requests after capability checks', async () => {
    registerCollectionHandlers();

    const handler = registered.get(COLLECTIONS_CHANNELS.SHARED_UPDATE);
    const request = {
      collectionId: 'collection-1',
      rawCollection: '{"version":1,"name":"Review","items":[]}',
    };
    await expect(handler?.(null, request)).resolves.toEqual({
      ok: true,
      value: request,
    });

    expect(assertCanopyCloudCapability).toHaveBeenCalledWith(
      'collections-crud-v1',
    );
    expect(updateSharedCollection).toHaveBeenCalledWith(request);
  });

  it('fails an update when its local share link cannot be stored', async () => {
    jest.mocked(updateSharedCollection).mockResolvedValueOnce({
      id: 'remote-collection',
      contentHash: 'hash-b',
      createdBy: { id: 'account-a' },
      shareScope: 'team',
      updatedAt: '2026-09-25T01:00:00.000Z',
    } as never);
    mockWriteCollectionRemoteMetadata.mockResolvedValueOnce(false);
    registerCollectionHandlers();

    const handler = registered.get(COLLECTIONS_CHANNELS.SHARED_UPDATE);
    await expect(
      handler?.(null, {
        collectionId: 'remote-collection',
        sourceCollectionId: 'missing-local',
        rawCollection: '{"version":1,"name":"Review","items":[]}',
      }),
    ).resolves.toMatchObject({
      ok: false,
      // The remote update landed; only the local link failed.
      failure: { kind: 'unknown', stage: 'finish', commitState: 'committed' },
    });

    expect(deleteSharedCollection).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'index write failed'])(
    'cleans only its prepared new shared collection when initial SAVE fails (%s)',
    async (message) => {
      mockSaveCollectionConfig.mockImplementationOnce((input, prepared) => {
        prepared?.({ ...localCollection, ...input, id: 'main-generated' });
        return Promise.reject(new Error(message));
      });
      registerCollectionHandlers();
      await expect(
        registered.get(COLLECTIONS_CHANNELS.SAVE_COLLECTION)?.(null, {
          name: 'New',
          sharedSource: { remoteId: 'shared-1', fetchedAt: 'now' },
        }),
      ).rejects.toThrow(message);
      expect(mockRollbackNewCollectionInstall).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'main-generated', name: 'New' }),
      );
    },
  );
  it('does not clean up an existing shared collection on a failed SAVE', async () => {
    mockSaveCollectionConfig.mockRejectedValueOnce(new Error('revoked'));
    registerCollectionHandlers();
    await expect(
      registered.get(COLLECTIONS_CHANNELS.SAVE_COLLECTION)?.(null, {
        ...localCollection,
        sharedSource: { remoteId: 'shared-1', fetchedAt: 'now' },
      }),
    ).rejects.toThrow('revoked');
    expect(mockRollbackNewCollectionInstall).not.toHaveBeenCalled();
  });
  it('creates no collection when package retrieval fails', async () => {
    mockGetCollectionPackage.mockRejectedValueOnce(new Error('revoked'));
    registerCollectionHandlers();
    await expect(
      registered.get(COLLECTIONS_CHANNELS.PACKAGE_INSTALL)?.(null, {
        collectionId: 'shared-1',
        createCollection: {
          name: 'New',
          description: '',
          sharedSource: { remoteId: 'shared-1', fetchedAt: 'now' },
        },
        packageRef: { version: 1, digest: packageDigest },
      }),
    ).rejects.toThrow('revoked');
    expect(mockReadCollectionConfig).not.toHaveBeenCalled();
    expect(mockSaveCollectionConfig).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'cloud unavailable'])(
    'cleans up its new collection without cloud authorization after %s',
    async (failure) => {
      mockInstallSubjectCapabilityPackage.mockRejectedValueOnce(
        new Error(failure),
      );
      registerCollectionHandlers();
      await expect(
        registered.get(COLLECTIONS_CHANNELS.PACKAGE_INSTALL)?.(null, {
          collectionId: 'shared-1',
          createCollection: {
            name: 'New',
            description: '',
            sharedSource: { remoteId: 'shared-1', fetchedAt: 'now' },
          },
          packageRef: { version: 1, digest: packageDigest },
        }),
      ).rejects.toThrow(failure);
      expect(mockSaveCollectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New',
          skills: [],
          plugins: [],
          mcpServers: [],
        }),
        expect.any(Function),
      );
      expect(mockRollbackNewCollectionInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New',
          sharedSource: { remoteId: 'shared-1', fetchedAt: 'now' },
        }),
        expect.objectContaining({ name: 'New' }),
      );
      expect(mockReadCollectionConfig).not.toHaveBeenCalled();
    },
  );

  it('restores Collection references when package provenance fails', async () => {
    mockInstallSubjectCapabilityPackage.mockImplementation(async (request) => {
      const installed = {
        supportingFileCount: 0,
        installedSkills: [{ name: 'Helper', localName: 'helper-2' }],
        uninstalledResourceLabels: [],
        keptLocalFiles: [],
      };
      if (!request.finalizeInstall || !request.rollbackFinalization) {
        throw new Error('missing install transaction callbacks');
      }
      await request.finalizeInstall(installed);
      await request.rollbackFinalization();
      throw new Error('ledger read-only');
    });
    registerCollectionHandlers();

    const handler = registered.get(COLLECTIONS_CHANNELS.PACKAGE_INSTALL);
    await expect(
      handler?.(null, {
        collectionId: 'shared-1',
        localCollectionId: 'local-1',
        packageRef: { version: 1, digest: packageDigest },
      }),
    ).rejects.toThrow('ledger read-only');

    expect(mockSaveCollectionConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'local-1',
        skills: [
          { sourceId: 'builtin:core', skillName: 'review' },
          { sourceId: 'custom:app', skillName: 'helper-2' },
        ],
      }),
    );
    expect(mockSaveCollectionConfig).toHaveBeenNthCalledWith(
      2,
      localCollection,
    );
  });

  it('resolves Collection MCP requirements before installing package files', async () => {
    mockGetCollectionPackage.mockResolvedValue({
      digest: packageDigest,
      manifest: {
        version: 1,
        pipelineContentHash: 'content-hash',
        resources: [],
        environmentRequirements: [
          {
            id: 'mcp:slack',
            kind: 'mcp',
            displayName: 'Slack',
            required: true,
            affectedSteps: [],
            setupHint: 'Connect Slack.',
          },
        ],
        bindings: {},
      },
    });
    mockGetMcpServerStatusByCatalogId.mockRejectedValue(
      new Error('status unavailable'),
    );
    mockInstallSubjectCapabilityPackage.mockResolvedValue({
      supportingFileCount: 0,
      installedSkills: [],
      uninstalledResourceLabels: [],
      keptLocalFiles: [],
    });
    registerCollectionHandlers();

    const handler = registered.get(COLLECTIONS_CHANNELS.PACKAGE_INSTALL);
    await expect(
      handler?.(null, {
        collectionId: 'shared-1',
        localCollectionId: 'local-1',
        packageRef: { version: 1, digest: packageDigest },
      }),
    ).rejects.toThrow('status unavailable');

    expect(mockInstallSubjectCapabilityPackage).not.toHaveBeenCalled();
  });
});
