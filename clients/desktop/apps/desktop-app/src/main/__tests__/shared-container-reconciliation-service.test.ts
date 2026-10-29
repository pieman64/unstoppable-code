import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { SharedContainerReconciliationService } from '../shared-containers/reconciliation-service';
import { SharedContainerReplicaManager } from '../shared-containers/replica/manager';
import type { SharedContainerReplicaBroadcast } from '@canopy/desktop-shared/types';
import { getObservabilityService } from '../observability';
import {
  buildSharedContainerReplicaFixture as buildFixture,
  fetchForSharedContainerFixture as fetchFor,
  transportForSharedContainerFixture as transportFor,
} from './fixtures/shared-container-replica-fixture';

function availableState(): {
  status: 'available';
  containerId: string;
  organizationId: string;
  containerType: 'COWORK_WORK_ENTRY';
  revisionId: string;
  revision: number;
  revisionCreatedAt: string;
  updatedAt: string;
} {
  return {
    status: 'available' as const,
    containerId: 'container-1',
    organizationId: 'org-1',
    containerType: 'COWORK_WORK_ENTRY' as const,
    revisionId: 'revision-1',
    revision: 1,
    revisionCreatedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

const dismissalCredentials = {
  baseUrl: 'https://cloud.example.test',
  apiKey: 'account-a-key',
  capabilities: ['shared-containers-v1'],
};

function resolveDismissalCredentials(): Promise<typeof dismissalCredentials> {
  return Promise.resolve(dismissalCredentials);
}

function validatedServerError(
  message: string,
  status: number,
): CanopyCloudClientError {
  return new CanopyCloudClientError(
    'http-error',
    message,
    status,
    undefined,
    undefined,
    true,
  );
}

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
  })),
}));

const recordSessionDiagnostic = jest.fn();
const observabilityMock = jest.mocked(getObservabilityService);

beforeEach(() => {
  recordSessionDiagnostic.mockClear();
  observabilityMock.mockReturnValue({
    recordSessionDiagnostic,
  } as unknown as ReturnType<typeof getObservabilityService>);
});

describe('shared-container reconciliation service', () => {
  it('blocks an account transition when root-wide cleanup finds a symbolic replica root', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
    const rootDir = join(parentDir, 'replica');
    const outsideDir = join(parentDir, 'outside');
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );
    await manager.sync('container-1', 'org-1');
    await rename(rootDir, outsideDir);
    const sentinelPath = join(outsideDir, 'container-1', 'sentinel.txt');
    await writeFile(sentinelPath, 'must survive');
    await symlink(
      outsideDir,
      rootDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    let accountPersisted = false;

    await expect(
      service.withReplicaPurgeFence(() => {
        accountPersisted = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(/symbolic link|junction/i);

    expect(accountPersisted).toBe(false);
    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('must survive');
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])(
    'blocks an account transition for a missing populated root (restart: %s)',
    async (restart) => {
      const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
      const rootDir = join(parentDir, 'replica');
      const outsideDir = join(parentDir, 'outside');
      const fixture = await buildFixture();
      const transport = transportFor(fixture);
      const initialManager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
      });
      await initialManager.sync('container-1', 'org-1');
      await rename(rootDir, outsideDir);
      const sentinelPath = join(outsideDir, 'container-1', 'sentinel.txt');
      await writeFile(sentinelPath, 'must survive');
      const manager = restart
        ? new SharedContainerReplicaManager({
            rootDir,
            transport,
            fetchImpl: fetchFor(fixture),
          })
        : initialManager;
      const service = new SharedContainerReconciliationService(
        manager,
        transport,
      );
      let accountPersisted = false;
      await expect(
        service.withReplicaPurgeFence(() => {
          accountPersisted = true;
          return Promise.resolve();
        }),
      ).rejects.toThrow(/replica root.*missing/i);
      expect(accountPersisted).toBe(false);
      expect(await readFile(sentinelPath, 'utf8')).toBe('must survive');
    },
  );

  it.each([false, true])(
    'discards a replaced root before persisting an account transition (restart: %s)',
    async (restart) => {
      const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
      const rootDir = join(parentDir, 'replica');
      const outsideDir = join(parentDir, 'outside');
      const fixture = await buildFixture();
      const transport = transportFor(fixture);
      const initialManager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
      });
      await initialManager.sync('container-1', 'org-1');
      await rename(rootDir, outsideDir);
      const sentinelPath = join(outsideDir, 'container-1', 'sentinel.txt');
      await writeFile(sentinelPath, 'must survive');
      await mkdir(rootDir);
      const replacementSentinelPath = join(rootDir, 'replacement.txt');
      await writeFile(replacementSentinelPath, 'discard');
      const manager = restart
        ? new SharedContainerReplicaManager({
            rootDir,
            transport,
            fetchImpl: fetchFor(fixture),
          })
        : initialManager;
      const service = new SharedContainerReconciliationService(
        manager,
        transport,
      );
      let accountPersisted = false;
      await service.withReplicaPurgeFence(async () => {
        await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
        accountPersisted = true;
      });
      expect(accountPersisted).toBe(true);
      expect(await readFile(sentinelPath, 'utf8')).toBe('must survive');
      await expect(stat(replacementSentinelPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        JSON.parse(
          await readFile(join(parentDir, '.replica.identity.json'), 'utf8'),
        ),
      ).toEqual({ version: 1, state: 'absent' });
    },
  );

  it.each(['remounted', 'unconfirmed'])(
    'cleans an independently initialized %s root before persisting sign-out',
    async (mode) => {
      const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
      const rootDir = join(parentDir, 'replica');
      const fixture = await buildFixture();
      const transport = transportFor(fixture);
      const initialManager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
      });
      await initialManager.sync('container-1', 'org-1');
      const markerPath = join(parentDir, '.replica.identity.json');
      const marker: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
      if (
        !marker ||
        typeof marker !== 'object' ||
        !('dev' in marker) ||
        typeof marker.dev !== 'string'
      ) {
        throw new Error('Expected a persisted root identity');
      }
      await writeFile(
        markerPath,
        JSON.stringify({
          ...marker,
          dev: String(BigInt(marker.dev) + BigInt(1)),
          ...(mode === 'unconfirmed' ? { birthtime: undefined } : {}),
        }),
      );
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
      });
      const service = new SharedContainerReconciliationService(
        manager,
        transport,
      );
      let accountPersisted = false;
      await service.withReplicaPurgeFence(async () => {
        await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.parse(await readFile(markerPath, 'utf8'))).toMatchObject({
          state: 'absent',
        });
        accountPersisted = true;
      });
      expect(accountPersisted).toBe(true);
    },
  );

  it('blocks an account transition when the replica root is swapped after validation', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
    const rootDir = join(parentDir, 'replica');
    const outsideDir = join(parentDir, 'outside');
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );
    await manager.sync('container-1', 'org-1');
    const outsideSentinelPath = join(outsideDir, 'container-1', 'sentinel.txt');
    const replacementSentinelPath = join(rootDir, 'replacement.txt');
    const store = manager.store as unknown as {
      validateReplicaRootForMutation(): Promise<unknown>;
    };
    const originalValidate = store.validateReplicaRootForMutation.bind(store);
    jest
      .spyOn(store, 'validateReplicaRootForMutation')
      .mockImplementationOnce(async () => {
        const validated = await originalValidate();
        await rename(rootDir, outsideDir);
        await writeFile(outsideSentinelPath, 'must survive');
        await mkdir(rootDir);
        await writeFile(replacementSentinelPath, 'do not delete');
        return validated;
      });
    let accountPersisted = false;

    await expect(
      service.withReplicaPurgeFence(() => {
        accountPersisted = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(/replica root.*changed/i);

    expect(accountPersisted).toBe(false);
    await expect(readFile(outsideSentinelPath, 'utf8')).resolves.toBe(
      'must survive',
    );
    await expect(readFile(replacementSentinelPath, 'utf8')).resolves.toBe(
      'do not delete',
    );
  });

  it('blocks an account transition when the verified quarantine is swapped', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
    const rootDir = join(parentDir, 'replica');
    const outsideDir = join(parentDir, 'outside');
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );
    await manager.sync('container-1', 'org-1');
    const outsideSentinelPath = join(outsideDir, 'container-1', 'sentinel.txt');
    const store = manager.store as unknown as {
      lstatIfPresent(path: string): Promise<unknown>;
    };
    const originalLstat = store.lstatIfPresent.bind(store);
    let replacementSentinelPath = '';
    jest.spyOn(store, 'lstatIfPresent').mockImplementation(async (path) => {
      const info = await originalLstat(path);
      if (
        !replacementSentinelPath &&
        path.startsWith(join(parentDir, '.replica.purge-')) &&
        info
      ) {
        await rename(path, outsideDir);
        await writeFile(outsideSentinelPath, 'must be erased before commit');
        await mkdir(path);
        replacementSentinelPath = join(path, 'replacement.txt');
        await writeFile(replacementSentinelPath, 'do not delete');
      }
      return info;
    });
    let accountPersisted = false;

    await expect(
      service.withReplicaPurgeFence(() => {
        accountPersisted = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(/replica root.*changed/i);

    expect(accountPersisted).toBe(false);
    await expect(stat(outsideSentinelPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(replacementSentinelPath, 'utf8')).resolves.toBe(
      'do not delete',
    );
    expect(await readdir(parentDir)).toContain('outside');
  });

  // CAN-2551: closing a viewer is ordinary navigation, not a retention
  // boundary. Purging there made every reopen a cold start (two HTTPS round
  // trips, a full artifact re-download, and a fresh `git clone`), so plaintext
  // now lives as long as the acceptance does.
  it('retains the replica when its container closes, and only drops tracking', async () => {
    const state = availableState();
    const manager = {
      close: jest.fn(() => Promise.resolve(true)),
      purge: jest.fn(() => Promise.resolve(true)),
    };
    const changed = jest.fn();
    const service = new SharedContainerReconciliationService(manager as never, {
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    });
    service.onChanged(changed);

    await service.close(state.containerId);

    expect(manager.close).not.toHaveBeenCalled();
    expect(manager.purge).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('still purges the replica when the recipient removes the share', async () => {
    const state = availableState();
    const manager = {
      close: jest.fn(() => Promise.resolve(true)),
      purge: jest.fn(() => Promise.resolve(true)),
      captureAuthorizationGeneration: jest.fn(() => 0),
    };
    const dismissRemote = jest.fn(() => Promise.resolve());
    const service = new SharedContainerReconciliationService(
      manager as never,
      {
        resolveLatest: jest.fn(),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      },
      dismissRemote,
      () => Promise.resolve({} as never),
    );

    await service.dismiss(state.containerId, state.organizationId);

    expect(dismissRemote).toHaveBeenCalled();
    expect(manager.purge).toHaveBeenCalledWith(
      state.containerId,
      expect.objectContaining({ authorizationGeneration: 0 }),
    );
  });

  it('announces an ordinary purge after bytes are deleted despite cleanup failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const cleanupFailure = new Error('view cleanup failed');
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
      cleanupViewState: (): Promise<void> => Promise.reject(cleanupFailure),
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );
    const changed = jest.fn<void, [SharedContainerReplicaBroadcast]>();
    service.onChanged(changed);
    await manager.sync('container-1', 'org-1');
    recordSessionDiagnostic.mockClear();

    await expect(service.purge('container-1', 'access-denied')).rejects.toBe(
      cleanupFailure,
    );

    expect(changed).toHaveBeenCalledWith({
      purged: 'container',
      containerId: 'container-1',
    });
    expect(recordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedContainerId: 'container-1',
        sharedContainerPurgeReason: 'access-denied',
      }),
    );
  });

  it.each([
    ['missing', null],
    ['corrupt', '{not-json'],
  ])(
    'purges orphaned plaintext before an organization snapshot when the index is %s',
    async (_case, indexContents) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const orphanPath = join(rootDir, 'orphan-container', 'plaintext');
      await mkdir(join(rootDir, 'orphan-container'), { recursive: true });
      await writeFile(orphanPath, 'secret');
      if (indexContents !== null) {
        await writeFile(join(rootDir, 'index.json'), indexContents);
      }
      const fixture = await buildFixture();
      const transport = transportFor(fixture);
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
      });
      const service = new SharedContainerReconciliationService(
        manager,
        transport,
      );

      await service.reconcileOrganizationSnapshot([]);

      await expect(stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('purges unindexed plaintext before applying a container-list snapshot', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const orphanPath = join(rootDir, 'orphan-container', 'plaintext');
    await mkdir(join(rootDir, 'orphan-container'), { recursive: true });
    await writeFile(orphanPath, 'secret');
    await writeFile(join(rootDir, 'index.json'), '{not-json');
    const fixture = await buildFixture();
    const transport = {
      ...transportFor(fixture),
      listSharedWithMe: jest.fn(() =>
        Promise.resolve({ containers: [], nextCursor: null }),
      ),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );

    await service.listSharedWithMe({ organizationId: 'org-1' });

    await expect(stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not fetch content while listing invitations', async () => {
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      purge: jest.fn(),
      pin: jest.fn(),
      beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
      reconcileContainerSnapshot: jest.fn(() => Promise.resolve()),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {} }),
        ),
      },
    };
    const transport = {
      listSharedWithMe: jest.fn(() =>
        Promise.resolve({ containers: [], nextCursor: null }),
      ),
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    };
    const service = new SharedContainerReconciliationService(
      manager as never,
      transport,
    );

    await service.listSharedWithMe({ organizationId: 'org-1' });
    expect(manager.sync).not.toHaveBeenCalled();
  });

  it('purges cached containers absent from a complete paginated listing', async () => {
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      purge: jest.fn(() => Promise.resolve()),
      purgeAll: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
      reconcileContainerSnapshot: jest.fn(() => Promise.resolve()),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({
            version: 1,
            containers: {
              'container-1': availableState(),
              'container-2': {
                ...availableState(),
                containerId: 'container-2',
              },
              'other-org': {
                ...availableState(),
                containerId: 'other-org',
                organizationId: 'org-2',
              },
            },
          }),
        ),
      },
    };
    const listSharedWithMe = jest
      .fn()
      .mockResolvedValueOnce({
        containers: [{ id: 'container-1' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({ containers: [], nextCursor: null });
    const service = new SharedContainerReconciliationService(
      manager as never,
      {
        listSharedWithMe,
        resolveLatest: jest.fn(),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      } as never,
    );

    await service.listSharedWithMe({ organizationId: 'org-1', limit: 20 });

    expect(listSharedWithMe).toHaveBeenNthCalledWith(2, {
      organizationId: 'org-1',
      limit: 20,
      cursor: 'page-2',
    });
    expect(manager.reconcileContainerSnapshot).toHaveBeenCalledWith(
      'org-1',
      ['container-1'],
      1,
      expect.any(Function),
    );
  });

  it('does not apply an older first-page snapshot after a newer listing starts', async () => {
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      purge: jest.fn(),
      pin: jest.fn(),
      beginContainerSnapshotListing: jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
      reconcileContainerSnapshot: jest.fn(() => Promise.resolve()),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {} }),
        ),
      },
    };
    let resolveOlder!: (value: {
      containers: Array<{ id: string }>;
      nextCursor: null;
    }) => void;
    let resolveNewer!: typeof resolveOlder;
    const listSharedWithMe = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewer = resolve;
          }),
      );
    const service = new SharedContainerReconciliationService(
      manager as never,
      {
        listSharedWithMe,
        resolveLatest: jest.fn(),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      } as never,
    );

    const older = service.listSharedWithMe({ organizationId: 'org-1' });
    const newer = service.listSharedWithMe({ organizationId: 'org-1' });
    resolveNewer({ containers: [{ id: 'newer' }], nextCursor: null });
    await expect(newer).resolves.toMatchObject({
      containers: [{ id: 'newer' }],
    });
    resolveOlder({ containers: [{ id: 'older' }], nextCursor: null });

    await expect(older).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.reconcileContainerSnapshot).toHaveBeenCalledTimes(1);
    expect(manager.reconcileContainerSnapshot).toHaveBeenCalledWith(
      'org-1',
      ['newer'],
      2,
      expect.any(Function),
    );
  });

  it('does not let an older listing purge after its reconciliation has entered', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = {
      ...transportFor(fixture),
      listSharedWithMe: jest
        .fn()
        .mockResolvedValueOnce({ containers: [], nextCursor: null })
        .mockResolvedValueOnce({
          containers: [{ id: 'container-1' }],
          nextCursor: null,
        }),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalEnsureIntegrity =
      manager.ensureReplicaStoreIntegrity.bind(manager);
    let markOlderReconciliationEntered!: () => void;
    const olderReconciliationEntered = new Promise<void>((resolve) => {
      markOlderReconciliationEntered = resolve;
    });
    let releaseOlderReconciliation!: () => void;
    const olderReconciliationGate = new Promise<void>((resolve) => {
      releaseOlderReconciliation = resolve;
    });
    let integrityChecks = 0;
    jest
      .spyOn(manager, 'ensureReplicaStoreIntegrity')
      .mockImplementation(async (): Promise<void> => {
        integrityChecks += 1;
        if (integrityChecks === 1) {
          markOlderReconciliationEntered();
          await olderReconciliationGate;
        }
        await originalEnsureIntegrity();
      });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );

    const older = service.listSharedWithMe({ organizationId: 'org-1' });
    await olderReconciliationEntered;
    const newer = service.listSharedWithMe({ organizationId: 'org-1' });
    await expect(newer).resolves.toMatchObject({
      containers: [{ id: 'container-1' }],
    });
    releaseOlderReconciliation();

    await expect(older).rejects.toMatchObject({ name: 'AbortError' });
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'available',
      revisionId: 'revision-1',
    });
  });

  it('does not let an older installed snapshot purge after a newer listing starts', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    let listingCalls = 0;
    let markNewerFetchStarted!: () => void;
    const newerFetchStarted = new Promise<void>((resolve) => {
      markNewerFetchStarted = resolve;
    });
    const transport = {
      ...transportFor(fixture),
      listSharedWithMe: jest.fn(() => {
        listingCalls += 1;
        if (listingCalls === 2) markNewerFetchStarted();
        return Promise.resolve(
          listingCalls === 1
            ? { containers: [], nextCursor: null }
            : {
                containers: [{ id: 'container-1' }],
                nextCursor: null,
              },
        );
      }),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalReadIndex = manager.store.readIndex.bind(manager.store);
    let markOlderSnapshotInstalled!: () => void;
    const olderSnapshotInstalled = new Promise<void>((resolve) => {
      markOlderSnapshotInstalled = resolve;
    });
    let releaseOlderSnapshot!: () => void;
    const olderSnapshotGate = new Promise<void>((resolve) => {
      releaseOlderSnapshot = resolve;
    });
    jest.spyOn(manager.store, 'readIndex').mockImplementationOnce(async () => {
      markOlderSnapshotInstalled();
      await olderSnapshotGate;
      return originalReadIndex();
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );

    const older = service.listSharedWithMe({ organizationId: 'org-1' });
    await olderSnapshotInstalled;
    const newer = service.listSharedWithMe({ organizationId: 'org-1' });
    await newerFetchStarted;
    releaseOlderSnapshot();

    await expect(older).rejects.toMatchObject({ name: 'AbortError' });
    await expect(newer).resolves.toMatchObject({
      containers: [{ id: 'container-1' }],
    });
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'available',
      revisionId: 'revision-1',
    });
  });

  it('purges organization replicas after conclusive listing access denial', async () => {
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      purge: jest.fn(() => Promise.resolve()),
      purgeAll: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
      reconcileContainerSnapshot: jest.fn(() => Promise.resolve()),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({
            version: 1,
            containers: {
              'container-1': availableState(),
              'other-org': {
                ...availableState(),
                containerId: 'other-org',
                organizationId: 'org-2',
              },
            },
          }),
        ),
      },
    };
    const service = new SharedContainerReconciliationService(manager as never, {
      listSharedWithMe: jest.fn(() =>
        Promise.reject(validatedServerError('org gone', 403)),
      ),
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    });

    await expect(
      service.listSharedWithMe({ organizationId: 'org-1' }),
    ).rejects.toThrow('org gone');
    expect(manager.reconcileContainerSnapshot).toHaveBeenCalledWith(
      'org-1',
      [],
      1,
      expect.any(Function),
    );
  });

  it('purges synchronized plaintext after a validated denial with a corrupt index', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const plaintextPath = join(
      rootDir,
      'container-1',
      'revisions',
      'revision-1',
      'artifacts',
      'chats',
      'chat-1.json',
    );
    await writeFile(join(rootDir, 'index.json'), '{not-json');
    jest
      .spyOn(manager, 'sync')
      .mockRejectedValueOnce(validatedServerError('container denied', 403));
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );

    const denial = (
      service as unknown as {
        reconcile(
          containerId: string,
          organizationId: string,
          force: boolean,
        ): Promise<unknown>;
      }
    ).reconcile('container-1', 'org-1', false);

    await expect(denial).rejects.toThrow('container denied');
    await expect(stat(plaintextPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([401, 403])(
    'does not purge organization replicas for an unstructured HTTP %i listing response',
    async (status) => {
      const manager = {
        sync: jest.fn(),
        getState: jest.fn(),
        purge: jest.fn(),
        pin: jest.fn(),
        beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
        reconcileContainerSnapshot: jest.fn(() => Promise.resolve()),
        store: {
          readIndex: jest.fn(() =>
            Promise.resolve({ version: 1, containers: {} }),
          ),
        },
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          listSharedWithMe: jest.fn(() =>
            Promise.reject(
              new CanopyCloudClientError(
                'http-error',
                '<html>intermediary response</html>',
                status,
              ),
            ),
          ),
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );

      await expect(
        service.listSharedWithMe({ organizationId: 'org-1' }),
      ).rejects.toThrow('intermediary response');
      expect(manager.reconcileContainerSnapshot).not.toHaveBeenCalled();
    },
  );

  it('purges replicas outside a confirmed organization snapshot', async () => {
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
      withOrganizationSnapshotFence: jest.fn(
        async (
          _organizationIds: readonly string[],
          operation: () => Promise<unknown>,
        ) => operation(),
      ),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({
            version: 1,
            containers: {
              retained: availableState(),
              removed: {
                ...availableState(),
                containerId: 'removed',
                organizationId: 'org-removed',
              },
            },
          }),
        ),
      },
    };
    const service = new SharedContainerReconciliationService(manager as never, {
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    });

    await service.reconcileOrganizationSnapshot(['org-1']);

    expect(manager.purge).toHaveBeenCalledTimes(1);
    expect(manager.purge).toHaveBeenCalledWith('removed', {
      allowDuringAuthorizationTransition: true,
    });
  });

  it('aborts an active first sync outside a confirmed organization snapshot before it can commit', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    fixture.detail.organizationId = 'org-removed';
    const transport = transportFor(fixture);
    const requestDownloadUrls = jest.spyOn(transport, 'requestDownloadUrls');
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    let releaseDownload!: () => void;
    let pauseFirstDownload = true;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: ((input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const response = (): Response =>
          new Response(fixture.responses.get(url));
        if (!pauseFirstDownload) return Promise.resolve(response());
        pauseFirstDownload = false;
        markDownloadStarted();
        return new Promise<Response>((resolve, reject) => {
          let settled = false;
          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            reject(new DOMException('Aborted', 'AbortError'));
          };
          init?.signal?.addEventListener('abort', onAbort, { once: true });
          releaseDownload = (): void => {
            if (settled) return;
            settled = true;
            init?.signal?.removeEventListener('abort', onAbort);
            resolve(response());
          };
        });
      }) as typeof fetch,
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );

    const syncing = manager.sync('container-1', 'org-removed');
    await downloadStarted;
    expect(requestDownloadUrls).toHaveBeenCalledTimes(1);

    let persisted = false;
    await service.reconcileOrganizationSnapshot(
      ['org-retained'],
      async (): Promise<void> => {
        await expect(
          manager.sync('container-1', 'org-removed'),
        ).rejects.toMatchObject({ name: 'AbortError' });
        persisted = true;
      },
    );
    releaseDownload();

    await expect(syncing).rejects.toMatchObject({ name: 'AbortError' });
    expect(persisted).toBe(true);
    await expect(manager.getState('container-1')).resolves.toBeNull();
    await expect(
      stat(join(rootDir, 'container-1', 'staging', 'revision-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(join(rootDir, 'container-1', 'revisions', 'revision-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['absent', 'denied'] as const)(
    'aborts an active first sync after a conclusive %s listing result',
    async (outcome) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture();
      const transport = {
        ...transportFor(fixture),
        listSharedWithMe:
          outcome === 'absent'
            ? jest.fn(() =>
                Promise.resolve({ containers: [], nextCursor: null }),
              )
            : jest.fn(() =>
                Promise.reject(validatedServerError('org gone', 403)),
              ),
      };
      let markDownloadStarted!: () => void;
      const downloadStarted = new Promise<void>((resolve) => {
        markDownloadStarted = resolve;
      });
      let markDownloadAborted!: () => void;
      const downloadAborted = new Promise<void>((resolve) => {
        markDownloadAborted = resolve;
      });
      let releaseDownload!: () => void;
      let pauseFirstDownload = true;
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: ((input, init) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (!pauseFirstDownload) {
            return Promise.resolve(new Response(fixture.responses.get(url)));
          }
          pauseFirstDownload = false;
          markDownloadStarted();
          return new Promise<Response>((resolve, reject) => {
            let settled = false;
            const onAbort = (): void => {
              if (settled) return;
              settled = true;
              markDownloadAborted();
              reject(new DOMException('Aborted', 'AbortError'));
            };
            init?.signal?.addEventListener('abort', onAbort, { once: true });
            releaseDownload = (): void => {
              if (settled) return;
              settled = true;
              init?.signal?.removeEventListener('abort', onAbort);
              resolve(new Response(fixture.responses.get(url)));
            };
          });
        }) as typeof fetch,
      });
      const service = new SharedContainerReconciliationService(
        manager,
        transport,
      );
      const syncing = manager.sync('container-1', 'org-1');
      await downloadStarted;

      const listing = service
        .listSharedWithMe({ organizationId: 'org-1' })
        .then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        );
      const first = await Promise.race([
        listing.then(() => 'listing' as const),
        downloadAborted.then(() => 'aborted' as const),
      ]);
      if (first === 'listing') releaseDownload();

      await expect(listing).resolves.toBe(
        outcome === 'absent' ? 'resolved' : 'rejected',
      );
      const syncResult = await syncing.then(
        () => 'resolved' as const,
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          typeof error.name === 'string'
            ? error.name
            : String(error),
      );
      expect(first).toBe('aborted');
      expect(syncResult).toBe('AbortError');
      await expect(manager.getState('container-1')).resolves.toBeNull();
    },
  );

  it('retries local cleanup after a remote dismissal already succeeded', async () => {
    const purgeFailure = new Error('local purge failed');
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      captureAuthorizationGeneration: jest.fn(() => 0),
      purge: jest
        .fn<Promise<void>, [string]>()
        .mockRejectedValueOnce(purgeFailure)
        .mockResolvedValueOnce(),
      pin: jest.fn(),
      store: { readIndex: jest.fn() },
    };
    const dismissRemote = jest
      .fn<Promise<void>, [string, string, typeof dismissalCredentials]>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(validatedServerError('grant not found', 404));
    const service = new SharedContainerReconciliationService(
      manager as never,
      {
        resolveLatest: jest.fn(),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      },
      dismissRemote,
      resolveDismissalCredentials,
    );

    await expect(service.dismiss('container-1', 'org-1')).rejects.toBe(
      purgeFailure,
    );
    await expect(
      service.dismiss('container-1', 'org-1'),
    ).resolves.toBeUndefined();

    expect(dismissRemote).toHaveBeenCalledTimes(2);
    expect(manager.purge).toHaveBeenCalledTimes(2);
  });

  it('does not treat an unvalidated dismissal 404 as authoritative success', async () => {
    const remoteFailure = new CanopyCloudClientError(
      'http-error',
      '<html>intermediary response</html>',
      404,
    );
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      captureAuthorizationGeneration: jest.fn(() => 0),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      store: { readIndex: jest.fn() },
    };
    const service = new SharedContainerReconciliationService(
      manager as never,
      {
        resolveLatest: jest.fn(),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      },
      jest.fn(() => Promise.reject(remoteFailure)),
      resolveDismissalCredentials,
    );

    await expect(service.dismiss('container-1', 'org-1')).rejects.toBe(
      remoteFailure,
    );
    expect(manager.purge).toHaveBeenCalledWith('container-1', {
      authorizationGeneration: 0,
    });
  });

  it('purges local content while preserving a non-idempotent remote dismissal error', async () => {
    const remoteFailure = new CanopyCloudClientError(
      'http-error',
      'service unavailable',
      503,
    );
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      captureAuthorizationGeneration: jest.fn(() => 0),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      store: { readIndex: jest.fn() },
    };
    const service = new SharedContainerReconciliationService(
      manager as never,
      {
        resolveLatest: jest.fn(),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      },
      jest.fn(() => Promise.reject(remoteFailure)),
      resolveDismissalCredentials,
    );

    await expect(service.dismiss('container-1', 'org-1')).rejects.toBe(
      remoteFailure,
    );
    expect(manager.purge).toHaveBeenCalledWith('container-1', {
      authorizationGeneration: 0,
    });
  });

  it('does not let a stale dismissal purge a replacement identity replica', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');

    let markDismissStarted!: () => void;
    const dismissStarted = new Promise<void>((resolve) => {
      markDismissStarted = resolve;
    });
    let releaseDismiss!: () => void;
    const dismissRemote = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          markDismissStarted();
          releaseDismiss = resolve;
        }),
    );
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
      dismissRemote,
      resolveDismissalCredentials,
    );

    const dismissing = service.dismiss('container-1', 'org-1');
    await dismissStarted;
    await service.withReplicaPurgeFence(() => Promise.resolve());
    await manager.sync('container-1', 'org-1');
    releaseDismiss();

    await expect(dismissing).rejects.toMatchObject({ name: 'AbortError' });
    expect(dismissRemote).toHaveBeenCalledWith(
      'container-1',
      'org-1',
      dismissalCredentials,
    );
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'available',
      containerId: 'container-1',
    });
  });

  it('delegates sign-out cleanup to the manager root-wide purge fence', async () => {
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      purge: jest.fn(),
      purgeAll: jest.fn(() => Promise.resolve()),
      withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
        operation(),
      ),
      pin: jest.fn(),
      store: { readIndex: jest.fn() },
    };
    const service = new SharedContainerReconciliationService(manager as never, {
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    });

    await service.purgeAll();

    expect(manager.withPurgeAllFence).toHaveBeenCalledTimes(1);
    expect(manager.purgeAll).not.toHaveBeenCalled();
    expect(manager.store.readIndex).not.toHaveBeenCalled();
  });

  it('preserves an intact cache without pinning when a revision 404s but the container remains reachable', async () => {
    const state = availableState();
    const manager = {
      sync: jest.fn(() =>
        Promise.reject(
          new CanopyCloudClientError('http-error', 'revision gone', 404),
        ),
      ),
      getState: jest.fn(() => Promise.resolve(state)),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(() =>
        Promise.resolve({ ...state, status: 'pinned' as const }),
      ),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {} }),
        ),
      },
    };
    const transport = {
      resolveLatest: jest.fn(() => Promise.resolve({ id: 'container-1' })),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    };
    const service = new SharedContainerReconciliationService(
      manager as never,
      transport as never,
    );

    await expect(service.open('container-1', 'org-1')).rejects.toThrow(
      'revision gone',
    );
    expect(manager.pin).not.toHaveBeenCalled();
    expect(manager.purge).not.toHaveBeenCalled();
  });

  it.each([403, 404])(
    'purges when the container access probe returns HTTP %i',
    async (status) => {
      const manager = {
        sync: jest.fn(() =>
          Promise.reject(
            new CanopyCloudClientError('http-error', 'revision gone', 404),
          ),
        ),
        getState: jest.fn(),
        purge: jest.fn(() => Promise.resolve()),
        pin: jest.fn(),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
        store: {
          readIndex: jest.fn(() =>
            Promise.resolve({ version: 1, containers: {} }),
          ),
        },
      };
      const transport = {
        resolveLatest: jest.fn(() =>
          Promise.reject(validatedServerError('container gone', status)),
        ),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        transport as never,
      );

      await expect(service.open('container-1', 'org-1')).rejects.toThrow(
        'revision gone',
      );
      expect(manager.purge).toHaveBeenCalledWith('container-1', {
        expectedOrganizationId: 'org-1',
      });
    },
  );

  it.each([403, 404])(
    'does not purge when the container access probe gets an unstructured HTTP %i response',
    async (status) => {
      const manager = {
        sync: jest.fn(() =>
          Promise.reject(
            new CanopyCloudClientError('http-error', 'revision gone', 404),
          ),
        ),
        getState: jest.fn(),
        purge: jest.fn(() => Promise.resolve()),
        pin: jest.fn(),
        store: {
          readIndex: jest.fn(() =>
            Promise.resolve({ version: 1, containers: {} }),
          ),
        },
      };
      const transport = {
        resolveLatest: jest.fn(() =>
          Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              '<html>intermediary response</html>',
              status,
            ),
          ),
        ),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        transport as never,
      );

      await expect(service.open('container-1', 'org-1')).rejects.toThrow(
        'revision gone',
      );
      expect(manager.purge).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])(
    'does not purge when replica sync gets an unstructured HTTP %i response',
    async (status) => {
      const manager = {
        sync: jest.fn(() =>
          Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              '<html>intermediary response</html>',
              status,
            ),
          ),
        ),
        getState: jest.fn(),
        purge: jest.fn(() => Promise.resolve()),
        pin: jest.fn(),
        store: {
          readIndex: jest.fn(() =>
            Promise.resolve({ version: 1, containers: {} }),
          ),
        },
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );

      await expect(service.open('container-1', 'org-1')).rejects.toThrow(
        'intermediary response',
      );
      expect(manager.purge).not.toHaveBeenCalled();
    },
  );

  it('does not pin from an old-identity authorization probe after a root purge fence', async () => {
    const state = availableState();
    const manager = {
      sync: jest.fn(() =>
        Promise.reject(
          new CanopyCloudClientError('http-error', 'revision gone', 404),
        ),
      ),
      getState: jest.fn(),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(() =>
        Promise.resolve({ ...state, status: 'pinned' as const }),
      ),
      withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
        operation(),
      ),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {} }),
        ),
      },
    };
    let resolveProbe!: (value: { id: string }) => void;
    const transport = {
      resolveLatest: jest.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    };
    const service = new SharedContainerReconciliationService(
      manager as never,
      transport as never,
    );

    const opening = service.open('container-1', 'org-1');
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(transport.resolveLatest).toHaveBeenCalledTimes(1);
    await service.withReplicaPurgeFence(() => Promise.resolve());
    resolveProbe({ id: 'container-1' });

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.pin).not.toHaveBeenCalled();
  });

  it('does not purge from an old-identity authorization denial after a root purge fence', async () => {
    const manager = {
      sync: jest.fn(() =>
        Promise.reject(
          new CanopyCloudClientError('http-error', 'revision gone', 404),
        ),
      ),
      getState: jest.fn(),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
      withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
        operation(),
      ),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {} }),
        ),
      },
    };
    let rejectProbe!: (error: Error) => void;
    const transport = {
      resolveLatest: jest.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectProbe = reject;
          }),
      ),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    };
    const service = new SharedContainerReconciliationService(
      manager as never,
      transport as never,
    );

    const opening = service.open('container-1', 'org-1');
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(transport.resolveLatest).toHaveBeenCalledTimes(1);
    await service.withReplicaPurgeFence(() => Promise.resolve());
    rejectProbe(
      new CanopyCloudClientError('http-error', 'container gone', 403),
    );

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.purge).not.toHaveBeenCalled();
  });

  it('finishes a started denial cleanup before a retaining organization snapshot', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const originalResolveLatest = transport.resolveLatest.bind(transport);
    let markOrg2Started!: () => void;
    const org2Started = new Promise<void>((resolve) => {
      markOrg2Started = resolve;
    });
    let releaseOrg2!: () => void;
    const org2Gate = new Promise<void>((resolve) => {
      releaseOrg2 = resolve;
    });
    transport.resolveLatest = jest.fn(
      async (containerId, organizationId, signal) => {
        if (organizationId === 'org-2') {
          markOrg2Started();
          await org2Gate;
          throw new Error('org-2 sync failed before authentication');
        }
        return originalResolveLatest(containerId, organizationId, signal);
      },
    );
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    await manager.pin('container-1');
    const org2Sync = manager.sync('container-1', 'org-2');
    await org2Started;

    const originalPurge = manager.purge.bind(manager);
    let markPurgeStarted!: () => void;
    const purgeStarted = new Promise<void>((resolve) => {
      markPurgeStarted = resolve;
    });
    jest
      .spyOn(manager, 'purge')
      .mockImplementationOnce(async (...args): Promise<boolean> => {
        markPurgeStarted();
        return originalPurge(...args);
      });
    jest
      .spyOn(manager, 'sync')
      .mockRejectedValueOnce(validatedServerError('container denied', 403));
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );
    const denial = (
      service as unknown as {
        reconcile(
          containerId: string,
          organizationId: string,
          force: boolean,
        ): Promise<unknown>;
      }
    ).reconcile('container-1', 'org-1', false);
    await purgeStarted;

    const generationBeforeSnapshot = manager.captureAuthorizationGeneration();
    const snapshot = service.reconcileOrganizationSnapshot(['org-1']);
    for (
      let attempt = 0;
      attempt < 16 &&
      manager.captureAuthorizationGeneration() === generationBeforeSnapshot;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    releaseOrg2();

    await expect(org2Sync).rejects.toThrow(
      'org-2 sync failed before authentication',
    );
    await expect(denial).rejects.toBeDefined();
    await snapshot;
    await expect(manager.getState('container-1')).resolves.toBeNull();
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not purge from an old-identity organization listing after a root purge fence', async () => {
    const manager = {
      sync: jest.fn(),
      getState: jest.fn(),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
      withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
        operation(),
      ),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({
            version: 1,
            containers: { 'container-1': availableState() },
          }),
        ),
      },
    };
    let rejectListing!: (error: Error) => void;
    const transport = {
      listSharedWithMe: jest.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectListing = reject;
          }),
      ),
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    };
    const service = new SharedContainerReconciliationService(
      manager as never,
      transport as never,
    );

    const listing = service.listSharedWithMe({ organizationId: 'org-1' });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await service.withReplicaPurgeFence(() => Promise.resolve());
    rejectListing(
      new CanopyCloudClientError('http-error', 'organization gone', 403),
    );

    await expect(listing).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.purge).not.toHaveBeenCalled();
  });

  it('keeps exactly one realtime subscription for the currently open container', async () => {
    const firstStop = jest.fn();
    const secondStop = jest.fn();
    const manager = {
      sync: jest
        .fn()
        .mockResolvedValueOnce(availableState())
        .mockResolvedValueOnce({
          ...availableState(),
          containerId: 'container-2',
          revisionId: 'revision-2',
        }),
      getState: jest.fn(),
      close: jest.fn(() => Promise.resolve(true)),
      purge: jest.fn(),
      pin: jest.fn(),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {}, artifacts: {} }),
        ),
      },
    };
    const subscribe = jest
      .fn()
      .mockReturnValueOnce({ stop: firstStop })
      .mockReturnValueOnce({ stop: secondStop });
    const service = new SharedContainerReconciliationService(manager as never, {
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
      subscribe,
    });

    await service.open('container-1', 'org-1');
    await service.open('container-2', 'org-1');

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();
  });

  it('cleans a reconciled replica when an organization snapshot advances the authorization epoch before ownership', async () => {
    const state = availableState();
    const manager = {
      sync: jest.fn(() => Promise.resolve(state)),
      close: jest.fn(() => Promise.resolve(true)),
      ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
      withOrganizationSnapshotFence: jest.fn(
        (_organizationIds: readonly string[], operation: () => Promise<void>) =>
          operation(),
      ),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({
            version: 1,
            containers: { 'container-1': state },
            artifacts: {},
            promotionCommits: {},
          }),
        ),
      },
    };
    const service = new SharedContainerReconciliationService(manager as never, {
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    });
    let snapshotStarted = false;
    let resolveSnapshot!: () => void;
    let rejectSnapshot!: (error: unknown) => void;
    const snapshotCompleted = new Promise<void>((resolve, reject) => {
      resolveSnapshot = resolve;
      rejectSnapshot = reject;
    });
    service.onChanged((changed) => {
      if (changed && !snapshotStarted) {
        snapshotStarted = true;
        void service
          .reconcileOrganizationSnapshot(['org-1'])
          .then(resolveSnapshot, rejectSnapshot);
      }
    });

    await expect(service.open('container-1', 'org-1')).rejects.toMatchObject({
      name: 'AbortError',
    });
    await snapshotCompleted;

    // The aborted open must not establish ownership, but it must also not
    // destroy a replica whose organization is still authorized: purging is now
    // reserved for dismiss, access loss, and account change (CAN-2551).
    expect(manager.close).not.toHaveBeenCalled();
  });

  it.each(['first', 'second'] as const)(
    'closes a superseded overlapping open when the %s container finishes first',
    async (firstToFinish) => {
      const firstState = availableState();
      const secondState = {
        ...availableState(),
        containerId: 'container-2',
        revisionId: 'revision-2',
      };
      let resolveFirst!: (state: typeof firstState) => void;
      const firstSync = new Promise<typeof firstState>((resolve) => {
        resolveFirst = resolve;
      });
      let resolveSecond!: (state: typeof secondState) => void;
      const secondSync = new Promise<typeof secondState>((resolve) => {
        resolveSecond = resolve;
      });
      const manager = {
        sync: jest.fn((containerId: string) =>
          containerId === 'container-1' ? firstSync : secondSync,
        ),
        getState: jest.fn(),
        close: jest.fn(() => Promise.resolve(true)),
        purge: jest.fn(),
        pin: jest.fn(),
        store: {
          readIndex: jest.fn(() =>
            Promise.resolve({ version: 1, containers: {}, artifacts: {} }),
          ),
        },
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );

      const firstOpen = service.open('container-1', 'org-1');
      const secondOpen = service.open('container-2', 'org-1');
      if (firstToFinish === 'first') {
        resolveFirst(firstState);
        await firstOpen;
        resolveSecond(secondState);
      } else {
        resolveSecond(secondState);
        await secondOpen;
        resolveFirst(firstState);
      }
      await Promise.all([firstOpen, secondOpen]);

      // The superseded open releases its subscription but keeps its bytes: an
      // accepted share survives navigation races, so switching back to
      // container-1 hits the warm replica instead of re-cloning (CAN-2551).
      expect(manager.close).not.toHaveBeenCalled();
      expect(manager.purge).not.toHaveBeenCalled();
    },
  );

  it('does not let an older same-container open close the newer owner', async () => {
    const state = availableState();
    let resolveSync!: (state: typeof state) => void;
    const sync = new Promise<typeof state>((resolve) => {
      resolveSync = resolve;
    });
    const manager = {
      sync: jest.fn(() => sync),
      getState: jest.fn(),
      close: jest.fn(() => Promise.resolve(true)),
      purge: jest.fn(),
      pin: jest.fn(),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {}, artifacts: {} }),
        ),
      },
    };
    const service = new SharedContainerReconciliationService(manager as never, {
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
    });

    const olderOpen = service.open('container-1', 'org-1');
    const newerOpen = service.open('container-1', 'org-1');
    resolveSync(state);

    await Promise.all([olderOpen, newerOpen]);
    expect(manager.close).not.toHaveBeenCalled();
  });

  it('does not share an active sync across organization identities', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    let markFirstSyncStarted!: () => void;
    const firstSyncStarted = new Promise<void>((resolve) => {
      markFirstSyncStarted = resolve;
    });
    let releaseFirstSync!: () => void;
    const firstSyncGate = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });
    const transport = {
      ...transportFor(fixture),
      resolveLatest: jest.fn(
        async (
          _containerId: string,
          organizationId: string,
          signal?: AbortSignal,
        ) => {
          if (organizationId !== 'org-1') {
            return { ...fixture.detail, organizationId };
          }
          markFirstSyncStarted();
          await Promise.race([
            firstSyncGate,
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            }),
          ]);
          return fixture.detail;
        },
      ),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    const sync = jest.spyOn(manager, 'sync');
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );

    const firstOpen = service.open('container-1', 'org-1').then(
      () => 'resolved' as const,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        typeof error.name === 'string'
          ? error.name
          : String(error),
    );
    await firstSyncStarted;
    const secondOpen = service.open('container-1', 'org-2').then(
      () => 'resolved' as const,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        typeof error.name === 'string'
          ? error.name
          : String(error),
    );
    for (let i = 0; i < 8 && sync.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }
    releaseFirstSync();

    await expect(secondOpen).resolves.toBe('AbortError');
    const firstOutcome = await firstOpen;
    expect(firstOutcome).toMatch(/^(?:AbortError|resolved)$/);
    expect(transport.resolveLatest).toHaveBeenCalledTimes(1);
    expect(transport.resolveLatest).toHaveBeenCalledWith(
      'container-1',
      'org-1',
      expect.any(AbortSignal),
    );
    // A superseded open no longer purges (CAN-2551), so what must hold is the
    // identity invariant, not absence: whatever survives belongs to the
    // organization that was actually authorized, never to org-2.
    const retained = await manager.getState('container-1');
    if (firstOutcome === 'resolved') {
      expect(retained?.organizationId).toBe('org-1');
    } else {
      expect(retained).toBeNull();
    }
    expect(retained?.organizationId).not.toBe('org-2');
  });

  it('replaces completed pinned state and subscriptions across organization identities', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const fixtureTransport = transportFor(fixture);
    const firstStop = jest.fn();
    const secondStop = jest.fn();
    const subscribe = jest.fn(
      (options: { organizationId: string }): { stop(): void } => ({
        stop: options.organizationId === 'org-1' ? firstStop : secondStop,
      }),
    );
    const transport = {
      ...fixtureTransport,
      resolveLatest: jest.fn((_containerId: string, organizationId: string) =>
        Promise.resolve({ ...fixture.detail, organizationId }),
      ),
      fetchRevision: jest.fn(
        (
          containerId: string,
          revisionId: string,
          organizationId: string,
          signal?: AbortSignal,
        ) =>
          fixtureTransport.fetchRevision(
            containerId,
            revisionId,
            organizationId,
            signal,
          ),
      ),
      requestDownloadUrls: jest.fn(
        (
          containerId: string,
          revisionId: string,
          organizationId: string,
          artifactIds: string[],
          signal?: AbortSignal,
        ) =>
          fixtureTransport.requestDownloadUrls(
            containerId,
            revisionId,
            organizationId,
            artifactIds,
            signal,
          ),
      ),
      subscribe,
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transport,
    );

    await expect(service.open('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
      organizationId: 'org-1',
    });
    await expect(manager.pin('container-1')).resolves.toMatchObject({
      status: 'pinned',
      organizationId: 'org-1',
    });

    await expect(service.open('container-1', 'org-2')).resolves.toMatchObject({
      status: 'available',
      organizationId: 'org-2',
    });

    expect(transport.resolveLatest).toHaveBeenCalledTimes(2);
    expect(transport.fetchRevision).toHaveBeenCalledTimes(2);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();
    expect(
      subscribe.mock.calls.map(([options]) => options.organizationId),
    ).toEqual(['org-1', 'org-2']);
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'available',
      organizationId: 'org-2',
    });
  });

  it.each(['direct', 'revision-probe'] as const)(
    'preserves another organization pinned replica after a %s denial',
    async (denialPath) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture();
      const fixtureTransport = transportFor(fixture);
      let org2Attempts = 0;
      const transport = {
        ...fixtureTransport,
        resolveLatest: jest.fn(
          (_containerId: string, organizationId: string) => {
            if (organizationId === 'org-1') {
              return Promise.resolve(fixture.detail);
            }
            org2Attempts += 1;
            if (denialPath === 'revision-probe' && org2Attempts === 1) {
              return Promise.reject(
                new CanopyCloudClientError('http-error', 'revision gone', 404),
              );
            }
            return Promise.reject(
              validatedServerError(
                'container denied',
                denialPath === 'direct' ? 403 : 404,
              ),
            );
          },
        ),
      };
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
      });
      const service = new SharedContainerReconciliationService(
        manager,
        transport,
      );

      await service.open('container-1', 'org-1');
      await manager.pin('container-1');

      await expect(service.open('container-1', 'org-2')).rejects.toThrow();
      await expect(manager.getState('container-1')).resolves.toMatchObject({
        status: 'pinned',
        organizationId: 'org-1',
      });
      const replicaStats = await stat(join(rootDir, 'container-1'));
      expect(replicaStats.isDirectory()).toBe(true);
    },
  );

  it('re-probes through the authenticated pull path before purging on stream denial', async () => {
    let onAccessDenied: (() => void) | undefined;
    const manager = {
      sync: jest.fn(() => Promise.resolve(availableState())),
      getState: jest.fn(),
      purge: jest.fn(() => Promise.resolve()),
      pin: jest.fn(),
      store: {
        readIndex: jest.fn(() =>
          Promise.resolve({ version: 1, containers: {}, artifacts: {} }),
        ),
      },
    };
    const service = new SharedContainerReconciliationService(manager as never, {
      resolveLatest: jest.fn(),
      fetchRevision: jest.fn(),
      requestDownloadUrls: jest.fn(),
      subscribe: (options): { stop(): void } => {
        onAccessDenied = options.onAccessDenied;
        return { stop: jest.fn() };
      },
    });
    await service.open('container-1', 'org-1');

    onAccessDenied?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.sync).toHaveBeenCalledTimes(2);
    expect(manager.purge).not.toHaveBeenCalled();
  });
  // CAN-2551 regression: a purge used to broadcast a bare `null`, which the
  // renderer read as "the mounted container is gone". Removing one share, or a
  // routine organization re-probe, therefore closed an unrelated recipient's
  // open viewer. Every purge now names the scope it applies to.
  describe('purge broadcasts name the container they apply to', () => {
    it('names only the dismissed container when the recipient removes a share', async () => {
      const manager = {
        close: jest.fn(() => Promise.resolve(true)),
        purge: jest.fn(() => Promise.resolve(true)),
        captureAuthorizationGeneration: jest.fn(() => 0),
      };
      const changed = jest.fn();
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
        jest.fn(() => Promise.resolve()),
        () => Promise.resolve({} as never),
      );
      service.onChanged(changed);

      await service.dismiss('container-1', 'org-1');

      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledWith({
        purged: 'container',
        containerId: 'container-1',
      });
    });

    it('emits one targeted purge per unauthorized container and none for a retained one', async () => {
      const manager = {
        sync: jest.fn(),
        getState: jest.fn(),
        purge: jest.fn(() => Promise.resolve(true)),
        pin: jest.fn(),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
        withOrganizationSnapshotFence: jest.fn(
          async (
            _organizationIds: readonly string[],
            operation: () => Promise<unknown>,
          ) => operation(),
        ),
        store: {
          readIndex: jest.fn(() =>
            Promise.resolve({
              version: 1,
              containers: {
                retained: availableState(),
                removed: {
                  ...availableState(),
                  containerId: 'removed',
                  organizationId: 'org-removed',
                },
                'removed-two': {
                  ...availableState(),
                  containerId: 'removed-two',
                  organizationId: 'org-removed',
                },
              },
            }),
          ),
        },
      };
      const changed = jest.fn<void, [SharedContainerReplicaBroadcast]>();
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );
      service.onChanged(changed);

      await service.reconcileOrganizationSnapshot(['org-1']);

      expect(changed.mock.calls.map(([event]) => event)).toEqual(
        expect.arrayContaining([
          { purged: 'container', containerId: 'removed' },
          { purged: 'container', containerId: 'removed-two' },
        ]),
      );
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed).not.toHaveBeenCalledWith({
        purged: 'container',
        containerId: 'retained',
      });
    });

    it('names only the denied container when access is validated away', async () => {
      let onAccessDenied: (() => void) | undefined;
      const manager = {
        sync: jest.fn(() => Promise.resolve(availableState())),
        getState: jest.fn(() => Promise.resolve(availableState())),
        purge: jest.fn(() => Promise.resolve(true)),
        pin: jest.fn(),
        captureAuthorizationGeneration: jest.fn(() => 0),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe: (options): { stop(): void } => {
            onAccessDenied = options.onAccessDenied;
            return { stop: jest.fn() };
          },
        },
      );
      await service.open('container-1', 'org-1');
      const changed = jest.fn<void, [SharedContainerReplicaBroadcast]>();
      service.onChanged(changed);

      manager.sync.mockRejectedValue(
        validatedServerError('forbidden', 403) as never,
      );
      onAccessDenied?.();
      await new Promise((resolve) => setImmediate(resolve));

      expect(changed).toHaveBeenCalledWith({
        purged: 'container',
        containerId: 'container-1',
      });
      expect(
        changed.mock.calls.every(
          ([event]) => !('purged' in event) || event.purged === 'container',
        ),
      ).toBe(true);
    });

    it('broadcasts an all-scope purge behind the account-change fence', async () => {
      const manager = {
        withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
          operation(),
        ),
      };
      const changed = jest.fn();
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );
      service.onChanged(changed);

      await service.purgeAll();

      expect(changed).toHaveBeenCalledWith({ purged: 'all' });
    });

    it('records an attributable session diagnostic for each purge', async () => {
      const manager = {
        close: jest.fn(() => Promise.resolve(true)),
        purge: jest.fn(() => Promise.resolve(true)),
        captureAuthorizationGeneration: jest.fn(() => 0),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
        jest.fn(() => Promise.resolve()),
        () => Promise.resolve({} as never),
      );

      await service.dismiss('container-1', 'org-1');

      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'shared_container_replica_purged',
          worktreeId: 'container-1',
          sharedContainerId: 'container-1',
          sharedContainerPurgeReason: 'dismissed',
          providerType: 'unknown',
        }),
      );
    });

    it('attributes an all-scope purge to every container it was tracking', async () => {
      const manager = {
        sync: jest.fn(() => Promise.resolve(availableState())),
        getState: jest.fn(() => Promise.resolve(availableState())),
        pin: jest.fn(),
        captureAuthorizationGeneration: jest.fn(() => 0),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
        withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
          operation(),
        ),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe: (): { stop(): void } => ({ stop: jest.fn() }),
        },
      );
      await service.open('container-1', 'org-1');
      recordSessionDiagnostic.mockClear();

      await service.purgeAll();

      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'shared_container_replica_purged',
          sharedContainerId: 'container-1',
          sharedContainerPurgeReason: 'account-changed',
        }),
      );
    });

    // An authorization snapshot purges inside the manager, below this service,
    // so it cannot route through `purgeReplica`. Before this seam existed the
    // removal reached neither the diagnostics nor the renderer -- the one
    // purge a recipient is most likely to notice (their access was revoked
    // mid-read) was the one purge nothing could explain.
    it('attributes and broadcasts a snapshot-fence purge', async () => {
      const manager = {
        sync: jest.fn(() => Promise.resolve(availableState())),
        getState: jest.fn(() => Promise.resolve(availableState())),
        pin: jest.fn(),
        captureAuthorizationGeneration: jest.fn(() => 0),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe: (): { stop(): void } => ({ stop: jest.fn() }),
        },
      );
      const changed = jest.fn();
      service.onChanged(changed);
      await service.open('container-1', 'org-1');
      recordSessionDiagnostic.mockClear();

      service.emitSnapshotPurge('container-1');

      expect(changed).toHaveBeenCalledWith({
        purged: 'container',
        containerId: 'container-1',
      });
      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'shared_container_replica_purged',
          sharedContainerId: 'container-1',
          sharedContainerPurgeReason: 'organization-unauthorized',
        }),
      );
    });

    it('announces a snapshot purge after bytes are deleted despite cleanup failure', async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture();
      const transport = transportFor(fixture);
      const cleanupFailure = new Error('view cleanup failed');
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
        cleanupViewState: (): Promise<void> => Promise.reject(cleanupFailure),
        onSnapshotContainerPurged: (containerId, scopeKey): void =>
          service.emitSnapshotPurge(containerId, scopeKey),
      });
      const service = new SharedContainerReconciliationService(
        manager,
        transport,
      );
      const changed = jest.fn<void, [SharedContainerReplicaBroadcast]>();
      service.onChanged(changed);
      await manager.sync('container-1', 'org-1');
      const listingGeneration =
        await manager.beginContainerSnapshotListing('org-1');
      recordSessionDiagnostic.mockClear();

      await expect(
        manager.reconcileContainerSnapshot('org-1', [], listingGeneration),
      ).rejects.toBe(cleanupFailure);

      expect(changed).toHaveBeenCalledWith({
        purged: 'container',
        containerId: 'container-1',
      });
      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          sharedContainerId: 'container-1',
          sharedContainerPurgeReason: 'organization-unauthorized',
        }),
      );
    });

    // The service only knows the containers it was actively tracking, so an
    // accepted share the recipient had closed used to lose its plaintext with
    // no diagnostic naming it. The manager reports the authoritative scope.
    it('attributes an all-scope purge to containers it was not tracking', async () => {
      const manager = {
        sync: jest.fn(() => Promise.resolve(availableState())),
        getState: jest.fn(() => Promise.resolve(availableState())),
        pin: jest.fn(),
        captureAuthorizationGeneration: jest.fn(() => 0),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
        withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
          operation(),
        ),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe: (): { stop(): void } => ({ stop: jest.fn() }),
        },
      );
      await service.open('container-1', 'org-1');
      const changed = jest.fn<void, [SharedContainerReplicaBroadcast]>();
      service.onChanged(changed);
      recordSessionDiagnostic.mockClear();
      // The real manager reports its scope from INSIDE the fence, before the
      // service's own callback runs. Driving it any other way takes the
      // out-of-band branch and proves nothing about the union.
      // `container-2` is indexed on disk but was never tracked here.
      manager.withPurgeAllFence.mockImplementation(
        async (operation: () => Promise<unknown>) => {
          service.recordPurgeAllScope(['container-1', 'container-2']);
          return operation();
        },
      );

      await service.purgeAll();

      // Exactly one emission, carrying the union -- not one per report.
      expect(
        changed.mock.calls.filter(
          ([event]) => 'purged' in event && event.purged === 'all',
        ),
      ).toHaveLength(1);
      for (const containerId of ['container-1', 'container-2']) {
        expect(recordSessionDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'shared_container_replica_purged',
            sharedContainerId: containerId,
            sharedContainerPurgeReason: 'account-changed',
          }),
        );
      }
    });

    // The manager can delete every replica and then throw before the service's
    // own callback runs (a view-state cleanup failure rejects after
    // `purgeAllBytes()`). The teardown must still be announced, or the reader
    // keeps a decrypted transcript over bytes that are gone.
    it('still announces a purge the manager aborted after deleting bytes', async () => {
      const manager = {
        sync: jest.fn(() => Promise.resolve(availableState())),
        getState: jest.fn(() => Promise.resolve(availableState())),
        pin: jest.fn(),
        captureAuthorizationGeneration: jest.fn(() => 0),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
        withPurgeAllFence: jest.fn(),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe: (): { stop(): void } => ({ stop: jest.fn() }),
        },
      );
      const changed = jest.fn<void, [SharedContainerReplicaBroadcast]>();
      service.onChanged(changed);
      recordSessionDiagnostic.mockClear();
      manager.withPurgeAllFence.mockImplementation(() => {
        service.recordPurgeAllScope(['indexed-1']);
        return Promise.reject(new Error('view-state cleanup failed'));
      });

      await expect(service.purgeAll()).rejects.toThrow(
        'view-state cleanup failed',
      );

      expect(
        changed.mock.calls.filter(
          ([event]) => 'purged' in event && event.purged === 'all',
        ),
      ).toHaveLength(1);
      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ sharedContainerId: 'indexed-1' }),
      );
    });

    // A leak here would attribute one account's containers to another's
    // teardown. This covers draining BETWEEN fences; isolation between
    // OVERLAPPING fences is structural -- the manager serializes them with
    // `while (this.purgeAllPromise)` -- so there is no interleaving to drive.
    it('drains each fence scope before the next fence runs', async () => {
      const manager = {
        captureAuthorizationGeneration: jest.fn(() => 0),
        withPurgeAllFence: jest.fn(),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );
      const scopes = ['indexed-1', 'indexed-2'];
      let call = 0;
      manager.withPurgeAllFence.mockImplementation(
        (operation: () => Promise<unknown>) => {
          service.recordPurgeAllScope([scopes[call++] ?? 'unexpected']);
          return operation();
        },
      );

      await service.purgeAll();
      recordSessionDiagnostic.mockClear();
      await service.purgeAll();

      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ sharedContainerId: 'indexed-2' }),
      );
      expect(recordSessionDiagnostic).not.toHaveBeenCalledWith(
        expect.objectContaining({ sharedContainerId: 'indexed-1' }),
      );
    });

    // Every other purge path bumps the authorization epoch first, so a sync
    // that resolved just before the bytes went cannot still broadcast
    // fresh-looking state. The out-of-band branch skipped it, and `reconcile`
    // from a realtime signal or the fallback poll does not pass through
    // `open()`'s `desiredOpen` gate, so nothing else would have caught it.
    it('cancels an in-flight sync when an out-of-band purge lands', async () => {
      let releaseSync!: (state: SharedContainerReplicaState) => void;
      const manager = {
        captureAuthorizationGeneration: jest.fn(() => 0),
        getState: jest.fn(() => Promise.resolve(availableState())),
        pin: jest.fn(),
        sync: jest.fn(
          () =>
            new Promise<SharedContainerReplicaState>((resolve) => {
              releaseSync = resolve;
            }),
        ),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe: (): { stop(): void } => ({ stop: jest.fn() }),
        },
      );
      const opening = service.open('container-1', 'org-1');
      // Let `open` reach `sync()` so the in-flight promise actually exists.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // The self-heal wipes every replica while the sync is still in flight.
      service.recordPurgeAllScope(['container-1']);
      const changed = jest.fn();
      service.onChanged(changed);
      releaseSync(availableState());

      await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
      // The stale sync must not broadcast readable state for bytes that are
      // already gone.
      expect(changed).not.toHaveBeenCalled();
    });

    // An out-of-band purge with nothing tracked and nothing reported has no
    // viewer to close and nothing to name. Emitting would broadcast an
    // unattributable teardown and, since the renderer relists on every purge,
    // feed a purge -> relist -> recovery -> purge cycle.
    it('does not announce an out-of-band purge with an empty scope', () => {
      const manager = { captureAuthorizationGeneration: jest.fn(() => 0) };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );
      const changed = jest.fn();
      service.onChanged(changed);

      service.recordPurgeAllScope([]);

      expect(changed).not.toHaveBeenCalled();
      expect(recordSessionDiagnostic).not.toHaveBeenCalled();
    });

    // `ensureReplicaStoreIntegrity()` self-heals by calling the MANAGER's own
    // `purgeAll()`, which never enters this service's fence. Buffering the
    // reported scope until a fence drained it meant that purge emitted nothing
    // at all, and its ids leaked into whatever legitimate purge came next --
    // attributing containers to the wrong event under the wrong reason.
    it('attributes an out-of-band whole-store purge on its own', () => {
      const manager = { captureAuthorizationGeneration: jest.fn(() => 0) };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );
      const changed = jest.fn();
      service.onChanged(changed);

      service.recordPurgeAllScope(['stale-a', 'stale-b']);

      expect(changed).toHaveBeenCalledWith({ purged: 'all' });
      for (const containerId of ['stale-a', 'stale-b']) {
        expect(recordSessionDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'shared_container_replica_purged',
            sharedContainerId: containerId,
            // Nobody signed out: an index the store cannot vouch for is its
            // own reason, so triage does not chase a phantom account switch.
            sharedContainerPurgeReason: 'replica-store-unrecoverable',
          }),
        );
      }
    });

    it('never carries an earlier purge scope into a later one', async () => {
      const manager = {
        sync: jest.fn(() => Promise.resolve(availableState())),
        getState: jest.fn(() => Promise.resolve(availableState())),
        pin: jest.fn(),
        captureAuthorizationGeneration: jest.fn(() => 0),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
        withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
          operation(),
        ),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe: (): { stop(): void } => ({ stop: jest.fn() }),
        },
      );
      // An out-of-band self-heal purge, emitted and settled on its own. It
      // names `stale-a`, and stops tracking whatever it took down with it.
      service.recordPurgeAllScope(['stale-a']);
      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ sharedContainerId: 'stale-a' }),
      );

      // Life goes on: a share opened afterwards, then an unrelated account
      // change. That purge must name its own container and nothing else --
      // `stale-a` was purged at a different time and is already accounted for.
      await service.open('container-2', 'org-1');
      recordSessionDiagnostic.mockClear();
      await service.purgeAll();

      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ sharedContainerId: 'container-2' }),
      );
      expect(recordSessionDiagnostic).not.toHaveBeenCalledWith(
        expect.objectContaining({ sharedContainerId: 'stale-a' }),
      );
    });

    it('does not broadcast a purge when the manager had nothing to remove', async () => {
      const manager = {
        purge: jest.fn(() => Promise.resolve(false)),
      };
      const changed = jest.fn();
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );
      service.onChanged(changed);

      await service.purge('container-1', 'dismissed');

      expect(changed).not.toHaveBeenCalled();
      expect(recordSessionDiagnostic).not.toHaveBeenCalled();
    });
  });
  describe('direct shares', () => {
    it('keeps direct replicas through an organization snapshot', async () => {
      const manager = {
        sync: jest.fn(),
        getState: jest.fn(),
        purge: jest.fn(() => Promise.resolve(true)),
        pin: jest.fn(),
        ensureReplicaStoreIntegrity: jest.fn(() => Promise.resolve()),
        withOrganizationSnapshotFence: jest.fn(
          async (
            _organizationIds: readonly string[],
            operation: () => Promise<unknown>,
          ) => operation(),
        ),
        store: {
          readIndex: jest.fn(() => {
            const personal: Record<string, unknown> = {
              ...availableState(),
              containerId: 'personal-direct',
              access: 'direct',
            };
            delete personal.organizationId;
            return Promise.resolve({
              version: 1,
              containers: {
                'org-removed': {
                  ...availableState(),
                  containerId: 'org-removed',
                  organizationId: 'org-removed',
                },
                'org-direct': {
                  ...availableState(),
                  containerId: 'org-direct',
                  organizationId: 'org-removed',
                  access: 'direct',
                },
                'personal-direct': personal,
              },
            });
          }),
        },
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );

      // A recipient who is in no organization at all still keeps direct shares.
      await service.reconcileOrganizationSnapshot([]);

      expect(manager.purge).toHaveBeenCalledTimes(1);
      expect(manager.purge).toHaveBeenCalledWith('org-removed', {
        allowDuringAuthorizationTransition: true,
      });
    });

    it('reconciles the direct listing against the direct scope', async () => {
      const manager = {
        beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
        reconcileContainerSnapshot: jest.fn(() => Promise.resolve()),
      };
      const listSharedWithMe = jest.fn(() =>
        Promise.resolve({
          containers: [{ id: 'direct-1' }],
          nextCursor: null,
        }),
      );
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          listSharedWithMe,
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        } as never,
      );

      await service.listSharedWithMe({});

      expect(listSharedWithMe).toHaveBeenCalledWith({});
      expect(manager.beginContainerSnapshotListing).toHaveBeenCalledWith(
        'direct',
      );
      expect(manager.reconcileContainerSnapshot).toHaveBeenCalledWith(
        'direct',
        ['direct-1'],
        1,
        expect.any(Function),
      );
    });

    it('purges direct replicas after a validated direct-listing denial', async () => {
      const manager = {
        beginContainerSnapshotListing: jest.fn(() => Promise.resolve(1)),
        reconcileContainerSnapshot: jest.fn(() => Promise.resolve()),
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          listSharedWithMe: jest.fn(() =>
            Promise.reject(validatedServerError('signed out', 401)),
          ),
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      );

      await expect(service.listSharedWithMe({})).rejects.toThrow('signed out');
      expect(manager.reconcileContainerSnapshot).toHaveBeenCalledWith(
        'direct',
        [],
        1,
        expect.any(Function),
      );
    });

    it('attributes a direct-listing removal to lost access', () => {
      const service = new SharedContainerReconciliationService({} as never, {
        resolveLatest: jest.fn(),
        fetchRevision: jest.fn(),
        requestDownloadUrls: jest.fn(),
      });
      service.emitSnapshotPurge('direct-1', 'direct');
      service.emitSnapshotPurge('org-1-container', 'org-1');

      expect(recordSessionDiagnostic).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          sharedContainerId: 'direct-1',
          sharedContainerPurgeReason: 'access-denied',
        }),
      );
      expect(recordSessionDiagnostic).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sharedContainerId: 'org-1-container',
          sharedContainerPurgeReason: 'organization-unauthorized',
        }),
      );
    });

    it('scopes manager snapshots so organization and direct listings never cross', async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
        },
      });
      const nothingPublished = {
        status: 'nothing-published' as const,
        containerType: 'COWORK_WORK_ENTRY' as const,
        updatedAt: '2026-08-28T00:00:00.000Z',
      };
      await manager.store.set({
        ...nothingPublished,
        containerId: 'org-share',
        organizationId: 'org-1',
      });
      await manager.store.set({
        ...nothingPublished,
        containerId: 'direct-org-share',
        organizationId: 'org-1',
        access: 'direct',
      });
      await manager.store.set({
        ...nothingPublished,
        containerId: 'personal-share',
        access: 'direct',
      });

      const orgGeneration =
        await manager.beginContainerSnapshotListing('org-1');
      await manager.reconcileContainerSnapshot('org-1', [], orgGeneration);
      expect(
        Object.keys((await manager.store.readIndex()).containers).sort(),
      ).toEqual(['direct-org-share', 'personal-share']);

      const directGeneration =
        await manager.beginContainerSnapshotListing('direct');
      await manager.reconcileContainerSnapshot(
        'direct',
        ['personal-share'],
        directGeneration,
      );
      await expect(manager.store.get('personal-share')).resolves.toEqual({
        ...nothingPublished,
        containerId: 'personal-share',
        access: 'direct',
      });
      expect(Object.keys((await manager.store.readIndex()).containers)).toEqual(
        ['personal-share'],
      );
    });
  });

  // A viewer close can land late: it waits for the per-container run lifecycle
  // lock and for process teardown, while the next open of the same share only
  // waits for one acceptance read. Closes are therefore scoped to the viewer
  // session that sent them, so arrival order stops mattering.
  describe('viewer sessions', () => {
    interface Deferred<T> {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (error: Error) => void;
    }

    function deferred<T>(): Deferred<T> {
      let resolve!: (value: T) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    type State = ReturnType<typeof availableState>;

    function stateFor(containerId: string): State {
      return { ...availableState(), containerId };
    }

    function buildTrackedService(): {
      service: SharedContainerReconciliationService;
      sync: jest.Mock<Promise<State>, [string, ...unknown[]]>;
      subscribe: jest.Mock<{ stop: jest.Mock }, [{ containerId: string }]>;
      stops: Map<string, jest.Mock>;
    } {
      const sync = jest.fn<Promise<State>, [string, ...unknown[]]>(
        (containerId) => Promise.resolve(stateFor(containerId)),
      );
      const stops = new Map<string, jest.Mock>();
      const subscribe = jest.fn<{ stop: jest.Mock }, [{ containerId: string }]>(
        ({ containerId }) => {
          const stop = jest.fn();
          stops.set(containerId, stop);
          return { stop };
        },
      );
      const manager = {
        sync,
        getState: jest.fn(),
        close: jest.fn(() => Promise.resolve(true)),
        purge: jest.fn(() => Promise.resolve(true)),
        pin: jest.fn(),
        captureAuthorizationGeneration: jest.fn(() => 0),
        withPurgeAllFence: jest.fn(async (operation: () => Promise<unknown>) =>
          operation(),
        ),
        store: {
          readIndex: jest.fn(() =>
            Promise.resolve({ version: 1, containers: {}, artifacts: {} }),
          ),
        },
      };
      const service = new SharedContainerReconciliationService(
        manager as never,
        {
          resolveLatest: jest.fn(),
          fetchRevision: jest.fn(),
          requestDownloadUrls: jest.fn(),
          subscribe,
        },
      );
      return { service, sync, subscribe, stops };
    }

    function openWithSession(
      service: SharedContainerReconciliationService,
      containerId: string,
      viewerSessionId: string,
      force = false,
    ): Promise<unknown> {
      // Mirrors the IPC handler: the session is registered synchronously, in
      // arrival order, before anything awaits.
      service.beginViewerSession(containerId, viewerSessionId);
      return service.open(
        containerId,
        'org-1',
        force,
        undefined,
        viewerSessionId,
      );
    }

    /** Fallback pulls a container receives over one pull interval. */
    async function pullsOverOneInterval(
      sync: jest.Mock<Promise<State>, [string, ...unknown[]]>,
      containerId: string,
    ): Promise<number> {
      const count = (): number =>
        sync.mock.calls.filter(([id]) => id === containerId).length;
      const before = count();
      await jest.advanceTimersByTimeAsync(30_000);
      return count() - before;
    }

    function trackingChanges(containerId: string): unknown[] {
      return recordSessionDiagnostic.mock.calls
        .map(
          ([entry]) =>
            entry as {
              kind: string;
              sharedContainerId?: string;
              sharedContainerTrackingChange?: string;
            },
        )
        .filter(
          (entry) =>
            entry.kind === 'shared_container_tracking_changed' &&
            entry.sharedContainerId === containerId,
        )
        .map((entry) => entry.sharedContainerTrackingChange);
    }

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('keeps a re-opened container tracked when the previous viewer session closes during its open', async () => {
      const { service, sync, stops } = buildTrackedService();
      await openWithSession(service, 'container-1', 'session-1');
      const reopenSync = deferred<State>();
      sync.mockReturnValueOnce(reopenSync.promise);

      const reopened = openWithSession(service, 'container-1', 'session-2');
      // The earlier visit's close lands while the re-open is still syncing.
      await service.close('container-1', 'session-1');
      reopenSync.resolve(stateFor('container-1'));
      await reopened;

      expect(stops.get('container-1')).not.toHaveBeenCalled();
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
    });

    it('resets the viewer layout only for the sync an open started', async () => {
      const { service, sync } = buildTrackedService();
      const modes = (): unknown[] =>
        sync.mock.calls.map(
          ([, , options]) =>
            (options as { viewerLayoutMode?: string }).viewerLayoutMode,
        );

      await openWithSession(service, 'container-1', 'session-1');
      // Retry is the same open with `force`.
      await openWithSession(service, 'container-1', 'session-2', true);
      expect(modes()).toEqual(['reset', 'reset']);

      // The fallback pull must never rearrange an open share.
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
      expect(modes()).toEqual(['reset', 'reset', 'seed']);
    });

    it('seeds for a retry in a session that already shows the share', async () => {
      const { service, sync } = buildTrackedService();
      const modes = (): unknown[] =>
        sync.mock.calls.map(
          ([, , options]) =>
            (options as { viewerLayoutMode?: string }).viewerLayoutMode,
        );

      await openWithSession(service, 'container-1', 'session-1');
      // The share is on screen, so the retry must not rearrange it.
      await openWithSession(service, 'container-1', 'session-1', true);

      expect(modes()).toEqual(['reset', 'seed']);
    });

    it('seeds for a retry once a background sync has shown the share', async () => {
      const { service, sync } = buildTrackedService();
      // The open finds nothing published, so it shows no grid.
      sync.mockResolvedValueOnce({
        ...stateFor('container-1'),
        status: 'nothing-published',
      } as unknown as State);
      await openWithSession(service, 'container-1', 'session-1');
      // The fallback pull finds the first revision and the grid mounts.
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);

      await openWithSession(service, 'container-1', 'session-1', true);

      expect(
        sync.mock.calls.map(
          ([, , options]) =>
            (options as { viewerLayoutMode?: string }).viewerLayoutMode,
        ),
      ).toEqual(['reset', 'seed', 'seed']);
    });

    it('resets on a retry when the session has not shown the share yet', async () => {
      const { service, sync } = buildTrackedService();
      sync.mockRejectedValueOnce(new Error('offline'));

      await expect(
        openWithSession(service, 'container-1', 'session-1'),
      ).rejects.toThrow('offline');
      await openWithSession(service, 'container-1', 'session-1', true);

      expect(
        sync.mock.calls.map(
          ([, , options]) =>
            (options as { viewerLayoutMode?: string }).viewerLayoutMode,
        ),
      ).toEqual(['reset', 'reset']);
    });

    it('seeds for an older open that a newer viewer session replaced', async () => {
      const { service, sync } = buildTrackedService();
      // The older open stalls before it reaches the service; the newer
      // session registers and opens first.
      service.beginViewerSession('container-1', 'session-1');
      await openWithSession(service, 'container-1', 'session-2');

      await service.open('container-1', 'org-1', false, undefined, 'session-1');

      expect(
        sync.mock.calls.map(
          ([, , options]) =>
            (options as { viewerLayoutMode?: string }).viewerLayoutMode,
        ),
      ).toEqual(['reset', 'seed']);
    });

    it('seeds for an open whose viewer session already closed', async () => {
      const { service, sync } = buildTrackedService();
      service.beginViewerSession('container-1', 'session-1');
      await service.close('container-1', 'session-1');

      await service.open('container-1', 'org-1', false, undefined, 'session-1');

      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync.mock.calls[0]?.[2]).toMatchObject({
        viewerLayoutMode: 'seed',
      });
    });

    it('keeps tracking when a superseded session closes after the re-open completed', async () => {
      const { service, sync, stops } = buildTrackedService();
      await openWithSession(service, 'container-1', 'session-1');
      await openWithSession(service, 'container-1', 'session-2');

      await service.close('container-1', 'session-1');

      expect(stops.get('container-1')).not.toHaveBeenCalled();
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
      // The pull re-arms itself, so tracking stays live past one interval.
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
    });

    it('does not track an open whose viewer session already closed', async () => {
      const { service, sync, subscribe, stops } = buildTrackedService();
      // A different share is on screen and must stay that way.
      await service.open('container-2', 'org-1');
      service.beginViewerSession('container-1', 'session-1');
      // The close overtakes its own open (the open is still reading the
      // acceptance record), so the open that follows has no viewer to serve.
      await service.close('container-1', 'session-1');

      await expect(
        service.open('container-1', 'org-1', false, undefined, 'session-1'),
      ).resolves.toEqual(stateFor('container-1'));

      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ containerId: 'container-2' }),
      );
      expect(stops.get('container-2')).not.toHaveBeenCalled();
      const before = sync.mock.calls.length;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(sync.mock.calls.slice(before).map(([id]) => id)).toEqual([
        'container-2',
      ]);
    });

    it('does not revive a closed viewer session when the same id begins again', async () => {
      const { service, sync, subscribe } = buildTrackedService();
      await openWithSession(service, 'container-1', 'session-1');
      await service.close('container-1', 'session-1');

      // A retry reuses its viewer's session id; the viewer is already gone.
      await openWithSession(service, 'container-1', 'session-1', true);

      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(0);
    });

    it('keeps another share tracked when a late close for a different share lands', async () => {
      const { service, sync, stops } = buildTrackedService();
      await openWithSession(service, 'container-1', 'session-1');
      const otherSync = deferred<State>();
      sync.mockReturnValueOnce(otherSync.promise);

      const otherOpen = openWithSession(service, 'container-2', 'session-2');
      // During the other share's open...
      await service.close('container-1', 'session-1');
      otherSync.resolve(stateFor('container-2'));
      await otherOpen;
      expect(await pullsOverOneInterval(sync, 'container-2')).toBe(1);

      // ...and again after it completed.
      await service.close('container-1', 'session-1');

      expect(stops.get('container-2')).not.toHaveBeenCalled();
      expect(await pullsOverOneInterval(sync, 'container-2')).toBe(1);
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(0);
    });

    it('does not arm when the owning session closes during its own open', async () => {
      const { service, sync, subscribe } = buildTrackedService();
      const openSync = deferred<State>();
      sync.mockReturnValueOnce(openSync.promise);

      const opened = openWithSession(service, 'container-1', 'session-1');
      await service.close('container-1', 'session-1');
      openSync.resolve(stateFor('container-1'));
      await opened;

      expect(subscribe).not.toHaveBeenCalled();
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(0);
    });

    it('does not arm an older open that arrives after a newer viewer session closed', async () => {
      const { service, sync, subscribe, stops } = buildTrackedService();
      // session-1's open is registered but still reading the acceptance record
      // when a re-click mints session-2, which opens and then closes.
      service.beginViewerSession('container-1', 'session-1');
      await openWithSession(service, 'container-1', 'session-2');
      await service.close('container-1', 'session-2');
      expect(stops.get('container-1')).toHaveBeenCalledTimes(1);
      subscribe.mockClear();
      recordSessionDiagnostic.mockClear();

      // The older open only now reaches the service. The newest session has
      // closed, so no viewer is left and no close will ever release an arm.
      await expect(
        service.open('container-1', 'org-1', false, undefined, 'session-1'),
      ).resolves.toEqual(stateFor('container-1'));

      expect(subscribe).not.toHaveBeenCalled();
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(0);
      expect(trackingChanges('container-1')).toEqual(['open-not-armed']);
    });

    it('lets an older open arm on behalf of a newer viewer session that is still open', async () => {
      const { service, sync, subscribe } = buildTrackedService();
      // session-1's open is still reading the acceptance record when a
      // re-click mints session-2, whose own open has not reached the service.
      service.beginViewerSession('container-1', 'session-1');
      service.beginViewerSession('container-1', 'session-2');

      await service.open('container-1', 'org-1', false, undefined, 'session-1');

      // The share is on screen under session-2, so it must receive updates.
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
    });

    it('releases tracking when the owning viewer session closes', async () => {
      const { service, sync, stops } = buildTrackedService();
      await openWithSession(service, 'container-1', 'session-1');

      await service.close('container-1', 'session-1');
      // A repeated close of the same session is idempotent.
      await service.close('container-1', 'session-1');

      expect(stops.get('container-1')).toHaveBeenCalledTimes(1);
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(0);
    });

    it('treats a close without a viewer session as unconditional', async () => {
      const { service, sync, stops } = buildTrackedService();
      await openWithSession(service, 'container-1', 'session-1');
      await openWithSession(service, 'container-1', 'session-2');

      await service.close('container-1');

      expect(stops.get('container-1')).toHaveBeenCalledTimes(1);
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(0);
    });

    describe('forgets the viewer session when the replica is purged', () => {
      const purges: [
        string,
        (service: SharedContainerReconciliationService) => Promise<void> | void,
      ][] = [
        [
          'a single-container purge',
          (service): Promise<void> => service.purge('container-1', 'dismissed'),
        ],
        [
          'a snapshot purge of the container',
          (service): void => service.emitSnapshotPurge('container-1', 'org-1'),
        ],
        [
          'a purge of everything',
          (service): Promise<void> => service.purgeAll(),
        ],
        [
          'an out-of-band whole-store purge',
          (service): void => service.recordPurgeAllScope(['container-1']),
        ],
      ];

      it.each(purges)('after %s', async (_name, purge) => {
        const { service } = buildTrackedService();
        service.beginViewerSession('container-1', 'session-2');
        // The recorded session is what makes an older one superseded.
        expect(
          service.isViewerSessionSuperseded('container-1', 'session-1'),
        ).toBe(true);

        await purge(service);

        expect(
          service.isViewerSessionSuperseded('container-1', 'session-1'),
        ).toBe(false);
      });
    });

    it('records a tracking diagnostic when a stale close is ignored', async () => {
      const { service } = buildTrackedService();
      await openWithSession(service, 'container-1', 'session-1');
      await openWithSession(service, 'container-1', 'session-2');
      recordSessionDiagnostic.mockClear();

      await service.close('container-1', 'session-1');

      expect(trackingChanges('container-1')).toEqual(['stale-close-ignored']);
      expect(recordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'shared_container_tracking_changed',
          worktreeId: 'container-1',
          chatId: '',
          providerType: 'unknown',
          sharedContainerId: 'container-1',
          sharedContainerTrackingChange: 'stale-close-ignored',
        }),
      );
    });

    it('records armed and released once per open and close, never per pull', async () => {
      const { service, sync } = buildTrackedService();

      await openWithSession(service, 'container-1', 'session-1');
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
      expect(await pullsOverOneInterval(sync, 'container-1')).toBe(1);
      await service.close('container-1', 'session-1');
      // Nothing is armed any more, so a second close has nothing to report.
      await service.close('container-1', 'session-1');

      expect(trackingChanges('container-1')).toEqual([
        'armed',
        'released-viewer-closed',
      ]);
    });

    it('records an open that was not armed because its viewer session closed', async () => {
      const { service } = buildTrackedService();
      service.beginViewerSession('container-1', 'session-1');
      await service.close('container-1', 'session-1');

      await service.open('container-1', 'org-1', false, undefined, 'session-1');

      expect(trackingChanges('container-1')).toEqual(['open-not-armed']);
    });

    it('names what released tracking when it was not the viewer closing', async () => {
      const { service, sync } = buildTrackedService();

      await openWithSession(service, 'container-1', 'session-1');
      // Opening another share replaces the first.
      await openWithSession(service, 'container-2', 'session-2');
      expect(trackingChanges('container-1')).toEqual([
        'armed',
        'released-replaced-by-open',
      ]);

      // A purge takes the second share's tracking with it.
      await service.purge('container-2', 'dismissed');
      expect(trackingChanges('container-2')).toEqual([
        'armed',
        'released-purged',
      ]);

      // A failed retry of a tracked share drops its tracking.
      await openWithSession(service, 'container-3', 'session-3');
      sync.mockRejectedValueOnce(new Error('sync failed'));
      await expect(
        openWithSession(service, 'container-3', 'session-3', true),
      ).rejects.toThrow('sync failed');
      expect(trackingChanges('container-3')).toEqual([
        'armed',
        'released-open-failed',
      ]);
    });
  });
});
