import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  type ArchivedContainerManifest,
  type ArchivedContainerManifestV1,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';

jest.mock('../lib/paths', () => ({ getWorkspacesRootDir: jest.fn() }));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/app-advisor-workspace', () => ({
  readAppAdvisorWorkspaceSettings: jest.fn(),
}));
jest.mock('../lib/archived-containers', () => ({
  listArchivedContainerManifests: jest.fn(() => Promise.resolve([])),
  purgeArchivedContainer: jest.fn(() => Promise.resolve(true)),
  removeIncompleteArchivedContainers: jest.fn(() => Promise.resolve(0)),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_projectId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
jest.mock('../lib/worktree-service', () => ({
  retryDeferredTemporaryWorkspaceDeletion: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../lib/archived-container-git', () => ({
  reconcileArchivedGitRefsForWorkspace: jest.fn(() => Promise.resolve()),
  recoverArchivedGitTeardownsForWorkspace: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/w5-destructive-recovery', () => ({
  hasUnresolvedDestructiveRecovery: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../ledger/lifecycle', () => ({
  notifyLedgerContainerPurged: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
}));

import {
  applyArchivedContainerRetention,
  createArchivedContainerTiming,
  purgeExpiredArchivedContainersForWorkspace,
  resolveContainerRetentionDays,
} from '../lib/archived-container-retention';
import { readAppAdvisorWorkspaceSettings } from '../lib/app-advisor-workspace';
import {
  listArchivedContainerManifests,
  purgeArchivedContainer,
  removeIncompleteArchivedContainers,
  withArchivedWorkspaceOperationLock,
} from '../lib/archived-containers';
import { getWorkspacesRootDir } from '../lib/paths';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { retryDeferredTemporaryWorkspaceDeletion } from '../lib/worktree-service';
import {
  reconcileArchivedGitRefsForWorkspace,
  recoverArchivedGitTeardownsForWorkspace,
} from '../lib/archived-container-git';
import { hasUnresolvedDestructiveRecovery } from '../lib/w5-destructive-recovery';
import {
  notifyLedgerContainerPurged,
  notifyLedgerContainerRestored,
  recordLedgerRestoreIntent,
} from '../ledger/lifecycle';

let workspacesRoot: string;

function workspaceConfig(
  type: WorkspaceConfigFile['type'],
  value: number | null | undefined,
): WorkspaceConfigFile {
  if (type === 'cowork') {
    return {
      version: 1,
      type,
      repos: [],
      cowork: { archiveRetentionDays: value },
    };
  }
  return {
    version: 1,
    type,
    repos: [],
    ...(value !== undefined ? { archiveRetentionDays: value } : {}),
  };
}

function archivedManifest(
  id: string,
  expiresAt: string,
  lockedAt?: string,
): ArchivedContainerManifest {
  return {
    version: 1,
    id,
    kind: 'worktree',
    projectId: 'workspace-1',
    name: id,
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: '2026-07-15T00:00:00.000Z',
    retentionDays: 7,
    expiresAt,
    ...(lockedAt !== undefined ? { lockedAt } : {}),
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

function archivedManifestOfKind(
  kind: ArchivedContainerManifestV1['kind'],
  projectId: string,
  id: string,
  expiresAt: string,
): ArchivedContainerManifestV1 {
  return {
    version: 1,
    id,
    kind,
    projectId,
    name: id,
    createdAt: '2026-07-02T00:00:00.000Z',
    archivedAt: '2026-07-15T00:00:00.000Z',
    retentionDays: 7,
    expiresAt,
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

/**
 * Runs the retention sweep over `manifests`, which it lists under the archive
 * operation lock.
 */
function sweep(
  projectId: string,
  now: number,
  manifests: ArchivedContainerManifest[],
): Promise<number> {
  jest.mocked(listArchivedContainerManifests).mockResolvedValueOnce(manifests);
  return purgeExpiredArchivedContainersForWorkspace(projectId, now);
}

describe('archived container retention', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    workspacesRoot = await mkdtemp(join(tmpdir(), 'canopy-retention-'));
    jest.mocked(getWorkspacesRootDir).mockReturnValue(workspacesRoot);
    jest.mocked(readAppAdvisorWorkspaceSettings).mockResolvedValue({
      version: 1,
      archiveRetentionDays: null,
    });
  });

  afterEach(async () => {
    await rm(workspacesRoot, { recursive: true, force: true });
  });

  it('skips an expired archive while its destructive journal is unresolved', async () => {
    jest.mocked(hasUnresolvedDestructiveRecovery).mockResolvedValueOnce(true);
    const manifest = archivedManifest('expired', new Date(0).toISOString());
    await expect(sweep('workspace-1', Date.now(), [manifest])).resolves.toBe(0);
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
  });

  it.each([
    ['single-repo', undefined, 7],
    ['single-repo', null, 7],
    ['single-repo', 0, 7],
    ['single-repo', 14, 14],
    ['cowork', undefined, 7],
    ['cowork', null, 7],
    ['cowork', 0, 7],
    ['cowork', 30, 30],
  ] as const)(
    'resolves %s persisted retention %s to %s',
    async (type, persisted, expected) => {
      jest
        .mocked(readWorkspaceConfig)
        .mockResolvedValue(workspaceConfig(type, persisted));
      await expect(resolveContainerRetentionDays('workspace-1')).resolves.toBe(
        expected,
      );
    },
  );

  it('treats App Advisor null and legacy zero as seven days (retention is always on)', async () => {
    await expect(
      resolveContainerRetentionDays(APP_ADVISOR_PROJECT_ID),
    ).resolves.toBe(7);
    jest.mocked(readAppAdvisorWorkspaceSettings).mockResolvedValue({
      version: 1,
      archiveRetentionDays: 0,
    });
    await expect(
      resolveContainerRetentionDays(APP_ADVISOR_PROJECT_ID),
    ).resolves.toBe(7);
    jest.mocked(readAppAdvisorWorkspaceSettings).mockResolvedValue({
      version: 1,
      archiveRetentionDays: 21,
    });
    await expect(
      resolveContainerRetentionDays(APP_ADVISOR_PROJECT_ID),
    ).resolves.toBe(21);
  });

  it('fixes expiry when the container is captured', () => {
    expect(
      createArchivedContainerTiming(7, Date.parse('2026-07-22T00:00:00.000Z')),
    ).toEqual({
      archivedAt: '2026-07-22T00:00:00.000Z',
      expiresAt: '2026-07-29T00:00:00.000Z',
    });
  });

  it('rejects retention values above the supported maximum', () => {
    expect(() =>
      createArchivedContainerTiming(MAX_ARCHIVE_RETENTION_DAYS + 1),
    ).toThrow(
      `Archive retention must be an integer from 1 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  });

  it('janitors every project, purges only expired manifests, and retries temporary cleanup', async () => {
    await mkdir(join(workspacesRoot, 'workspace-1'));
    const now = Date.parse('2026-07-22T00:00:00.000Z');
    jest
      .mocked(listArchivedContainerManifests)
      .mockImplementation((projectId) =>
        Promise.resolve(
          projectId === 'workspace-1'
            ? [
                archivedManifest('expired-1', '2026-07-21T23:59:59.000Z'),
                archivedManifest('future-1', '2026-07-23T00:00:00.000Z'),
                // Locked containers are exempt even when past expiry.
                archivedManifest(
                  'locked-expired-1',
                  '2026-07-01T00:00:00.000Z',
                  '2026-07-16T00:00:00.000Z',
                ),
              ]
            : [],
        ),
      );

    await applyArchivedContainerRetention(now);

    expect(removeIncompleteArchivedContainers).toHaveBeenCalledWith(
      'workspace-1',
      24 * 60 * 60 * 1_000,
      now,
    );
    expect(removeIncompleteArchivedContainers).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      24 * 60 * 60 * 1_000,
      now,
    );
    expect(withArchivedWorkspaceOperationLock).toHaveBeenCalledWith(
      'workspace-1',
      expect.any(Function),
    );
    expect(purgeArchivedContainer).toHaveBeenCalledTimes(1);
    expect(purgeArchivedContainer).toHaveBeenCalledWith(
      'workspace-1',
      'expired-1',
    );
    expect(retryDeferredTemporaryWorkspaceDeletion).toHaveBeenCalledWith(
      'workspace-1',
    );
    // Only the purged container retires its Ledger scope.
    expect(notifyLedgerContainerPurged).toHaveBeenCalledTimes(1);
    expect(notifyLedgerContainerPurged).toHaveBeenCalledWith({
      container: {
        kind: 'code_worktree',
        workspaceId: 'workspace-1',
        worktreeId: 'expired-1',
      },
      containerCreatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('recovers interrupted archive deletion before acquiring the retention lock', async () => {
    await mkdir(join(workspacesRoot, 'workspace-1'));
    let lockHeld = false;
    let recoveryObservedLockHeld: boolean | undefined;
    jest
      .mocked(withArchivedWorkspaceOperationLock)
      .mockImplementation(async (_projectId, operation) => {
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      });
    jest
      .mocked(recoverArchivedGitTeardownsForWorkspace)
      .mockImplementation(() => {
        recoveryObservedLockHeld = lockHeld;
        return Promise.resolve();
      });

    await applyArchivedContainerRetention();

    expect(recoverArchivedGitTeardownsForWorkspace).toHaveBeenCalledWith(
      'workspace-1',
    );
    expect(recoveryObservedLockHeld).toBe(false);
    expect(reconcileArchivedGitRefsForWorkspace).toHaveBeenCalledWith(
      'workspace-1',
    );
  });

  it('continues purging expired archives after one archive fails', async () => {
    const now = Date.parse('2026-07-22T00:00:00.000Z');
    jest
      .mocked(purgeArchivedContainer)
      .mockRejectedValueOnce(new Error('unavailable repository'))
      .mockResolvedValueOnce(true);
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await expect(
        sweep('workspace-1', now, [
          archivedManifest('expired-1', '2026-07-20T00:00:00.000Z'),
          archivedManifest('expired-2', '2026-07-21T00:00:00.000Z'),
        ]),
      ).resolves.toBe(1);
    } finally {
      warn.mockRestore();
    }

    expect(purgeArchivedContainer).toHaveBeenNthCalledWith(
      1,
      'workspace-1',
      'expired-1',
    );
    expect(purgeArchivedContainer).toHaveBeenNthCalledWith(
      2,
      'workspace-1',
      'expired-2',
    );
    expect(retryDeferredTemporaryWorkspaceDeletion).toHaveBeenCalledWith(
      'workspace-1',
    );
    // The failed purge kept its archive, so only expired-2 retires.
    expect(notifyLedgerContainerPurged).toHaveBeenCalledTimes(1);
    expect(notifyLedgerContainerPurged).toHaveBeenCalledWith({
      container: {
        kind: 'code_worktree',
        workspaceId: 'workspace-1',
        worktreeId: 'expired-2',
      },
      containerCreatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  describe('Ledger lifecycle participant', () => {
    const now = Date.parse('2026-07-22T00:00:00.000Z');
    const expired = '2026-07-21T00:00:00.000Z';

    it('tells the Ledger about each purged worktree and Cowork Work Entry', async () => {
      jest
        .mocked(purgeArchivedContainer)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await expect(
        sweep('workspace-1', now, [
          archivedManifest('expired-1', expired),
          archivedManifestOfKind(
            'work-entry',
            'workspace-1',
            'expired-entry',
            expired,
          ),
          archivedManifest('future-1', '2026-07-23T00:00:00.000Z'),
          // Another operation already removed it: nothing was purged here.
          archivedManifest('expired-gone', expired),
        ]),
      ).resolves.toBe(2);

      expect(notifyLedgerContainerPurged).toHaveBeenCalledTimes(2);
      expect(notifyLedgerContainerPurged).toHaveBeenNthCalledWith(1, {
        container: {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'expired-1',
        },
        containerCreatedAt: '2026-07-01T00:00:00.000Z',
      });
      expect(notifyLedgerContainerPurged).toHaveBeenNthCalledWith(2, {
        container: {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'expired-entry',
        },
        containerCreatedAt: '2026-07-02T00:00:00.000Z',
      });
    });

    it('tells the Ledger about a purged App Advisor Work Entry', async () => {
      await expect(
        sweep(APP_ADVISOR_PROJECT_ID, now, [
          archivedManifestOfKind(
            'work-entry',
            APP_ADVISOR_PROJECT_ID,
            'advisor-entry',
            expired,
          ),
        ]),
      ).resolves.toBe(1);

      expect(notifyLedgerContainerPurged).toHaveBeenCalledWith({
        container: {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: 'advisor-entry',
        },
        containerCreatedAt: '2026-07-02T00:00:00.000Z',
      });
    });

    it('retires nothing when it purges the archive a restore left behind', async () => {
      await expect(
        sweep('workspace-1', now, [
          {
            ...archivedManifestOfKind(
              'worktree',
              'workspace-1',
              'restored-1',
              expired,
            ),
            restoredTo: {
              kind: 'worktree',
              id: 'new-worktree',
              restoredAt: '2026-07-16T00:00:00.000Z',
              createdAt: '2026-07-16T00:00:00.000Z',
            },
          },
        ]),
      ).resolves.toBe(1);

      expect(purgeArchivedContainer).toHaveBeenCalledWith(
        'workspace-1',
        'restored-1',
      );
      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
      // Its mapping was made durable first, and its reattach queued.
      const restored = {
        container: {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'new-worktree',
        },
        containerCreatedAt: '2026-07-16T00:00:00.000Z',
      };
      const archivedContainer = {
        kind: 'code_worktree',
        workspaceId: 'workspace-1',
        worktreeId: 'restored-1',
      };
      const [recordedFrom, recordedTo] =
        jest.mocked(recordLedgerRestoreIntent).mock.calls[0] ?? [];
      expect(recordedFrom?.container).toEqual(archivedContainer);
      expect(recordedTo).toEqual(restored);
      const [notifiedFrom, notifiedTo] =
        jest.mocked(notifyLedgerContainerRestored).mock.calls[0] ?? [];
      expect(notifiedFrom?.container).toEqual(archivedContainer);
      expect(notifiedTo).toEqual(restored);
      expect(
        jest.mocked(recordLedgerRestoreIntent).mock.invocationCallOrder[0],
      ).toBeLessThan(
        jest.mocked(purgeArchivedContainer).mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('lists the archives it may purge under the archive operation lock', async () => {
      let lockHeld = false;
      let listedUnderLock: boolean | undefined;
      jest
        .mocked(withArchivedWorkspaceOperationLock)
        .mockImplementationOnce(async (_projectId, operation) => {
          lockHeld = true;
          try {
            return await operation();
          } finally {
            lockHeld = false;
          }
        });
      jest.mocked(listArchivedContainerManifests).mockImplementationOnce(() => {
        listedUnderLock = lockHeld;
        return Promise.resolve([archivedManifest('expired-1', expired)]);
      });

      await expect(
        purgeExpiredArchivedContainersForWorkspace('workspace-1', now),
      ).resolves.toBe(1);

      expect(listedUnderLock).toBe(true);
    });

    it('decides from the manifest a restore left under the lock, not from an earlier read', async () => {
      // An earlier read outside the lock saw the archive expired and never
      // restored. A restore then held the lock first: it committed
      // `restoredTo` and kept the archive, since its intent was not durable.
      const unrestored = archivedManifestOfKind(
        'worktree',
        'workspace-1',
        'restored-1',
        expired,
      );
      const restored: ArchivedContainerManifest = {
        ...unrestored,
        restoredTo: {
          kind: 'worktree',
          id: 'new-worktree',
          restoredAt: '2026-07-16T00:00:00.000Z',
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      };
      let onDisk: ArchivedContainerManifest = unrestored;
      jest
        .mocked(withArchivedWorkspaceOperationLock)
        .mockImplementationOnce((_projectId, operation) => {
          onDisk = restored;
          return operation();
        });
      jest
        .mocked(listArchivedContainerManifests)
        .mockImplementationOnce(() => Promise.resolve([onDisk]));
      jest
        .mocked(recordLedgerRestoreIntent)
        .mockResolvedValueOnce('not_durable');

      await expect(
        purgeExpiredArchivedContainersForWorkspace('workspace-1', now),
      ).resolves.toBe(0);

      // The archive and its `restoredTo`, the only lasting mapping, stay, and
      // the scope is neither retired nor moved yet.
      expect(purgeArchivedContainer).not.toHaveBeenCalled();
      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
      expect(notifyLedgerContainerRestored).not.toHaveBeenCalled();
      expect(recordLedgerRestoreIntent).toHaveBeenCalledTimes(1);
    });

    it('keeps an expired restore archive while its Ledger mapping cannot be made durable', async () => {
      jest
        .mocked(recordLedgerRestoreIntent)
        .mockResolvedValueOnce('not_durable');

      await expect(
        sweep('workspace-1', now, [
          {
            ...archivedManifestOfKind(
              'worktree',
              'workspace-1',
              'restored-1',
              expired,
            ),
            restoredTo: {
              kind: 'worktree',
              id: 'new-worktree',
              restoredAt: '2026-07-16T00:00:00.000Z',
              createdAt: '2026-07-16T00:00:00.000Z',
            },
          },
          archivedManifest('expired-1', expired),
        ]),
      ).resolves.toBe(1);

      // The restore archive waits for the next run; the other expired one goes.
      expect(purgeArchivedContainer).toHaveBeenCalledTimes(1);
      expect(purgeArchivedContainer).toHaveBeenCalledWith(
        'workspace-1',
        'expired-1',
      );
      expect(notifyLedgerContainerRestored).not.toHaveBeenCalled();
    });

    it('purges a restore archive that predates restore creation times without recording a mapping', async () => {
      await expect(
        sweep('workspace-1', now, [
          {
            ...archivedManifestOfKind(
              'worktree',
              'workspace-1',
              'restored-1',
              expired,
            ),
            restoredTo: {
              kind: 'worktree',
              id: 'new-worktree',
              restoredAt: '2026-07-16T00:00:00.000Z',
            },
          },
        ]),
      ).resolves.toBe(1);

      expect(recordLedgerRestoreIntent).not.toHaveBeenCalled();
      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
    });

    it('keeps sweeping when the Ledger participant throws', async () => {
      jest.mocked(notifyLedgerContainerPurged).mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });
      const warn = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        await expect(
          sweep('workspace-1', now, [
            archivedManifest('expired-1', expired),
            archivedManifest('expired-2', expired),
          ]),
        ).resolves.toBe(2);
        // The defect is not reported as a failed purge.
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }

      expect(purgeArchivedContainer).toHaveBeenCalledTimes(2);
      expect(notifyLedgerContainerPurged).toHaveBeenCalledTimes(2);
      expect(retryDeferredTemporaryWorkspaceDeletion).toHaveBeenCalledWith(
        'workspace-1',
      );
    });
  });
});
